import './quiet.mjs';
// Loaded dynamically so the warning filter in quiet.mjs is in place before node:sqlite initializes.
const { DatabaseSync } = await import('node:sqlite');
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { allRooms } from './local-state.mjs';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new AppError(status, message); };
const now = () => new Date().toISOString();
const roomView = r => ({ id: r.id, name: r.name, description: r.description, createdAt: r.created_at });
const messageView = r => ({ id: r.id, roomId: r.room_id, senderId: r.sender_id, senderName: r.sender_name,
  senderKind: r.sender_kind, body: r.body, createdAt: r.created_at, replyTo: r.reply_to, clientMessageId: r.client_message_id });

export const hashToken = token => createHash('sha256').update(token).digest('hex');

export const DEFAULT_ROOM = { id: 'general', name: 'General', description: 'A shared space for everyone in this workspace.' };

export class Store {
  constructor(dataDir, agents) {
    this.db = new DatabaseSync(resolve(dataDir, 'commons.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        last_seen TEXT, connected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES rooms(id), sender_id TEXT NOT NULL REFERENCES agents(id),
        sender_name TEXT NOT NULL, sender_kind TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id), client_message_id TEXT,
        UNIQUE(sender_id, client_message_id));
      CREATE INDEX IF NOT EXISTS messages_room_id ON messages(room_id, id);
      CREATE TABLE IF NOT EXISTS read_positions (agent_id TEXT NOT NULL REFERENCES agents(id),
        room_id TEXT NOT NULL REFERENCES rooms(id), cursor INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, room_id));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);`);
    // Columns added after 0.2: activity separate from bridge presence.
    const columns = new Set(this.db.prepare('PRAGMA table_info(agents)').all().map(c => c.name));
    if (!columns.has('last_active_at')) this.db.exec('ALTER TABLE agents ADD COLUMN last_active_at TEXT');
    if (!columns.has('last_active_via')) this.db.exec('ALTER TABLE agents ADD COLUMN last_active_via TEXT');
    for (const a of [{ id: 'you', name: 'You', kind: 'human' }, ...agents]) this.registerAgent(a);
    // A restarted server has no evidence of a connected bridge yet.
    this.db.exec('UPDATE agents SET connected=0');
    if (!this.db.prepare('SELECT 1 FROM rooms LIMIT 1').get()) {
      this.db.prepare('INSERT INTO rooms(id,name,description,created_at) VALUES(?,?,?,?)').run(DEFAULT_ROOM.id, DEFAULT_ROOM.name, DEFAULT_ROOM.description, now());
    }
  }

  room(id) {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
    if (!r) fail(404, 'That room does not exist.');
    return roomView(r);
  }

  registerAgent(agent) {
    this.db.prepare('INSERT INTO agents(id,name,kind) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind').run(agent.id, agent.name, agent.kind);
  }

  state(me, registeredAgents) {
    const canAccess = roomId => me.owner || me.allRooms || me.roomIds?.includes(roomId);
    const rooms = this.db.prepare(`SELECT r.*,
      (SELECT MAX(created_at) FROM messages WHERE room_id=r.id) AS last_message_at,
      (SELECT COUNT(*) FROM messages WHERE room_id=r.id) AS message_count,
      COALESCE((SELECT cursor FROM read_positions WHERE agent_id=? AND room_id=r.id),0) AS read_cursor,
      (SELECT COUNT(*) FROM messages WHERE room_id=r.id AND sender_id<>? AND id>COALESCE(
        (SELECT cursor FROM read_positions WHERE agent_id=? AND room_id=r.id),0)) AS unread
      FROM rooms r ORDER BY r.created_at,r.rowid`).all(me.id, me.id, me.id).filter(r => canAccess(r.id)).map(r => ({ ...roomView(r),
        lastMessageAt: r.last_message_at, messageCount: r.message_count, unread: r.unread, readCursor: r.read_cursor }));
    const visibleRooms = new Set(rooms.map(r => r.id));
    const agentAccess = new Map(registeredAgents.map(a => [a.id, a]));
    const agents = this.db.prepare("SELECT * FROM agents WHERE kind<>'human' ORDER BY rowid").all().filter(a => {
      const registered = agentAccess.get(a.id);
      return registered && (me.owner || (allRooms(registered) ? visibleRooms.size > 0 : registered.roomIds.some(id => visibleRooms.has(id))));
    }).map(a => {
      const connected = Boolean(a.connected && a.last_seen && Date.now() - Date.parse(a.last_seen) < 45000);
      const registered = agentAccess.get(a.id);
      return { id: a.id, name: a.name, kind: a.kind, status: connected ? 'connected' : 'offline', lastSeen: a.last_seen, connected,
        lastActiveAt: a.last_active_at ?? null, lastActiveVia: a.last_active_via ?? null,
        ...(me.owner ? { roomIds: registered.roomIds ?? null, access: allRooms(registered) ? 'all' : 'selected' } : {}) };
    });
    return { me: { id: me.id, name: me.name, kind: me.kind, owner: me.owner }, rooms, agents, mode: 'local', toolsConnected: agents.some(a => a.connected) };
  }

  messages(roomId, { after, before, limit = 100, q = '' } = {}) {
    this.room(roomId);
    let rows;
    if (q) {
      // instr is a literal substring search: %, _ and quotes are ordinary text.
      rows = this.db.prepare('SELECT * FROM messages WHERE room_id=? AND instr(lower(body),lower(?))>0 ORDER BY id DESC LIMIT ?').all(roomId, q, limit + 1).reverse();
    } else if (after !== undefined) {
      rows = this.db.prepare('SELECT * FROM messages WHERE room_id=? AND id>? ORDER BY id LIMIT ?').all(roomId, after, limit + 1);
    } else if (before !== undefined) {
      rows = this.db.prepare('SELECT * FROM messages WHERE room_id=? AND id<? ORDER BY id DESC LIMIT ?').all(roomId, before, limit + 1).reverse();
    } else {
      rows = this.db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY id DESC LIMIT ?').all(roomId, limit + 1).reverse();
    }
    const hasMore = rows.length > limit;
    if (hasMore) rows = after !== undefined && !q ? rows.slice(0, limit) : rows.slice(1);
    const messages = rows.map(messageView);
    return { messages, nextCursor: messages.at(-1)?.id ?? after ?? 0, hasMore };
  }

  send(sender, { roomId, body, replyTo = null, clientMessageId = null }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.room(roomId);
      if (clientMessageId) {
        const existing = this.db.prepare('SELECT * FROM messages WHERE sender_id=? AND client_message_id=?').get(sender.id, clientMessageId);
        if (existing) {
          if (existing.room_id !== roomId || existing.body !== body || existing.reply_to !== replyTo) fail(409, 'This retry ID already belongs to a different message.');
          this.db.exec('COMMIT');
          return { message: messageView(existing), duplicate: true };
        }
      }
      if (replyTo !== null) {
        const parent = this.db.prepare('SELECT room_id FROM messages WHERE id=?').get(replyTo);
        if (!parent || parent.room_id !== roomId) fail(400, 'A reply must refer to a message in this room.');
      }
      const result = this.db.prepare(`INSERT INTO messages(room_id,sender_id,sender_name,sender_kind,body,created_at,reply_to,client_message_id)
        VALUES(?,?,?,?,?,?,?,?)`).run(roomId, sender.id, sender.name, sender.kind, body, now(), replyTo, clientMessageId);
      const message = messageView(this.db.prepare('SELECT * FROM messages WHERE id=?').get(Number(result.lastInsertRowid)));
      this.db.exec('COMMIT');
      return { message, duplicate: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  markRead(agentId, roomId, cursor) {
    this.room(roomId);
    const latest = this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE room_id=?').get(roomId).id;
    if (cursor > latest) fail(400, 'Read position is beyond the last message in this room.');
    this.db.prepare(`INSERT INTO read_positions(agent_id,room_id,cursor) VALUES(?,?,?)
      ON CONFLICT(agent_id,room_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)`).run(agentId, roomId, cursor);
    return { ok: true, cursor: this.db.prepare('SELECT cursor FROM read_positions WHERE agent_id=? AND room_id=?').get(agentId, roomId).cursor };
  }

  heartbeat(agentId, connected = true) {
    this.db.prepare('UPDATE agents SET last_seen=?,connected=? WHERE id=?').run(now(), connected ? 1 : 0, agentId);
  }

  // Any authenticated agent request counts as activity, whether or not a bridge is heartbeating.
  touch(agentId, via = 'api') {
    this.db.prepare('UPDATE agents SET last_active_at=?,last_active_via=? WHERE id=?').run(now(), via, agentId);
  }

  // Browser sessions survive restarts. Only a SHA-256 of the cookie value is stored.
  createSession(token, label, ttlMs) {
    const at = Date.now();
    const id = randomUUID().slice(0, 8);
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(new Date(at).toISOString());
    this.db.prepare('INSERT INTO sessions(token_hash,id,label,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?,?)')
      .run(hashToken(token), id, label, new Date(at).toISOString(), new Date(at).toISOString(), new Date(at + ttlMs).toISOString());
    return id;
  }

  // Returns the session, sliding its expiry forward when it was last refreshed more than refreshMs ago.
  useSession(token, ttlMs, refreshMs) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(token));
    if (!row) return null;
    const at = Date.now();
    if (Date.parse(row.expires_at) <= at) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash); return null; }
    let refreshed = false;
    if (at - Date.parse(row.last_used_at) > refreshMs) {
      this.db.prepare('UPDATE sessions SET last_used_at=?,expires_at=? WHERE token_hash=?').run(new Date(at).toISOString(), new Date(at + ttlMs).toISOString(), row.token_hash);
      refreshed = true;
    }
    return { id: row.id, refreshed };
  }

  sessions() {
    return this.db.prepare('SELECT id,label,created_at,last_used_at,expires_at FROM sessions WHERE expires_at>? ORDER BY last_used_at DESC').all(now())
      .map(r => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at }));
  }

  deleteSession(id) { return this.db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes > 0; }
  deleteAllSessions() { this.db.exec('DELETE FROM sessions'); }

  createRoom(name, description, id = randomUUID()) {
    if (this.db.prepare('SELECT id FROM rooms WHERE name=? COLLATE NOCASE').get(name)) fail(409, 'A room with that name already exists.');
    this.db.prepare('INSERT INTO rooms(id,name,description,created_at) VALUES(?,?,?,?)').run(id, name, description, now());
    return this.room(id);
  }

  export(roomId) {
    return { name: 'Agent Commons', exportedAt: now(), room: this.room(roomId),
      messages: this.db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY id').all(roomId).map(messageView) };
  }

  close() { this.db.close(); }
}
