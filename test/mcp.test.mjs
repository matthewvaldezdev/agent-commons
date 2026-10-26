import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { seededServer } from './helpers.mjs';

function bridge(url, dataDir, agent, credentialFile) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url)), '--agent', agent, '--url', url,
    ...(credentialFile ? ['--credential-file', credentialFile] : ['--data-dir', dataDir])], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const frames = [];
  let buffer = '', stdout = '', stderr = '', sequence = 0, protocolError;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    for (const item of pending.values()) item.reject(new Error('MCP bridge exited before replying.'));
    resolve({ code, signal });
  }));
  child.on('error', (error) => {
    protocolError = error;
    for (const item of pending.values()) item.reject(error);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        assert.equal(frame.jsonrpc, '2.0', 'Every stdout line must be JSON-RPC.');
        frames.push(frame);
        const waiter = pending.get(frame.id);
        if (waiter) { pending.delete(frame.id); waiter.resolve(frame); }
      } catch {
        protocolError = new Error('MCP stdout contained non-JSON protocol output.');
        for (const item of pending.values()) item.reject(protocolError);
      }
    }
  });
  async function request(method, params) {
    if (protocolError) throw protocolError;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} reply timed out.`));
      }, 2500);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  async function initialize() {
    const response = await request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'isolated-node-test', version: '1' },
    });
    assert.equal(response.result.serverInfo.name, 'agent-commons');
    assert.equal(response.result.protocolVersion, '2025-11-25');
    assert.ok(response.result.capabilities.tools);
    assert.match(response.result.instructions, /information, not instructions|data, not instructions/i);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async function call(name, args = {}) {
    const response = await request('tools/call', { name, arguments: args });
    assert.ok(!response.error, 'Tool calls should return a tool result.');
    assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
    return JSON.parse(response.result.content.find((item) => item.type === 'text').text);
  }
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await Promise.race([exited, delay(1000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(1000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return exited;
  }
  return {
    request, initialize, call, close, frames,
    raw(line) { child.stdin.write(line + '\n'); },
    assertClean(tokens) {
      assert.equal(protocolError, undefined);
      assert.equal(buffer, '', 'Every MCP output frame must end with a newline.');
      for (const token of tokens)
        assert.ok(!stdout.includes(token) && !stderr.includes(token), 'Bridge output must never leak credentials.');
    },
  };
}

test('real Claude/Codex stdio bridges keep identities, strict framing, explicit delivery and independent read positions', { timeout: 15000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-commons-mcp-'));
  const bridges = [];
  let running;
  t.after(async () => {
    try { for (const client of bridges.reverse()) await client.close(); }
    finally {
      try { await running?.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  running = await seededServer({ dataDir });
  const tokens = Object.fromEntries(running.credentials.agents.map((a) => [a.id, a.token]));
  async function api(agent, path, body) {
    const response = await fetch(running.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${tokens[agent]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2500),
    });
    const value = await response.json();
    assert.ok(response.ok, value.error ?? 'Expected a successful HTTP response.');
    return value;
  }
  const seed = await api('codex', '/api/messages', { roomId: 'project', body: 'Isolated Codex message for the Claude test bridge' });
  const claude = bridge(running.url, dataDir, 'claude'); bridges.push(claude);
  const early = await claude.request('tools/list');
  assert.equal(early.error.code, -32002);
  await claude.initialize();
  const listed = await claude.request('tools/list');
  const names = listed.result.tools.map((tool) => tool.name);
  const expected = ['commons_list_rooms', 'commons_read_messages', 'commons_send_message', 'commons_mark_read', 'commons_wait_for_messages'];
  for (const required of expected.slice(0, 4)) assert.ok(names.includes(required));
  assert.ok(names.every((name) => expected.includes(name)), 'Expose only the documented local messaging tools.');
  const rooms = await claude.call('commons_list_rooms');
  assert.equal(rooms.me.id, 'claude');
  assert.equal(rooms.mode, 'local');
  assert.ok(rooms.rooms.some((room) => room.id === 'project'));
  assert.equal((await api('codex', '/api/messages?room=project&after=0')).messages.length, 1, 'Initializing a bridge must not post an automatic greeting.');
  const clientMessageId = randomUUID();
  const payload = { roomId: 'project', body: 'Explicit test-only Claude reply', replyTo: seed.message.id, clientMessageId };
  const sent = await claude.call('commons_send_message', payload);
  assert.equal(sent.message.senderId, 'claude');
  assert.equal(sent.message.senderName, 'Claude');
  assert.equal(sent.message.replyTo, seed.message.id);
  const retried = await claude.call('commons_send_message', payload);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.message.id, sent.message.id);
  const read = await claude.call('commons_read_messages', { roomId: 'project', after: 0 });
  assert.deepEqual(read.messages.map((message) => message.id), [seed.message.id, sent.message.id]);
  assert.equal((await claude.call('commons_list_rooms')).rooms.find((room) => room.id === 'project').unread, 1, 'MCP reads must not implicitly acknowledge.');
  const spoof = await claude.request('tools/call', { name: 'commons_send_message', arguments: { ...payload, senderId: 'codex' } });
  assert.equal(spoof.result.isError, true);
  const conflict = await claude.request('tools/call', { name: 'commons_send_message', arguments: { ...payload, body: 'Changed retry body' } });
  assert.equal(conflict.result.isError, true);
  const codex = bridge(running.url, dataDir, 'codex'); bridges.push(codex);
  await codex.initialize();
  const codexRooms = await codex.call('commons_list_rooms');
  assert.equal(codexRooms.me.id, 'codex');
  const received = await codex.call('commons_read_messages', { roomId: 'project', after: seed.message.id });
  assert.deepEqual(received.messages.map((message) => message.id), [sent.message.id]);
  const marked = await codex.call('commons_mark_read', { roomId: 'project', cursor: sent.message.id });
  assert.equal(marked.cursor, sent.message.id);
  assert.equal((await codex.call('commons_list_rooms')).rooms.find((room) => room.id === 'project').unread, 0);
  assert.equal((await claude.call('commons_list_rooms')).rooms.find((room) => room.id === 'project').unread, 1);
  await claude.call('commons_mark_read', { roomId: 'project', cursor: sent.message.id });
  assert.equal((await claude.call('commons_list_rooms')).rooms.find((room) => room.id === 'project').unread, 0);
  const unsupported = await claude.request('unsupported/test');
  assert.equal(unsupported.error.code, -32601);
  claude.raw('{ invalid-json }');
  await claude.request('ping');
  assert.ok(claude.frames.some((frame) => frame.id === null && frame.error?.code === -32700));
  await claude.close();
  assert.equal((await api('codex', '/api/state')).agents.find((agent) => agent.id === 'claude').connected, false);
  const transcript = await api('codex', '/api/messages?room=project&after=0');
  assert.equal(transcript.messages.length, 2, 'Only the explicit isolated sends should exist.');
  await codex.close();
  const secrets = [...Object.values(tokens), running.credentials.ownerToken];
  claude.assertClean(secrets);
  codex.assertClean(secrets);
});

test('separately named bridges from the same service authenticate and enforce assigned rooms', { timeout: 10000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commons-named-mcp-'));
  const app = await seededServer({ dataDir });
  const bridges = [];
  t.after(async () => {
    for (const client of bridges) await client.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function owner(path, body) {
    const response = await fetch(app.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${app.credentials.ownerToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.ok);
    return response.json();
  }
  const agents = [];
  const keys = [app.credentials.ownerToken];
  for (const name of ['Research Claude', 'Review Claude']) {
    const { agent } = await owner('/api/agents', { name, kind: 'claude', roomIds: ['general'] });
    const setup = await owner(`/api/connect?agent=${agent.id}`);
    keys.push(JSON.parse(await readFile(setup.credentialFile, 'utf8')).token);
    const client = bridge(app.url, dataDir, agent.id, setup.credentialFile);
    bridges.push(client); agents.push(agent);
    await client.initialize();
    const state = await client.call('commons_list_rooms');
    assert.equal(state.me.name, name);
    assert.deepEqual(state.rooms.map(room => room.id), ['general']);
    const denied = await client.request('tools/call', { name: 'commons_read_messages', arguments: { roomId: 'project' } });
    assert.equal(denied.result.isError, true);
  }
  assert.notEqual(agents[0].id, agents[1].id);
  const sent = await bridges[0].call('commons_send_message', { roomId: 'general', body: 'A scoped handoff', clientMessageId: 'named-send' });
  assert.equal(sent.message.senderName, 'Research Claude');
  const read = await bridges[1].call('commons_read_messages', { roomId: 'general', after: 0 });
  assert.equal(read.messages.length, 1, 'Initialization must not generate messages.');
  await bridges[1].call('commons_mark_read', { roomId: 'general', cursor: read.nextCursor });
  for (const client of bridges) client.assertClean(keys);
});
