import { createServer } from 'node:http';
import { readFile, chmod, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { Store, AppError, fail, hashToken } from './store.mjs';
import { ensureCredentials, saveCredentials, writeConnectionCredential, randomToken, agentKinds, allRooms, validAgentId, slugify } from './local-state.mjs';
import { packageDir, mcpPath, version, dataDirFrom, portFrom, requireNode } from './paths.mjs';
import { buildSnippets, agentPrompt, CLIENTS, clientFile } from './connect.mjs';
import { stableRuntime } from './runtime.mjs';

const nowDate = () => new Date().toISOString().slice(0, 10);
const agentView = agent => ({ id: agent.id, name: agent.name, kind: agent.kind, roomIds: agent.roomIds ?? null, access: allRooms(agent) ? 'all' : 'selected' });
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object.');
  return value;
};
function text(value, label, max, { required = true, trim = true } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') fail(400, `${label} must be text.`);
  const result = trim ? value.trim() : value;
  if ((required && !result.trim()) || result.length > max) fail(400, `${label} must contain ${required ? '1' : '0'} to ${max} characters.`);
  return result;
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function queryInt(params, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!params.has(key)) return fallback;
  const value = params.get(key);
  if (!/^\d+$/.test(value)) fail(400, `Invalid ${key}.`);
  return integer(Number(value), key, min, max);
}
function allowedKeys(body, keys) {
  if (Object.keys(body).some(key => !keys.includes(key))) fail(400, 'Unsupported fields. The authenticated sender is assigned automatically.');
}
const DAY = 24 * 3600 * 1000;
export const SESSION_TTL = 90 * DAY;
const SESSION_REFRESH = 3600 * 1000;
const SIGNIN_CODE_TTL = 2 * 60 * 1000;
const sessionCookie = (value, maxAgeMs) => `commons_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
// A readable label for the signed-in browsers list, e.g. "Firefox on Linux". Never used for authorization.
export function browserLabel(userAgent = '') {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'this computer';
  return `${browser} on ${os}`;
}

async function bodyJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Use application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) fail(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error instanceof AppError) throw error; fail(400, 'Invalid JSON.'); }
}

export async function startServer({ port = portFrom(), dataDir = dataDirFrom() } = {}) {
  requireNode();
  dataDir = resolve(dataDir);
  const credentials = await ensureCredentials(dataDir);
  const store = new Store(dataDir, credentials.agents);
  if (process.platform !== 'win32') await chmod(resolve(dataDir, 'commons.sqlite'), 0o600);
  const human = { id: 'you', name: 'You', kind: 'human', owner: true };
  const signinCodes = new Map(); // sha256(code) -> expiry; single use, memory only
  const activity = new Map(); // agentId -> last recorded activity (ms), to avoid a database write per request
  const changes = new EventEmitter(); changes.setMaxListeners(0);
  const streams = new Set();
  const pending = new Set();
  let credentialUpdates = Promise.resolve();
  const updateCredentials = action => {
    const result = credentialUpdates.then(action);
    credentialUpdates = result.catch(() => {});
    return result;
  };
  let url;
  let closing = false;
  const broadcast = event => {
    changes.emit('change', event);
    const payload = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of streams) if (!res.write(payload)) res.end();
  };
  const roomLink = roomId => `${url}/#room=${encodeURIComponent(roomId)}`;
  const messageLink = (roomId, id) => `${roomLink(roomId)}&message=${id}`;
  // Links never carry a credential: agents see and repeat them.
  const withLinks = result => ({ ...result, messages: result.messages.map(m => ({ ...m, messageUrl: messageLink(m.roomId, m.id) })) });
  const recordActivity = (agentId, via) => {
    const at = Date.now();
    const last = activity.get(agentId);
    if (last && at - last.at < 1000 && last.via === via) return;
    activity.set(agentId, { at, via });
    store.touch(agentId, via);
    if (!last || at - last.at > 30000) broadcast({ type: 'presence' });
  };
  const cookieValue = req => req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('commons_session='))?.slice('commons_session='.length);
  function identify(req, res) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      if (equal(bearer, credentials.ownerToken)) return human;
      const agent = credentials.agents.find(a => equal(a.token, bearer));
      if (agent) {
        // Heartbeats are bridge presence, not activity.
        if (!req.url.startsWith('/api/heartbeat')) recordActivity(agent.id, req.headers['x-agent-commons-client'] === 'bridge' ? 'bridge' : 'api');
        return { id: agent.id, name: agent.name, kind: agent.kind, roomIds: agent.roomIds, allRooms: allRooms(agent), owner: false };
      }
      fail(401, 'Unknown local credential.');
    }
    const cookie = cookieValue(req);
    const session = cookie && store.useSession(cookie, SESSION_TTL, SESSION_REFRESH);
    if (session) {
      if (session.refreshed && res && !res.headersSent) res.setHeader('Set-Cookie', sessionCookie(cookie, SESSION_TTL));
      return { ...human, sessionId: session.id };
    }
    fail(401, 'Sign in to Agent Commons by running "agent-commons open" on this computer.');
  }
  const ownerOnly = me => { if (!me.owner) fail(403, 'This action is for the person using the app.'); };
  const roomAccess = (me, roomId) => {
    if (!me.owner && !me.allRooms && !me.roomIds.includes(roomId)) fail(404, 'That room does not exist.');
    return store.room(roomId);
  };
  // null grants every room, including rooms created later; an array grants exactly those rooms.
  const grantedRooms = value => {
    if (value === null) return undefined;
    if (!Array.isArray(value) || value.length > 1000) fail(400, 'Choose a list of permitted rooms, or null for every room.');
    const ids = value.map(id => text(id, 'Room', 100));
    if (new Set(ids).size !== ids.length) fail(400, 'Choose each room only once.');
    for (const id of ids) {
      try { store.room(id); }
      catch (error) { if (error.status === 404) fail(400, 'Choose existing rooms for this identity.'); throw error; }
    }
    return ids;
  };
  function guard(req) {
    const authority = new URL(url).host;
    const actualPort = new URL(url).port;
    if (![authority, `localhost:${actualPort}`].includes(req.headers.host)) fail(403, 'Unsupported local host.');
    if (req.headers.origin && ![url, `http://localhost:${actualPort}`].includes(req.headers.origin)) fail(403, 'This app accepts requests from its own local window only.');
    if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
  }
  async function waitForMessage(roomId, res, seconds, agentId) {
    await new Promise(resolveWait => {
      const timer = setTimeout(finish, seconds * 1000);
      const changed = event => { if ((event.type === 'message' && event.roomId === roomId) || (event.type === 'agent' && event.agentId === agentId)) finish(); };
      function finish() {
        clearTimeout(timer); changes.off('change', changed); res.off('close', finish); pending.delete(finish); resolveWait();
      }
      changes.on('change', changed); res.on('close', finish); pending.add(finish);
    });
  }
  async function createAgent({ name, kind, roomIds }) {
    return updateCredentials(async () => {
      if (credentials.agents.some(a => a.name.toLowerCase() === name.toLowerCase())) fail(409, 'An agent already uses that name. Choose a separate name for this connection.');
      const base = slugify(name);
      let id = base;
      while (credentials.agents.some(a => a.id === id) || id === 'you') id = `${base}-${randomUUID().slice(0, 8)}`;
      const created = { id, name, kind, token: randomToken(), ...(roomIds === undefined ? {} : { roomIds }) };
      const next = { ...credentials, agents: [...credentials.agents, created] };
      await writeConnectionCredential(dataDir, created);
      await saveCredentials(dataDir, next);
      Object.assign(credentials, next);
      store.registerAgent(created);
      return created;
    });
  }
  async function connectionInfo(agent, platform = process.platform) {
    const credentialFile = await writeConnectionCredential(dataDir, agent);
    const runtime = await stableRuntime(dataDir);
    const snippets = buildSnippets({ agentId: agent.id, credentialFile, url, bridge: runtime.mcp });
    const clients = Object.fromEntries(Object.keys(CLIENTS).map(id => [id, { title: CLIENTS[id].title, file: clientFile(id, platform), snippet: snippets[id] }]));
    return { agent: agentView(agent), nodePath: process.execPath, mcpPath: runtime.mcp, dataDir, url, credentialFile, mcpConfig: snippets.entry, serverKey: snippets.key, clients, prompt: agentPrompt(agent, url) };
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      guard(req);
      const route = new URL(req.url, url);
      const path = route.pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, name: 'Agent Commons', version });
      if (req.method === 'POST' && path === '/api/session') {
        // A one-time sign-in code (what "agent-commons open" uses), or the owner token typed by hand as a fallback.
        const body = await bodyJSON(req); allowedKeys(body, ['code', 'token']);
        if (typeof body.code === 'string') {
          const key = hashToken(body.code);
          const expiry = signinCodes.get(key);
          signinCodes.delete(key);
          if (!expiry || expiry < Date.now()) fail(401, 'That sign-in link was already used or has expired. Run "agent-commons open" again for a fresh one.');
        } else if (!equal(body.token, credentials.ownerToken)) fail(401, 'That key does not open this workspace.');
        const sessionToken = randomToken();
        store.createSession(sessionToken, browserLabel(req.headers['user-agent']), SESSION_TTL);
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sessionToken, SESSION_TTL) });
      }
      if (path.startsWith('/api/')) {
        let me = identify(req, res);
        if (req.method === 'POST' && path === '/api/signin-codes') {
          ownerOnly(me);
          const code = randomToken();
          const at = Date.now();
          for (const [key, expiry] of signinCodes) if (expiry < at) signinCodes.delete(key);
          signinCodes.set(hashToken(code), at + SIGNIN_CODE_TTL);
          return json(res, 201, { code, expiresAt: new Date(at + SIGNIN_CODE_TTL).toISOString() });
        }
        if (req.method === 'GET' && path === '/api/sessions') {
          ownerOnly(me);
          return json(res, 200, { sessions: store.sessions().map(s => ({ ...s, current: s.id === me.sessionId })) });
        }
        if (req.method === 'DELETE' && (path === '/api/sessions' || path.startsWith('/api/sessions/'))) {
          ownerOnly(me);
          const id = path.slice('/api/sessions/'.length);
          if (path === '/api/sessions') { store.deleteAllSessions(); signinCodes.clear(); }
          else if (!store.deleteSession(id)) fail(404, 'That browser is already signed out.');
          const signedOutHere = path === '/api/sessions' || id === me.sessionId;
          return json(res, 200, { ok: true, signedOutHere }, signedOutHere && me.sessionId ? { 'Set-Cookie': sessionCookie('', 0) } : {});
        }
        if (req.method === 'POST' && path === '/api/owner/rotate') {
          ownerOnly(me);
          // Replaces the owner key and signs out every browser. The new key is written to credentials.json, never returned.
          await updateCredentials(async () => {
            const next = { ...credentials, ownerToken: randomToken() };
            await saveCredentials(dataDir, next);
            Object.assign(credentials, next);
          });
          store.deleteAllSessions();
          signinCodes.clear(); // a code minted before the rotate must not open a new session after it
          return json(res, 200, { ok: true }, me.sessionId ? { 'Set-Cookie': sessionCookie('', 0) } : {});
        }
        if (req.method === 'GET' && path === '/api/state') {
          const state = store.state(me, credentials.agents);
          return json(res, 200, { ...state, url, rooms: state.rooms.map(r => ({ ...r, url: roomLink(r.id) })) });
        }
        if (req.method === 'GET' && path === '/api/messages') {
          const roomId = text(route.searchParams.get('room'), 'Room', 100);
          const after = queryInt(route.searchParams, 'after', undefined);
          const before = queryInt(route.searchParams, 'before', undefined);
          if (after !== undefined && before !== undefined) fail(400, 'Use either after or before.');
          const limit = queryInt(route.searchParams, 'limit', 100, 1, 100);
          const wait = queryInt(route.searchParams, 'wait', 0, 0, 20);
          const q = text(route.searchParams.get('q') ?? '', 'Search', 200, { required: false });
          roomAccess(me, roomId);
          let result = store.messages(roomId, { after, before, limit, q });
          if (!q && after !== undefined && result.messages.length === 0 && wait) {
            await waitForMessage(roomId, res, wait, me.id);
            if (res.destroyed) return;
            if (closing) return json(res, 503, { error: 'The local app is stopping. Reopen it to continue.' });
            me = identify(req, res);
            roomAccess(me, roomId);
            result = store.messages(roomId, { after, limit });
          }
          return json(res, 200, { ...withLinks(result), roomUrl: roomLink(roomId) });
        }
        if (req.method === 'POST' && path === '/api/messages') {
          const body = await bodyJSON(req); allowedKeys(body, ['roomId', 'body', 'replyTo', 'clientMessageId']);
          const message = { roomId: text(body.roomId, 'Room', 100), body: text(body.body, 'Message', 12000, { trim: false }) };
          if (body.replyTo != null) message.replyTo = integer(body.replyTo, 'Reply ID', 1);
          if (body.clientMessageId != null) message.clientMessageId = text(body.clientMessageId, 'Retry ID', 128);
          me = identify(req, res);
          roomAccess(me, message.roomId);
          const result = store.send(me, message);
          if (!result.duplicate) broadcast({ type: 'message', roomId: message.roomId, id: result.message.id });
          return json(res, result.duplicate ? 200 : 201, { ...result, message: { ...result.message, messageUrl: messageLink(message.roomId, result.message.id) }, roomUrl: roomLink(message.roomId) });
        }
        if (req.method === 'POST' && path === '/api/read') {
          const body = await bodyJSON(req); allowedKeys(body, ['roomId', 'cursor']);
          const roomId = text(body.roomId, 'Room', 100);
          me = identify(req, res);
          roomAccess(me, roomId);
          const result = store.markRead(me.id, roomId, integer(body.cursor, 'Read position'));
          broadcast({ type: 'read', roomId });
          return json(res, 200, result);
        }
        if (req.method === 'POST' && path === '/api/heartbeat') {
          if (me.owner) fail(403, 'Presence is tracked for agent bridges.');
          const body = await bodyJSON(req); allowedKeys(body, ['connected']);
          if (body.connected !== undefined && typeof body.connected !== 'boolean') fail(400, 'connected must be true or false.');
          store.heartbeat(me.id, body.connected !== false);
          broadcast({ type: 'presence' }); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && path === '/api/rooms') {
          ownerOnly(me); const body = await bodyJSON(req); allowedKeys(body, ['name', 'description']);
          const room = store.createRoom(text(body.name, 'Room name', 50), text(body.description, 'Description', 240, { required: false }));
          broadcast({ type: 'room', roomId: room.id }); return json(res, 201, { room: { ...room, url: roomLink(room.id) } });
        }
        if (req.method === 'POST' && path === '/api/agents') {
          ownerOnly(me);
          const body = await bodyJSON(req); allowedKeys(body, ['name', 'kind', 'roomIds']);
          const name = text(body.name, 'Agent name', 80);
          if (!agentKinds.includes(body.kind)) fail(400, `Choose one of: ${agentKinds.join(', ')}.`);
          const roomIds = grantedRooms(body.roomIds === undefined ? [] : body.roomIds);
          const agent = await createAgent({ name, kind: body.kind, roomIds });
          broadcast({ type: 'agent', agentId: agent.id });
          return json(res, 201, { agent: agentView(agent) });
        }
        if ((req.method === 'PATCH' || req.method === 'DELETE') && path.startsWith('/api/agents/')) {
          ownerOnly(me);
          const agentId = path.slice('/api/agents/'.length);
          if (!validAgentId(agentId)) fail(404, 'That agent does not exist.');
          if (req.method === 'DELETE') {
            await updateCredentials(async () => {
              if (!credentials.agents.some(a => a.id === agentId)) fail(404, 'That agent does not exist.');
              const next = { ...credentials, agents: credentials.agents.filter(a => a.id !== agentId) };
              await saveCredentials(dataDir, next);
              Object.assign(credentials, next);
              await unlink(resolve(dataDir, 'connections', `${agentId}.json`)).catch(() => {});
            });
            broadcast({ type: 'agent', agentId });
            return json(res, 200, { ok: true });
          }
          const body = await bodyJSON(req); allowedKeys(body, ['name', 'roomIds']);
          if (!Object.keys(body).length) fail(400, 'Choose a name or room access to update.');
          const name = body.name === undefined ? undefined : text(body.name, 'Agent name', 80);
          const hasRooms = body.roomIds !== undefined;
          const roomIds = hasRooms ? grantedRooms(body.roomIds) : undefined;
          const agent = await updateCredentials(async () => {
            const existing = credentials.agents.find(a => a.id === agentId);
            if (!existing) fail(404, 'That agent does not exist.');
            if (name !== undefined && name.toLowerCase() !== existing.name.toLowerCase() && credentials.agents.some(a => a.id !== agentId && a.name.toLowerCase() === name.toLowerCase())) fail(409, 'An agent already uses that name. Choose a separate name for this connection.');
            const updated = { ...existing, ...(name !== undefined ? { name } : {}) };
            if (hasRooms) { if (roomIds === undefined) delete updated.roomIds; else updated.roomIds = roomIds; }
            const next = { ...credentials, agents: credentials.agents.map(a => a.id === agentId ? updated : a) };
            await saveCredentials(dataDir, next);
            Object.assign(credentials, next);
            store.registerAgent(updated);
            return updated;
          });
          broadcast({ type: 'agent', agentId: agent.id });
          return json(res, 200, { agent: agentView(agent) });
        }
        if (req.method === 'GET' && path === '/api/export') {
          ownerOnly(me);
          const transcript = store.export(text(route.searchParams.get('room'), 'Room', 100));
          const filename = `${transcript.room.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 50) || 'conversation'}-${nowDate()}.json`;
          return json(res, 200, transcript, route.searchParams.get('download') === '1'
            ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {});
        }
        if (req.method === 'GET' && path === '/api/connect') {
          ownerOnly(me);
          const agentId = route.searchParams.get('agent');
          const agent = credentials.agents.find(a => a.id === agentId);
          if (!agent) fail(404, 'That agent does not exist.');
          return json(res, 200, await connectionInfo(agent));
        }
        if (req.method === 'POST' && path === '/api/install') {
          // The "set it up for me" button: writes this identity into a client's own config, with a backup. Owner only.
          ownerOnly(me);
          const body = await bodyJSON(req); allowedKeys(body, ['agentId', 'client']);
          const { installClient, restartAdvice, clientTargets } = await import('./install.mjs');
          if (!Object.hasOwn(clientTargets(), body.client)) fail(400, 'Choose a client this computer can set up.');
          const agent = credentials.agents.find(a => a.id === body.agentId);
          if (!agent) fail(404, 'That agent does not exist.');
          const info = await connectionInfo(agent);
          let result;
          try { result = await installClient(body.client, info.serverKey, info.mcpConfig); }
          catch (error) { fail(409, error.message); }
          const advice = result.status === 'manual' ? null : await restartAdvice(body.client, result.status === 'unchanged' ? null : result.file);
          return json(res, 200, { status: result.status, file: result.file ?? null, backup: result.backup ?? null, reason: result.reason ?? null, advice: advice?.message ?? null });
        }
        if (req.method === 'GET' && path === '/api/events') {
          ownerOnly(me);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
          res.write(': connected\n\n'); streams.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 15000);
          res.on('close', () => { clearInterval(ping); streams.delete(res); }); return;
        }
        fail(404, 'That API route does not exist.');
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      const asset = files[path];
      if (req.method !== 'GET' || !asset) fail(404, 'Page not found.');
      const content = await readFile(resolve(packageDir, 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(content);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'The local app encountered a problem. Your saved messages are retained.' });
      else if (!res.destroyed) res.end();
      if (!error.status) console.error('Agent Commons request failed:', error.message);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen);
    });
  } catch (error) { store.close(); throw error; }
  url = `http://127.0.0.1:${server.address().port}`;
  const stale = setInterval(() => broadcast({ type: 'presence' }), 15000); stale.unref();
  const close = async () => {
    if (closing) return; closing = true;
    clearInterval(stale);
    for (const finish of pending) finish();
    for (const res of streams) res.end();
    await new Promise(resolveClose => { server.close(resolveClose); server.closeIdleConnections(); });
    await credentialUpdates;
    store.close();
  };
  // Programmatic helpers used by the CLI (same process, no HTTP round trip).
  const api = {
    createAgent: async ({ name, kind, roomIds }) => agentView(await createAgent({ name: text(name, 'Agent name', 80), kind, roomIds })),
    connectionInfo: async (agentId, platform) => {
      const agent = credentials.agents.find(a => a.id === agentId);
      if (!agent) fail(404, 'That agent does not exist.');
      return connectionInfo(agent, platform);
    },
    listAgents: () => credentials.agents.map(agentView),
  };
  return { server, store, url, dataDir, credentials, api, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startServer();
  console.log(`Agent Commons ${version} is running at ${app.url}\nData: ${app.dataDir}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
