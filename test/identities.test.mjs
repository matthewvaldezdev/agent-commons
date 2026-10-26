import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { seededServer } from './helpers.mjs';
import { parseOptions, CommonsClient } from '../src/mcp.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commons-identities-'));
  let app = await seededServer({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const original = await readFile(join(dataDir, 'credentials.json'), 'utf8');
  const owner = app.credentials.ownerToken;
  async function api(path, body, token = owner, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(app.url + path, { method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) });
    return { status: response.status, value: await response.json() };
  }
  async function ok(path, body, token, method) {
    const result = await api(path, body, token, method);
    assert.ok(result.status >= 200 && result.status < 300, result.value.error || 'Request should succeed.');
    return result.value;
  }
  async function create(name, kind, roomIds) {
    const result = await ok('/api/agents', { name, kind, ...(roomIds === undefined ? {} : { roomIds }) });
    const connect = await ok(`/api/connect?agent=${result.agent.id}`);
    const connection = JSON.parse(await readFile(connect.credentialFile, 'utf8'));
    return { ...result.agent, token: connection.token, connect };
  }
  return { dataDir, original, owner, api, ok, create, get app() { return app; },
    async restart() { await app.close(); app = await seededServer({ dataDir }); } };
}

test('named identities isolate rooms, reads, writes, metadata and owner controls', async (t) => {
  const f = await fixture(t);
  const noRooms = await f.create('Research helper', 'chatgpt');
  const a = await f.create('Design reviewer', 'claude', ['general']);
  const b = await f.create('Code reviewer', 'claude', ['handoffs']);
  const peer = await f.create('Local helper', 'other', ['general']);
  const state = await f.ok('/api/state', undefined, a.token);
  assert.deepEqual(state.rooms.map(r => r.id), ['general']);
  assert.ok(state.agents.some(agent => agent.id === peer.id));
  assert.ok(!state.agents.some(agent => agent.id === b.id || agent.id === noRooms.id));
  assert.ok(state.agents.every(agent => !Object.hasOwn(agent, 'roomIds') && !Object.hasOwn(agent, 'token')));
  assert.deepEqual((await f.ok('/api/state', undefined, noRooms.token)).rooms, []);
  for (const roomId of ['project', 'does-not-exist']) {
    assert.equal((await f.api(`/api/messages?room=${roomId}`, undefined, a.token)).status, 404);
    assert.equal((await f.api('/api/messages', { roomId, body: 'Denied message' }, a.token)).status, 404);
    assert.equal((await f.api('/api/read', { roomId, cursor: 0 }, a.token)).status, 404);
  }
  for (const [path, body, method] of [
    ['/api/agents', { name: 'Unauthorized helper', kind: 'other', roomIds: [] }, 'POST'],
    [`/api/agents/${a.id}`, { roomIds: ['project'] }, 'PATCH'],
    [`/api/connect?agent=${a.id}`, undefined, 'GET'],
    ['/api/export?room=general', undefined, 'GET'],
    ['/api/events', undefined, 'GET'],
  ]) assert.equal((await f.api(path, body, a.token, method)).status, 403);
  const sent = await f.ok('/api/messages', { roomId: 'general', body: 'A bounded review', clientMessageId: 'same-id' }, a.token);
  const second = await f.ok('/api/messages', { roomId: 'general', body: 'A separate review', clientMessageId: 'same-id' }, peer.token);
  assert.equal(sent.message.senderName, a.name);
  assert.equal(sent.message.senderKind, 'claude');
  assert.notEqual(sent.message.id, second.message.id);
  await f.ok('/api/read', { roomId: 'general', cursor: second.message.id }, a.token);
  const cursor = token => f.ok('/api/state', undefined, token).then(s => s.rooms[0].readCursor);
  assert.equal(await cursor(a.token), second.message.id);
  assert.equal(await cursor(peer.token), 0);
  const room = (await f.ok('/api/rooms', { name: 'Future private project' })).room;
  assert.equal((await f.api(`/api/messages?room=${room.id}`, undefined, a.token)).status, 404);
  assert.equal((await f.ok('/api/state', undefined, f.app.credentials.agents.find(x => x.id === 'claude').token)).rooms.length, 4);
});

test('owner setup contains only one identity reference and grants/names survive reopening without token changes', async (t) => {
  const f = await fixture(t);
  await f.restart();
  assert.equal(await readFile(join(f.dataDir, 'credentials.json'), 'utf8'), f.original, 'Opening old data must not rewrite its credentials.');
  const before = JSON.parse(f.original);
  const a = await f.create('Assistant with spaces', 'codex', ['general']);
  const credentials = JSON.parse(await readFile(join(f.dataDir, 'credentials.json'), 'utf8'));
  const serialized = JSON.stringify(a.connect);
  for (const token of [credentials.ownerToken, ...credentials.agents.map(agent => agent.token)]) assert.ok(!serialized.includes(token));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(a.connect.credentialFile, 'utf8'))).sort(), ['agentId', 'dataDir', 'token', 'version']);
  assert.ok(a.connect.mcpConfig.args.includes('--credential-file'));
  assert.ok(!a.connect.mcpConfig.args.includes('--data-dir'));
  if (process.platform !== 'win32') assert.equal((await stat(a.connect.credentialFile)).mode & 0o777, 0o600);
  const client = new CommonsClient(parseOptions(a.connect.mcpConfig.args.slice(1), {}));
  assert.equal((await client.callTool('commons_list_rooms')).me.id, a.id);
  const message = await f.ok('/api/messages', { roomId: 'general', body: 'Preserve this handoff' });
  await client.callTool('commons_mark_read', { roomId: 'general', cursor: message.message.id });
  await f.ok(`/api/agents/${a.id}`, { name: 'Renamed reviewer', roomIds: ['general', 'handoffs'] }, undefined, 'PATCH');
  await f.restart();
  const after = JSON.parse(await readFile(join(f.dataDir, 'credentials.json'), 'utf8'));
  assert.equal(after.ownerToken, before.ownerToken);
  for (const old of before.agents) assert.deepEqual(after.agents.find(x => x.id === old.id), old);
  assert.equal(after.agents.find(x => x.id === a.id).token, a.token);
  const state = await f.ok('/api/state', undefined, a.token);
  assert.equal(state.me.name, 'Renamed reviewer');
  assert.deepEqual(state.rooms.map(r => r.id), ['general', 'handoffs']);
  assert.equal(state.rooms.find(r => r.id === 'general').readCursor, message.message.id);
  assert.equal((await f.ok('/api/messages?room=general', undefined, a.token)).messages[0].body, 'Preserve this handoff');
  // Any identity can move between all-room and selected-room access, in both directions.
  assert.equal((await f.ok('/api/agents/claude', { roomIds: [] }, undefined, 'PATCH')).agent.access, 'selected');
  assert.equal((await f.ok('/api/state', undefined, f.app.credentials.agents.find(x => x.id === 'claude').token)).rooms.length, 0);
  assert.equal((await f.ok('/api/agents/claude', { roomIds: null }, undefined, 'PATCH')).agent.access, 'all');
  const everyRoom = (await f.ok('/api/state')).rooms.length;
  assert.equal((await f.ok('/api/state', undefined, f.app.credentials.agents.find(x => x.id === 'claude').token)).rooms.length, everyRoom);
  // Revoking an identity removes its credential and connection file.
  assert.equal((await f.api(`/api/agents/${a.id}`, undefined, undefined, 'DELETE')).status, 200);
  assert.equal((await f.api('/api/state', undefined, a.token)).status, 401);
  await assert.rejects(stat(a.connect.credentialFile));
});

test('removing room access terminates pending reads and cannot leak a later message', async (t) => {
  const f = await fixture(t);
  const a = await f.create('Temporary reviewer', 'other', ['general']);
  const waiting = f.api('/api/messages?room=general&after=0&wait=2', undefined, a.token);
  await delay(50);
  await f.ok(`/api/agents/${a.id}`, { roomIds: [] }, undefined, 'PATCH');
  await f.ok('/api/messages', { roomId: 'general', body: 'Private after revocation' });
  const result = await waiting;
  assert.equal(result.status, 404);
  assert.ok(!JSON.stringify(result.value).includes('Private after revocation'));
  assert.deepEqual((await f.ok('/api/state', undefined, a.token)).rooms, []);
});

test('agent creation validates explicit grants and concurrent owners preserve all credentials', async (t) => {
  const f = await fixture(t);
  for (const body of [
    { name: '', kind: 'other' }, { name: 'Bad kind', kind: 'human' },
    { name: 'Unknown room', kind: 'chatgpt', roomIds: ['absent'] },
    { name: 'Wildcard room', kind: 'chatgpt', roomIds: ['*'] },
    { name: 'Wrong grant type', kind: 'other', roomIds: 'general' },
    { name: 'Spoof token', kind: 'other', roomIds: [], token: 'injected' },
  ]) assert.equal((await f.api('/api/agents', body)).status, 400);
  const created = await Promise.all(Array.from({ length: 8 }, (_, n) => f.create(`Parallel helper ${n}`, 'other', [])));
  assert.equal((await f.api('/api/agents', { name: 'parallel HELPER 0', kind: 'claude', roomIds: [] })).status, 409);
  assert.equal((await f.api(`/api/agents/${created[1].id}`, { name: created[0].name }, undefined, 'PATCH')).status, 409);
  assert.equal(new Set(created.map(a => a.id)).size, 8);
  const credentials = JSON.parse(await readFile(join(f.dataDir, 'credentials.json'), 'utf8'));
  assert.equal(credentials.agents.length, 10);
  assert.equal(new Set(credentials.agents.map(a => a.token)).size, 10);
  await f.restart();
  assert.equal((await f.ok('/api/state')).agents.length, 10);
});

test('credential updates preserve extension fields and historical sender names', async (t) => {
  const f = await fixture(t);
  await f.app.close();
  const path = join(f.dataDir, 'credentials.json');
  const old = JSON.parse(await readFile(path, 'utf8'));
  old.extension = { preserved: 'owner metadata' };
  old.agents[0].extension = { preserved: 'legacy metadata' };
  await writeFile(path, JSON.stringify(old));
  // startServer.close is idempotent, so the fixture may reopen a closed instance.
  await f.restart();
  await f.ok('/api/messages', { roomId: 'general', body: 'Historical attribution' }, old.agents[0].token);
  await f.ok('/api/agents/claude', { name: 'Claude primary' }, undefined, 'PATCH');
  await f.create('Extension-safe helper', 'other', []);
  const current = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(current.extension, old.extension);
  assert.deepEqual(current.agents[0].extension, old.agents[0].extension);
  assert.equal(current.agents[0].token, old.agents[0].token);
  assert.equal((await f.ok('/api/messages?room=general')).messages[0].senderName, 'Claude');
});

test('portable bridge options reject remote URLs, mixed stores and mismatched connection files', async (t) => {
  const f = await fixture(t);
  const a = await f.create('A local chat agent', 'chatgpt', []);
  assert.equal(parseOptions([], { AGENT_COMMONS_AGENT_ID: a.id, AGENT_COMMONS_CREDENTIAL_FILE: a.connect.credentialFile }).agent, a.id);
  for (const url of ['https://127.0.0.1:4317', 'http://example.com', 'http://127.0.0.1:4317/?token=x']) {
    assert.throws(() => parseOptions(['--agent', a.id, '--url', url], {}));
  }
  assert.throws(() => parseOptions(['--agent', 'you'], {}));
  assert.throws(() => parseOptions(['--agent', a.id, '--data-dir', f.dataDir, '--credential-file', a.connect.credentialFile], {}));
  const client = new CommonsClient(parseOptions(['--agent', 'codex', '--credential-file', a.connect.credentialFile], {}));
  await assert.rejects(() => client.agentToken(), /belong to this agent/);
  const badFile = join(f.dataDir, 'invalid.json');
  await writeFile(badFile, JSON.stringify({ ...JSON.parse(await readFile(a.connect.credentialFile, 'utf8')), ownerToken: f.owner }));
  await assert.rejects(() => new CommonsClient({ agent: a.id, credentialFile: badFile }).agentToken(), /only its own credential/);
});
