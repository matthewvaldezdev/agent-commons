// Writes an Agent Commons entry into an MCP client's own configuration, the way a person would by hand,
// but without the risky part: every other setting is kept, a timestamped backup is written beside the file,
// the write is atomic, and running it twice changes nothing.
import { readFile, writeFile, rename, copyFile, stat, mkdir, unlink, access, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve, dirname, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const run = promisify(execFile);

const appData = (env, home) => env.APPDATA || resolve(home, 'AppData', 'Roaming');

// Where each client keeps its MCP servers, how to tell it is installed, and how to restart it.
export function clientTargets({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const claudeDir = platform === 'darwin' ? resolve(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? resolve(appData(env, home), 'Claude') : resolve(env.XDG_CONFIG_HOME || resolve(home, '.config'), 'Claude');
  const codexHome = env.CODEX_HOME || resolve(home, '.codex');
  return {
    'claude-desktop': { title: 'Claude Desktop', format: 'json', file: resolve(claudeDir, 'claude_desktop_config.json'), detect: [claudeDir], app: 'claude-desktop', extensions: resolve(claudeDir, 'Claude Extensions') },
    'claude-code': { title: 'Claude Code', format: 'cli', command: 'claude', detect: [resolve(home, '.claude.json'), resolve(home, '.claude')], cli: true },
    codex: { title: 'Codex', format: 'toml', file: resolve(codexHome, 'config.toml'), detect: [codexHome], cli: true },
    cursor: { title: 'Cursor', format: 'json', file: resolve(home, '.cursor', 'mcp.json'), detect: [resolve(home, '.cursor')], app: 'cursor' },
    windsurf: { title: 'Windsurf', format: 'json', file: resolve(home, '.codeium', 'windsurf', 'mcp_config.json'), detect: [resolve(home, '.codeium', 'windsurf')], app: 'windsurf' },
    gemini: { title: 'Gemini CLI', format: 'json', file: resolve(home, '.gemini', 'settings.json'), detect: [resolve(home, '.gemini')], cli: true },
  };
}

const exists = path => access(path).then(() => true, () => false);

export async function findOnPath(command, { platform = process.platform, env = process.env } = {}) {
  const names = platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const name of names) if (await exists(resolve(dir, name))) return resolve(dir, name);
  }
  return null;
}

// Clients that look installed on this computer, in a stable order.
export async function detectClients(options = {}) {
  const targets = clientTargets(options);
  const found = [];
  for (const [id, target] of Object.entries(targets)) {
    let present = false;
    for (const path of target.detect) if (await exists(path)) { present = true; break; }
    if (!present && target.command) present = Boolean(await findOnPath(target.command, options));
    if (present) found.push(id);
  }
  return found;
}

const stamp = (now = new Date()) => now.toISOString().replace(/[:.]/g, '-');

async function writeAtomic(file, content, mode) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: mode ?? 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function readExisting(file) {
  try { return { text: await readFile(file, 'utf8'), mode: (await stat(file)).mode & 0o777 }; }
  catch (error) { if (error.code === 'ENOENT') return { text: null, mode: undefined }; throw error; }
}

async function backup(file, now) {
  const path = `${file}.agent-commons-backup-${stamp(now)}`;
  await copyFile(file, path);
  return path;
}

// JSON clients: put the entry under mcpServers[key]. The file is re-serialized with its own indentation,
// so unchanged settings keep their exact values; nothing outside mcpServers[key] is touched.
export async function installJson(file, key, entry, { now } = {}) {
  const { text, mode } = await readExisting(file);
  let config = {};
  if (text !== null && text.trim()) {
    try { config = JSON.parse(text); }
    catch { throw new Error(`${file} is not valid JSON, so it was left alone. Fix or move it, then run this again.`); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file} does not contain a JSON object, so it was left alone.`);
  }
  const servers = config.mcpServers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`mcpServers in ${file} is not an object, so it was left alone.`);
  const previous = servers[key];
  if (isDeepStrictEqual(previous, entry)) return { status: 'unchanged', file };
  const indent = text?.match(/\n([ \t]+)"/)?.[1] ?? 2;
  const next = { ...config, mcpServers: { ...servers, [key]: entry } };
  const saved = text === null ? null : await backup(file, now);
  await writeAtomic(file, JSON.stringify(next, null, indent) + (text === null || text.endsWith('\n') ? '\n' : ''), mode);
  return { status: previous === undefined ? 'added' : 'updated', file, backup: saved };
}

const tomlString = value => JSON.stringify(value);
export const tomlBlock = (key, entry) => `[mcp_servers.${tomlString(key)}]\ncommand = ${tomlString(entry.command)}\nargs = [${entry.args.map(tomlString).join(', ')}]\n`;

// Codex: one [mcp_servers."key"] table in config.toml, replaced in place or appended. Other tables, comments,
// the file's line endings and its final newline are kept. An entry written some other way is left for a person.
export async function installToml(file, key, entry, { now } = {}) {
  const { text, mode } = await readExisting(file);
  const source = text ?? '';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const block = tomlBlock(key, entry).trimEnd().split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedKey = `(?:"${escaped}"|'${escaped}'|${escaped})`;
  const header = new RegExp(`^\\s*\\[mcp_servers\\.${quotedKey}\\]\\s*(#.*)?$`);
  // An entry written as an inline table (under [mcp_servers], or as mcp_servers.key = {...}) is not ours to rewrite.
  let inServersTable = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) { inServersTable = /^\s*\[mcp_servers\]\s*(#.*)?$/.test(line); continue; }
    if (new RegExp(`^\\s*mcp_servers\\.${quotedKey}\\s*=`).test(line) || (inServersTable && new RegExp(`^\\s*${quotedKey}\\s*=`).test(line))) {
      throw new Error(`${file} already defines ${key} in a form this tool does not edit. Remove that entry, then run this again.`);
    }
  }
  const start = lines.findIndex(line => header.test(line));
  let next;
  let status;
  if (start === -1) {
    const body = source.replace(/(\r?\n)+$/, '');
    next = (body ? `${body}${eol}${eol}` : '') + block.join(eol) + eol;
    status = 'added';
  } else {
    let end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
    if (end === -1) end = lines.length;
    // Comments and blank lines just above the next table belong to that table.
    let last = end;
    while (last - 1 > start && /^\s*(#.*)?$/.test(lines[last - 1])) last--;
    const current = lines.slice(start, last).join('\n').trim();
    if (current === block.join('\n').trim()) return { status: 'unchanged', file };
    next = [...lines.slice(0, start), ...block, ...lines.slice(last)].join(eol);
    if (source.endsWith(eol) && !next.endsWith(eol)) next += eol;
    status = 'updated';
  }
  const saved = text === null ? null : await backup(file, now);
  await writeAtomic(file, next, mode);
  return { status, file, backup: saved };
}

// Runs the claude CLI. On Windows it is claude.cmd, which needs cmd.exe; quote the whole line the way Node's own
// shell option does, so paths with spaces survive /s and % is not expanded.
export function runClaude(claude, args, { platform = process.platform, env = process.env, runner = run, timeout = 30000 } = {}) {
  if (platform !== 'win32') return runner(claude, args, { env, timeout });
  const quote = arg => `"${String(arg).replace(/"/g, '""').replace(/%/g, '"^%"')}"`;
  return runner(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[claude, ...args].map(quote).join(' ')}"`], { env, timeout, windowsVerbatimArguments: true });
}

// Claude Code keeps user-scope servers in ~/.claude.json, which it rewrites while running, so use its own CLI.
export async function installClaudeCode(key, entry, { platform = process.platform, env = process.env, runner = run } = {}) {
  const claude = await findOnPath('claude', { platform, env });
  if (!claude) return { status: 'manual', reason: 'The claude command was not found on PATH.' };
  const call = args => runClaude(claude, args, { platform, env, runner });
  const existing = await call(['mcp', 'get', key]).then(r => r.stdout, () => null);
  if (existing !== null && entry.args.every(arg => existing.includes(arg)) && existing.includes(entry.command)) return { status: 'unchanged', file: 'claude mcp (user scope)' };
  if (existing !== null) await call(['mcp', 'remove', '--scope', 'user', key]).catch(() => {});
  await call(['mcp', 'add', '--scope', 'user', key, '--', entry.command, ...entry.args]);
  return { status: existing === null ? 'added' : 'updated', file: 'claude mcp (user scope)' };
}

// True when the Agent Commons Claude Desktop extension is installed, so a config entry would load it twice.
export async function hasDesktopExtension(options = {}) {
  const dir = clientTargets(options)['claude-desktop'].extensions;
  return (await readdir(dir).catch(() => [])).some(name => /agent-commons/i.test(name));
}

export async function installClient(client, key, entry, options = {}) {
  const target = clientTargets(options)[client];
  if (!target) throw new Error(`No installer for ${client}.`);
  if (client === 'claude-desktop' && await hasDesktopExtension(options)) return { status: 'unchanged', file: 'the Agent Commons extension', extension: true, title: target.title };
  if (target.format === 'json') return { ...await installJson(target.file, key, entry, options), title: target.title };
  if (target.format === 'toml') return { ...await installToml(target.file, key, entry, options), title: target.title };
  return { ...await installClaudeCode(key, entry, options), title: target.title };
}

// Main-process patterns per desktop app. Electron helper processes carry --type= and are skipped.
const APP_PATTERNS = {
  'claude-desktop': { darwin: /\/Claude\.app\/Contents\/MacOS\/Claude(\s|$)/, linux: /claude-desktop|\/opt\/Claude\/|\/Claude(\.AppImage)?(\s|$)/, win32: 'Claude', exclude: /claude-code|@anthropic-ai|agent-commons/ },
  cursor: { darwin: /\/Cursor\.app\/Contents\/MacOS\/Cursor(\s|$)/, linux: /\/cursor(\s|$)|[Cc]ursor[^/]*\.AppImage|\/share\/cursor\//, win32: 'Cursor' },
  windsurf: { darwin: /\/Windsurf\.app\/Contents\/MacOS\/Windsurf(\s|$)/, linux: /\/windsurf(\s|$)|\/share\/windsurf\//, win32: 'Windsurf' },
};

// When the app's oldest running process started, or null if it is not running.
export async function appStartTime(app, { platform = process.platform, runner = run } = {}) {
  const pattern = APP_PATTERNS[app];
  if (!pattern) return null;
  if (platform === 'win32') {
    const script = `Get-Process -Name '${pattern.win32}' -ErrorAction SilentlyContinue | ForEach-Object { $_.StartTime.ToString('o') }`;
    const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).catch(() => ({ stdout: '' }));
    const times = stdout.split(/\r?\n/).map(s => Date.parse(s.trim())).filter(Number.isFinite);
    return times.length ? new Date(Math.min(...times)) : null;
  }
  const { stdout } = await runner('ps', ['-A', '-o', 'lstart=', '-o', 'args=']).catch(() => ({ stdout: '' }));
  const match = pattern[platform];
  if (!match) return null;
  const times = [];
  for (const line of stdout.split('\n')) {
    const started = Date.parse(line.slice(0, 24));
    const args = line.slice(24).trim();
    if (!Number.isFinite(started) || !args || /--type=/.test(args) || pattern.exclude?.test(args)) continue;
    if (match.test(args)) times.push(started);
  }
  return times.length ? new Date(Math.min(...times)) : null;
}

const QUIT = {
  darwin: title => `Quit ${title} with Cmd+Q (closing the window is not enough), then open it again.`,
  win32: title => `Quit ${title} from its icon in the system tray (closing the window is not enough), then open it again.`,
  linux: title => `Quit ${title} from its tray icon menu (closing the window is not enough), then open it again.`,
};

// Tells the person what to do so the client actually loads the new entry.
export async function restartAdvice(client, file, options = {}) {
  const target = clientTargets(options)[client];
  if (!target) return null;
  if (target.cli) return { needed: true, message: `Start a new ${target.title} session to load it.` };
  const platform = options.platform || process.platform;
  const started = await appStartTime(target.app, options);
  const quit = (QUIT[platform] || QUIT.linux)(target.title);
  if (!started) return { needed: false, message: `${target.title} is not running. It will load Agent Commons the next time it opens.` };
  const modified = file ? await stat(file).then(s => s.mtime, () => null) : null;
  if (modified && started >= modified) return { needed: false, running: started, message: `${target.title} started after this change, so it has loaded it.` };
  return { needed: true, running: started, message: `${target.title} has been running since ${started.toLocaleString()}, before this change. ${quit}` };
}
