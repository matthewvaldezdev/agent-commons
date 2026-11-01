#!/usr/bin/env node
// Builds dist/agent-commons-<version>.mcpb: a Claude Desktop extension people add from Settings, with nothing to paste.
// Usage: npm run pack:extension   (needs network once, to fetch the official @anthropic-ai/mcpb packer through npx)
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const stage = resolve(root, 'dist', 'extension');
const output = resolve(root, 'dist', `agent-commons-${pkg.version}.mcpb`);

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const entry of ['bin', 'src', 'public', 'package.json', 'LICENSE', 'README.md']) await cp(resolve(root, entry), resolve(stage, entry), { recursive: true });
await cp(resolve(root, 'extension', 'icon.png'), resolve(stage, 'icon.png'));
const manifest = JSON.parse(await readFile(resolve(root, 'extension', 'manifest.json'), 'utf8'));
manifest.version = pkg.version; // one version, kept in package.json
await writeFile(resolve(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const packer = ['-y', '@anthropic-ai/mcpb@2'];
execFileSync(npx, [...packer, 'validate', resolve(stage, 'manifest.json')], { stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync(npx, [...packer, 'pack', stage, output], { stdio: 'inherit', shell: process.platform === 'win32' });
console.log(`\nBuilt ${output}\nDouble-click it, or drag it into Claude Desktop > Settings > Extensions.`);
