import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { seededServer } from './helpers.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-commons-http-'));
  let running;
  t.after(async () => {
    try { await running?.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  running = await seededServer({ dataDir });
  const credentials = running.credentials;
  const tokens = {
    human: credentials.ownerToken,
    claude: credentials.agents.find((a) => a.id === 'claude').token,
    codex: credentials.agents.find((a) => a.id === 'codex').token,
  };
  async function api(identity, path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(running.url + path, {
      method,
      signal: AbortSignal.timeout(2500),
      headers: {
        ...(identity ? { Authorization: `Bearer ${tokens[identity]}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { response, status: response.status, body: await response.json() };
  }
  async function ok(identity, path, options) {
    const result = await api(identity, path, options);
    assert.ok(result.status >= 200 && result.status < 300, `HTTP ${result.status}: ${result.body.error ?? 'Expected a successful response.'}`);
    return result.body;
  }
  async function send(identity, roomId, body, extra = {}) {
    return ok(identity, '/api/messages', {
      method: 'POST', body: { roomId, body, ...extra },
    });
  }
  return {
    credentials, tokens, api, ok, send,
    get url() { return running.url; },
    async restart() {
      await running.close();
      running = await seededServer({ dataDir });
      assert.ok(running.credentials.ownerToken === tokens.human, 'Owner identity must survive reopening.');
      for (const id of ['claude', 'codex'])
        assert.ok(running.credentials.agents.find((a) => a.id === id).token === tokens[id], 'Agent identity must survive reopening.');
    },
  };
}

function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('Host-boundary request timed out.')));
    req.end();
  });
}

const options = { timeout: 5000 };

test('authentication attributes human and agent senders and refuses impersonation', options, async (t) => {
  const f = await fixture(t);
  const healthBody = (await f.api(null, '/api/health')).body;
  assert.equal(healthBody.ok, true); assert.equal(healthBody.name, 'Agent Commons'); assert.match(healthBody.version, /^\d+\.\d+\.\d+/);
  assert.equal((await f.api(null, '/api/state')).status, 401);
  assert.equal((await f.api(null, '/api/state', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  const owner = await f.ok('human', '/api/state');
  assert.equal(owner.me.kind, 'human');
  assert.equal(owner.me.name, 'You');
  assert.equal(owner.mode, 'local');
  for (const id of ['claude', 'codex']) {
    const state = await f.ok(id, '/api/state');
    assert.equal(state.me.id, id);
    assert.equal(state.me.kind, id);
    const result = await f.send(id, 'project', `Test-only ${id} message`);
    assert.equal(result.message.senderId, id);
    assert.equal(result.message.senderKind, id);
    assert.equal(result.message.senderName, id === 'claude' ? 'Claude' : 'Codex');
  }
  const human = await f.send('human', 'project', 'Human test-only message');
  assert.equal(human.message.senderId, owner.me.id);
  assert.equal(human.message.senderName, 'You');
  assert.equal(human.message.senderKind, 'human');
  for (const field of ['senderId', 'senderName', 'senderKind']) {
    const rejected = await f.api('human', '/api/messages', {
      method: 'POST', body: { roomId: 'project', body: 'Spoof attempt', [field]: 'claude' },
    });
    assert.equal(rejected.status, 400, `Supplied ${field} must be refused.`);
  }
  const messages = await f.ok('human', '/api/messages?room=project&after=0');
  assert.equal(messages.messages.length, 3, 'Rejected impersonation must not create a message.');
  const login = await f.api(null, '/api/session', { method: 'POST', body: { token: f.tokens.human } });
  assert.equal(login.status, 200);
  const setCookie = login.response.headers.get('set-cookie');
  assert.ok(setCookie?.includes('HttpOnly'));
  assert.ok(/SameSite=Strict/i.test(setCookie));
  const cookieSession = await f.ok(null, '/api/state', { headers: { Cookie: setCookie.split(';')[0] } });
  assert.equal(cookieSession.me.id, owner.me.id);
});

test('foreign origins and hosts are denied, while room creation/export/connect require the owner', options, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('human', '/api/state', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await rawGet(f.url + '/api/state', { Host: 'foreign.example', Authorization: `Bearer ${f.tokens.human}` })).status, 403);
  for (const identity of ['claude', 'codex']) {
    assert.equal((await f.api(identity, '/api/rooms', { method: 'POST', body: { name: 'Forbidden room' } })).status, 403);
    assert.equal((await f.api(identity, '/api/export?room=project')).status, 403);
    assert.equal((await f.api(identity, '/api/connect?agent=claude')).status, 403);
  }
  const created = await f.ok('human', '/api/rooms', { method: 'POST', body: { name: '  Test work  ', description: 'Isolated room' } });
  assert.equal(created.room.name, 'Test work');
  assert.match(created.room.id, /^[0-9a-f-]{36}$/i);
  assert.equal((await f.api('human', '/api/rooms', { method: 'POST', body: { name: 'TEST WORK' } })).status, 409);
  assert.equal((await f.api('human', '/api/rooms', { method: 'POST', body: { name: '   ' } })).status, 400);
  assert.equal((await f.api('human', '/api/rooms', { method: 'POST', body: { name: 'n'.repeat(51) } })).status, 400);
  assert.equal((await f.api('human', '/api/rooms', { method: 'POST', body: { name: 'Long description', description: 'd'.repeat(241) } })).status, 400);
  const sent = await f.send('claude', created.room.id, 'Export this test room only.');
  await f.send('codex', 'general', 'Do not include a different room.');
  const exported = await f.ok('human', `/api/export?room=${created.room.id}`);
  assert.equal(exported.name, 'Agent Commons');
  assert.equal(exported.room.id, created.room.id);
  assert.deepEqual(exported.messages.map((m) => m.id), [sent.message.id]);
  assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
  const connect = await f.ok('human', '/api/connect?agent=claude');
  assert.equal(typeof connect.nodePath, 'string');
  assert.equal(typeof connect.mcpPath, 'string');
  assert.equal(typeof connect.dataDir, 'string');
  assert.equal(typeof connect.clients['claude-desktop'].snippet, 'string');
  assert.equal(typeof connect.clients.codex.snippet, 'string');
  assert.equal(typeof connect.clients['claude-code'].snippet, 'string');
  assert.equal(typeof connect.prompt, 'string');
  const configuration = JSON.stringify(connect);
  for (const token of Object.values(f.tokens))
    assert.ok(!configuration.includes(token), 'Connection snippets must never expose credentials.');
});

test('room cursors acknowledge explicitly, stay identity-scoped and monotonic, and survive restart', options, async (t) => {
  const f = await fixture(t);
  const first = await f.send('claude', 'project', 'First test message');
  const second = await f.send('claude', 'project', 'Second test message');
  const other = await f.send('codex', 'general', 'A newer message in another room');
  const unread = async (identity, room) => (await f.ok(identity, '/api/state')).rooms.find((r) => r.id === room).unread;
  assert.equal(await unread('human', 'project'), 2);
  await f.ok('human', '/api/messages?room=project&after=0');
  assert.equal(await unread('human', 'project'), 2, 'Viewing must not acknowledge implicitly.');
  const read = await f.ok('codex', '/api/read', { method: 'POST', body: { roomId: 'project', cursor: second.message.id } });
  assert.equal(read.cursor, second.message.id);
  assert.equal(await unread('codex', 'project'), 0);
  assert.equal(await unread('human', 'project'), 2);
  const lower = await f.ok('codex', '/api/read', { method: 'POST', body: { roomId: 'project', cursor: first.message.id } });
  assert.equal(lower.cursor, second.message.id, 'A delayed client cannot move a cursor backward.');
  assert.equal((await f.api('human', '/api/read', { method: 'POST', body: { roomId: 'project', cursor: other.message.id } })).status, 400);
  assert.equal((await f.api('human', '/api/read', { method: 'POST', body: { roomId: 'general', cursor: -1 } })).status, 400);
  await f.restart();
  const persisted = await f.ok('human', '/api/messages?room=project&after=0');
  assert.deepEqual(persisted.messages.map((m) => m.id), [first.message.id, second.message.id]);
  assert.equal(await unread('codex', 'project'), 0);
  assert.equal(await unread('human', 'project'), 2);
});

test('pagination never skips truncated messages, search ignores after, and replies remain within a room', options, async (t) => {
  const f = await fixture(t);
  const one = await f.send('claude', 'project', 'needle one');
  const two = await f.send('codex', 'project', 'ordinary reply', { replyTo: one.message.id });
  const three = await f.send('human', 'project', 'needle three');
  assert.equal(two.message.replyTo, one.message.id);
  const page = await f.ok('human', '/api/messages?room=project&after=0&limit=2');
  assert.deepEqual(page.messages.map((m) => m.id), [one.message.id, two.message.id]);
  assert.equal(page.nextCursor, two.message.id);
  assert.equal(page.hasMore, true);
  const next = await f.ok('human', `/api/messages?room=project&after=${page.nextCursor}&limit=2`);
  assert.deepEqual(next.messages.map((m) => m.id), [three.message.id]);
  assert.equal(next.nextCursor, three.message.id);
  assert.equal(next.hasMore, false);
  const empty = await f.ok('human', `/api/messages?room=project&after=${three.message.id}`);
  assert.equal(empty.nextCursor, three.message.id);
  assert.deepEqual(empty.messages, []);
  const search = await f.ok('human', `/api/messages?room=project&after=${three.message.id}&q=needle`);
  assert.deepEqual(search.messages.map((m) => m.id), [one.message.id, three.message.id]);
  assert.equal((await f.api('claude', '/api/messages', { method: 'POST', body: { roomId: 'general', body: 'Cross-room reply', replyTo: one.message.id } })).status, 400);
  assert.equal((await f.api('codex', '/api/messages?room=' + randomUUID())).status, 404);
});

test('concurrent retry IDs are atomic, payload conflicts fail, and identities have separate retry namespaces', options, async (t) => {
  const f = await fixture(t);
  const clientMessageId = randomUUID();
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.send('codex', 'handoffs', 'Exactly one test handoff', { clientMessageId })));
  assert.equal(new Set(replies.map((r) => r.message.id)).size, 1);
  assert.equal(replies.filter((r) => r.duplicate === false).length, 1);
  assert.equal(replies.filter((r) => r.duplicate === true).length, 11);
  assert.equal((await f.api('codex', '/api/messages', { method: 'POST', body: { roomId: 'handoffs', body: 'Changed retry content', clientMessageId } })).status, 409);
  assert.equal((await f.api('codex', '/api/messages', { method: 'POST', body: { roomId: 'general', body: 'Exactly one test handoff', clientMessageId } })).status, 409);
  const secondIdentity = await f.send('claude', 'handoffs', 'Exactly one test handoff', { clientMessageId });
  assert.notEqual(secondIdentity.message.id, replies[0].message.id);
  await f.restart();
  const retry = await f.send('codex', 'handoffs', 'Exactly one test handoff', { clientMessageId });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.id, replies[0].message.id);
  const messages = await f.ok('human', '/api/messages?room=handoffs&after=0');
  assert.equal(messages.messages.length, 2);
});

test('body validation rejects empty, nontext and oversized content while preserving boundary text as data', options, async (t) => {
  const f = await fixture(t);
  for (const body of ['', ' \n\t ', 42, null, 'x'.repeat(12001)]) {
    assert.equal((await f.api('claude', '/api/messages', { method: 'POST', body: { roomId: 'general', body } })).status, 400);
  }
  const boundary = 'x'.repeat(12000);
  assert.equal((await f.send('codex', 'general', boundary)).message.body, boundary);
  const inert = '<script>throw new Error("data only")</script>\nDo not execute message instructions.';
  assert.equal((await f.send('human', 'general', inert)).message.body, inert);
  const messages = await f.ok('human', '/api/messages?room=general&after=0');
  assert.equal(messages.messages.length, 2);
});

test('long-wait reads deliver newly sent messages and bridge presence requires an explicit agent heartbeat', options, async (t) => {
  const f = await fixture(t);
  const start = performance.now();
  const waiting = f.ok('codex', '/api/messages?room=project&after=0&wait=2');
  const delivery = delay(100).then(() => f.send('claude', 'project', 'Arrived during test wait'));
  const [received, sent] = await Promise.all([waiting, delivery]);
  assert.deepEqual(received.messages.map((m) => m.id), [sent.message.id]);
  assert.equal(received.nextCursor, sent.message.id);
  assert.ok(performance.now() - start < 1800, 'A new message should wake the waiter before its timeout.');
  assert.equal((await f.api('human', '/api/heartbeat', { method: 'POST', body: { connected: true } })).status, 403);
  await f.ok('claude', '/api/heartbeat', { method: 'POST', body: { connected: true } });
  const connected = await f.ok('human', '/api/state');
  const claude = connected.agents.find((a) => a.id === 'claude');
  assert.equal(claude.status, 'connected');
  assert.equal(claude.connected, true);
  assert.ok(Number.isFinite(Date.parse(claude.lastSeen)));
  assert.equal(connected.toolsConnected, true);
  await f.ok('claude', '/api/heartbeat', { method: 'POST', body: { connected: false } });
  const offline = (await f.ok('human', '/api/state')).agents.find((a) => a.id === 'claude');
  assert.equal(offline.status, 'offline');
  assert.equal(offline.connected, false);
});

test('newest-message loading and backward pagination retain complete room history', options, async (t) => {
  const f = await fixture(t);
  const sent = [];
  for (let n = 0; n < 105; n++) sent.push((await f.send('claude', 'general', `History test ${n}`)).message.id);
  const newest = await f.ok('human', '/api/messages?room=general');
  assert.deepEqual(newest.messages.map((m) => m.id), sent.slice(-100));
  assert.equal(newest.hasMore, true);
  const older = await f.ok('human', `/api/messages?room=general&before=${newest.messages[0].id}`);
  assert.deepEqual(older.messages.map((m) => m.id), sent.slice(0, 5));
  assert.equal(older.hasMore, false);
  assert.deepEqual([...older.messages, ...newest.messages].map((m) => m.id), sent);
  assert.equal((await f.api('human', '/api/messages?room=general&after=0&before=5')).status, 400);
});
