import { mkdir, readFile, writeFile, chmod, rename, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const randomToken = () => randomBytes(32).toString('base64url');
export const agentKinds = ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'chatgpt', 'other'];
export const validAgentId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && id !== 'you';
// An identity without a roomIds array may read and post in every room, including rooms created later.
export const allRooms = agent => !Array.isArray(agent.roomIds);

export function slugify(name) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agent';
}

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || credentials.version !== 1 ||
    typeof credentials.ownerToken !== 'string' || credentials.ownerToken.length < 32 || !Array.isArray(credentials.agents) ||
    credentials.agents.some(a => !a || typeof a !== 'object' || !agentKinds.includes(a.kind) || !validAgentId(a.id) ||
      typeof a.name !== 'string' || !a.name.trim() || typeof a.token !== 'string' || a.token.length < 32 ||
      (!allRooms(a) && (a.roomIds.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(a.roomIds).size !== a.roomIds.length)))) {
    throw new Error('The local credentials file is invalid. Restore your data backup; credentials have not been replaced.');
  }
  const ids = credentials.agents.map(a => a.id);
  const tokens = [credentials.ownerToken, ...credentials.agents.map(a => a.token)];
  if (new Set(ids).size !== ids.length || new Set(tokens).size !== tokens.length) {
    throw new Error('Local credentials contain duplicate identities or keys. Credentials have not been replaced.');
  }
}

async function atomicPrivateJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Updates keep version 1 and every unrecognized field; callers serialize mutations.
export async function saveCredentials(dataDir, credentials) {
  validateCredentials(credentials);
  await atomicPrivateJSON(resolve(dataDir, 'credentials.json'), credentials);
}

// This file carries exactly one identity's key, never the owner's or another agent's.
// It also records the workspace it belongs to, so a bridge that has to start the service starts the right one.
export async function writeConnectionCredential(dataDir, agent) {
  if (!validAgentId(agent.id)) throw new Error('Invalid connection identity.');
  const directory = resolve(dataDir, 'connections');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const path = resolve(directory, `${agent.id}.json`);
  await atomicPrivateJSON(path, { version: 1, agentId: agent.id, token: agent.token, dataDir: resolve(dataDir) });
  return path;
}

export async function ensureCredentials(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = resolve(dataDir, 'credentials.json');
  try {
    await writeFile(path, JSON.stringify({ version: 1, ownerToken: randomToken(), agents: [] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const credentials = JSON.parse(await readFile(path, 'utf8'));
  validateCredentials(credentials);
  if (process.platform !== 'win32') {
    await chmod(dataDir, 0o700);
    await chmod(path, 0o600);
  }
  return credentials;
}
