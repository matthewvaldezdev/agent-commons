// Shared fixture: a workspace with two all-room agents (claude, codex) and three rooms (general, project, handoffs).
import { after } from 'node:test';
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

// Temp folders are removed once every test in the file has finished and closed its servers. Removing one from a
// test's own cleanup could run before that test's server closes (hooks run in the order they were added), and
// Windows refuses to delete an open database, which then skipped the server's close and kept the process alive.
const leftovers = [];
after(async () => {
  for (const dir of leftovers) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

export async function tempDataDir(t, prefix = 'agent-commons-') {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  leftovers.push(dataDir);
  return dataDir;
}
