import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const binPath = resolve(packageDir, 'bin', 'agent-commons.mjs');
export const mcpPath = resolve(packageDir, 'src', 'mcp.mjs');
export const DEFAULT_PORT = 4317;
export const version = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')).version;

// Per-user data directory following each platform's convention.
// Override with AGENT_COMMONS_DATA_DIR or --data-dir.
export function platformDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return resolve(home, 'Library', 'Application Support', 'agent-commons');
  if (platform === 'win32') return resolve(env.APPDATA || resolve(home, 'AppData', 'Roaming'), 'agent-commons');
  return resolve(env.XDG_DATA_HOME || resolve(home, '.local', 'share'), 'agent-commons');
}

export const dataDirFrom = (explicit, env = process.env) => resolve(explicit || env.AGENT_COMMONS_DATA_DIR || platformDataDir());

export function portFrom(explicit, env = process.env) {
  const value = Number(explicit ?? env.AGENT_COMMONS_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('The port must be a whole number from 0 to 65535.');
  return value;
}

export const localUrl = port => `http://127.0.0.1:${port}`;

export function requireNode24() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Agent Commons requires Node.js 24 or newer.');
}
