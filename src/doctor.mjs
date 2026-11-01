// One pass over everything that has to be true for an agent to see the commons_* tools.
// Each check is { level: 'ok' | 'warn' | 'fail', name, detail }. The first 'fail' is the thing to fix.
import { readFile, stat, readdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve, basename } from 'node:path';
import { health, sameWorkspace } from './launcher.mjs';
import { MIN_NODE, version } from './paths.mjs';
import { clientTargets, restartAdvice, findOnPath } from './install.mjs';

const run = promisify(execFile);
const exists = path => access(path).then(() => true, () => false);
const newEnough = v => { const [a, b] = String(v).replace(/^v/, '').split('.').map(Number); return a > MIN_NODE[0] || (a === MIN_NODE[0] && b >= MIN_NODE[1]); };
const privateMode = async path => process.platform === 'win32' || ((await stat(path)).mode & 0o077) === 0;

// Agent Commons entries in one client's config: [{ key, command, args }].
async function configEntries(target) {
  if (target.format === 'cli') return null;
  let text;
  try { text = await readFile(target.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (target.format === 'json') {
    const servers = JSON.parse(text || '{}').mcpServers || {};
    return Object.entries(servers).filter(([key, e]) => key.startsWith('agent-commons') || JSON.stringify(e).includes('agent-commons')).map(([key, e]) => ({ key, command: e.command, args: e.args || [] }));
  }
  const entries = [];
  for (const block of text.split(/^(?=\s*\[)/m)) {
    const key = block.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([^\]\s]+))\]/)?.slice(1).find(Boolean);
    if (!key || !(key.startsWith('agent-commons') || block.includes('agent-commons'))) continue;
    const command = block.match(/^\s*command\s*=\s*(".*")\s*$/m)?.[1];
    const args = block.match(/^\s*args\s*=\s*(\[.*\])\s*$/m)?.[1];
    entries.push({ key, command: command && JSON.parse(command), args: args ? JSON.parse(args) : [] });
  }
  return entries;
}

const argAfter = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

export async function doctor({ dataDir, url, agentId, home = homedir(), env = process.env, platform = process.platform } = {}) {
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });

  add(newEnough(process.versions.node) ? 'ok' : 'fail', 'Node.js', `${process.versions.node} at ${process.execPath}${newEnough(process.versions.node) ? '' : ` (needs ${MIN_NODE.join('.')} or newer)`}`);

  let credentials = null;
  const credentialPath = resolve(dataDir, 'credentials.json');
  try {
    credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
    add(await privateMode(credentialPath) ? 'ok' : 'fail', 'Workspace', `${dataDir}${await privateMode(credentialPath) ? '' : ' (credentials.json is readable by other users; run chmod 600 on it)'}`);
  } catch (error) {
    add(error.code === 'ENOENT' ? 'warn' : 'fail', 'Workspace', error.code === 'ENOENT' ? `nothing at ${dataDir} yet; run "agent-commons setup"` : `credentials.json could not be read: ${error.message}`);
  }

  const running = await health(url);
  let state = null;
  if (!running) add('warn', 'Service', `not running at ${url}. That is fine: it starts when an agent uses it. "agent-commons open" starts it now.`);
  else if (!credentials || !(await sameWorkspace(url, dataDir))) add('fail', 'Service', `${url} is answered by a different Agent Commons workspace. Stop it, or use another port everywhere with AGENT_COMMONS_PORT.`);
  else {
    add(running.version === version ? 'ok' : 'warn', 'Service', `running ${running.version} at ${url}${running.version === version ? '' : ` (this command is ${version}; restart the service to update it)`}`);
    const response = await fetch(`${url}/api/state`, { headers: { authorization: `Bearer ${credentials.ownerToken}` } });
    if (response.ok) state = await response.json();
  }

  const identities = (credentials?.agents || []).filter(a => !agentId || a.id === agentId);
  if (agentId && !identities.length) add('fail', `Identity ${agentId}`, 'does not exist. "agent-commons agents" lists identities.');
  for (const agent of identities) {
    const file = resolve(dataDir, 'connections', `${agent.id}.json`);
    let problem = null;
    try {
      const connection = JSON.parse(await readFile(file, 'utf8'));
      if (connection.agentId !== agent.id || connection.token !== agent.token) problem = 'its connection file does not match; run "agent-commons connect" for it again';
      else if (!(await privateMode(file))) problem = `its connection file is readable by other users (${file})`;
    } catch { problem = `its connection file is missing (${file}); run "agent-commons connect" for it again`; }
    const live = state?.agents.find(a => a.id === agent.id);
    const seen = live ? (live.connected ? 'bridge connected now' : live.lastActiveAt ? `last active ${new Date(live.lastActiveAt).toLocaleString()} via ${live.lastActiveVia}` : live.lastSeen ? `bridge last seen ${new Date(live.lastSeen).toLocaleString()}` : 'never connected') : 'service not running';
    add(problem ? 'fail' : live && !live.connected && !live.lastActiveAt && !live.lastSeen ? 'warn' : 'ok', `Identity ${agent.name}`, problem || seen);
  }

  const targets = clientTargets({ home, env, platform });
  for (const [id, target] of Object.entries(targets)) {
    if (target.format === 'cli') {
      const claude = await findOnPath('claude', { platform, env });
      if (!claude) continue;
      const listed = await run(claude, ['mcp', 'list'], { env, timeout: 15000 }).then(r => r.stdout, () => '');
      const line = listed.split('\n').find(l => l.includes('agent-commons'));
      if (line) add(/✓|connected/i.test(line) ? 'ok' : 'warn', target.title, line.trim());
      continue;
    }
    let entries;
    try { entries = await configEntries(target); }
    catch (error) { add('fail', target.title, `${target.file} could not be parsed: ${error.message}`); continue; }
    if (!entries.length) continue;
    for (const entry of entries) {
      const label = `${target.title} (${entry.key})`;
      const script = entry.args.find(a => /mcp\.mjs$|agent-commons\.mjs$/.test(a));
      const credentialFile = argAfter(entry.args, '--credential-file');
      const entryAgent = argAfter(entry.args, '--agent');
      if (entry.command && /[\\/]/.test(entry.command) && !(await exists(entry.command))) { add('fail', label, `the Node path in ${target.file} no longer exists: ${entry.command}. Run "agent-commons setup" again.`); continue; }
      if (entry.command && /node(\.exe)?$/i.test(basename(entry.command))) {
        const v = await run(entry.command, ['--version'], { timeout: 10000 }).then(r => r.stdout.trim(), () => null);
        if (!v || !newEnough(v)) { add('fail', label, `${entry.command} is Node ${v || 'unknown'}; Agent Commons needs ${MIN_NODE.join('.')} or newer.`); continue; }
      }
      if (script && !(await exists(script))) { add('fail', label, `the bridge script is gone: ${script}. Run "agent-commons setup" again.`); continue; }
      if (credentialFile && !(await exists(credentialFile))) { add('fail', label, `the connection file is missing: ${credentialFile}. Run "agent-commons setup" again.`); continue; }
      if (entryAgent && credentials && !credentials.agents.some(a => a.id === entryAgent)) { add('fail', label, `points at identity "${entryAgent}", which no longer exists. Run "agent-commons setup" again.`); continue; }
      const advice = await restartAdvice(id, target.file, { platform, env, home });
      add(advice?.needed && !target.cli ? 'fail' : 'ok', label, advice?.needed && !target.cli ? advice.message : `configured in ${target.file}`);
    }
  }

  // Claude Desktop writes one log per MCP server; the last lines usually say exactly why a server did not load.
  const logDir = platform === 'darwin' ? resolve(home, 'Library', 'Logs', 'Claude') : resolve(targets['claude-desktop'].file, '..', 'logs');
  const logs = await readdir(logDir).catch(() => []);
  const relevant = logs.filter(name => /agent-commons/.test(name)).concat(logs.includes('main.log') ? ['main.log'] : []);
  for (const name of relevant.slice(0, 3)) {
    const lines = (await readFile(resolve(logDir, name), 'utf8').catch(() => '')).split('\n').filter(l => /agent-commons|stdio server|mcp/i.test(l)).slice(-4);
    if (lines.length) add(lines.some(l => /error|fail|no stdio servers/i.test(l)) ? 'warn' : 'ok', `Claude Desktop log ${name}`, lines.map(l => l.slice(0, 220)).join('\n      '));
  }
  return checks;
}
