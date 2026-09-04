import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { ipcMain, type WebContents } from 'electron';

import type { ElectronConfigStore } from '../psb/store';

const SETTINGS_KEY = 'tts.pauseSystemMedia';
const COMMAND_TIMEOUT_MS = 8_000;

type SupportedPlatform = 'darwin' | 'win32';
type CommandRunner = (file: string, args: string[]) => Promise<string>;
type PauseToken = { platform: SupportedPlatform; targets: string[] };
type CommandFailure = Error & { stdout?: string };
export type SystemMediaSupport = 'system' | 'limited' | 'unavailable';
type MacNowPlaying = {
  bundleIdentifier: string;
  processIdentifier: number;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
};

const MEDIA_CONTROL_TARGET_PREFIX = 'media-control:';

const MAC_PAUSE_SCRIPTS: Record<string, string> = {
  Music: `
if application "Music" is not running then return "skipped"
tell application "Music"
  if player state is not playing then return "skipped"
  pause
end tell
return "paused"
`,
  Spotify: `
if application "Spotify" is not running then return "skipped"
set stateScript to "tell application " & quote & "Spotify" & quote & " to return (player state as text) = " & quote & "playing" & quote
if not (run script stateScript) then return "skipped"
run script ("tell application " & quote & "Spotify" & quote & " to pause")
return "paused"
`,
};

const MAC_RESUME_SCRIPTS: Record<string, string> = {
  Music: `
if application "Music" is not running then return "skipped"
tell application "Music"
  if player state is not paused then return "skipped"
  play
end tell
return "resumed"
`,
  Spotify: `
if application "Spotify" is not running then return "skipped"
set stateScript to "tell application " & quote & "Spotify" & quote & " to return (player state as text) = " & quote & "paused" & quote
if not (run script stateScript) then return "skipped"
run script ("tell application " & quote & "Spotify" & quote & " to play")
return "resumed"
`,
};

const WINDOWS_AWAIT_HELPER = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
function Await-WinRt($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
function Get-SessionKey($session, $seen) {
  $source = [string]$session.SourceAppUserModelId
  try {
    $properties = Await-WinRt ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $identity = $source + [char]31 + [string]$properties.Title + [char]31 + [string]$properties.Artist + [char]31 + [string]$properties.AlbumTitle
  } catch {
    $identity = $source
  }
  $ordinal = if ($seen.ContainsKey($identity)) { [int]$seen[$identity] } else { 0 }
  $seen[$identity] = $ordinal + 1
  $rawKey = $identity + [char]31 + $ordinal
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rawKey))
}
`;

function windowsPauseScript(): string {
  return `${WINDOWS_AWAIT_HELPER}
$seen = @{}
foreach ($session in @($manager.GetSessions())) {
  $key = Get-SessionKey $session $seen
  if ([int]$session.GetPlaybackInfo().PlaybackStatus -ne 4) { continue }
  try {
    if (Await-WinRt ($session.TryPauseAsync()) ([bool])) { Write-Output $key }
  } catch { }
}
`;
}

function windowsResumeScript(targets: string[]): string {
  const encodedTargets = Buffer.from(JSON.stringify(targets), 'utf8').toString('base64');
  return `${WINDOWS_AWAIT_HELPER}
$targetJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTargets}'))
$targets = @($targetJson | ConvertFrom-Json)
$failed = [System.Collections.Generic.List[string]]::new()
$matched = [System.Collections.Generic.HashSet[string]]::new()
$presentSources = [System.Collections.Generic.HashSet[string]]::new()
$seen = @{}
foreach ($session in @($manager.GetSessions())) {
  [void]$presentSources.Add([string]$session.SourceAppUserModelId)
  $key = Get-SessionKey $session $seen
  if ($targets -notcontains $key) { continue }
  [void]$matched.Add($key)
  if ([int]$session.GetPlaybackInfo().PlaybackStatus -eq 5) {
    try {
      if (-not (Await-WinRt ($session.TryPlayAsync()) ([bool]))) { $failed.Add($key) }
    } catch { $failed.Add($key) }
  }
}
foreach ($target in $targets) {
  if ($matched.Contains($target)) { continue }
  $rawKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($target))
  $source = $rawKey.Split([char]31)[0]
  if ($presentSources.Contains($source)) { $failed.Add($target) }
}
Write-Output (ConvertTo-Json -Compress -InputObject @($failed))
`;
}

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) reject(Object.assign(error, { stdout }));
        else resolve(stdout);
      },
    );
  });
}

function powershellArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

function parseTargets(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return [...new Set(values.filter((value): value is string => typeof value === 'string' && !!value))];
  } catch {
    return [...new Set(trimmed.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  }
}

function resolveMacMediaControlPath(): string | null {
  const candidates = ['/opt/homebrew/bin/media-control', '/usr/local/bin/media-control'];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function parseMacNowPlaying(output: string): MacNowPlaying {
  const value = JSON.parse(output) as Record<string, unknown>;
  if (
    typeof value.bundleIdentifier !== 'string'
    || typeof value.processIdentifier !== 'number'
    || typeof value.title !== 'string'
    || typeof value.playing !== 'boolean'
  ) {
    throw new Error('invalid_media_control_output');
  }
  return {
    bundleIdentifier: value.bundleIdentifier,
    processIdentifier: value.processIdentifier,
    title: value.title,
    artist: typeof value.artist === 'string' ? value.artist : '',
    album: typeof value.album === 'string' ? value.album : '',
    playing: value.playing,
  };
}

function encodeMacNowPlaying(value: MacNowPlaying): string {
  const identity: Omit<MacNowPlaying, 'playing'> = {
    bundleIdentifier: value.bundleIdentifier,
    processIdentifier: value.processIdentifier,
    title: value.title,
    artist: value.artist,
    album: value.album,
  };
  return MEDIA_CONTROL_TARGET_PREFIX
    + Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
}

function decodeMacNowPlaying(target: string): Omit<MacNowPlaying, 'playing'> | null {
  if (!target.startsWith(MEDIA_CONTROL_TARGET_PREFIX)) return null;
  try {
    const raw = Buffer.from(target.slice(MEDIA_CONTROL_TARGET_PREFIX.length), 'base64').toString('utf8');
    return JSON.parse(raw) as Omit<MacNowPlaying, 'playing'>;
  } catch {
    return null;
  }
}

function isSameMacMedia(
  current: MacNowPlaying,
  expected: Omit<MacNowPlaying, 'playing'>,
): boolean {
  return current.bundleIdentifier === expected.bundleIdentifier
    && current.processIdentifier === expected.processIdentifier
    && current.title === expected.title
    && current.artist === expected.artist
    && current.album === expected.album;
}

async function readPausedMacMedia(
  path: string,
  run: CommandRunner,
  fallback: MacNowPlaying,
): Promise<MacNowPlaying> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await delay(100);
    try {
      const current = parseMacNowPlaying(await run(path, ['get', '--no-artwork']));
      if (!current.playing) return current;
    } catch {
      break;
    }
  }
  return fallback;
}

async function pausePlatformMedia(
  platform: NodeJS.Platform,
  run: CommandRunner,
  macMediaControlPath: string | null,
): Promise<PauseToken | null> {
  if (platform === 'darwin') {
    if (macMediaControlPath) {
      try {
        const current = parseMacNowPlaying(
          await run(macMediaControlPath, ['get', '--no-artwork']),
        );
        if (!current.playing) return null;
        const target = encodeMacNowPlaying(current);
        try {
          await run(macMediaControlPath, ['pause']);
        } catch {
          // 命令可能已送达但进程异常退出；保留 token，恢复阶段会重新查状态。
        }
        const paused = await readPausedMacMedia(macMediaControlPath, run, current);
        return { platform, targets: [paused.playing ? target : encodeMacNowPlaying(paused)] };
      } catch {
        // CLI 不可用时继续走兼容 fallback。
      }
    }
    const targets: string[] = [];
    for (const [appName, script] of Object.entries(MAC_PAUSE_SCRIPTS)) {
      try {
        if ((await run('/usr/bin/osascript', ['-e', script])).trim() === 'paused') {
          targets.push(appName);
        }
      } catch {
        // 单个播放器失败不能丢掉此前已经暂停的目标。
      }
    }
    return targets.length > 0 ? { platform, targets } : null;
  }
  if (platform === 'win32') {
    let output = '';
    try {
      output = await run('powershell.exe', powershellArgs(windowsPauseScript()));
    } catch (error) {
      output = (error as CommandFailure).stdout ?? '';
    }
    const targets = parseTargets(output);
    return targets.length > 0 ? { platform, targets } : null;
  }
  return null;
}

async function resumePlatformMedia(
  token: PauseToken,
  run: CommandRunner,
  macMediaControlPath: string | null,
  shouldResume: () => boolean,
): Promise<string[]> {
  if (token.platform === 'darwin') {
    const failed: string[] = [];
    for (const target of token.targets) {
      const media = decodeMacNowPlaying(target);
      if (media) {
        if (!macMediaControlPath) {
          failed.push(target);
          continue;
        }
        try {
          const current = parseMacNowPlaying(
            await run(macMediaControlPath, ['get', '--no-artwork']),
          );
          if (isSameMacMedia(current, media) && !current.playing) {
            if (!shouldResume()) {
              failed.push(target);
              continue;
            }
            await run(macMediaControlPath, ['play']);
          }
        } catch {
          failed.push(target);
        }
        continue;
      }
      const appName = target;
      const script = MAC_RESUME_SCRIPTS[appName];
      if (!script) continue;
      if (!shouldResume()) {
        failed.push(appName);
        continue;
      }
      try {
        await run('/usr/bin/osascript', ['-e', script]);
      } catch {
        failed.push(appName);
      }
    }
    return failed;
  }
  if (!shouldResume()) return token.targets;
  const output = await run('powershell.exe', powershellArgs(windowsResumeScript(token.targets)));
  return parseTargets(output);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SystemMediaController {
  private enabled: boolean;
  private readonly activeSources = new Set<number>();
  private token: PauseToken | null = null;
  private chain = Promise.resolve();

  constructor(
    private readonly store: ElectronConfigStore,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: CommandRunner = runFile,
    private readonly macMediaControlPath: string | null = resolveMacMediaControlPath(),
  ) {
    this.enabled = store.get(SETTINGS_KEY) === true;
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  async getSupport(): Promise<SystemMediaSupport> {
    if (this.platform === 'win32') return 'system';
    if (this.platform === 'darwin' && this.macMediaControlPath) {
      try {
        await this.run(this.macMediaControlPath, ['test']);
        return 'system';
      } catch {
        return 'limited';
      }
    }
    if (this.platform === 'darwin') return 'limited';
    return 'unavailable';
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.store.set(SETTINGS_KEY, enabled);
    return this.reconcile();
  }

  setTtsActive(sourceId: number, active: boolean): Promise<void> {
    if (active) this.activeSources.add(sourceId);
    else this.activeSources.delete(sourceId);
    return this.reconcile();
  }

  async dispose(): Promise<void> {
    this.activeSources.clear();
    this.enabled = false;
    await Promise.race([this.reconcile(), delay(5_000)]);
  }

  private reconcile(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const ttsActive = this.activeSources.size > 0;
      if (this.enabled && ttsActive && !this.token) {
        try {
          this.token = await pausePlatformMedia(
            this.platform,
            this.run,
            this.macMediaControlPath,
          );
        } catch (error) {
          console.warn('[system-media] 暂停外部媒体失败:', error);
        }
        return;
      }
      if ((!this.enabled || !ttsActive) && this.token) {
        if (this.enabled) {
          await delay(100);
          if (this.activeSources.size > 0) return;
        }
        const token = this.token;
        let remaining = token.targets;
        for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
          const shouldResume = () => !this.enabled || this.activeSources.size === 0;
          if (!shouldResume()) break;
          if (attempt > 0) await delay(150);
          try {
            remaining = await resumePlatformMedia(
              { ...token, targets: remaining },
              this.run,
              this.macMediaControlPath,
              shouldResume,
            );
          } catch (error) {
            if (attempt === 1) console.warn('[system-media] 恢复外部媒体失败:', error);
          }
        }
        if (remaining.length > 0 && (!this.enabled || this.activeSources.size === 0)) {
          console.warn(`[system-media] ${remaining.length} 个外部媒体会话恢复失败，保留待重试`);
        }
        this.token = remaining.length > 0 ? { ...token, targets: remaining } : null;
      }
    });
    return this.chain;
  }
}

export function registerSystemMediaIpcHandlers(
  store: ElectronConfigStore,
): SystemMediaController {
  const controller = new SystemMediaController(store);
  const boundSenders = new Set<number>();
  const bindSenderLifecycle = (sender: WebContents) => {
    if (boundSenders.has(sender.id)) return;
    boundSenders.add(sender.id);
    const release = () => {
      sender.removeListener('destroyed', release);
      sender.removeListener('render-process-gone', release);
      boundSenders.delete(sender.id);
      void controller.setTtsActive(sender.id, false);
    };
    sender.once('destroyed', release);
    sender.once('render-process-gone', release);
  };
  ipcMain.handle('system-media:get-enabled', () => controller.getEnabled());
  ipcMain.handle('system-media:get-support', () => controller.getSupport());
  ipcMain.handle('system-media:set-enabled', (_event, enabled: unknown) =>
    controller.setEnabled(enabled === true).then(() => controller.getEnabled()));
  ipcMain.handle('system-media:set-tts-active', (event, active: unknown) => {
    bindSenderLifecycle(event.sender);
    return controller.setTtsActive(event.sender.id, active === true);
  });
  return controller;
}
