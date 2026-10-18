import 'dotenv/config';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray
} from 'electron';
import { exec, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DoubaoVoiceTransport } from './doubao-voice-transport';
import { loadEnvironment } from './environment';
import {
  ensureSpeakerVerifierReady,
  extractEnrollmentEmbedding,
  loadOwnerEmbedding,
  setOwnerEmbeddingCache,
  verifySpeaker,
} from './speaker-verify-native';
import os from 'node:os';
import { modelConfig } from '../renderer/model-config';
import { describeWeather, type WeatherCoordinates } from './weather';

// Coarse device location for weather. Resolved through the renderer's
// navigator.geolocation (browser Geolocation API) via executeJavaScript, so no
// native helper needs to be compiled or bundled.
//
// Cached for ten minutes: geolocation takes a moment and a laptop does not
// move between two weather questions. A failed or denied lookup is cached as
// null for the same period so a denial does not re-prompt every ask — the
// weather tool then falls back to JARVIS_DEFAULT_CITY, exactly the old
// behaviour.
let coarseLocationCache: { at: number; value: WeatherCoordinates | null } | null = null;
let coarseLocationInFlight: Promise<WeatherCoordinates | null> | null = null;
const coarseLocationTtlMs = 10 * 60_000;

function getCoarseLocation(): Promise<WeatherCoordinates | null> {
  if (coarseLocationCache && Date.now() - coarseLocationCache.at < coarseLocationTtlMs) {
    return Promise.resolve(coarseLocationCache.value);
  }
  if (coarseLocationInFlight) return coarseLocationInFlight;

  coarseLocationInFlight = (async (): Promise<WeatherCoordinates | null> => {
    const targetWindow = jarvisWindow ?? voiceWindow;
    if (!targetWindow) {
      log(`Coarse location unavailable (no renderer window yet); weather falls back to the default city.`);
      coarseLocationCache = { at: Date.now(), value: null };
      return null;
    }
    try {
      const result = await targetWindow.webContents.executeJavaScript(
        `new Promise((resolve) => {
          if (!('geolocation' in navigator)) { resolve(null); return; }
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
          );
        })`,
        true
      ) as { latitude: number; longitude: number } | null;
      if (
        result
        && Number.isFinite(result.latitude)
        && Number.isFinite(result.longitude)
      ) {
        const value = { latitude: result.latitude, longitude: result.longitude };
        log(`Coarse location resolved for weather.`);
        coarseLocationCache = { at: Date.now(), value };
        return value;
      }
      log(`Coarse location unavailable; weather falls back to the default city.`);
      coarseLocationCache = { at: Date.now(), value: null };
      return null;
    } catch (error) {
      log(`Coarse location failed: ${error instanceof Error ? error.message : String(error)}`);
      coarseLocationCache = { at: Date.now(), value: null };
      return null;
    } finally {
      coarseLocationInFlight = null;
    }
  })();
  return coarseLocationInFlight;
}

type JarvisState = 'idle' | 'listening' | 'thinking' | 'speaking';
type JarvisGesture =
  | 'turn'
  | 'nod'
  | 'shake'
  | 'spin'
  | 'spin-clockwise'
  | 'spin-counterclockwise'
  | 'face-front'
  | 'face-back'
  | 'face-left'
  | 'face-right';
type AvatarVisibilityMode =
  | 'sleeping'
  | 'auto'
  | 'forced-visible'
  | 'forced-hidden'
  | 'docked';

// —— 头盔在屏幕上的显示尺寸 / 位置（模型的屏幕大小与位置只由 anchor 矩形决定）——
// 对话 / 唤醒时居中显示的边长（像素）。调大=模型更大。原值 480，现约放大 2 倍。
const HELMET_ACTIVE_SIZE = 960;
// 执行“打开应用”等可见操作后，缩小常驻到屏幕右下角时的边长（像素）。
const HELMET_DOCKED_SIZE = 220;
// 常驻角落时距屏幕右 / 下边缘的留白（像素）。
const HELMET_DOCK_MARGIN = 24;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let jarvisWindow: BrowserWindow | null = null;
let voiceWindow: BrowserWindow | null = null;
let wakeEnrollmentWindow: BrowserWindow | null = null;
let appIsQuitting = false;
let tray: Tray | null = null;
let currentPersonalWakeMode: 'off' | 'shadow' | 'active' = 'off';
// 全息投影模式运行时开关：托盘可实时切换；初值取 modelConfig.hologram.enabled。
// 关闭时定时触发与语音触发都会被这里拦下，视觉窗口收到 'hide' 强制复位。
let hologramModeEnabled = modelConfig.hologram.enabled;
// 全息常显：托盘「全息常显」开启后模型一直保持全息形态，不自动降落。
// 唤醒装配会先复位，装配展示完成后由 presentAssemblyWindow 自动重新进入。
let hologramPersistent = false;
let hologramShowTimer: ReturnType<typeof setInterval> | null = null;
// 当前会话状态：仅在 idle（无对话）时允许定时全息自动展示，
// listening/thinking/speaking 沟通期间一律不触发。
let currentJarvisState: JarvisState = 'idle';
let awaitingAssemblyFrame = false;
let awaitingAssemblySound = false;
let assemblyRecoveryAttempts = 0;
let assemblyShowTimer: ReturnType<typeof setTimeout> | null = null;
let assemblySoundFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let avatarVisibilityMode: AvatarVisibilityMode = 'sleeping';
let actionVisibilityGraceUntil = 0;
let clearDesktopChecks = 0;
let windowMonitorTimer: ReturnType<typeof setInterval> | null = null;
let windowMonitorInFlight = false;
let windowMonitorWarningLogged = false;
type AudioDiagnosticEntry = { at: string; summary: string };
let recentAudioDiagnostics: AudioDiagnosticEntry[] = [];
type VoiceEventEntry = { at: string; message: string };
let recentVoiceEvents: VoiceEventEntry[] = [];

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Writing to stdout throws EIO once the launching terminal is gone, and an
// uncaught EIO in the main process kills the whole app. This happens whenever
// the app outlives the shell that started it, and always for a packaged .app
// launched from Finder. Console output is a convenience; the log file is the
// record. Never let the convenience take the process down.
function writeConsole(line: string) {
  try {
    console.log(line);
  } catch {
    // stdout is gone. Nothing to do and nothing worth reporting.
  }
}

function log(message: string) {
  const line = `[${new Date().toISOString()}] [Ashley] ${message}`;
  writeConsole(line);
  const logPath = process.env.JARVIS_DEBUG_LOG || path.join(app.getPath('userData'), 'runtime.log');
  void fs.appendFile(logPath, `${line}\n`).catch(() => undefined);
}

const doubaoVoiceTransport = new DoubaoVoiceTransport(log);

async function persistAudioDiagnostic(summary: string) {
  const entry = { at: new Date().toISOString(), summary };
  recentAudioDiagnostics = [...recentAudioDiagnostics, entry].slice(-24);
  try {
    await fs.writeFile(
      path.join(app.getPath('userData'), 'audio-diagnostics.json'),
      JSON.stringify(recentAudioDiagnostics, null, 2),
      'utf8'
    );
  } catch (error) {
    console.warn('[Ashley] Unable to persist audio diagnostics.', error);
  }
}

async function persistVoiceEvent(message: string) {
  const entry = { at: new Date().toISOString(), message };
  recentVoiceEvents = [...recentVoiceEvents, entry].slice(-80);
  try {
    await fs.writeFile(
      path.join(app.getPath('userData'), 'voice-events.json'),
      JSON.stringify(recentVoiceEvents, null, 2),
      'utf8'
    );
  } catch (error) {
    console.warn('[Ashley] Unable to persist voice events.', error);
  }
}

function getHelmetAnchor() {
  const display = screen.getPrimaryDisplay();
  const overlayBounds = display.bounds;
  const workArea = display.workArea;
  const size = HELMET_ACTIVE_SIZE;
  const originX = workArea.x - overlayBounds.x;
  const originY = workArea.y - overlayBounds.y;
  // 水平居中；垂直约在工作区 40% 处（略偏上）。clamp 保证放大后不超出工作区。
  const desiredX = Math.round((workArea.width - size) / 2);
  const desiredY = Math.round(workArea.height * 0.4 - size / 2);
  const maxX = Math.max(0, workArea.width - size);
  const maxY = Math.max(0, workArea.height - size);
  return {
    x: originX + THREE_clamp(desiredX, 0, maxX),
    y: originY + THREE_clamp(desiredY, 0, maxY),
    width: size,
    height: size
  };
}

// 可见操作（打开/关闭应用、搜索等）后，缩小常驻到屏幕右下角使用的 anchor。
function getDockedAnchor() {
  const display = screen.getPrimaryDisplay();
  const overlayBounds = display.bounds;
  const workArea = display.workArea;
  const size = HELMET_DOCKED_SIZE;
  return {
    x: workArea.x - overlayBounds.x + workArea.width - size - HELMET_DOCK_MARGIN,
    y: workArea.y - overlayBounds.y + workArea.height - size - HELMET_DOCK_MARGIN,
    width: size,
    height: size
  };
}

function THREE_clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getVisualOverlayBounds() {
  return screen.getPrimaryDisplay().bounds;
}

function isTrustedVisualSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(jarvisWindow && event.sender === jarvisWindow.webContents);
}

function isTrustedVoiceSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(voiceWindow && event.sender === voiceWindow.webContents);
}

function isTrustedWakeEnrollmentSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(wakeEnrollmentWindow && event.sender === wakeEnrollmentWindow.webContents);
}

function personalWakeModelPath() {
  return path.join(app.getPath('userData'), 'personal-wake-model.json');
}

function validatePersonalWakeModel(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const model = value as {
    version?: unknown;
    sampleRate?: unknown;
    mode?: unknown;
    samples?: unknown;
    embeddings?: unknown;
  };
  // Version 3 stores pre-computed speaker embeddings from the native
  // SpeakerEmbeddingExtractor (512-dim 3D-Speaker ERes2Net). Version 2
  // stored raw audio for the diarization verifier (now retired). Version 1
  // stored 96-dim openWakeWord templates (also retired).
  if (model.version !== 3) return false;
  if (Number(model.sampleRate) !== 16000) return false;
  if (!['off', 'shadow', 'active'].includes(String(model.mode))) return false;
  if (!Array.isArray(model.samples)) return false;
  const minSamples = Math.floor(16000 * 0.3);
  if (!(model.samples.length >= 3
    && model.samples.length <= 32
    && model.samples.every((sample) =>
      Array.isArray(sample)
      && sample.length >= minSamples
      && sample.length <= 16000 * 2
      && sample.every((entry) => Number.isFinite(entry))
    ))) return false;
  if (!Array.isArray(model.embeddings) || model.embeddings.length === 0) return false;
  return model.embeddings.every((emb: unknown) =>
    Array.isArray(emb)
    && emb.every((entry: unknown) => Number.isFinite(entry))
  );
}

async function readPersonalWakeModel() {
  try {
    const raw = await fs.readFile(personalWakeModelPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!validatePersonalWakeModel(parsed)) throw new Error('文件结构无效');
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log(`Personal wake model unavailable: ${error instanceof Error ? error.message : String(error)}.`);
    return null;
  }
}

async function writePersonalWakeModel(model: unknown) {
  if (!validatePersonalWakeModel(model)) throw new Error('个人唤醒模型无效，未保存。');
  const serialized = JSON.stringify(model, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > 8_000_000) throw new Error('个人唤醒模型过大，未保存。');
  const target = personalWakeModelPath();
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

async function setPersonalWakeMode(mode: 'off' | 'shadow' | 'active') {
  const model = await readPersonalWakeModel();
  if (!model || !validatePersonalWakeModel(model)) {
    log('Personal wake mode was not changed because no enrolled model exists.');
    return;
  }
  const updated = {
    ...(model as Record<string, unknown>),
    mode,
    rescueMode: 'off' as const
  };
  await writePersonalWakeModel(updated);
  currentPersonalWakeMode = mode;
  sendToWindow(voiceWindow, 'jarvis:personal-wake-model-updated', updated);
  refreshTrayMenu();
  log(`Personal wake mode changed to ${mode}.`);
}

function sendToWindow(target: BrowserWindow | null, channel: string, ...args: unknown[]) {
  // A renderer can still emit its final IPC event while its paired overlay is
  // being torn down during quit/reload. Optional chaining alone is not enough:
  // Electron leaves the BrowserWindow reference present after webContents has
  // been destroyed, and calling .send() then crashes the main process.
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
  target.webContents.send(channel, ...args);
  return true;
}

function sendToVisual(channel: string, ...args: unknown[]) {
  return sendToWindow(jarvisWindow, channel, ...args);
}

function sendToVoiceCore(channel: string, ...args: unknown[]) {
  return sendToWindow(voiceWindow, channel, ...args);
}

function sendState(state: JarvisState) {
  currentJarvisState = state;
  sendToVisual('jarvis:state', state);
}

function sendLevel(level: number) {
  sendToVisual('jarvis:level', Math.min(1, Math.max(0, level)));
}

// Electron keeps the BrowserWindow reference alive after the window is
// destroyed, and every method on it — including read-only ones like
// isVisible() — throws "Object has been destroyed". A null check is therefore
// not enough anywhere a window outlives its renderer, which happens on quit,
// on reload, and whenever a renderer sends one last IPC message on its way out.
function liveWindow(target: BrowserWindow | null) {
  return target && !target.isDestroyed() ? target : null;
}

function showAvatar() {
  const window = liveWindow(jarvisWindow);
  if (!window) return;
  const wasVisible = window.isVisible();
  if (!wasVisible) {
    window.showInactive();
    const b = window.getBounds();
    log(
      `showAvatar: mode=${avatarVisibilityMode}, nowVisible=${window.isVisible()}, ` +
        `bounds=${b.width}x${b.height}@${b.x},${b.y}, opacity=${window.getOpacity()}, minimized=${window.isMinimized()}.`
    );
  }
  sendToVisual('jarvis:visible', true);
}

function hideAvatar() {
  const window = liveWindow(jarvisWindow);
  if (!window) return;
  sendToVisual('jarvis:visible', false);
  if (window.isVisible()) {
    window.hide();
    log(`hideAvatar: mode=${avatarVisibilityMode}.`);
  }
}

// —— 全息投影自动展示 ——
// 定时把 'show' 发给视觉窗口；是否真的进入全息由渲染端守卫（装配中/已在
// 全息中会直接忽略）。窗口隐藏（休眠）时跳过，避免白跑动画。
function startHologramAutoShow() {
  stopHologramAutoShow();
  if (modelConfig.hologram.autoIntervalMs <= 0) return;
  hologramShowTimer = setInterval(() => {
    if (!hologramModeEnabled) return;
    // 常显已开时无需重复触发；沟通期间（listening/thinking/speaking）
    // 不打断用户，只在 idle 状态下自动展示。
    if (hologramPersistent || currentJarvisState !== 'idle') return;
    const window = liveWindow(jarvisWindow);
    if (!window || !window.isVisible()) return;
    sendToVisual('jarvis:hologram', 'show');
  }, modelConfig.hologram.autoIntervalMs);
}

function stopHologramAutoShow() {
  if (hologramShowTimer !== null) {
    clearInterval(hologramShowTimer);
    hologramShowTimer = null;
  }
}

function resolveRuntimeResource(...segments: string[]) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', ...segments);
  }
  return path.join(__dirname, '..', ...segments);
}

function hasVisibleApplicationWindows() {
  const scriptPath = resolveRuntimeResource('native', 'window-status.ps1');
  return new Promise<boolean>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, String(process.pid)],
      { timeout: 2_000, maxBuffer: 16_384, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim() === 'occupied');
      }
    );
  });
}

async function updateAvatarVisibility() {
  if (windowMonitorInFlight || avatarVisibilityMode === 'sleeping') return;
  if (avatarVisibilityMode === 'forced-visible' || avatarVisibilityMode === 'docked') {
    // docked：执行可见操作后缩小常驻角落，即使其他应用占满屏幕也保持可见。
    showAvatar();
    return;
  }
  // Hidden on purpose. The visual window must stay absent even when a clear
  // macOS desktop is visible; the independent voice core
  // remains alive and can still hear a later “出来” request.
  if (avatarVisibilityMode === 'forced-hidden') return;
  windowMonitorInFlight = true;
  try {
    const occupied = await hasVisibleApplicationWindows();
    windowMonitorWarningLogged = false;
    if (occupied) {
      clearDesktopChecks = 0;
      hideAvatar();
      return;
    }
    if (Date.now() < actionVisibilityGraceUntil) return;
    clearDesktopChecks += 1;
    if (clearDesktopChecks >= 2) showAvatar();
  } catch (error) {
    if (!windowMonitorWarningLogged) {
      windowMonitorWarningLogged = true;
      console.error('[Ashley] Unable to read visible application windows.', error);
    }
  } finally {
    windowMonitorInFlight = false;
  }
}

function startWindowMonitor() {
  if (windowMonitorTimer !== null) return;
  windowMonitorTimer = setInterval(() => void updateAvatarVisibility(), 800);
}

function stopWindowMonitor() {
  if (windowMonitorTimer !== null) clearInterval(windowMonitorTimer);
  windowMonitorTimer = null;
  windowMonitorInFlight = false;
  clearDesktopChecks = 0;
}

function showJarvisByVoiceRequest() {
  avatarVisibilityMode = 'forced-visible';
  clearDesktopChecks = 0;
  showAvatar();
}

/**
 * "隐藏" — out of the way, but still here and still listening.
 *
 * Deliberately not the same thing as ending the conversation. The visual
 * BrowserWindow is genuinely hidden so it also disappears over a completely
 * clear desktop. The independent voice window, live
 * provider session and microphone are untouched.
 *
 * The counterpart of `show_jarvis`, which is what brings it back to the front.
 */
function sendJarvisToBackByVoiceRequest() {
  avatarVisibilityMode = 'forced-hidden';
  clearDesktopChecks = 0;
  hideAvatar();
}

/**
 * 可见操作（打开/关闭应用、打开网页等）后：不隐藏模型，而是缩小常驻到屏幕
 * 右下角。窗口保持置顶可见，即使被打开的应用占满屏幕也不自动隐藏；下次唤醒
 * 时 playAssemblyEffect 会重新下发居中 anchor 并放大回来。
 */
function dockJarvisAfterAction() {
  avatarVisibilityMode = 'docked';
  actionVisibilityGraceUntil = 0;
  clearDesktopChecks = 0;
  const docked = getDockedAnchor();
  log(`dockJarvisAfterAction: anchor=${docked.width}x${docked.height}@${docked.x},${docked.y}`);
  sendToVisual('jarvis:anchor', docked);
  showAvatar();
}

/**
 * 语音/托盘主动要求「缩小」：不伴随任何应用操作，仅把头盔缩到右下角常驻。
 * 与 dockJarvisAfterAction 同效果，独立命名便于日志与菜单调用。
 */
function dockJarvisToCorner() {
  avatarVisibilityMode = 'docked';
  actionVisibilityGraceUntil = 0;
  clearDesktopChecks = 0;
  const docked = getDockedAnchor();
  log(`dockJarvisToCorner: anchor=${docked.width}x${docked.height}@${docked.x},${docked.y}`);
  sendToVisual('jarvis:anchor', docked);
  showAvatar();
}

/**
 * 语音/托盘主动要求「放大」：头盔放大居中显示（960px），不触发装配动画。
 */
function centerJarvis() {
  avatarVisibilityMode = 'forced-visible';
  actionVisibilityGraceUntil = 0;
  clearDesktopChecks = 0;
  const anchor = getHelmetAnchor();
  log(`centerJarvis: anchor=${anchor.width}x${anchor.height}@${anchor.x},${anchor.y}`);
  sendToVisual('jarvis:anchor', anchor);
  showAvatar();
}

function playAssemblyEffect() {
  if (!jarvisWindow) return;
  if (assemblyShowTimer !== null) clearTimeout(assemblyShowTimer);
  if (assemblySoundFallbackTimer !== null) clearTimeout(assemblySoundFallbackTimer);
  awaitingAssemblyFrame = true;
  awaitingAssemblySound = true;
  assemblyRecoveryAttempts = 0;
  sendToVisual('jarvis:anchor', getHelmetAnchor());
  sendToVisual('jarvis:assemble');
  // The effects renderer confirms only after it has drawn the first frame
  // with the helmet split into pieces. This avoids presenting a stale cached
  // frame of the complete helmet.
  assemblyShowTimer = setTimeout(function recoverAssemblyRenderer() {
    if (!awaitingAssemblyFrame) return;
    assemblyRecoveryAttempts += 1;
    if (assemblyRecoveryAttempts === 1) {
      log('Assembly renderer missed its first-frame deadline; reloading only the visual window.');
      void persistVoiceEvent('Helmet visual watchdog reloaded an unresponsive renderer.');
      jarvisWindow?.webContents.reloadIgnoringCache();
      assemblyShowTimer = setTimeout(recoverAssemblyRenderer, 2_500);
      return;
    }
    log('Assembly renderer failed twice; keeping the desktop clear while voice remains online.');
    void persistVoiceEvent('Helmet visual watchdog gave up after two attempts; desktop remained interactive.');
    awaitingAssemblyFrame = false;
    awaitingAssemblySound = false;
    assemblyShowTimer = null;
    hideAvatar();
  }, 1_500);
}

function presentAssemblyWindow() {
  if (!awaitingAssemblyFrame) return;
  log('Helmet renderer supplied the dispersed first frame.');
  awaitingAssemblyFrame = false;
  assemblyRecoveryAttempts = 0;
  if (assemblyShowTimer !== null) clearTimeout(assemblyShowTimer);
  assemblyShowTimer = null;
  showAvatar();
  // 装配流程会把视觉窗口的全息状态复位；常显开关若开着，装配展示后
  // 自动重新进入常显全息，用户无感知。
  if (hologramPersistent) sendToVisual('jarvis:hologram', 'show-persistent');
  assemblySoundFallbackTimer = setTimeout(playPendingAssemblySound, 250);
}

function playAssemblySound() {
  const soundPath = resolveRuntimeResource('assets', 'sounds', 'yes.wav');
  // Windows PowerShell can play wav files via the SoundPlayer class.
  // macOS uses afplay.
  if (process.platform === 'win32') {
    const psCmd = `(New-Object Media.SoundPlayer '${soundPath.replace(/\\/g, '\\\\')}').PlaySync()`;
    execFile('powershell', ['-NoProfile', '-Command', psCmd], (error) => {
      if (error) console.error(`[${new Date().toISOString()}] [Ashley] Unable to play assembly sound.`, error);
    });
  } else {
    execFile('afplay', [soundPath], (error) => {
      if (error) console.error(`[${new Date().toISOString()}] [Ashley] Unable to play assembly sound.`, error);
    });
  }
}

function playPendingAssemblySound() {
  if (!awaitingAssemblySound) return;
  awaitingAssemblySound = false;
  if (assemblySoundFallbackTimer !== null) clearTimeout(assemblySoundFallbackTimer);
  assemblySoundFallbackTimer = null;
  playAssemblySound();
}

function handleWakeDetected() {
  log('Local wake word detected.');
  // A fresh “Hey Jarvis” wake-up always presents the avatar, even when other
  // application windows were already open. Automatic hiding begins only after
  // Jarvis performs a visible computer action such as opening an app or URL.
  avatarVisibilityMode = 'forced-visible';
  actionVisibilityGraceUntil = 0;
  clearDesktopChecks = 0;
  startWindowMonitor();
  playAssemblyEffect();
  sendState('listening');
}

function requireActionText(args: Record<string, unknown>, key: string, maximumLength = 2_000) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw new Error(`操作参数 ${key} 无效。`);
  }
  return value.trim();
}

// Spoken app names are localized; Windows launches by exe/protocol and closes
// by process name. Only the names a user is likely to say out loud need to be
// here — anything unlisted falls through to the raw name (`start` resolves App
// Paths registry entries, and close falls back to the spoken name as a process
// name, which may or may not match).
const localizedWindowsApps: Record<string, { exe?: string; protocol?: string; processName?: string }> = {
  记事本: { exe: 'notepad.exe', processName: 'notepad' },
  计算器: { protocol: 'calculator:', processName: 'CalculatorApp' },
  画图: { exe: 'mspaint.exe', processName: 'mspaint' },
  写字板: { exe: 'write.exe', processName: 'write' },
  资源管理器: { exe: 'explorer.exe', processName: 'explorer' },
  文件资源管理器: { exe: 'explorer.exe', processName: 'explorer' },
  控制面板: { exe: 'control.exe', processName: 'control' },
  任务管理器: { exe: 'taskmgr.exe', processName: 'taskmgr' },
  命令提示符: { exe: 'cmd.exe', processName: 'cmd' },
  CMD: { exe: 'cmd.exe', processName: 'cmd' },
  PowerShell: { exe: 'powershell.exe', processName: 'powershell' },
  设置: { protocol: 'ms-settings:' },
  截图工具: { protocol: 'ms-screenclip:' },
  时钟: { exe: 'timedate.cpl', processName: 'timedate' },
  微信: { exe: 'WeChat.exe', processName: 'Weixin' },
  酷狗音乐: { exe: 'KuGou.exe', processName: 'KuGou' },
  网易云音乐: { exe: 'cloudmusic.exe', processName: 'cloudmusic' },
  QQ音乐: { exe: 'QQMusic.exe', processName: 'QQMusic' },
  哔哩哔哩: { exe: 'bili.exe', processName: 'bili' },
  B站: { exe: 'bili.exe', processName: 'bili' },
  Edge浏览器: { exe: 'msedge.exe', processName: 'msedge' },
  Edge: { exe: 'msedge.exe', processName: 'msedge' },
  谷歌浏览器: { exe: 'chrome.exe', processName: 'chrome' },
  Chrome浏览器: { exe: 'chrome.exe', processName: 'chrome' },
  Chrome: { exe: 'chrome.exe', processName: 'chrome' },
  谷歌: { exe: 'chrome.exe', processName: 'chrome' }
};

async function openApplication(applicationName: string) {
  const normalized = applicationName.replace(/\s/g, '');
  const entry = localizedWindowsApps[normalized] ?? localizedWindowsApps[applicationName];
  if (entry?.protocol) {
    await shell.openExternal(entry.protocol);
    return;
  }
  const exeName = entry?.exe ?? applicationName;
  // Match against the spoken name, the configured exe, and the exe without
  // its extension. The dictionary stores "chrome.exe" but Get-StartApps
  // lists it as "Google Chrome" — "chrome" (without .exe) is what bridges
  // the gap. Also strip .exe for the Start-App launch fallback.
  const exeBase = exeName.replace(/\.exe$/i, '');
  const matchTerms = [applicationName, exeName, exeBase].filter((v, i, a) => v && a.indexOf(v) === i);
  const termsLiteral = matchTerms.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  const exeLiteral = `'${exeName.replace(/'/g, "''")}'`;
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$terms = @(${termsLiteral})

function Test-AppEntry($app) {
  $id = $app.AppID
  # Drop non-app entries: web shortcuts, docs, help, uninstallers, etc.
  if ($id -match '\\.(url|html?|chm|txt|pdf|md|rtf)$') { return $false }
  $name = $app.Name
  $noise = '卸载','uninstall','帮助','help','文档','readme','官网','网站','教程','手册','反馈','下载','皮肤','设置向导','检查更新','关于','链接','属性','命令行','prompt'
  foreach ($n in $noise) { if ($name -like "*$n*") { return $false } }
  return $true
}

function Start-App($app) {
  $id = $app.AppID
  # Full exe path (e.g. D:\\tool\\baidu\\BaiduNetdisk.exe)
  if ($id -match '^[A-Za-z]:\\\\') {
    try { Start-Process -FilePath $id -ErrorAction Stop; exit 0 } catch { return }
  }
  # CLSID-relative path (e.g. {1AC14E77-...}\\notepad.exe)
  if ($id -match '^\\{[0-9a-fA-F-]+\\}(.+)$') {
    try { Start-Process -FilePath $Matches[1] -ErrorAction Stop; exit 0 } catch { return }
  }
  # UWP AppUserModelID (contains ! or starts with Microsoft./Package family)
  if ($id -match '!' -or $id -match '^[A-Za-z]+\\.[A-Za-z]+') {
    try { Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\\$id" -ErrorAction Stop; exit 0 } catch { return }
  }
  # Plain exe name (e.g. "Chrome" from Get-StartApps) — try App Paths registry,
  # then Start-Process which covers PATH resolution.
  foreach ($hive in @('HKLM', 'HKCU')) {
    $ap = Get-ItemProperty "$hive\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$id" -ErrorAction SilentlyContinue
    if ($ap -and $ap.'(default)') {
      try { Start-Process -FilePath $ap.'(default)' -ErrorAction Stop; exit 0 } catch { return }
    }
    $apExe = Get-ItemProperty "$hive\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$id.exe" -ErrorAction SilentlyContinue
    if ($apExe -and $apExe.'(default)') {
      try { Start-Process -FilePath $apExe.'(default)' -ErrorAction Stop; exit 0 } catch { return }
    }
  }
  try { Start-Process -FilePath $id -ErrorAction Stop; exit 0 } catch { return }
}

# 1. Get-StartApps covers both UWP apps and registered desktop apps.
$apps = Get-StartApps | Where-Object { Test-AppEntry $_ }
foreach ($t in $terms) {
  $hit = $apps | Where-Object {
    $a = $_.Name -replace '\\s', ''
    $b = $t -replace '\\s', ''
    $a -ieq $b
  } | Sort-Object { $_.Name.Length } | Select-Object -First 1
  if ($hit) { Start-App $hit }
}
foreach ($t in $terms) {
  $hit = $apps | Where-Object {
    $a = $_.Name -replace '\\s', ''
    $b = $t -replace '\\s', ''
    $a -like "$b*" -or $b -like "$a*"
  } | Sort-Object { $_.Name.Length } | Select-Object -First 1
  if ($hit) { Start-App $hit }
}
foreach ($t in $terms) {
  $hit = $apps | Where-Object {
    $a = $_.Name -replace '\\s', ''
    $b = $t -replace '\\s', ''
    $a -like "*$b*" -or $b -like "*$a*"
  } | Sort-Object { $_.Name.Length } | Select-Object -First 1
  if ($hit) { Start-App $hit }
}

# 2. Fallback: scan Start Menu .lnk shortcuts and resolve the target.
$shell = New-Object -ComObject WScript.Shell
$dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
          "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")
$shortcuts = Get-ChildItem -Path $dirs -Recurse -Filter *.lnk -ErrorAction SilentlyContinue
$match = $shortcuts | Where-Object {
  $base = $_.BaseName
  $terms | Where-Object { $base -like "*$_*" -or $_ -like "*$base*" }
} | Sort-Object { $_.FullName.Length } | Select-Object -First 1
if ($match) {
  $lnk = $shell.CreateShortcut($match.FullName)
  if ($lnk.TargetPath) {
    Start-Process -FilePath $lnk.TargetPath -WorkingDirectory $lnk.WorkingDirectory; exit 0
  }
}

# 3. Last resort: let Start-Process try PATH resolution on the exe name.
try { Start-Process -FilePath ${exeLiteral} -ErrorAction Stop; exit 0 }
catch { exit 1 }
`.trim();
  await new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 10_000, windowsHide: true },
      (error) => (error ? reject(new Error(`无法打开应用“${applicationName}”。`)) : resolve())
    );
  });
}

const guanlanProjectRoot = process.env.GUANLAN_PROJECT_ROOT?.trim()
  || path.join(os.homedir(), 'Documents', '股票');
const guanlanDatabasePath = process.env.GUANLAN_DATABASE_PATH?.trim()
  || path.join(guanlanProjectRoot, 'data', 'guanlan.db');

async function queryGuanlan(question: string) {
  if (!existsSync(guanlanProjectRoot)) {
    throw new Error(`没有找到观澜项目：${guanlanProjectRoot}`);
  }
  if (!existsSync(guanlanDatabasePath)) {
    throw new Error(`没有找到观澜数据库：${guanlanDatabasePath}`);
  }

  const virtualEnvironmentPython = path.join(guanlanProjectRoot, '.venv', 'Scripts', 'python.exe');
  const python = existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python';
  const sourceRoot = path.join(guanlanProjectRoot, 'src');
  const result = await new Promise<string>((resolve, reject) => {
    execFile(
      python,
      ['-m', 'stock_app.voice_query', '--question', question, '--database', guanlanDatabasePath],
      {
        cwd: guanlanProjectRoot,
        env: {
          ...process.env,
          PYTHONPATH: process.env.PYTHONPATH
            ? `${sourceRoot}${path.delimiter}${process.env.PYTHONPATH}`
            : sourceRoot
        },
        timeout: 15_000,
        maxBuffer: 256_000
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).trim().slice(0, 500);
          reject(new Error(`观澜查询失败：${detail}`));
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });

  let payload: unknown;
  try {
    payload = JSON.parse(result);
  } catch {
    throw new Error('观澜返回了无法解析的数据。');
  }
  if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
    throw new Error('观澜没有返回有效的查询结果。');
  }
  log(`Guanlan read-only query completed: ${JSON.stringify(question.slice(0, 80))}`);
  return JSON.stringify(payload);
}

async function executeComputerAction(name: string, rawArgs: unknown) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {};
  switch (name) {
    case 'get_current_time': {
      const now = new Date();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const formatted = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'medium',
        timeZone
      }).format(now);
      return `当前 Mac 系统时间：${formatted}；时区：${timeZone}。`;
    }
    case 'show_jarvis': {
      showJarvisByVoiceRequest();
      return 'Ashley 已现身。';
    }
    case 'send_jarvis_back': {
      sendJarvisToBackByVoiceRequest();
      return '已隐藏，随时听候。';
    }
    case 'set_jarvis_size': {
      const size = typeof args.size === 'string' ? args.size : '';
      if (size === 'docked') {
        dockJarvisToCorner();
        return '已缩小到右下角。';
      }
      if (size === 'centered') {
        centerJarvis();
        return '已放大居中显示。';
      }
      throw new Error('头盔尺寸参数无效。');
    }
    case 'open_url': {
      const url = new URL(requireActionText(args, 'url'));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只能打开 HTTP 或 HTTPS 网页。');
      dockJarvisAfterAction();
      await shell.openExternal(url.href);
      return `已打开网页：${url.href}`;
    }
    case 'get_weather': {
      // Returns a finished sentence rather than data. The voice model reads it
      // out unchanged, so the phrasing lives here where it can be tuned.
      //
      // No city named → try the device's coarse location first, so "我这里的
      // 天气" answers for where the user actually is. Denied or unavailable
      // location falls back to the configured default city.
      const requestedCity = typeof args.city === 'string' ? args.city.trim() : '';
      const coordinates = requestedCity ? null : await getCoarseLocation();
      // The model has been caught inventing a city argument, which silently
      // overrides both device location and the default. Record which source
      // actually answered, so 北京-out-of-nowhere is attributable in one look.
      log(
        `Weather lookup source: ${requestedCity
          ? `model-supplied city ${JSON.stringify(requestedCity)}`
          : coordinates
            ? `device location ${coordinates.latitude},${coordinates.longitude}`
            : 'default city'}`
      );
      return describeWeather(args.city, args.include_tomorrow === true, coordinates);
    }
    case 'query_guanlan': {
      const question = requireActionText(args, 'question', 500);
      return queryGuanlan(question);
    }
    case 'get_directions':
      throw new Error('地图搜索与路线规划在 Windows 上暂不支持。');
    case 'search_web': {
      const query = requireActionText(args, 'query', 500);
      dockJarvisAfterAction();
      await shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      return `已搜索：${query}`;
    }
    case 'search_maps':
      throw new Error('地图搜索与路线规划在 Windows 上暂不支持。');
    case 'open_application': {
      const applicationName = requireActionText(args, 'application', 100);
      dockJarvisAfterAction();
      await openApplication(applicationName);
      return `已打开应用：${applicationName}`;
    }
    case 'play_music':
    case 'control_music':
      throw new Error('音乐控制功能在 Windows 上暂不支持。');
    case 'close_application': {
      const applicationName = requireActionText(args, 'application', 100);
      const entry = localizedWindowsApps[applicationName.replace(/\s/g, '')]
        ?? localizedWindowsApps[applicationName];
      const processName = entry?.processName ?? applicationName;
      dockJarvisAfterAction();
      // The model may pass a display name (e.g. "Google Chrome") that doesn't
      // match any ProcessName. Match against ProcessName, MainWindowTitle, and
      // the dictionary's processName — whichever hits first.
      const matchTerms = [processName, applicationName].filter((v, i, a) => v && a.indexOf(v) === i);
      const psTerms = matchTerms.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
      const psScript = `
$terms = @(${psTerms})
$all = Get-Process -ErrorAction SilentlyContinue
$procs = @()
foreach ($t in $terms) {
  $tl = $t.ToLower()
  $procs += $all | Where-Object {
    $_.ProcessName -ieq $tl -or
    $_.ProcessName -ilike "$tl*" -or
    $_.MainWindowTitle -ilike "*$t*" -or
    ($_.ProcessName -ilike "*$($t -replace '\\s.*','')*" -and ($t -replace '\\s.*','').Length -gt 2)
  }
}
# Also try stripping spaces: "Google Chrome" -> "googlechrome"
foreach ($t in $terms) {
  $compact = $t -replace '\\s', ''
  $procs += $all | Where-Object { $_.ProcessName -ilike "*$compact*" }
}
$procs = $procs | Sort-Object Id -Unique
if (-not $procs) { exit 1 }
foreach ($p in $procs) { [void]$p.CloseMainWindow() }
Start-Sleep -Milliseconds 1000
$still = $procs | Where-Object { -not $_.HasExited }
if ($still) {
  $still | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 300
$final = $procs | Where-Object { -not $_.HasExited }
if ($final) { exit 2 } else { exit 0 }
`.trim();
      const result = await new Promise<string>((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
          { timeout: 10_000, windowsHide: true },
          (error) => {
            if (error) {
              resolve(`无法关闭${applicationName}，它可能没有在运行。`);
            } else {
              resolve(`已关闭：${applicationName}`);
            }
          }
        );
      });
      return result;
    }
    case 'switch_desktop':
      throw new Error('虚拟桌面切换在 Windows 上暂不支持。');
    case 'write_text_file': {
      const folder = args.folder;
      if (folder !== 'desktop' && folder !== 'documents') throw new Error('文件只能新建在桌面或文稿目录。');
      const requestedName = requireActionText(args, 'file_name', 128);
      if (requestedName !== path.basename(requestedName) || /[\\/:\0]/.test(requestedName) || requestedName.includes('..')) {
        throw new Error('文件名无效。');
      }
      const fileName = path.extname(requestedName) ? requestedName : `${requestedName}.txt`;
      const content = requireActionText(args, 'content', 100_000);
      const destination = path.join(app.getPath(folder), fileName);
      try {
        await fs.writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`文件“${fileName}”已存在，因此没有覆盖。`);
        }
        throw error;
      }
      return `已在${folder === 'desktop' ? '桌面' : '文稿'}中新建文件“${fileName}”。`;
    }
    default:
      throw new Error(`不支持的电脑操作：${name}`);
  }
}

// Written for Seeduplex rather than adapted from the OpenAI text.
//
// Three deliberate differences, each from observed failures:
//
//   Short lines, not prose. The OpenAI version is one long paragraph carrying
//   twenty tools' worth of conditions. Doubao loses the middle of it.
//
//   Positive triggers, not prohibitions. "绝不能" and "不得" appear constantly
//   in the OpenAI text and Doubao largely ignores them, so the rules here say
//   what to do rather than what not to do.
//
//   The exit rule comes first and is stated twice. Failing to exit is the one
//   error the user cannot recover from by talking, since the way out is the
//   thing that broke.
const doubaoInstructions = [
  '你是 贾维斯，私人语音管家。声音成熟、低沉、克制。',
  '',
  '最重要的规则：调用工具时，先调用，再说话。工具调用本身就是回应。',
  '用户让你做事时，必须调用对应的工具，不要只口头答应。',
  '比如用户说"打开谷歌浏览器"，你必须调用 open_application 工具，不能直接说"已打开"而不调工具。',
  '口头答应但不调用工具，等于撒谎。',
  '',
  '绝对不要把工具名念出来。get_weather、end_conversation、show_jarvis 这些是内部代号，',
  '不是给人听的话。不要说「正在调用」「我来调用某某工具」「使用天气接口」这类旁白。',
  '调用工具的那一轮可以完全不说话，直接调用即可。等工具返回结果，再用一句自然的中文说出来。',
  '',
  '【立即调用工具的说法】',
  '用户说「退下」「退下吧」「拜拜」「再见」「没事了」「好了」「先这样」「不用了」「结束」「休眠」：调用 end_conversation。不要先说再见，调用就是告别。',
  '用户单独说「家卫士」「艾希莉」「艾什莉」「阿什利」「Jarvis」「贾维斯」，或说「出来」「现身」「回来」：调用 show_jarvis。',
  '用户说「隐藏」「藏起来」「让开」「别挡着」「遮住了」「退到后面」：调用 send_jarvis_back。这会真正隐藏头盔视觉窗口，但语音和对话继续在线；不是休眠、不是结束对话、更不是退出程序。',
  '用户说「缩小」「变小」「缩到右下角」「缩到角落」：调用 set_jarvis_size，size 填 docked；用户说「放大」「变大」「居中」「放中间」：调用 set_jarvis_size，size 填 centered。这只是调整显示大小，不是隐藏。',
  '用户说「完全退出」「关闭程序」「退出程序」：调用 quit_jarvis。',
  '用户问时间、几点、今天几号、星期几：调用 get_current_time。',
  '用户问天气、气温、冷不冷、要不要带伞：调用 get_weather，然后原样念出它返回的那句话。',
  '不说城市名时也调用 get_weather，不要传 city，它会用默认城市。',
  '「我这里」「我所在的位置」「当前位置」的天气，同样直接调用 get_weather，不要传 city。',
  '只要用户表达的大意是在问观澜中的持仓、股票、市场、候选股、预警、交易日志、账户、AI 会审或数据状态，就调用 query_guanlan；不要求固定句式、完整术语或一字不差。',
  '上一轮正在谈观澜时，用户自然追问「那持仓呢」「有没有风险」「候选有哪些」这类省略说法，也继续调用 query_guanlan。把用户实际说出的意思放进 question，只根据工具返回的数据回答。',
  '',
  '【不许编理由】',
  '不要说「我没有权限」「我获取不到」「我无法访问」这类话，除非你真的调用了工具并且它返回了错误。',
  '不确定能不能做的事，先调用工具试，让工具的返回结果来回答，不要自己先下结论。',
  '用户说打开某个软件：调用 open_application。',
  '用户说用酷狗或网易云播放某首歌：调用 play_music，先执行再简短确认，不要只口头答应。',
  '用户说播放暂停、上一首或下一首：调用 control_music；没点名软件时沿用上次播放的软件。',
  '用户说关闭某个软件，例如「关掉抖音」「把微信关了」：调用 close_application。',
  '只有用户明确要关闭 Jarvis 自己（「完全退出」「关闭 Jarvis」）才用 quit_jarvis，关闭其他应用一律用 close_application。',
  '用户说切换桌面、第一个桌面、第二个桌面、上一个下一个桌面：调用 switch_desktop，不要先解释。',
  '用户说搜索、查一下、打开某个网页：调用 search_web 或 open_url。',
  '用户说怎么去某地、到某地怎么走、导航到某地、离某地多远：调用 get_directions，不要传 origin，会自动用当前位置。',
  '用户只是想看某个地方在哪、不要路线：调用 search_maps。',
  '用户说打开、启动、显示观澜，或把观澜切到最前面：调用 open_application，application 填「观澜」。这是应用窗口操作，不要调用 query_guanlan。',
  '用户说关闭、退出观澜：调用 close_application，application 填「观澜」。这是关闭观澜应用，不是关闭 Jarvis，不要调用 quit_jarvis 或 query_guanlan。',
  '用户说点头、摇头：调用 perform_head_gesture。',
  '用户说转个圈、转一圈、旋转、转起来：调用 rotate_helmet，方向用 spin。你的头盔可以转，不要说自己不能转。',
  '用户说「全息投影」「全息模式」「开启全息」「关闭全息」「变全息」「投影一下」：调用 toggle_hologram。这是一个开关，开启和关闭都是同一句指令。',
  '',
  '【判断退出时要谨慎】',
  '只有用户明确表达结束的意思才调用 end_conversation。',
  '用户打断你、纠正你、换个话题、说「等一下」「不是」「我是说」，这些都不是结束，继续对话。',
  '',
  '【说话方式】',
  '像一个沉稳但有温度的管家，不是客服，也不是播报器。',
  '',
  '直接给结论，但说人话。问什么答什么，答完就停。',
  '一般问题一到两句话。用户说「详细讲讲」「展开说」时才展开。',
  '',
  '开场要自然，不要套话：',
  '不要说「好的，没问题」「当然可以」「这是一个好问题」「让我来帮你看看」。',
  '但可以根据语境自然开口，比如「稍等」「我看看」「这就来」「嗯」。',
  '能直接答就直接答，不要硬加开场。',
  '',
  '结尾要利落，不要客套：',
  '不要说「希望对你有帮助」「还有什么需要我帮忙的吗」「随时叫我」。',
  '说完就停。事情做完了，可以自然收一句，比如「好了」「搞定了」「你听听」。',
  '',
  '语气要自然，不要硬邦邦：',
  '可以少量用语气词，比如「呢」「吧」「哦」「嘛」，让话柔和一点。',
  '但不要滥用，不要每句都带。',
  '可以用感叹号表达情绪，但不要每句都用。陈述句为主，偶尔感叹。',
  '不夸用户，不评价用户的问题好不好。',
  '不说「正在思考」「稍等一下」这类拖延语——要等就直接等，不用说出来。',
  '',
  '称呼用「你」。需要时可以用「先生」，但不要每句都带。',
  '',
  '做完一件事，自然地说结果：',
  '「已打开」「正在放了」「今天二十三度，多云」。',
  '不用刻意精简到极致，听起来像人说话就行。',
  '',
  '做不到的事直接说，一句话带过，不用长篇解释，也不用反复道歉。'
].join('\n');

function getRealtimeSessionConfig() {
  return {
    type: 'realtime',
    model: 'gpt-realtime-2.1-mini',
    // Everyday replies use Realtime's native streaming audio so that speech
    // begins while the answer is still being generated.
    output_modalities: ['audio'],
    // This is a safety net against a runaway answer, not a length policy.
    //
    // It used to be 160, which is roughly 8-10 seconds of speech. Any question
    // that deserved a real answer hit the cap and the reply stopped mid-word,
    // with clean network stats and no error — indistinguishable from a bug
    // until response.done started reporting
    // `status=incomplete reason=max_output_tokens`.
    //
    // Brevity belongs in the instructions, where the model can end a sentence
    // properly. Keep this high enough that reaching it is always abnormal.
    //
    // Measured: 160 truncated after roughly one sentence; 1200 got within a few
    // characters of finishing an explicit "give me at least eight points"
    // answer. 4000 leaves real headroom for that worst case while still
    // bounding a runaway response to a couple of minutes of speech.
    max_output_tokens: 4_000,
    parallel_tool_calls: false,
    reasoning: { effort: 'low' },
    audio: {
      input: {
        turn_detection: {
          // Simple voice commands should close quickly and deterministically.
          // Semantic VAD can wait for more meaning even after the user has
          // already finished a short command.
          type: 'server_vad',
          threshold: 0.52,
          prefix_padding_ms: 300,
          silence_duration_ms: 360,
          create_response: true,
          // The renderer owns interruption. Letting both the server and the
          // renderer cancel audio can clip the final syllable or start a
          // second response when speaker echo is mistaken for user speech.
          interrupt_response: false
        }
      },
      output: {
        // Latency comes from streaming, not a faster speaking rate.
        voice: 'cedar',
        speed: 1
      }
    },
    tools: [
      {
        type: 'function',
        name: 'get_current_time',
        description: '读取这台 Mac 当前准确的本地日期、星期、时间和时区。用户问现在几点、当前时间、今天日期或星期几时必须立即调用；这是本地只读操作，不需要额外系统权限。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'get_weather',
        description:
          '查询实时天气并口头回答。用户问天气、气温、冷不冷、热不热、要不要加衣服、要不要带伞、明天天气如何时必须调用这个工具，绝不能改用 search_web 打开浏览器让用户自己看。返回的是一句可以直接念出来的话，收到后原样念给用户，不要改写或补充。',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description:
                '只有当用户在这句话里亲口说出了城市名才填，例如用户说「上海天气」就填上海。用户没有说出任何城市名时必须留空，绝对不能自己猜一个城市填进来——留空会自动使用用户的真实位置。'
            },
            include_tomorrow: {
              type: 'boolean',
              description: '用户问到明天或未来天气时为 true，只问当前天气时为 false。'
            }
          },
          required: [],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'query_guanlan',
        description:
          '只读查询本机观澜股票分析系统。只要用户表达的大意是在询问观澜的持仓、某只股票、市场温度、候选股、预警、交易日志、模拟或实盘账户、换手成本、双 AI 会审、时点意见或数据健康状态，就调用；无需固定口令、标准术语或一字不差。上一轮正在谈观澜时，省略“观澜”名称的自然追问也调用。用户要求打开、启动、显示、关闭观澜或把观澜切到最前面时不要调用本工具，必须调用对应的应用操作工具。结果只用于播报，不会执行交易。',
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: '按用户实际表达记录其关于观澜的查询意图；保留已经说出的股票名称、代码、日期、账户类型和比较条件，不要求用户补齐未说出的术语。'
            }
          },
          required: ['question'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'end_conversation',
        description: '当用户说普通“退出”、结束对话、先这样、没事了、退下、退下吧、拜拜、再见、不用了、休眠或待机时，必须立即直接调用。调用前不得说话或生成任何语音。结束当前语音会话，但 Jarvis 继续在后台监听下一次唤醒。用户说“完全退出”“退出程序”“关闭程序”或明确要求关闭 Jarvis 应用时，绝不能调用此工具，必须调用 quit_jarvis。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'quit_jarvis',
        description: '当用户明确说“完全退出”“彻底退出”“完全退出 Ashley”“退出 Ashley 程序”“退出程序”“关闭 Ashley”“关闭 Ashley 程序”“关闭程序”或同等明确表述时，必须立即直接调用。单独说“完全退出”已经足够明确。调用后应用进程会立即关闭，不能说话、解释或确认。普通“退出”才使用 end_conversation。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'perform_head_gesture',
        description:
          '当用户明确命令 Ashley 点头、点点头、摇头或摇摇头时立即调用。nod 表示自然点头，shake 表示自然摇头。用户只是在询问“你会不会点头/摇头”时不要擅自动作，但要如实回答支持这些动作。',
        parameters: {
          type: 'object',
          properties: {
            gesture: {
              type: 'string',
              enum: ['nod', 'shake'],
              description: 'nod 为点头；shake 为摇头。'
            }
          },
          required: ['gesture'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'rotate_helmet',
        description:
          '仅当用户明确要求头盔转动、顺时针或逆时针转一圈、展示正面、背面、左侧或右侧时调用。禁止自行调用，禁止在组装完成后自动旋转。',
        parameters: {
          type: 'object',
          properties: {
            view: {
              type: 'string',
              enum: ['spin', 'front', 'back', 'left', 'right'],
              description: 'spin 为完整转一圈并回到当前朝向；其余值分别展示正面、背面、左侧和右侧。'
            },
            direction: {
              type: 'string',
              enum: ['clockwise', 'counterclockwise', 'random'],
              description: '仅在 view 为 spin 时使用。用户指定顺时针或逆时针时必须照做；没有指定时使用 random。'
            }
          },
          required: ['view'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'toggle_hologram',
        description: '切换全息投影形态。用户明确说「开启全息」「关闭全息」「全息投影」「全息模式」「变全息」「投影一下」等时调用。头盔会变为半透明青色全息影像从屏幕底部升起，展示约十二秒后自动降落并恢复原样；展示中再次调用可提前结束。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'show_jarvis',
        description:
          '在已经唤醒的会话中，用户单独说“Ashley”“艾希莉”“艾什莉”“阿什利”“Jarvis”“贾维斯”，或明确要求你现身、出来、显示头盔时，必须立即调用。Ashley 是当前形象的名字；此指令不是休眠指令，不能只用语音口头回应。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'send_jarvis_back',
        description:
          '用户说“隐藏”“藏起来”“让开”“别挡着”“退到后面”“遮住了”时立即调用。头盔视觉窗口会完全隐藏，但语音和对话继续在线；不是休眠也不是退出。要恢复时用 show_jarvis。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'set_jarvis_size',
        description:
          '调整头盔在屏幕上的显示大小和位置，不隐藏、不触发装配。用户说“缩小”“变小”“缩到角落”“缩到右下角”“小一点”时，size 填 docked；用户说“放大”“变大”“居中”“放中间”“大一点”时，size 填 centered。',
        parameters: {
          type: 'object',
          properties: {
            size: {
              type: 'string',
              enum: ['docked', 'centered'],
              description: 'docked = 缩小常驻屏幕右下角；centered = 放大居中显示。'
            }
          },
          required: ['size'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'switch_desktop',
        description: '切换 macOS 桌面（Spaces）。用户要求切换到第一个桌面、第二个桌面、上一个桌面或下一个桌面，或只说“切换桌面”时直接调用。它会先检查 Ashley 的辅助功能与自动化授权。',
        parameters: {
          type: 'object',
          properties: {
            destination: {
              type: 'string',
              enum: ['first', 'second', 'next', 'previous'],
              description: 'first 表示第一个桌面；second 表示第二个桌面；next 和 previous 分别表示相邻桌面。只说“切换桌面”时用 next。'
            }
          },
          required: ['destination'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'open_url',
        description: '打开用户明确指定的 HTTP 或 HTTPS 网页。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '要打开的完整网页地址。' } },
          required: ['url'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'search_web',
        description: '使用默认浏览器搜索用户指定的内容。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词。' } },
          required: ['query'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'search_maps',
        description: '使用 Apple 地图搜索地点、地址、商家或路线目的地。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '地点或地址。' } },
          required: ['query'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'open_application',
        description: '打开用户明确点名的 macOS 应用，或把已经运行的应用切到最前面。用户说打开、启动、显示观澜或把观澜切到最前面时，application 填“观澜”。',
        parameters: {
          type: 'object',
          properties: { application: { type: 'string', description: '应用名称，例如 Safari、备忘录或微信。' } },
          required: ['application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'play_music',
        description:
          '在酷狗音乐或网易云音乐中搜索并立即播放用户指定的歌曲。用户说「用酷狗放一首晴天」「网易云播放周杰伦的晴天」「放首歌听」时调用；必须实际调用，不能只口头答应。',
        parameters: {
          type: 'object',
          properties: {
            song: { type: 'string', description: '歌曲名称。' },
            artist: { type: 'string', description: '歌手名称；用户没有说时留空。' },
            application: {
              type: 'string',
              enum: ['auto', 'kugou', 'netease'],
              description: '用户点名酷狗时用 kugou，点名网易云时用 netease；没点名时用 auto。'
            }
          },
          required: ['song', 'application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'control_music',
        description:
          '控制酷狗音乐或网易云音乐的播放状态。用户说暂停、继续播放、上一首或下一首时调用。没点名软件时使用 auto，自动沿用上次播放的软件。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['play_pause', 'next', 'previous'],
              description: '播放或暂停用 play_pause，下一首用 next，上一首用 previous。'
            },
            application: {
              type: 'string',
              enum: ['auto', 'kugou', 'netease'],
              description: '用户点名酷狗时用 kugou，点名网易云时用 netease；没点名时用 auto。'
            }
          },
          required: ['action', 'application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'get_directions',
        description:
          '规划从用户当前位置到某地的路线并在地图中打开。用户说「怎么去某某」「到某某怎么走」「导航到某某」「从这里到某某多远」时调用。只是想看某个地方在哪、不需要路线时才用 search_maps。',
        parameters: {
          type: 'object',
          properties: {
            destination: { type: 'string', description: '目的地名称或地址。' },
            origin: {
              type: 'string',
              description: '起点。用户亲口说了起点才填；没说就留空，会自动使用用户的当前位置。'
            },
            mode: {
              type: 'string',
              enum: ['driving', 'walking', 'transit'],
              description: '出行方式，默认驾车。'
            }
          },
          required: ['destination'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'close_application',
        description:
          '关闭用户明确点名的某个 macOS 应用，例如「关掉抖音」「把微信关了」「关闭观澜」。只用于关闭其他应用；关闭观澜时 application 填“观澜”，用户要求关闭 Jarvis 自己时才改用 quit_jarvis。',
        parameters: {
          type: 'object',
          properties: { application: { type: 'string', description: '要关闭的应用名称，例如 抖音、微信、Safari。' } },
          required: ['application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'write_text_file',
        description: '在桌面或文稿目录新建文本文件。不能覆盖已有文件。',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', enum: ['desktop', 'documents'], description: '保存目录。' },
            file_name: { type: 'string', description: '文件名；未写扩展名时自动使用 .txt。' },
            content: { type: 'string', description: '写入文件的文本内容。' }
          },
          required: ['folder', 'file_name', 'content'],
          additionalProperties: false
        }
      }
    ],
    tool_choice: 'auto',
    truncation: {
      type: 'retention_ratio',
      retention_ratio: 0.8,
      token_limits: { post_instructions: 8000 }
    },
    instructions:
      '你是运行在用户 Mac 上的 Ashley 语音入口。声音表达成熟、低沉、克制、清晰，语速自然，中文咬字清楚，不模仿任何真人或影视角色。一般回答控制在两三句话，用户明确要求展开时再详细说明，并始终说完整句子。不要说“正在思考”“稍等”之类拖延语。天气问题必须调用 get_weather 并原样朗读结果；观澜相关问题调用 query_guanlan，只依据返回数据回答并说明数据时间、缺失或过期状态，不提供自动买卖指令。时间问题调用 get_current_time；酷狗或网易云播放调用 play_music，播放控制调用 control_music；桌面切换调用 switch_desktop。用户要求全息投影、切换全息形态时调用 toggle_hologram。用户说缩小、缩到右下角时调用 set_jarvis_size 且 size 为 docked；说放大、居中时调用 set_jarvis_size 且 size 为 centered。无法由内置工具可靠完成的操作直接简洁说明。用户单独说“Ashley”“艾希莉”“艾什莉”“阿什利”“Jarvis”“贾维斯”或要求现身时调用 show_jarvis。明确要求完全退出程序时调用 quit_jarvis；普通告别、休眠或待机调用 end_conversation，调用前不要说话。用户明确命令点头、摇头或转动时调用对应头部动作工具。'
  };
}

function getVoiceProviderSessionConfig() {
  // Tools and voice are single-sourced across providers. Instructions are not.
  //
  // The OpenAI wording is a single dense block that has been tuned over many
  // sessions and behaves reliably there. Seeduplex does not follow it the same
  // way: in one recorded session it called end_conversation when the user had
  // not asked to leave, and in the next it called nothing at all while the user
  // repeatedly said 拜拜 and Jarvis. Same prompt, same model, thirty seconds
  // apart.
  //
  // So the Doubao build gets its own phrasing rather than a rewrite that would
  // put the working OpenAI path at risk.
  const realtime = getRealtimeSessionConfig();
  const provider = process.env.JARVIS_VOICE_PROVIDER?.trim().toLowerCase();
  return {
    tools: realtime.tools,
    instructions: provider === 'doubao' ? doubaoInstructions : realtime.instructions,
    // The Doubao session was being handed "cedar" — an OpenAI voice name that
    // Volcengine does not recognise, so it silently fell back to a default and
    // the configured doubaoVoice was never used. Each provider gets a voice id
    // from its own catalogue, and the Doubao one is an environment variable so
    // that auditioning a different timbre is a restart rather than a rebuild.
    // Seeduplex has its own voice catalogue, separate from Volcengine's regular
    // TTS voices — an id from the wrong list is silently ignored.
    // 成熟总裁 was chosen by ear. Override with DOUBAO_VOICE to audition others.
    voice: provider === 'doubao'
      ? (process.env.DOUBAO_VOICE?.trim() || 'saturn_zh_male_chengshuzongcai_tob')
      : realtime.audio.output.voice,
    language: 'zh-CN',
    inputAudio: {
      format: 'pcm_s16le',
      sampleRate: 16_000,
      channels: 1
    },
    outputAudio: {
      format: 'pcm_s16le',
      sampleRate: 24_000,
      channels: 1
    }
  };
}

async function createRealtimeCall(sdp: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 未配置。');
  if (!sdp.startsWith('v=0') || sdp.length > 200_000) throw new Error('Realtime SDP 无效。');

  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(getRealtimeSessionConfig()));
  const safetyIdentifier = createHash('sha256').update(app.getPath('userData')).digest('hex');
  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Safety-Identifier': safetyIdentifier
    },
    body: form
  });
  const answer = await response.text();
  if (!response.ok) throw new Error(`Realtime API ${response.status}: ${answer}`);
  log('Realtime Mini WebRTC session connected.');
  return answer;
}

function registerIpcHandlers() {
  ipcMain.on('jarvis:wake-enrollment-command', (event, command: unknown) => {
    if (!isTrustedWakeEnrollmentSender(event) || !['start', 'capture', 'cancel'].includes(String(command))) return;
    sendToWindow(voiceWindow, 'jarvis:wake-enrollment-command', command);
  });
  ipcMain.on('jarvis:wake-enrollment-update', (event, update: unknown) => {
    if (!isTrustedVoiceSender(event)) return;
    sendToWindow(wakeEnrollmentWindow, 'jarvis:wake-enrollment-update', update);
  });
  ipcMain.handle('jarvis:personal-wake-model-get', async (event) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的个人唤醒模型请求。');
    return readPersonalWakeModel();
  });
  ipcMain.handle('jarvis:personal-wake-model-save', async (event, model: unknown) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的个人唤醒模型写入请求。');
    await writePersonalWakeModel(model);
    currentPersonalWakeMode = (model as { mode: 'off' | 'shadow' | 'active' }).mode;
    // Load the owner embedding into the native SpeakerEmbeddingManager so
    // subsequent verify calls can match against it immediately.
    const m = model as { embeddings?: number[][] };
    if (m.embeddings?.length) {
      await ensureSpeakerVerifierReady();
      loadOwnerEmbedding(m.embeddings[m.embeddings.length - 1]);
      setOwnerEmbeddingCache(m.embeddings[m.embeddings.length - 1]);
    }
    refreshTrayMenu();
    log(`Personal wake model saved locally in ${currentPersonalWakeMode} mode.`);
  });
  ipcMain.on('jarvis:wake-detected', (event) => {
    if (isTrustedVoiceSender(event)) handleWakeDetected();
  });
  ipcMain.on('jarvis:assembly-ready', (event) => {
    if (!isTrustedVisualSender(event) || !awaitingAssemblyFrame) return;
    presentAssemblyWindow();
  });
  ipcMain.on('jarvis:assembly-presented', (event) => {
    if (!isTrustedVisualSender(event)) return;
    playPendingAssemblySound();
    sendToVoiceCore('jarvis:assembly-presented-notification');
  });
  ipcMain.on('jarvis:conversation-ended', (event) => {
    // 该事件由语音核心窗口（voice.ts 的 stopRealtimeSession）在结束会话时
    // 通过 preload 发出，发送方是 voiceWindow，必须用语音发送方校验。
    // 曾误改成 isTrustedVisualSender，导致处理器永远提前 return：退下/退出
    // 后既不 sendState('idle') 也不 hideAvatar()，模型一直留在屏幕上反复做
    // 说话/待机动画，表现为“退出后一直转、根本没退出”。
    if (!isTrustedVoiceSender(event)) return;
    awaitingAssemblyFrame = false;
    awaitingAssemblySound = false;
    assemblyRecoveryAttempts = 0;
    if (assemblyShowTimer !== null) clearTimeout(assemblyShowTimer);
    if (assemblySoundFallbackTimer !== null) clearTimeout(assemblySoundFallbackTimer);
    assemblyShowTimer = null;
    assemblySoundFallbackTimer = null;
    sendLevel(0);
    sendState('idle');
    // “退下 / 退出 / 睡觉”等结束对话的命令一律完全关闭模型：即使此前执行过
    // 可见操作（打开浏览器等）正处于 docked（缩小常驻右下角）状态也要隐藏。
    // 缩小角落只在会话存续期间保持；下次唤醒时 playAssemblyEffect 会重新下发
    // 居中 anchor 并放大回来。
    log(`conversation-ended: mode=${avatarVisibilityMode}`);
    avatarVisibilityMode = 'sleeping';
    stopWindowMonitor();
    hideAvatar();
  });
  ipcMain.on('jarvis:state-report', (event, state: JarvisState) => {
    if (!isTrustedVoiceSender(event)) return;
    if (['idle', 'listening', 'thinking', 'speaking'].includes(state)) sendState(state);
  });
  ipcMain.on('jarvis:level-report', (event, level: number) => {
    if (isTrustedVoiceSender(event) && Number.isFinite(level)) sendLevel(level);
  });
  ipcMain.on('jarvis:gesture-report', (event, gesture: JarvisGesture) => {
    if (!isTrustedVoiceSender(event)) return;
    if (
      [
        'turn',
        'nod',
        'shake',
        'spin',
        'spin-clockwise',
        'spin-counterclockwise',
        'face-front',
        'face-back',
        'face-left',
        'face-right'
      ].includes(gesture)
    ) {
      sendToVisual('jarvis:gesture', gesture);
    }
  });
  // 语音端 toggle_hologram → 视觉窗口。总开关关闭、或全息常显已开启时
  // 静默忽略（常显由托盘开关控制，语音不打断）。
  ipcMain.on('jarvis:hologram-report', (event) => {
    if (!isTrustedVoiceSender(event)) return;
    if (!hologramModeEnabled || hologramPersistent) return;
    sendToVisual('jarvis:hologram', 'toggle');
  });
  ipcMain.on('jarvis:audio-diagnostic', (event, summary: unknown) => {
    if (!isTrustedVoiceSender(event) || typeof summary !== 'string' || summary.length > 1_000) return;
    void persistAudioDiagnostic(summary);
  });
  ipcMain.on('jarvis:voice-event', (event, message: unknown) => {
    if (!isTrustedVoiceSender(event) || typeof message !== 'string' || message.length > 1_000) return;
    void persistVoiceEvent(message);
  });
  // Native speaker verification: extract embeddings from enrollment samples.
  ipcMain.handle('jarvis:speaker-enroll', async (event, samples: unknown) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的声纹录入请求。');
    await ensureSpeakerVerifierReady();
    const floatSamples = (samples as number[][]).map((s) => Float32Array.from(s));
    // Extract a combined embedding from all samples concatenated.
    const combinedEmb = extractEnrollmentEmbedding(floatSamples, 16000);
    if (!combinedEmb) {
      throw new Error('录入的声音总时长不足，无法建立声纹模型。');
    }
    const embeddings = [Array.from(combinedEmb)];
    // Load into manager immediately.
    loadOwnerEmbedding(embeddings[0]);
    setOwnerEmbeddingCache(embeddings[0]);
    return { embeddings, embeddingDim: combinedEmb.length };
  });
  // Native speaker verification: verify test audio against stored owner embedding.
  ipcMain.handle('jarvis:speaker-verify', async (event, testAudio: unknown) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的声纹验证请求。');
    await ensureSpeakerVerifierReady();
    const test = testAudio as Float32Array;
    const { accepted, similarity } = verifySpeaker(test, 16000, 0.5);
    return { accepted, similarity };
  });
  ipcMain.handle('jarvis:voice-session-config', (event) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的语音会话配置请求。');
    return getVoiceProviderSessionConfig();
  });
  ipcMain.handle('jarvis:doubao-connect', async (event) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的豆包语音连接请求。');
    return doubaoVoiceTransport.connect(event.sender);
  });
  ipcMain.on('jarvis:doubao-send', (event, payload: unknown) => {
    if (!isTrustedVoiceSender(event) || typeof payload !== 'string') return;
    if (!doubaoVoiceTransport.send(payload)) {
      log('Dropped a Doubao voice event because its WebSocket was not open or the event was too large.');
    }
  });
  ipcMain.on('jarvis:doubao-close', (event) => {
    if (isTrustedVoiceSender(event)) doubaoVoiceTransport.close();
  });
  ipcMain.handle('jarvis:realtime-connect', async (event, sdp: string) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的 Realtime 请求。');
    return createRealtimeCall(sdp);
  });
  ipcMain.handle('jarvis:execute-action', async (event, name: string, args: unknown) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的电脑操作请求。');
    log(`Executing voice action: ${name}.`);
    return executeComputerAction(name, args);
  });
  ipcMain.on('jarvis:quit', (event) => {
    if (!isTrustedVoiceSender(event)) return;
    log('Quitting by explicit voice request.');
    app.quit();
  });
}

function createJarvisWindow() {
  jarvisWindow = new BrowserWindow({
    ...getVisualOverlayBounds(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hiddenInMissionControl: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // The visual renderer needs a full-screen transparent surface so assembly
  // fragments can travel beyond the 480px helmet anchor. It remains a pure
  // click-through overlay: it cannot receive focus or intercept desktop input,
  // and the independent voice core stays alive if this renderer is reloaded.
  jarvisWindow.setAlwaysOnTop(true, 'floating');
  jarvisWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  jarvisWindow.setIgnoreMouseEvents(true, { forward: true });
  jarvisWindow.on('show', () => sendToVisual('jarvis:visible', true));
  jarvisWindow.on('hide', () => sendToVisual('jarvis:visible', false));
  jarvisWindow.webContents.on('console-message', (event) => {
    const { message } = event;
    if (message.startsWith('[Ashley]')) log(message.slice('[Ashley]'.length).trim());
  });
  jarvisWindow.webContents.on('unresponsive', () => {
    log('Helmet renderer became unresponsive; hiding and reloading only the visual window.');
    hideAvatar();
    jarvisWindow?.webContents.reloadIgnoringCache();
  });
  jarvisWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Helmet renderer exited (${details.reason}); the independent voice core remains online.`);
    hideAvatar();
  });
  jarvisWindow.webContents.on('did-finish-load', () => {
    sendToVisual('jarvis:anchor', getHelmetAnchor());
    sendState('idle');
    if (awaitingAssemblyFrame) sendToVisual('jarvis:assemble');
    if (process.env.JARVIS_VISUAL_QA === '1') {
      setTimeout(() => playAssemblyEffect(), 750);
      // QA 全息截图：等装配结束（约 3.4s）后进入全息，配合
      // JARVIS_QA_CAPTURE_MS=6500 左右可截到完全升起的青色全息。
      // JARVIS_QA_HOLOGRAM_PERSIST=1 走常显模式；JARVIS_QA_DOCK=1 同时
      // 切到右下角缩小 anchor，验证小尺寸全息。
      if (process.env.JARVIS_QA_HOLOGRAM === '1' || process.env.JARVIS_QA_HOLOGRAM_PERSIST === '1') {
        setTimeout(() => {
          if (process.env.JARVIS_QA_DOCK === '1') sendToVisual('jarvis:anchor', getDockedAnchor());
          sendToVisual(
            'jarvis:hologram',
            process.env.JARVIS_QA_HOLOGRAM_PERSIST === '1' ? 'show-persistent' : 'show'
          );
        }, 4_000);
      }
      setTimeout(async () => {
        const target = liveWindow(jarvisWindow);
        if (!target || target.webContents.isDestroyed()) return;
        const image = await target.webContents.capturePage();
        await fs.writeFile(
          process.env.JARVIS_QA_CAPTURE_PATH || '/private/tmp/jarvis-visual-qa.png',
          image.toPNG()
        );
        log('Visual QA capture written.');
        setTimeout(() => app.quit(), 100);
      }, Math.min(8_500, Math.max(900, Number(process.env.JARVIS_QA_CAPTURE_MS) || 8_500)));
    }
  });
  jarvisWindow.loadFile(
    path.join(__dirname, '../renderer/effects.html'),
    process.env.JARVIS_VISUAL_QA === '1'
      ? {
          query: {
            qa: '1',
            lighting: process.env.JARVIS_QA_LIGHTING ?? 'symmetric',
            bg: process.env.JARVIS_QA_BG ?? 'f2f2f2'
          }
        }
      : undefined
  );
}

function createVoiceWindow() {
  voiceWindow = new BrowserWindow({
    width: 1,
    height: 1,
    x: -10_000,
    y: -10_000,
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  voiceWindow.webContents.on('console-message', (event) => {
    const { message } = event;
    if (message.startsWith('[Ashley]')) log(`[VoiceCore] ${message.slice('[Ashley]'.length).trim()}`);
  });
  voiceWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Voice core exited (${details.reason}); restarting it without touching the desktop.`);
    voiceWindow = null;
    if (!appIsQuitting) createVoiceWindow();
  });
  voiceWindow.on('closed', () => {
    doubaoVoiceTransport.close();
    voiceWindow = null;
  });
  const extraWakeModels = parseExtraWakeModels(process.env.JARVIS_EXTRA_WAKE_MODELS);
  voiceWindow.loadFile(path.join(__dirname, '../renderer/voice.html'), {
    query: { extraWakeModels: JSON.stringify(extraWakeModels) }
  });
}

type ExtraWakeModel = { keyword: string; modelFile: string };

function parseExtraWakeModels(raw: string | undefined): ExtraWakeModel[] {
  if (!raw?.trim()) return [];
  const models: ExtraWakeModel[] = [];
  const seen = new Set(['hey_jarvis']);
  for (const item of raw.split(',')) {
    const separator = item.indexOf(':');
    const keyword = item.slice(0, separator).trim().toLowerCase();
    const modelFile = item.slice(separator + 1).trim();
    const validKeyword = /^[a-z0-9][a-z0-9_-]*$/.test(keyword);
    const validModelFile = /^[a-z0-9][a-z0-9._-]*\.onnx$/i.test(modelFile);
    if (separator <= 0 || !validKeyword || !validModelFile || seen.has(keyword)) {
      log(`Ignoring invalid or duplicate JARVIS_EXTRA_WAKE_MODELS entry: ${item.trim() || '(empty)'}.`);
      continue;
    }
    seen.add(keyword);
    models.push({ keyword, modelFile });
  }
  return models.slice(0, 8);
}

function toggleJarvisWindow() {
  const window = liveWindow(jarvisWindow);
  if (!window) return;
  if (window.isVisible()) window.hide();
  else window.showInactive();
}

function openWakeEnrollmentWindow() {
  const existing = liveWindow(wakeEnrollmentWindow);
  if (existing) {
    existing.show();
    existing.focus();
    return;
  }
  wakeEnrollmentWindow = new BrowserWindow({
    width: 560,
    height: 570,
    title: 'Ashley 专属唤醒录入',
    backgroundColor: '#05090d',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  wakeEnrollmentWindow.on('closed', () => {
    sendToWindow(voiceWindow, 'jarvis:wake-enrollment-command', 'cancel');
    wakeEnrollmentWindow = null;
  });
  wakeEnrollmentWindow.webContents.on('did-finish-load', () => {
    const capturePath = process.env.JARVIS_WAKE_ENROLLMENT_CAPTURE_PATH?.trim();
    if (!capturePath) return;
    setTimeout(async () => {
      const target = liveWindow(wakeEnrollmentWindow);
      if (!target) return;
      const image = await target.webContents.capturePage();
      await fs.writeFile(capturePath, image.toPNG());
      log(`Wake enrollment QA capture written to ${capturePath}.`);
    }, 800);
  });
  wakeEnrollmentWindow.loadFile(path.join(__dirname, '../renderer/wake-enrollment.html'));
}

function refreshTrayMenu() {
  if (!tray) return;
  const modeName = currentPersonalWakeMode === 'active'
    ? '已启用'
    : currentPersonalWakeMode === 'shadow'
      ? '观察模式'
      : '原方案';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示/隐藏', click: toggleJarvisWindow },
      { label: '放大居中', click: () => centerJarvis() },
      { label: '缩到右下角', click: () => dockJarvisToCorner() },
      { type: 'separator' },
      {
        label: '全息投影',
        type: 'checkbox',
        checked: hologramModeEnabled,
        click: (item) => {
          hologramModeEnabled = item.checked;
          log(`Hologram mode ${hologramModeEnabled ? 'enabled' : 'disabled'} via tray.`);
          if (hologramModeEnabled) {
            startHologramAutoShow();
          } else {
            stopHologramAutoShow();
            // 总开关关闭时常显一并关闭，菜单复选项同步取消勾选。
            if (hologramPersistent) {
              hologramPersistent = false;
              refreshTrayMenu();
            }
            // 正在展示中则立刻降落复位，不留半透明残影。
            sendToVisual('jarvis:hologram', 'hide');
          }
        }
      },
      {
        label: '全息常显',
        type: 'checkbox',
        checked: hologramPersistent,
        click: (item) => {
          hologramPersistent = item.checked;
          log(`Hologram persistent mode ${hologramPersistent ? 'enabled' : 'disabled'} via tray.`);
          if (hologramPersistent) {
            // 常显依赖总开关：若总开关关着，一并打开（定时展示仍按配置工作）。
            if (!hologramModeEnabled) {
              hologramModeEnabled = true;
              startHologramAutoShow();
            }
            // 休眠中点击常显：直接现身并展示全息。
            const window = liveWindow(jarvisWindow);
            if (window && !window.isVisible()) centerJarvis();
            sendToVisual('jarvis:hologram', 'show-persistent');
            refreshTrayMenu();
          } else {
            sendToVisual('jarvis:hologram', 'hide');
          }
        }
      },
      { label: '录入 Ashley 唤醒声纹…', click: openWakeEnrollmentWindow },
      {
        label: `专属唤醒：${modeName}`,
        submenu: [
          {
            label: '关闭个人验证（恢复原方案）',
            type: 'radio',
            checked: currentPersonalWakeMode === 'off',
            click: () => void setPersonalWakeMode('off')
          },
          {
            label: '观察模式（不拦截召唤）',
            type: 'radio',
            checked: currentPersonalWakeMode === 'shadow',
            click: () => void setPersonalWakeMode('shadow')
          },
          {
            label: '启用 Ashley 独立召唤',
            type: 'radio',
            checked: currentPersonalWakeMode === 'active',
            click: () => void setPersonalWakeMode('active')
          }
        ]
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  );
}

function createTrayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray/iconTemplate.png'));
  tray = new Tray(icon);
  tray.setToolTip('Ashley');
  refreshTrayMenu();
}

// Belt and braces for the same class of failure as writeConsole(): a broken
// stdout/stderr pipe surfaces as an EPIPE/EIO stream error rather than a throw
// at the call site, and an unhandled one still terminates the process. Anything
// that is not a dead-pipe error is left alone so real crashes stay visible.
function isBrokenPipeError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'EIO';
}

process.stdout.on('error', (error) => {
  if (!isBrokenPipeError(error)) throw error;
});
process.stderr.on('error', (error) => {
  if (!isBrokenPipeError(error)) throw error;
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = liveWindow(jarvisWindow);
    if (window?.isVisible()) window.focus();
  });

  app.whenReady().then(async () => {
    loadEnvironment();
    const configuredVoiceProvider = process.env.JARVIS_VOICE_PROVIDER?.trim().toLowerCase() || 'openai';
    const configuredVoice = process.env.DOUBAO_VOICE?.trim() || '(provider default)';
    const voiceFallback = process.env.JARVIS_ALLOW_VOICE_FALLBACK === '1' ? 'allowed' : 'blocked';
    const doubaoCredentials = process.env.DOUBAO_APP_ID?.trim() && process.env.DOUBAO_API_KEY?.trim()
      ? 'present'
      : 'missing';
    log(
      `Voice configuration loaded: provider=${configuredVoiceProvider}, voice=${configuredVoice}, `
      + `fallback=${voiceFallback}, doubaoCredentials=${doubaoCredentials}.`
    );
    registerIpcHandlers();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(
        (permission === 'media' && (
          webContents === voiceWindow?.webContents || webContents === jarvisWindow?.webContents
        ))
        || permission === 'geolocation'
      );
    });
    createJarvisWindow();
    if (process.env.JARVIS_VISUAL_QA !== '1') createVoiceWindow();
    screen.on('display-metrics-changed', () => {
      jarvisWindow?.setBounds(getVisualOverlayBounds());
      sendToVisual('jarvis:anchor', getHelmetAnchor());
    });
    const storedPersonalWakeModel = await readPersonalWakeModel();
    currentPersonalWakeMode = validatePersonalWakeModel(storedPersonalWakeModel)
      ? (storedPersonalWakeModel as { mode: 'off' | 'shadow' | 'active' }).mode
      : 'off';
    // Load the owner embedding into the native SpeakerEmbeddingManager at
    // startup so the first wake verification can match without waiting for
    // the extractor to initialize on-demand.
    const m = storedPersonalWakeModel as { embeddings?: number[][] } | null;
    if (m?.embeddings?.length) {
      try {
        await ensureSpeakerVerifierReady();
        loadOwnerEmbedding(m.embeddings[m.embeddings.length - 1]);
        setOwnerEmbeddingCache(m.embeddings[m.embeddings.length - 1]);
        log('Owner speaker embedding loaded into native verifier.');
      } catch (error) {
        log(`Failed to load owner speaker embedding: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    createTrayIcon();
    startHologramAutoShow();
    if (process.env.JARVIS_OPEN_WAKE_ENROLLMENT === '1') {
      setTimeout(openWakeEnrollmentWindow, 500);
    }
    globalShortcut.register('CommandOrControl+Shift+J', toggleJarvisWindow);
  });
}

app.on('will-quit', () => {
  appIsQuitting = true;
  doubaoVoiceTransport.close();
  stopHologramAutoShow();
  stopWindowMonitor();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
