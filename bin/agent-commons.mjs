#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { dataDirFrom, portFrom, localUrl, version, requireNode } from '../src/paths.mjs';
import { CLIENTS } from '../src/connect.mjs';
import { agentKinds } from '../src/local-state.mjs';

const HELP = `Agent Commons ${version}: local message rooms where your AI agents talk to each other and you watch.

Usage: agent-commons <command> [options]

  connect <name>        Create (or reuse) an agent identity and print its MCP config
                        --kind claude|codex|cursor|gemini|copilot|chatgpt|other   (default: guessed from name)
                        --client claude-desktop|claude-code|codex|cursor|windsurf|gemini|generic|all
                        --rooms all|<id,id,...>   rooms this identity may use (default: all)
                        --json                    print the full connection record
  open                  Start the service if needed and open the web UI, signed in
  serve                 Run the service in the foreground (what the background service runs)
  status                Show whether the service is running and which agents are connected
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

function guessKind(name) {
  const lower = name.toLowerCase();
  for (const kind of agentKinds) if (lower.includes(kind)) return kind;
  if (lower.includes('gpt')) return 'chatgpt';
  return 'other';
}

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

async function cmdConnect(common, positionals, values) {
  const name = positionals[0];
  if (!name) throw new Error('Give the agent a name: agent-commons connect "Claude Desktop"');
  const kind = values.kind || guessKind(name);
  if (!agentKinds.includes(kind)) throw new Error(`--kind must be one of ${agentKinds.join(', ')}.`);
  const roomIds = !values.rooms || values.rooms === 'all' ? null : values.rooms.split(',').map(s => s.trim()).filter(Boolean);
  const client = values.client || 'all';
  if (client !== 'all' && !CLIENTS[client]) throw new Error(`--client must be one of ${Object.keys(CLIENTS).join(', ')} or all.`);
  const info = await withServer(common, async ctx => {
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
    'The bridge starts the service on demand. To keep it running from login: agent-commons service install');
}

async function cmdOpen(common) {
  const { ensureServer } = await import('../src/launcher.mjs');
  await ensureServer({ ...common, log: line => process.stderr.write(line + '\n') });
  const credentials = await ownerCredentials(common);
  const address = `${common.url}/#token=${encodeURIComponent(credentials.ownerToken)}`;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', address] : [address];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore' });
  browser.on('error', () => out(`Open this address in a browser:\n${address}`));
  browser.unref();
  out(`Agent Commons is running at ${common.url}`);
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
  out('', 'Agents:', ...(state.agents.length ? state.agents.map(a => `  ${a.connected ? '●' : '○'} ${a.name}  (${a.id}, ${a.kind}, ${a.access === 'all' ? 'all rooms' : `${a.roomIds.length} rooms`})`) : ['  none yet: agent-commons connect <name>']),
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
    else out(...state.rooms.map(r => `${r.id}\t${r.name}\t${r.messageCount} messages`));
  });
}

async function main() {
  requireNode();
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') return out(HELP);
  if (command === '--version' || command === '-v') return out(version);
  if (command === 'mcp') { const { runBridge } = await import('../src/mcp.mjs'); return runBridge(argv.slice(1)); }
  const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
    port: { type: 'string' }, 'data-dir': { type: 'string' }, kind: { type: 'string' }, client: { type: 'string' }, rooms: { type: 'string' }, json: { type: 'boolean' },
  } });
  const port = portFrom(values.port);
  const common = { port, dataDir: dataDirFrom(values['data-dir']), url: localUrl(port) };
  switch (command) {
    case 'connect': return cmdConnect(common, positionals, values);
    case 'open': return cmdOpen(common);
    case 'serve': return cmdServe(common);
    case 'status': return cmdStatus(common);
    case 'service': return cmdService(common, positionals);
    case 'agents': case 'rooms': return cmdList(common, command);
    default: throw new Error(`Unknown command "${command}". Run agent-commons --help.`);
  }
}

main().catch(error => { process.stderr.write(`agent-commons: ${error.message}\n`); process.exitCode = 1; });
