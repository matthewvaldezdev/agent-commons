// Client configs and the background service must point at files that will still exist next month.
// When Agent Commons runs from the npx cache (which npm may clean at any time), copy it into the
// workspace once and point everything at that copy instead.
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { packageDir, version } from './paths.mjs';

export const isEphemeral = (dir = packageDir, env = process.env) =>
  env.AGENT_COMMONS_STABLE_RUNTIME === '1' || dir.split(sep).includes('_npx') || dir.includes(`${sep}_npx${sep}`);

// Returns { dir, bin, mcp }: the package directory configs should reference.
export async function stableRuntime(dataDir, { from = packageDir, env = process.env } = {}) {
  if (!isEphemeral(from, env)) return paths(from);
  const target = resolve(dataDir, 'runtime');
  const installed = await readFile(resolve(target, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => null);
  if (installed !== version) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const staging = `${target}.${process.pid}.tmp`;
    await rm(staging, { recursive: true, force: true });
    for (const entry of ['bin', 'src', 'public', 'package.json', 'LICENSE']) {
      await cp(resolve(from, entry), resolve(staging, entry), { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  }
  return paths(target);
}

const paths = dir => ({ dir, bin: resolve(dir, 'bin', 'agent-commons.mjs'), mcp: resolve(dir, 'src', 'mcp.mjs') });
