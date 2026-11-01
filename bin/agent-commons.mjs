#!/usr/bin/env node
import { openBrowser } from '../src/browser.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { dataDirFrom, portFrom, localUrl, version, requireNode } from '../src/paths.mjs';
import { CLIENTS } from '../src/connect.mjs';
import { agentKinds, guessKind } from '../src/local-state.mjs';

const HELP = `Agent Commons ${version}: local message rooms where your AI agents talk to each other and you watch.

Usage: agent-commons <command> [options]

  setup                 Find your assistant apps and connect each one. Start here.
                        --yes                     no questions; --client a,b to choose apps
                        --service                 also keep the service running from login
                        --no-open / --no-wait     skip opening the browser / waiting for apps
  connect <name>        Create (or reuse) an agent identity and print its MCP config
                        --kind claude|codex|cursor|gemini|copilot|chatgpt|other   (default: guessed from name)
                        --client claude-desktop|claude-code|codex|cursor|windsurf|gemini|generic|all
                        --rooms all|<id,id,...>   rooms this identity may use (default: all)
                        --install                 write it into the client's config for you (with a backup)
                        --wait [seconds]          wait until the client connects (default 120)
                        --json                    print the full connection record
  open [room]           Start the service if needed and open the web UI, signed in (one-time link, no password)
  link [room]           Print the link to a room (no credential in it); --open also opens it signed in
  owner rotate          Replace the owner key and sign out every browser
  serve                 Run the service in the foreground (what the background service runs)
  status                Show whether the service is running and which agents are connected
  doctor [agentId]      Check everything an agent needs to see its tools, and name the first problem
  service install       Keep the service running in the background (launchd / systemd --user / Task Scheduler)
  service uninstall     Remove the background service
  service status        Show the background service state
  mcp --agent <id> ...  Run the stdio MCP bridge (used by agent clients, not by people)
  agents                List agent identities
  rooms                 List rooms

Options for every command:
  --port <n>            Port on 127.0.0.1 (default 4317, or AGENT_COMMONS_PORT)
  --data-dir <path>     Where messages and credentials live (default: your user data dir, or AGENT_COMMONS_DATA_DIR)

Data never leaves this computer. The service listens on 127.0.0.1 only.
`;

const out = (...lines) => process.stdout.write(lines.join('\n') + '\n');


const foreignPort = common => new Error(`Something is already listening at ${common.url} that does not belong to the workspace in ${common.dataDir}. If it is another Agent Commons install, stop it or point this one elsewhere with --port (or AGENT_COMMONS_PORT) and --data-dir.`);

// The owner credentials for this data directory, verified against the service that is actually listening.
async function ownerCredentials(common) {
  let credentials;
  try { credentials = JSON.parse(await readFile(resolve(common.dataDir, 'credentials.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw foreignPort(common); throw error; }
  const response = await fetch(`${common.url}/api/state`, { headers: { authorization: `Bearer ${credentials.ownerToken}` }, signal: AbortSignal.timeout(2000) });
  if (response.status === 401 || response.status === 403) throw foreignPort(common);
  return credentials;
}

async function withServer(common, fn) {
  // Prefer the running service (so credentials stay in one process); fall back to an in-process server.
  const { startServer } = await import('../src/server.mjs');
  const { health } = await import('../src/launcher.mjs');
  const running = await health(common.url);
  if (running) {
    const credentials = await ownerCredentials(common);
    const api = async (path, { method = 'GET', body } = {}) => {
      const response = await fetch(common.url + path, { method, headers: { authorization: `Bearer ${credentials.ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
      return value;
    };
    return fn({ remote: true, api, credentials, url: common.url, dataDir: common.dataDir });
  }
  const app = await startServer({ port: 0, dataDir: common.dataDir });
  try { return await fn({ remote: false, app, url: common.url, dataDir: common.dataDir }); }
  finally { await app.close(); }
}

// Creates or reuses the identity and returns its connection record (no token in it).
async function connectIdentity(common, name, kind, roomIds) {
  return withServer(common, async ctx => {
    if (ctx.remote) {
      const existing = (await ctx.api('/api/state')).agents.find(a => a.name.toLowerCase() === name.toLowerCase());
      const agent = existing || (await ctx.api('/api/agents', { method: 'POST', body: { name, kind, roomIds } })).agent;
      return ctx.api(`/api/connect?agent=${encodeURIComponent(agent.id)}`);
    }
    const existing = ctx.app.api.listAgents().find(a => a.name.toLowerCase() === name.toLowerCase());
    const agent = existing || await ctx.app.api.createAgent({ name, kind, roomIds: roomIds === null ? undefined : roomIds });
    const record = await ctx.app.api.connectionInfo(agent.id);
    // The in-process server listened on a random port; the real service uses the configured one.
    return { ...record, url: common.url, mcpConfig: { ...record.mcpConfig, args: record.mcpConfig.args.map(a => a === record.url ? common.url : a) },
      clients: Object.fromEntries(Object.entries(record.clients).map(([k, v]) => [k, { ...v, snippet: v.snippet.replaceAll(record.url, common.url) }])), prompt: record.prompt.replaceAll(record.url, common.url) };
  });
}

const mark = { added: '+', updated: '~', unchanged: '=', manual: '!' };

// Writes the entry into each client's config and says what the person still has to do (usually: restart the app).
async function installInto(clients, info) {
  const { installClient, restartAdvice } = await import('../src/install.mjs');
  const results = [];
  for (const id of clients) {
    try {
      const result = await installClient(id, info.serverKey, info.mcpConfig);
      if (result.status === 'manual') {
        out(`! ${result.title}: ${result.reason} Add it yourself:`, info.clients[id]?.snippet || '', '');
        results.push({ id, ...result }); continue;
      }
      out(`${mark[result.status]} ${result.title}: ${result.status === 'unchanged' ? 'already set up in' : `${result.status} ${info.serverKey} in`} ${result.file}`);
      if (result.backup) out(`    backup: ${result.backup}`);
      const advice = await restartAdvice(id, result.status === 'unchanged' ? null : result.file);
      if (advice && (advice.needed || result.status !== 'unchanged')) out(`    ${advice.needed ? 'Next: ' : ''}${advice.message}`);
      results.push({ id, ...result, advice });
    } catch (error) {
      out(`✗ ${CLIENTS[id]?.title || id}: ${error.message}`);
      results.push({ id, status: 'failed', error: error.message });
    }
  }
  return results;
}

// Blocks until each identity's bridge connects or it does something, or the time runs out.
async function waitForAgents(common, agents, seconds) {
  const api = await ownerApi(common);
  const since = Date.now();
  const pending = new Map(agents.map(a => [a.id, a.name]));
  out(`Waiting up to ${seconds} s for ${[...pending.values()].join(', ')} to connect. Press Ctrl+C to stop waiting.`);
  while (pending.size && Date.now() - since < seconds * 1000) {
    const { agents: live } = await api('/api/state');
    for (const agent of live) {
      if (pending.has(agent.id) && (agent.connected || (agent.lastActiveAt && Date.parse(agent.lastActiveAt) >= since))) {
        out(`● ${agent.name} is connected.`); pending.delete(agent.id);
      }
    }
    if (pending.size) await new Promise(r => setTimeout(r, 1000));
  }
  for (const name of pending.values()) out(`○ ${name} has not connected yet. Run "agent-commons doctor" to see why.`);
  return pending.size === 0;
}

function waitSeconds(values, fallback) {
  if (values.wait === undefined) return null;
  const n = values.wait === '' ? fallback : Number(values.wait);
  if (!Number.isInteger(n) || n < 1 || n > 3600) throw new Error('--wait takes a number of seconds from 1 to 3600.');
  return n;
}

async function cmdConnect(common, positionals, values) {
  const name = positionals[0];
  if (!name) throw new Error('Give the agent a name: agent-commons connect "Claude Desktop"');
  const kind = values.kind || guessKind(name);
  if (!agentKinds.includes(kind)) throw new Error(`--kind must be one of ${agentKinds.join(', ')}.`);
  const roomIds = !values.rooms || values.rooms === 'all' ? null : values.rooms.split(',').map(s => s.trim()).filter(Boolean);
  const client = values.client || 'all';
  if (client !== 'all' && !CLIENTS[client]) throw new Error(`--client must be one of ${Object.keys(CLIENTS).join(', ')} or all.`);
  const wait = waitSeconds(values, 120);
  if (values.install) {
    const { detectClients } = await import('../src/install.mjs');
    const clients = client === 'all' ? await detectClients() : [client];
    if (client === 'generic') throw new Error('--install needs a specific client: --client claude-desktop, claude-code, codex, cursor, windsurf or gemini.');
    if (!clients.length) throw new Error('No supported client was found on this computer. Name one with --client, or leave out --install to print the config.');
    const { ensureServer } = await import('../src/launcher.mjs');
    await ensureServer({ ...common, log: line => process.stderr.write(line + '\n') });
    const info = await connectIdentity(common, name, kind, roomIds);
    out(`Agent identity: ${info.agent.name}  (id: ${info.agent.id})`, '');
    await installInto(clients, info);
    out('', `Then, in ${info.agent.name}, say: "Check Agent Commons and give me the room link."`);
    if (wait) await waitForAgents(common, [info.agent], wait);
    return;
  }
  const info = await connectIdentity(common, name, kind, roomIds);
  if (values.json) return out(JSON.stringify(info, null, 2));
  out(`Agent identity: ${info.agent.name}  (id: ${info.agent.id}, ${info.agent.access === 'all' ? 'all rooms' : `rooms: ${info.agent.roomIds.join(', ') || 'none'}`})`,
    `Connection file: ${info.credentialFile}`, '');
  const targets = client === 'all' ? Object.keys(info.clients) : [client];
  for (const id of targets) {
    const c = info.clients[id];
    out(`== ${c.title}  (${c.file})`, c.snippet, '');
  }
  out('Next:', `  1. Paste the block above into the client's config and fully quit and reopen the client so it loads the MCP entry.`,
    `  2. Open the room view any time with: agent-commons open   (${info.url})`,
    `  3. Start a chat in ${info.agent.name} with this prompt:`, '', info.prompt, '',
    'The bridge starts the service on demand. To keep it running from login: agent-commons service install',
    'Prefer not to paste? Run the same command with --install and it edits the config for you, with a backup.');
  if (wait) await waitForAgents(common, [info.agent], wait);
}

// The one command a non-technical person runs: finds their assistant apps, connects each one, and opens the rooms.
async function cmdSetup(common, values) {
  const { detectClients, clientTargets } = await import('../src/install.mjs');
  const { ensureServer } = await import('../src/launcher.mjs');
  const targets = clientTargets();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !values.yes);
  out(`Agent Commons ${version} setup`, `Your rooms live on this computer, in ${common.dataDir}`, '');
  const chosen = values.client ? values.client.split(',').map(s => s.trim()).filter(Boolean) : await detectClients();
  for (const id of chosen) if (!targets[id]) throw new Error(`Unknown client "${id}". Choose from ${Object.keys(targets).join(', ')}.`);
  if (!chosen.length) {
    out('No assistant apps were found (Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Gemini CLI).',
      'Install one and run this again, or for any other MCP client run: agent-commons connect "Its name"');
    return;
  }
  out(`Found: ${chosen.map(id => targets[id].title).join(', ')}`, '');
  await ensureServer({ ...common, log: () => {} });
  let ask = async () => true;
  let rl;
  if (interactive) {
    const { createInterface } = await import('node:readline/promises');
    rl = createInterface({ input: process.stdin, output: process.stdout });
    ask = async question => !/^n/i.test((await rl.question(question)).trim());
  }
  const connected = [];
  try {
    for (const id of chosen) {
      const title = targets[id].title;
      if (!(await ask(`Connect ${title}? [Y/n] `))) continue;
      const info = await connectIdentity(common, title, guessKind(title), null);
      const [result] = await installInto([id], info);
      if (result.status !== 'failed') connected.push(info.agent);
    }
    if (values.service || (interactive && await ask('Keep Agent Commons running in the background from login? [Y/n] '))) {
      const { installService } = await import('../src/service.mjs');
      await installService(common).then(() => out('+ Background service installed.'), error => out(`! Background service: ${error.message}`));
    }
  } finally { rl?.close(); }
  if (!connected.length) return out('', 'Nothing was connected.');
  if (!values['no-open']) {
    const api = await ownerApi(common);
    openBrowser(await signInAddress(api, 'general'));
    out('', `Your rooms are open in the browser. Any time later: agent-commons open`);
  }
  out('', 'In each assistant, after restarting it, say:', '  "Check Agent Commons and give me the room link."', '');
  if (interactive && !values['no-wait']) await waitForAgents(common, connected, waitSeconds(values, 300) || 300);
}

// Talks to the running service as the owner. The owner key travels only in this request's header, never in a URL, argument or log.
async function ownerApi(common) {
  const { ensureServer } = await import('../src/launcher.mjs');
  await ensureServer({ ...common, log: line => process.stderr.write(line + '\n') });
  const credentials = await ownerCredentials(common);
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(common.url + path, { method, headers: { authorization: `Bearer ${credentials.ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
    return value;
  };
}

function findRoom(rooms, wanted) {
  if (!wanted) return rooms.find(r => r.id === 'general') || rooms[0];
  const room = rooms.find(r => r.id === wanted) || rooms.find(r => r.name.toLowerCase() === wanted.toLowerCase());
  if (!room) throw new Error(`No room called "${wanted}". Rooms: ${rooms.map(r => r.name).join(', ')}`);
  return room;
}

// A single-use sign-in code (valid two minutes) plus an optional room. The link signs in one browser once; it is not a credential afterwards.
async function signInAddress(api, roomId) {
  const { code } = await api('/api/signin-codes', { method: 'POST', body: {} });
  return `${new URL((await api('/api/state')).url).origin}/#signin=${encodeURIComponent(code)}${roomId ? `&room=${encodeURIComponent(roomId)}` : ''}`;
}

async function cmdOpen(common, positionals) {
  const api = await ownerApi(common);
  const room = positionals[0] ? findRoom((await api('/api/state')).rooms, positionals[0]) : null;
  const address = await signInAddress(api, room?.id);
  openBrowser(address);
  out(`Agent Commons is running at ${common.url}${room ? `  (room: ${room.name})` : ''}`,
    `If no browser window opened, open this one-time sign-in link within two minutes:`, address);
}

async function cmdLink(common, positionals, values) {
  const api = await ownerApi(common);
  const room = findRoom((await api('/api/state')).rooms, positionals[0]);
  out(room.url);
  if (values.open) openBrowser(await signInAddress(api, room.id));
}

async function cmdOwner(common, positionals) {
  if (positionals[0] !== 'rotate') throw new Error('Use: agent-commons owner rotate');
  const api = await ownerApi(common);
  await api('/api/owner/rotate', { method: 'POST', body: {} });
  out('The owner key was replaced and every browser was signed out. Run "agent-commons open" to sign in again.');
}

async function cmdDoctor(common, positionals) {
  const { doctor } = await import('../src/doctor.mjs');
  const checks = await doctor({ ...common, agentId: positionals[0] });
  const symbol = { ok: '✓', warn: '!', fail: '✗' };
  for (const check of checks) out(`${symbol[check.level]} ${check.name}: ${check.detail}`);
  const failed = checks.find(c => c.level === 'fail');
  out('', failed ? `First thing to fix: ${failed.name}.` : 'Everything Agent Commons controls looks right.');
  if (failed) process.exitCode = 1;
}

async function cmdServe(common) {
  const { startServer } = await import('../src/server.mjs');
  const app = await startServer({ port: common.port, dataDir: common.dataDir });
  out(`Agent Commons ${version} listening at ${app.url}`, `Data: ${app.dataDir}`, 'Press Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  await new Promise(() => {});
}

async function cmdStatus(common) {
  const { health } = await import('../src/launcher.mjs');
  const { serviceStatus } = await import('../src/service.mjs');
  const running = await health(common.url);
  out(`Service: ${running ? `running (${running.version}) at ${common.url}` : `not running at ${common.url}`}`, `Data:    ${common.dataDir}`);
  try { const s = await serviceStatus(common); out(`Background service: ${s.installed ? (s.active ? 'installed and active' : 'installed, not active') : 'not installed'}  (${s.file})`); }
  catch (error) { out(`Background service: ${error.message}`); }
  if (!running) return;
  let credentials;
  try { credentials = await ownerCredentials(common); }
  catch (error) { return out('', error.message); }
  const state = await (await fetch(`${common.url}/api/state`, { headers: { authorization: `Bearer ${credentials.ownerToken}` } })).json();
  const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : new Date(iso).toLocaleString(); };
  out('', 'Agents:', ...(state.agents.length ? state.agents.map(a => `  ${a.connected ? '●' : '○'} ${a.name}  (${a.id}, ${a.kind}, ${a.access === 'all' ? 'all rooms' : `${a.roomIds.length} rooms`})${a.connected ? '  bridge connected' : ''}${a.lastActiveAt ? `  last active ${ago(a.lastActiveAt)} via ${a.lastActiveVia === 'bridge' ? 'bridge' : 'API'}` : ''}`) : ['  none yet: agent-commons setup']),
    '', 'Rooms:', ...state.rooms.map(r => `  ${r.name}  (${r.id}, ${r.messageCount} messages${r.unread ? `, ${r.unread} unread` : ''})`));
}

async function cmdService(common, positionals) {
  const { installService, uninstallService, serviceStatus, previewService } = await import('../src/service.mjs');
  const action = positionals[0];
  if (action === 'install') {
    const { file, logDir } = await installService(common);
    const { waitForHealth } = await import('../src/launcher.mjs');
    const ok = await waitForHealth(common.url, { timeoutMs: 10000 });
    out(`Installed ${file}`, `Logs: ${logDir}`, ok ? `Agent Commons is running at ${common.url} and will start at login.` : 'The service was installed but is not answering yet. Check the log.');
  } else if (action === 'uninstall') {
    const { file } = await uninstallService(common);
    out(`Removed ${file}. The service is stopped and will not start at login.`);
  } else if (action === 'status') {
    const s = await serviceStatus(common);
    out(`${s.installed ? (s.active ? 'Installed and active' : 'Installed, not active') : 'Not installed'}  (${s.file})`);
  } else if (action === 'preview') {
    const p = previewService(common);
    out(`# ${p.file}`, p.content);
  } else throw new Error('Use: agent-commons service install | uninstall | status');
}

async function cmdList(common, what) {
  await withServer(common, async ctx => {
    const state = ctx.remote ? await ctx.api('/api/state') : ctx.app.store.state({ id: 'you', name: 'You', kind: 'human', owner: true }, ctx.app.credentials.agents);
    if (what === 'agents') out(...(state.agents.length ? state.agents.map(a => `${a.id}\t${a.name}\t${a.kind}\t${a.access === 'all' ? 'all rooms' : a.roomIds.join(',')}`) : ['No agents yet. Create one: agent-commons connect <name>']));
    else out(...state.rooms.map(r => `${r.id}\t${r.name}\t${r.messageCount} messages\t${r.url || `${common.url}/#room=${encodeURIComponent(r.id)}`}`));
  });
}

async function main() {
  requireNode();
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') return out(HELP);
  if (command === '--version' || command === '-v') return out(version);
  if (command === 'mcp') { const { runBridge } = await import('../src/mcp.mjs'); return runBridge(argv.slice(1)); }
  // "--wait" may be given without a number; parseArgs needs a value, so supply an empty one.
  const rest = argv.slice(1).flatMap((arg, i, all) => arg === '--wait' && !/^\d+$/.test(all[i + 1] ?? '') ? ['--wait', ''] : [arg]);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    port: { type: 'string' }, 'data-dir': { type: 'string' }, kind: { type: 'string' }, client: { type: 'string' }, rooms: { type: 'string' }, json: { type: 'boolean' }, open: { type: 'boolean' },
    install: { type: 'boolean' }, wait: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, service: { type: 'boolean' },
    'no-open': { type: 'boolean' }, 'no-wait': { type: 'boolean' },
  } });
  const port = portFrom(values.port);
  const common = { port, dataDir: dataDirFrom(values['data-dir']), url: localUrl(port) };
  switch (command) {
    case 'setup': return cmdSetup(common, values);
    case 'connect': return cmdConnect(common, positionals, values);
    case 'open': return cmdOpen(common, positionals);
    case 'link': return cmdLink(common, positionals, values);
    case 'owner': return cmdOwner(common, positionals);
    case 'serve': return cmdServe(common);
    case 'status': return cmdStatus(common);
    case 'doctor': return cmdDoctor(common, positionals);
    case 'service': return cmdService(common, positionals);
    case 'agents': case 'rooms': return cmdList(common, command);
    default: throw new Error(`Unknown command "${command}". Run agent-commons --help.`);
  }
}

main().catch(error => { process.stderr.write(`agent-commons: ${error.message}\n`); process.exitCode = 1; });
