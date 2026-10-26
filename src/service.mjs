// Installs Agent Commons as a per-user background service so it is always available.
// macOS: launchd LaunchAgent. Linux: systemd user unit. Windows: Task Scheduler logon task.
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { binPath } from './paths.mjs';

const run = promisify(execFile);
const LABEL = 'dev.agent-commons.server';

const escapeXml = value => value.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function plan({ platform = process.platform, port, dataDir, nodePath = process.execPath, home = homedir() }) {
  const args = [binPath, 'serve', '--port', String(port), '--data-dir', dataDir];
  const logDir = resolve(dataDir, 'logs');
  if (platform === 'darwin') {
    const file = resolve(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${[nodePath, ...args].map(a => `<string>${escapeXml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(resolve(logDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(resolve(logDir, 'server.log'))}</string>
</dict></plist>
`;
    return { platform, file, content, logDir,
      install: async () => { await run('launchctl', ['unload', file]).catch(() => {}); await run('launchctl', ['load', '-w', file]); },
      uninstall: async () => { await run('launchctl', ['unload', '-w', file]).catch(() => {}); },
      status: async () => (await run('launchctl', ['list']).catch(() => ({ stdout: '' }))).stdout.includes(LABEL) };
  }
  if (platform === 'linux') {
    const file = resolve(process.env.XDG_CONFIG_HOME || resolve(home, '.config'), 'systemd', 'user', 'agent-commons.service');
    const quote = a => `"${a.replace(/(["\\])/g, '\\$1')}"`;
    const content = `[Unit]
Description=Agent Commons local message rooms for AI agents
After=default.target

[Service]
ExecStart=${[nodePath, ...args].map(quote).join(' ')}
Restart=always
RestartSec=2
StandardOutput=append:${resolve(logDir, 'server.log')}
StandardError=append:${resolve(logDir, 'server.log')}

[Install]
WantedBy=default.target
`;
    return { platform, file, content, logDir,
      install: async () => { await run('systemctl', ['--user', 'daemon-reload']); await run('systemctl', ['--user', 'enable', '--now', 'agent-commons.service']); },
      uninstall: async () => { await run('systemctl', ['--user', 'disable', '--now', 'agent-commons.service']).catch(() => {}); await run('systemctl', ['--user', 'daemon-reload']).catch(() => {}); },
      status: async () => (await run('systemctl', ['--user', 'is-active', 'agent-commons.service']).catch(() => ({ stdout: '' }))).stdout.trim() === 'active' };
  }
  if (platform === 'win32') {
    const file = resolve(dataDir, 'service', 'agent-commons.cmd');
    const content = `@echo off\r\n"${nodePath}" ${args.map(a => `"${a}"`).join(' ')} >> "${resolve(logDir, 'server.log')}" 2>&1\r\n`;
    const task = 'AgentCommons';
    return { platform, file, content, logDir,
      install: async () => {
        await run('schtasks', ['/Create', '/F', '/TN', task, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TR', `wscript.exe //B "${resolve(dataDir, 'service', 'start-hidden.vbs')}"`]);
        await run('schtasks', ['/Run', '/TN', task]);
      },
      uninstall: async () => { await run('schtasks', ['/End', '/TN', task]).catch(() => {}); await run('schtasks', ['/Delete', '/F', '/TN', task]).catch(() => {}); },
      status: async () => (await run('schtasks', ['/Query', '/TN', task]).catch(() => ({ stdout: '' }))).stdout.includes(task),
      extraFiles: [[resolve(dataDir, 'service', 'start-hidden.vbs'), `CreateObject("Wscript.Shell").Run """${file}""", 0, False\r\n`]] };
  }
  throw new Error(`Service installation is not supported on ${platform}. Run "agent-commons serve" from your own process manager instead.`);
}

export async function installService(options) {
  const p = plan(options);
  await mkdir(p.logDir, { recursive: true });
  await mkdir(resolve(p.file, '..'), { recursive: true });
  await writeFile(p.file, p.content);
  for (const [path, content] of p.extraFiles || []) await writeFile(path, content);
  await p.install();
  return { file: p.file, logDir: p.logDir };
}

export async function uninstallService(options) {
  const p = plan(options);
  await p.uninstall();
  await unlink(p.file).catch(() => {});
  for (const [path] of p.extraFiles || []) await unlink(path).catch(() => {});
  return { file: p.file };
}

export async function serviceStatus(options) {
  const p = plan(options);
  const installed = await readFile(p.file, 'utf8').then(() => true, () => false);
  return { installed, active: installed && await p.status(), file: p.file, logDir: p.logDir };
}

export const previewService = options => plan(options);
