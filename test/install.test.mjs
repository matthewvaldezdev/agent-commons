// Connector-style setup: config merging with backups, restart checks, self-provisioning bridges, and `setup` end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, stat, utimes } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installJson, installToml, tomlBlock, detectClients, appStartTime, restartAdvice, clientTargets } from '../src/install.mjs';

// Tests must never open a real browser.
process.env.AGENT_COMMONS_NO_BROWSER = '1';
import { CommonsClient, friendlyClientName, parseOptions } from '../src/mcp.mjs';
import { stableRuntime } from '../src/runtime.mjs';
import { binPath } from '../src/paths.mjs';
import { health } from '../src/launcher.mjs';
import { seededServer, tempDataDir } from './helpers.mjs';

const run = promisify(execFile);
const entry = { command: '/usr/bin/node', args: ['/x/src/mcp.mjs', '--agent', 'claude-desktop', '--credential-file', '/x/connections/claude-desktop.json', '--url', 'http://127.0.0.1:4317'] };

test('JSON install keeps every other setting, writes a backup, and is a no-op the second time', async t => {
  const dir = await tempDataDir(t, 'commons-json-');
  const file = join(dir, 'claude_desktop_config.json');
  const original = JSON.stringify({ globalShortcut: 'Ctrl+Space', preferences: { menuBarEnabled: false, folders: ['/home/m/a', '/home/m/b'] }, mcpServers: { other: { command: 'uvx', args: ['thing'] } } }, null, 2) + '\n';
  await writeFile(file, original, { mode: 0o644 });
  const first = await installJson(file, 'agent-commons-claude-desktop', entry);
  assert.equal(first.status, 'added');
  assert.equal(await readFile(first.backup, 'utf8'), original, 'The backup is the untouched original.');
  const after = await readFile(file, 'utf8');
  const parsed = JSON.parse(after);
  assert.deepEqual(parsed.mcpServers['agent-commons-claude-desktop'], entry);
  const before = JSON.parse(original);
  for (const key of Object.keys(before)) if (key !== 'mcpServers') assert.deepEqual(parsed[key], before[key]);
  assert.deepEqual(parsed.mcpServers.other, before.mcpServers.other);
  assert.ok(after.startsWith(original.slice(0, original.indexOf('"mcpServers"'))), 'Text before mcpServers is byte-for-byte unchanged.');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o644, 'File mode is preserved.');

  const second = await installJson(file, 'agent-commons-claude-desktop', entry);
  assert.equal(second.status, 'unchanged');
  assert.equal(await readFile(file, 'utf8'), after);
  assert.equal((await readdir(dir)).filter(n => n.includes('backup')).length, 1, 'No extra backup on a no-op.');

  const moved = await installJson(file, 'agent-commons-claude-desktop', { ...entry, args: [...entry.args.slice(0, -1), 'http://127.0.0.1:4318'] });
  assert.equal(moved.status, 'updated');
});

test('JSON install refuses to touch a file it cannot parse, and creates a missing one', async t => {
  const dir = await tempDataDir(t, 'commons-json-bad-');
  const file = join(dir, 'broken.json');
  await writeFile(file, '{ "trailing": true, }');
  await assert.rejects(installJson(file, 'k', entry), /not valid JSON/);
  assert.equal(await readFile(file, 'utf8'), '{ "trailing": true, }');
  const fresh = join(dir, 'nested', 'mcp.json');
  const created = await installJson(fresh, 'k', entry);
  assert.equal(created.status, 'added');
  assert.equal(created.backup, null);
  assert.deepEqual(JSON.parse(await readFile(fresh, 'utf8')), { mcpServers: { k: entry } });
});

test('Codex TOML install appends, replaces in place, and leaves other tables alone', async t => {
  const dir = await tempDataDir(t, 'commons-toml-');
  const file = join(dir, 'config.toml');
  const original = 'model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\nargs = []\n';
  await writeFile(file, original);
  assert.equal((await installToml(file, 'agent-commons-codex', entry)).status, 'added');
  let text = await readFile(file, 'utf8');
  assert.ok(text.startsWith(original));
  assert.ok(text.includes(tomlBlock('agent-commons-codex', entry)));
  assert.equal((await installToml(file, 'agent-commons-codex', entry)).status, 'unchanged');
  await writeFile(file, text + '\n[profiles.fast]\nmodel = "mini"\n');
  const changed = { ...entry, command: '/opt/node/bin/node' };
  assert.equal((await installToml(file, 'agent-commons-codex', changed)).status, 'updated');
  text = await readFile(file, 'utf8');
  assert.equal(text.match(/\[mcp_servers\."agent-commons-codex"\]/g).length, 1);
  assert.ok(text.includes('command = "/opt/node/bin/node"'));
  assert.ok(text.includes('[mcp_servers.github]\ncommand = "gh-mcp"'));
  assert.ok(text.includes('[profiles.fast]\nmodel = "mini"'));
});

test('clients are detected from their config folders', async t => {
  const home = await tempDataDir(t, 'commons-home-');
  await mkdir(join(home, '.config', 'Claude'), { recursive: true });
  await mkdir(join(home, '.codex'));
  const found = await detectClients({ home, platform: 'linux', env: { PATH: '' } });
  assert.deepEqual(found, ['claude-desktop', 'codex']);
  assert.equal(clientTargets({ home, platform: 'darwin', env: {} })['claude-desktop'].file, join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
});

test('the restart check names an app that started before the config changed', async t => {
  const dir = await tempDataDir(t, 'commons-restart-');
  const file = join(dir, 'claude_desktop_config.json');
  await writeFile(file, '{}');
  const ps = 'Sun Nov  1 00:10:00 2026 /usr/lib/claude-desktop/claude-desktop\n'
    + 'Sun Nov  1 00:12:00 2026 /usr/lib/claude-desktop/claude-desktop --type=renderer\n'
    + 'Sun Nov  1 00:05:00 2026 node /home/m/.npm/bin/claude --resume\n';
  const runner = async () => ({ stdout: ps });
  const started = await appStartTime('claude-desktop', { platform: 'linux', runner });
  assert.equal(started.getTime(), Date.parse('Sun Nov  1 00:10:00 2026'), 'The main process counts; helpers and Claude Code do not.');
  await utimes(file, new Date(), new Date('2026-11-01T12:00:00'));
  const stale = await restartAdvice('claude-desktop', file, { platform: 'linux', runner });
  assert.equal(stale.needed, true);
  assert.match(stale.message, /has been running since .*before this change\. Quit Claude Desktop from its tray icon menu \(closing the window is not enough\)/);
  await utimes(file, new Date(), new Date('2026-10-31T12:00:00'));
  assert.equal((await restartAdvice('claude-desktop', file, { platform: 'linux', runner })).needed, false);
  assert.equal((await restartAdvice('claude-desktop', file, { platform: 'linux', runner: async () => ({ stdout: '' }) })).needed, false);
  assert.match((await restartAdvice('codex', file, { platform: 'linux' })).message, /new Codex session/);
});

test('a bridge with only a name sets up its own identity on first use and reuses it after', async t => {
  const dataDir = await tempDataDir(t, 'commons-provision-');
  const app = await seededServer({ dataDir });
  t.after(() => app.close());
  const options = parseOptions(['--name', 'Claude Desktop', '--data-dir', dataDir, '--url', app.url, '--no-autostart'], {});
  assert.equal(options.provision, true);
  const first = new CommonsClient(options);
  const rooms = await first.callTool('commons_list_rooms');
  assert.equal(rooms.me.name, 'Claude Desktop');
  assert.equal(rooms.me.id, 'claude-desktop');
  const created = app.credentials.agents.find(a => a.id === 'claude-desktop');
  assert.equal(created.kind, 'claude');
  assert.equal(created.roomIds, undefined, 'A self-provisioned identity may use every room.');
  const again = new CommonsClient(parseOptions(['--name', 'claude desktop', '--data-dir', dataDir, '--url', app.url, '--no-autostart'], {}));
  assert.equal((await again.callTool('commons_list_rooms')).me.id, 'claude-desktop', 'Same name, same identity.');
  assert.equal(app.credentials.agents.filter(a => a.name.toLowerCase() === 'claude desktop').length, 1);

  const unnamed = new CommonsClient(parseOptions(['--data-dir', dataDir, '--url', app.url, '--no-autostart'], {}));
  unnamed.clientName = friendlyClientName({ name: 'codex-mcp-client' });
  assert.equal((await unnamed.callTool('commons_list_rooms')).me.id, 'codex', 'The seeded Codex identity is reused by name.');

  const opened = await first.callTool('commons_open_room', { roomId: 'project', messageId: 1 });
  assert.equal(opened.url, `${app.url}/#room=project&message=1`);
  assert.ok(!JSON.stringify(opened).includes(app.credentials.ownerToken));
  assert.doesNotMatch(JSON.stringify(opened), /signin/);
});

test('client names map to friendly identities', () => {
  assert.equal(friendlyClientName({ name: 'claude-ai' }), 'Claude Desktop');
  assert.equal(friendlyClientName({ name: 'claude-code' }), 'Claude Code');
  assert.equal(friendlyClientName({ name: 'cursor-vscode' }), 'Cursor');
  assert.equal(friendlyClientName({ name: 'my_custom-agent' }), 'My Custom Agent');
  assert.equal(friendlyClientName(undefined), 'Agent');
  assert.throws(() => parseOptions(['--credential-file', '/x.json'], {}), /--agent ID/);
});

test('runs from the npx cache are copied into the workspace so configs keep working', async t => {
  const dataDir = await tempDataDir(t, 'commons-runtime-');
  const runtime = await stableRuntime(dataDir, { env: { AGENT_COMMONS_STABLE_RUNTIME: '1' } });
  assert.equal(runtime.dir, join(dataDir, 'runtime'));
  assert.ok((await stat(runtime.mcp)).isFile());
  assert.ok((await stat(join(runtime.dir, 'public', 'app.js'))).isFile());
  const same = await stableRuntime(dataDir, { env: { AGENT_COMMONS_STABLE_RUNTIME: '1' } });
  assert.equal(same.mcp, runtime.mcp);
});

async function freePort() {
  return new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

test('setup connects every detected app in one command', { timeout: 30000, skip: process.platform === 'win32' && 'process lookup differs on Windows' }, async t => {
  const home = await tempDataDir(t, 'commons-setup-home-');
  const dataDir = join(home, 'workspace');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // Claude Desktop keeps its config in a different place on each OS; ask the installer where.
  const claudeConfig = clientTargets({ home, platform: process.platform, env: { XDG_CONFIG_HOME: join(home, '.config') } })['claude-desktop'].file;
  await mkdir(dirname(claudeConfig), { recursive: true });
  await writeFile(claudeConfig, JSON.stringify({ preferences: { keep: true } }, null, 2) + '\n');
  await mkdir(join(home, '.codex'));
  t.after(async () => {
    const { stdout } = await run('ps', ['-eo', 'pid,args']).catch(() => ({ stdout: '' }));
    for (const line of stdout.split('\n')) if (line.includes('agent-commons.mjs serve') && line.includes(dataDir)) { try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGTERM'); } catch {} }
    for (let i = 0; i < 40 && await health(url); i++) await delay(100);
  });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex'), PATH: dirname(process.execPath), AGENT_COMMONS_NO_BROWSER: '1' };
  const { stdout } = await run(process.execPath, [binPath, 'setup', '--yes', '--no-open', '--client', 'claude-desktop,codex', '--data-dir', dataDir, '--port', String(port)], { env });
  assert.match(stdout, /Found: Claude Desktop, Codex/);
  assert.match(stdout, /\+ Claude Desktop: added agent-commons-claude-desktop in/);
  assert.match(stdout, /\+ Codex: added agent-commons-codex in/);
  const claude = JSON.parse(await readFile(claudeConfig, 'utf8'));
  assert.deepEqual(claude.preferences, { keep: true });
  const server = claude.mcpServers['agent-commons-claude-desktop'];
  assert.equal(server.args[server.args.indexOf('--agent') + 1], 'claude-desktop');
  assert.ok(!JSON.stringify(claude).includes(JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8')).ownerToken));
  assert.match(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\."agent-commons-codex"\]/);

  const again = await run(process.execPath, [binPath, 'setup', '--yes', '--no-open', '--client', 'claude-desktop,codex', '--data-dir', dataDir, '--port', String(port)], { env });
  assert.match(again.stdout, /= Claude Desktop: already set up/);
  assert.match(again.stdout, /= Codex: already set up/);

  const report = await run(process.execPath, [binPath, 'doctor', '--data-dir', dataDir, '--port', String(port)], { env }).catch(error => error);
  assert.match(report.stdout, /✓ Service: running/);
  // A real Claude Desktop running on the test machine makes this a restart warning instead; both are correct.
  assert.match(report.stdout, /(✓ Claude Desktop \(agent-commons-claude-desktop\): configured in|! Claude Desktop \(agent-commons-claude-desktop\): Claude Desktop has been running since)/);
  assert.doesNotMatch(report.stdout, /✗/);
  assert.match(report.stdout, /✓ Codex \(agent-commons-codex\): configured in/);
});

test('the web UI can set up a client for the owner, and agents cannot', { skip: process.platform === 'win32' && 'HOME redirection differs on Windows' }, async t => {
  const home = await tempDataDir(t, 'commons-ui-install-');
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, '.config');
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const app = await seededServer({ dataDir: join(home, 'workspace') });
  t.after(() => app.close());
  const post = (token, body) => fetch(`${app.url}/api/install`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  const denied = await post(app.credentials.agents[0].token, { agentId: 'claude', client: 'cursor' });
  assert.equal(denied.status, 403);
  const done = await post(app.credentials.ownerToken, { agentId: 'claude', client: 'cursor' });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'added');
  const config = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(config.mcpServers['agent-commons-claude'].args.includes('--credential-file'), true);
  assert.equal((await post(app.credentials.ownerToken, { agentId: 'claude', client: 'cursor' })).body.status, 'unchanged');
  assert.equal((await post(app.credentials.ownerToken, { agentId: 'claude', client: 'nope' })).status, 400);
});

test('TOML install keeps comments, line endings and final newline, and refuses inline entries', async t => {
  const dir = await tempDataDir(t, 'commons-toml-edges-');
  const file = join(dir, 'config.toml');
  await writeFile(file, '[mcp_servers."agent-commons-codex"]\r\ncommand = "old"\r\nargs = []\r\n\r\n# Fast profile, keep this comment\r\n[profiles.fast]\r\nmodel = "mini"\r\n');
  assert.equal((await installToml(file, 'agent-commons-codex', entry)).status, 'updated');
  const text = await readFile(file, 'utf8');
  assert.ok(text.includes('\r\n\r\n# Fast profile, keep this comment\r\n[profiles.fast]'), 'The comment above the next table survives.');
  assert.ok(!/[^\r]\n/.test(text), 'Line endings stay CRLF.');
  assert.ok(text.endsWith('\r\n'));
  assert.equal((await installToml(file, 'agent-commons-codex', entry)).status, 'unchanged');

  const atEnd = join(dir, 'end.toml');
  await writeFile(atEnd, 'model = "x"\n[mcp_servers."agent-commons-codex"]\ncommand = "old"\nargs = []');
  await installToml(atEnd, 'agent-commons-codex', entry);
  assert.match(await readFile(atEnd, 'utf8'), /command = "\/usr\/bin\/node"\nargs = \[.*\]$/);

  const sub = join(dir, 'sub.toml');
  await writeFile(sub, '[mcp_servers."agent-commons-codex"]\ncommand = "old"\nargs = []\n\n[mcp_servers."agent-commons-codex".env]\nX = "1"\n');
  await installToml(sub, 'agent-commons-codex', entry);
  assert.match(await readFile(sub, 'utf8'), /\[mcp_servers\."agent-commons-codex"\.env\]\nX = "1"\n$/, 'A sub-table of our entry is kept.');

  for (const inline of ['[mcp_servers]\n"agent-commons-codex" = { command = "x" }\n', 'mcp_servers.agent-commons-codex = { command = "x" }\n']) {
    const f = join(dir, `inline-${inline.length}.toml`);
    await writeFile(f, inline);
    await assert.rejects(installToml(f, 'agent-commons-codex', entry), /form this tool does not edit/);
    assert.equal(await readFile(f, 'utf8'), inline);
  }
});

test('setup will not edit settings unattended without --yes, and skips Claude Desktop when the extension is installed', { timeout: 30000, skip: process.platform === 'win32' && 'process lookup differs on Windows' }, async t => {
  const home = await tempDataDir(t, 'commons-unattended-');
  const config = join(home, '.config', 'Claude', 'claude_desktop_config.json');
  await mkdir(join(home, '.config', 'Claude', 'Claude Extensions', 'local.mcpb.matthew-valdez.agent-commons'), { recursive: true });
  await writeFile(config, '{}\n');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: dirname(process.execPath), AGENT_COMMONS_NO_BROWSER: '1' };
  const refused = await run(process.execPath, [binPath, 'setup', '--client', 'claude-desktop', '--data-dir', join(home, 'ws'), '--port', '1'], { env }).catch(error => error);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /add --yes/);
  assert.equal(await readFile(config, 'utf8'), '{}\n', 'Nothing was edited.');
  const { installClient } = await import('../src/install.mjs');
  const viaExtension = await installClient('claude-desktop', 'agent-commons-x', entry, { home, platform: 'linux', env: {} });
  assert.equal(viaExtension.status, 'unchanged');
  assert.equal(viaExtension.extension, true);
  assert.equal(await readFile(config, 'utf8'), '{}\n', 'No duplicate entry next to the extension.');
});

test('on Windows the claude command line is quoted as one string for cmd.exe', async () => {
  const { runClaude } = await import('../src/install.mjs');
  let seen;
  await runClaude('C:\\Users\\John Smith\\AppData\\Roaming\\npm\\claude.cmd', ['mcp', 'add', 'k', '--', 'C:\\Program Files\\nodejs\\node.exe', '100%'], { platform: 'win32', env: {}, runner: async (...args) => { seen = args; return { stdout: '' }; } });
  assert.equal(seen[0], 'cmd.exe');
  assert.deepEqual(seen[1].slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(seen[1][3], '""C:\\Users\\John Smith\\AppData\\Roaming\\npm\\claude.cmd" "mcp" "add" "k" "--" "C:\\Program Files\\nodejs\\node.exe" "100"^%"""');
  assert.equal(seen[2].windowsVerbatimArguments, true);
});
