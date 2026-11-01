// Starts the local server on demand. Used by the CLI and by the MCP bridge when a tool call finds nothing listening.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { binPath, version, MIN_NODE } from './paths.mjs';

export async function health(url, timeout = 1000) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.name === 'Agent Commons' ? body : null;
  } catch { return null; }
}

// Confirms the listener on this port belongs to this data directory and not to a different workspace.
export async function sameWorkspace(url, dataDir) {
  // A running service always has a credentials file in its own data directory, so a missing file means the listener is someone else's.
  let credentials;
  try { credentials = JSON.parse(await readFile(resolve(dataDir, 'credentials.json'), 'utf8')); }
  catch { return false; }
  try {
    const response = await fetch(`${url}/api/state`, { headers: { authorization: `Bearer ${credentials.ownerToken}` }, signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch { return false; }
}

export async function waitForHealth(url, { timeoutMs = 8000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await health(url, 500);
    if (body) return body;
    await delay(intervalMs);
  }
  return null;
}

// Spawns `agent-commons serve` as a detached background process that outlives the caller.
// Inside an app with a bundled Node too old for node:sqlite, prefer a node on PATH that is new enough.
function serverNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const recent = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  if (!process.versions.electron || recent) return process.execPath;
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['node.exe'] : ['node']) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.execPath;
}

export function spawnDetached({ port, dataDir, nodePath = serverNode() }) {
  const child = spawn(nodePath, [binPath, 'serve', '--port', String(port), '--data-dir', dataDir], {
    detached: true, stdio: 'ignore', windowsHide: true,
    // Inside an Electron host (e.g. a Claude Desktop extension), execPath is the app binary; this makes it behave as plain Node.
    env: { ...process.env, AGENT_COMMONS_PORT: String(port), AGENT_COMMONS_DATA_DIR: dataDir, ...(process.versions.electron && nodePath === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  });
  child.unref();
  return child;
}

// Returns { url, started: boolean, version }. Throws when the port is held by something that is not this workspace.
export async function ensureServer({ port, dataDir, url, autostart = true, log = () => {} }) {
  const running = await health(url);
  if (running) {
    if (running.version !== version) log(`Agent Commons ${running.version} is running; this bridge is ${version}.`);
    if (!(await sameWorkspace(url, dataDir))) throw new Error(`Another Agent Commons workspace is using ${url}. Set AGENT_COMMONS_PORT or point this bridge at the same data directory.`);
    return { url, started: false, version: running.version };
  }
  if (!autostart) return null;
  log(`Starting Agent Commons at ${url}`);
  spawnDetached({ port, dataDir });
  const body = await waitForHealth(url);
  if (!body) throw new Error(`Agent Commons did not start at ${url} within 8 seconds. Run "agent-commons serve" in a terminal to see why.`);
  return { url, started: true, version: body.version };
}
