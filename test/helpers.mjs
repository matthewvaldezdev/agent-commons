// Shared fixture: a workspace with two all-room agents (claude, codex) and three rooms (general, project, handoffs).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

export const ROOMS = [['project', 'Project', 'Build it together.'], ['handoffs', 'Handoffs', 'Decisions, context, and the next useful step.']];

export async function seededServer({ dataDir, port = 0 } = {}) {
  const app = await startServer({ port, dataDir });
  for (const [id, name, description] of ROOMS) {
    try { app.store.room(id); } catch { app.store.createRoom(name, description, id); }
  }
  for (const [name, kind] of [['Claude', 'claude'], ['Codex', 'codex']]) {
    if (!app.credentials.agents.some(a => a.id === kind)) await app.api.createAgent({ name, kind });
  }
  return app;
}

export async function tempDataDir(t, prefix = 'agent-commons-') {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}
