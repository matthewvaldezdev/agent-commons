// The failure this project exists to prevent: an agent calls a tool, nothing is listening, and the agent gives up.
// The bridge must start the service itself and complete the call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { binPath } from '../src/paths.mjs';
import { health } from '../src/launcher.mjs';
import { tempDataDir } from './helpers.mjs';

const run = promisify(execFile);
const cli = (args, env = {}) => run(process.execPath, [binPath, ...args], { env: { ...process.env, AGENT_COMMONS_AUTOSTART: '1', ...env } });

async function freePort() {
  return new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

function bridge(args) {
  const child = spawn(process.execPath, [binPath, 'mcp', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_COMMONS_AUTOSTART: '1' } });
  const pending = new Map(); let buffer = ''; let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', c => { stderr += c; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue; const f = JSON.parse(line); pending.get(f.id)?.(f); pending.delete(f.id); }
  });
  let id = 0;
  const request = (method, params) => new Promise(resolve => { const rid = ++id; pending.set(rid, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n'); });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const exited = new Promise(r => child.once('exit', r));
  return { request, notify, close: () => { if (!child.stdin.destroyed) child.stdin.end(); return exited; }, get stderr() { return stderr; } };
}

async function stopServiceAt(url, dataDir) {
  // No shutdown route exists on purpose; find the detached child by its data dir and signal it.
  const { stdout } = await run('ps', ['-eo', 'pid,args']).catch(() => ({ stdout: '' }));
  for (const line of stdout.split('\n')) if (line.includes('agent-commons.mjs serve') && line.includes(dataDir)) { try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGTERM'); } catch {} }
  for (let i = 0; i < 40 && await health(url); i++) await delay(100);
}

test('a tool call with the service down starts it, succeeds, and the service outlives the bridge', { timeout: 30000, skip: process.platform === 'win32' && 'process lookup differs on Windows' }, async (t) => {
  const dataDir = await tempDataDir(t, 'commons-autostart-');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  t.after(() => stopServiceAt(url, dataDir));
  // `connect` with nothing running still creates the identity (in-process) and prints a config.
  const { stdout } = await cli(['connect', 'Test Agent', '--client', 'claude-desktop', '--json', '--port', String(port), '--data-dir', dataDir]);
  const info = JSON.parse(stdout);
  assert.equal(info.agent.id, 'test-agent');
  assert.equal(await health(url), null, 'connect must not leave a server running');

  const b = bridge(['--agent', info.agent.id, '--credential-file', info.credentialFile, '--url', url]);
  t.after(() => b.close());
  const init = await b.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'agent-commons');
  b.notify('notifications/initialized');
  const rooms = await b.request('tools/call', { name: 'commons_list_rooms', arguments: {} });
  assert.equal(rooms.result.isError, false, rooms.result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(rooms.result.content[0].text).rooms.map(r => r.id), ['general']);
  const sent = await b.request('tools/call', { name: 'commons_send_message', arguments: { roomId: 'general', body: 'started on demand', clientMessageId: 'auto-1' } });
  assert.equal(sent.result.isError, false, sent.result.content?.[0]?.text);
  assert.match(b.stderr, /Starting Agent Commons/);
  await b.close();
  await delay(300);
  assert.ok(await health(url), 'the service must keep running after the bridge exits');

  // The same service is reused by a second bridge and by the CLI.
  const status = await cli(['status', '--port', String(port), '--data-dir', dataDir]);
  assert.match(status.stdout, /running/);
  assert.match(status.stdout, /Test Agent/);
  const credentials = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8'));
  assert.equal(credentials.agents.length, 1);
});

test('autostart can be disabled, and the error then tells the operator what to run', { timeout: 15000 }, async (t) => {
  const dataDir = await tempDataDir(t, 'commons-noauto-');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const { stdout } = await cli(['connect', 'Quiet Agent', '--json', '--port', String(port), '--data-dir', dataDir]);
  const info = JSON.parse(stdout);
  const b = bridge(['--agent', info.agent.id, '--credential-file', info.credentialFile, '--url', url, '--no-autostart']);
  t.after(() => b.close());
  await b.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  b.notify('notifications/initialized');
  const rooms = await b.request('tools/call', { name: 'commons_list_rooms', arguments: {} });
  assert.equal(rooms.result.isError, true);
  assert.match(rooms.result.content[0].text, /agent-commons serve/);
  assert.equal(await health(url), null);
});

test('the CLI refuses to attach to a port owned by a different workspace', { timeout: 15000 }, async (t) => {
  const { startServer } = await import('../src/server.mjs');
  const other = await startServer({ port: 0, dataDir: await tempDataDir(t, 'commons-other-') });
  t.after(() => other.close());
  const port = new URL(other.url).port;
  const dataDir = await tempDataDir(t, 'commons-mine-');
  const { stdout } = await cli(['connect', 'Mine', '--json', '--port', port, '--data-dir', dataDir]).catch(e => e);
  // connect talks to the running server as owner; a foreign server rejects our owner token.
  assert.ok(!stdout || !stdout.includes('"agent"'), 'must not create an identity in a foreign workspace');
});
