// Room links, passwordless sign-in, and activity presence (0.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { seededServer, tempDataDir } from './helpers.mjs';
import { CommonsClient } from '../src/mcp.mjs';
import { browserLabel } from '../src/server.mjs';

async function boot(t) {
  const dataDir = await tempDataDir(t, 'commons-links-');
  let app = await seededServer({ dataDir });
  t.after(() => app.close());
  const owner = () => app.credentials.ownerToken;
  const token = id => app.credentials.agents.find(a => a.id === id).token;
  const call = async (path, { auth, cookie, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(app.url + path, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  return {
    dataDir, call, owner, token,
    get app() { return app; },
    async restart() { const port = Number(new URL(app.url).port); await app.close(); app = await seededServer({ dataDir, port }); },
  };
}

const cookieOf = header => header.split(';')[0];

test('rooms and messages carry links that open the room, and no link carries a credential', async t => {
  const f = await boot(t);
  const state = (await f.call('/api/state', { auth: f.token('claude') })).body;
  const project = state.rooms.find(r => r.id === 'project');
  assert.equal(project.url, `${f.app.url}/#room=project`);
  const sent = await f.call('/api/messages', { auth: f.token('claude'), method: 'POST', body: { roomId: 'project', body: 'Plan posted.' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.messageUrl, `${f.app.url}/#room=project&message=${sent.body.message.id}`);
  assert.equal(sent.body.roomUrl, project.url);
  const read = (await f.call('/api/messages?room=project', { auth: f.token('codex') })).body;
  assert.equal(read.messages.at(-1).messageUrl, sent.body.message.messageUrl);

  const client = new CommonsClient({ agent: 'claude', dataDir: f.dataDir, url: f.app.url, autostart: false });
  const rooms = await client.callTool('commons_list_rooms');
  assert.equal(rooms.rooms.find(r => r.id === 'project').url, project.url);
  const viaTool = await client.callTool('commons_send_message', { roomId: 'project', body: 'Via the bridge.' });
  assert.match(viaTool.message.messageUrl, /#room=project&message=\d+$/);

  const everything = JSON.stringify([state, sent.body, read, rooms, viaTool]);
  const secrets = [f.owner(), ...f.app.credentials.agents.map(a => a.token)];
  for (const secret of secrets) assert.ok(!everything.includes(secret), 'A server-produced response must never contain a token.');
  for (const link of everything.match(/http:\/\/127\.0\.0\.1:\d+\/[^"]*/g)) assert.doesNotMatch(link, /token|signin|session/i);
});

test('a one-time sign-in code opens a session that survives a restart; a used code does not work twice', async t => {
  const f = await boot(t);
  const minted = await f.call('/api/signin-codes', { auth: f.owner(), method: 'POST', body: {} });
  assert.equal(minted.status, 201);
  assert.ok(!minted.body.code.includes(f.owner()));
  const agentMint = await f.call('/api/signin-codes', { auth: f.token('claude'), method: 'POST', body: {} });
  assert.equal(agentMint.status, 403, 'Agents cannot mint sign-in codes.');

  const signedIn = await f.call('/api/session', { method: 'POST', body: { code: minted.body.code }, headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' } });
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.cookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=7776000/);
  const cookie = cookieOf(signedIn.cookie);
  const again = await f.call('/api/session', { method: 'POST', body: { code: minted.body.code } });
  assert.equal(again.status, 401, 'Codes are single use.');
  assert.match(again.body.error, /already used or has expired/);

  await f.restart();
  const after = await f.call('/api/state', { cookie });
  assert.equal(after.status, 200, 'A service restart must not sign the browser out.');
  assert.equal(after.body.me.id, 'you');

  const sessions = (await f.call('/api/sessions', { cookie })).body.sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].label, 'Firefox on Linux');
  assert.equal(sessions[0].current, true);
  assert.ok(!JSON.stringify(sessions).includes(cookie.split('=')[1]), 'The session list never exposes the cookie value.');

  const out = await f.call(`/api/sessions/${sessions[0].id}`, { cookie, method: 'DELETE' });
  assert.equal(out.body.signedOutHere, true);
  assert.equal((await f.call('/api/state', { cookie })).status, 401);
});

test('without owner auth, localhost cannot post as the operator', async t => {
  const f = await boot(t);
  const anonymous = await f.call('/api/messages', { method: 'POST', body: { roomId: 'general', body: 'I am Matthew.' } });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.body.error, /agent-commons open/);
  const bogus = await f.call('/api/session', { method: 'POST', body: { code: 'not-a-real-code' } });
  assert.equal(bogus.status, 401);
});

test('rotating the owner key signs out every browser and keeps the new key out of the response', async t => {
  const f = await boot(t);
  const { body: { code } } = await f.call('/api/signin-codes', { auth: f.owner(), method: 'POST', body: {} });
  const cookie = cookieOf((await f.call('/api/session', { method: 'POST', body: { code } })).cookie);
  const before = f.owner();
  const rotated = await f.call('/api/owner/rotate', { auth: before, method: 'POST', body: {} });
  assert.equal(rotated.status, 200);
  assert.notEqual(f.owner(), before);
  assert.ok(!JSON.stringify(rotated.body).includes(f.owner()));
  assert.equal((await f.call('/api/state', { auth: before })).status, 401);
  assert.equal((await f.call('/api/state', { cookie })).status, 401);
  assert.equal((await f.call('/api/state', { auth: f.owner() })).status, 200);
});

test('posting without a bridge still shows the agent as recently active', async t => {
  const f = await boot(t);
  const start = Date.now();
  await f.call('/api/messages', { auth: f.token('codex'), method: 'POST', body: { roomId: 'project', body: 'Direct API post.' } });
  const codex = (await f.call('/api/state', { auth: f.owner() })).body.agents.find(a => a.id === 'codex');
  assert.equal(codex.connected, false, 'Bridge presence stays separate.');
  assert.ok(Date.parse(codex.lastActiveAt) >= start - 1000 && Date.parse(codex.lastActiveAt) <= Date.now());
  assert.equal(codex.lastActiveVia, 'api');
  await f.call('/api/heartbeat', { auth: f.token('claude'), method: 'POST', body: { connected: true } });
  const claude = (await f.call('/api/state', { auth: f.owner() })).body.agents.find(a => a.id === 'claude');
  assert.equal(claude.connected, true);
  assert.equal(claude.lastActiveAt, null, 'A heartbeat alone is presence, not activity.');
});

test('browser labels are readable', () => {
  assert.equal(browserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Version/18 Safari/605'), 'Safari on macOS');
  assert.equal(browserLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537 Edg/130'), 'Edge on Windows');
  assert.equal(browserLabel(undefined), 'Browser on this computer');
});

test('rotating the owner key or signing out everywhere cancels sign-in codes minted before it', async t => {
  const f = await boot(t);
  const early = (await f.call('/api/signin-codes', { auth: f.owner(), method: 'POST', body: {} })).body.code;
  await f.call('/api/owner/rotate', { auth: f.owner(), method: 'POST', body: {} });
  assert.equal((await f.call('/api/session', { method: 'POST', body: { code: early } })).status, 401);
  const second = (await f.call('/api/signin-codes', { auth: f.owner(), method: 'POST', body: {} })).body.code;
  await f.call('/api/sessions', { auth: f.owner(), method: 'DELETE' });
  assert.equal((await f.call('/api/session', { method: 'POST', body: { code: second } })).status, 401);
});
