// Opens an address in the person's default browser. Fire and forget: failures are reported by the caller's fallback text.
import { spawn } from 'node:child_process';

export function openBrowser(address, { platform = process.platform, env = process.env } = {}) {
  if (env.AGENT_COMMONS_NO_BROWSER === '1') return false;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', address] : [address];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}
