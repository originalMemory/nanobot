import { execFile } from 'node:child_process';

const GET_FOREGROUND_WINDOW = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NanobotFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@;
$handle = [NanobotFocus]::GetForegroundWindow();
[uint32]$processId = 0;
[void][NanobotFocus]::GetWindowThreadProcessId($handle, [ref]$processId);
"$($handle.ToInt64())|$processId"
`;

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export function nativeWindowHandleValue(handle: Buffer): string | null {
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString();
  if (handle.length >= 4) return handle.readUInt32LE(0).toString();
  return null;
}

export async function captureWindowsForegroundWindow(
  excludedHandle?: string | null,
): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const [handle, ownerProcessId] = (await runPowerShell(GET_FOREGROUND_WINDOW)).split('|');
    if (!/^\d+$/.test(handle) || handle === '0' || handle === excludedHandle) return null;
    if (ownerProcessId === String(process.pid)) return null;
    return handle;
  } catch (error) {
    console.warn('[shortcut] failed to capture Windows foreground window:', error);
    return null;
  }
}

export async function restoreWindowsForegroundWindow(handle: string | null): Promise<boolean> {
  if (process.platform !== 'win32' || !handle || !/^\d+$/.test(handle)) return false;
  const script = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NanobotFocusRestore {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@;
$handle = [IntPtr]${handle};
if ([NanobotFocusRestore]::IsWindow($handle)) {
  [void][NanobotFocusRestore]::ShowWindowAsync($handle, 9);
  [NanobotFocusRestore]::SetForegroundWindow($handle)
} else {
  $false
}
`;
  try {
    return (await runPowerShell(script)).toLowerCase() === 'true';
  } catch (error) {
    console.warn('[shortcut] failed to restore Windows foreground window:', error);
    return false;
  }
}
