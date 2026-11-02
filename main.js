const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked'); } catch (e) {}

const DEFAULTS = { boxes: [], strength: 24, fps: 30, bitrate: 12, codec: 'h264', mic: true, sys: true, mp4: true, savePath: '', micDevice: '' };

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg() { try { const data = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); return Object.assign({}, DEFAULTS, { ...data, boxes: [] }); } catch (e) { return Object.assign({}, DEFAULTS); } }
function saveCfg() { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (e) {} }

function setDefaultSavePath() {
  try {
    if (!fs.existsSync(cfgFile())) {
      const downloadsPath = app.getPath('downloads');
      cfg.savePath = downloadsPath;
      saveCfg();
    }
  } catch (e) {}
}

let win = null, overlay = null, hudWin = null, cfg = null, recStream = null, recPath = null;
const webPrefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false };

function createWin() {
  win = new BrowserWindow({ width: 560, height: 860, title: 'Safe Recorder', backgroundColor: '#0b1630', webPreferences: webPrefs });
  win.setMenuBarVisibility(false);
  win.setContentProtection(true);            // this window is NOT captured in the recording
  win.loadFile('index.html');
  win.on('closed', () => {
    win = null;
    if (overlay) overlay.close();
    if (hudWin) hudWin.close();
  });
}

// Floating HUD Window for Windows/Steam-style Recording Bar and Blue/Warn Toasts
function getHudWin() {
  if (hudWin && !hudWin.isDestroyed()) return hudWin;
  const d = screen.getPrimaryDisplay();
  const width = 440;
  const height = 66;
  hudWin = new BrowserWindow({
    x: Math.round(d.bounds.x + (d.bounds.width - width) / 2),
    y: d.bounds.y + 14,
    width: width,
    height: height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    focusable: false, // Never steal focus from other apps
    webPreferences: webPrefs
  });
  hudWin.setContentProtection(true);        // HUD is NEVER captured in the recording
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.loadFile('hud.html');
  hudWin.on('closed', () => { hudWin = null; });
  return hudWin;
}

function showHudToast(type, title, sub, duration = 2500, icon = '') {
  // If overlay is currently open, do not show HUD to avoid covering overlay's bar
  if (overlay) return;
  const h = getHudWin();
  h.showInactive(); // Show without stealing keyboard focus
  h.webContents.send('hud-show-toast', { type, title, sub, duration, icon });
}

function updateHudRec(data) {
  // If overlay is open, don't show HUD
  if (overlay && data.active) return;
  const h = getHudWin();
  if (data.active) {
    h.showInactive(); // Show without stealing keyboard focus
  }
  h.webContents.send('hud-update-rec', data);
}

function hideHud() {
  if (hudWin && !hudWin.isDestroyed()) {
    hudWin.webContents.send('hud-update-rec', { active: false });
    hudWin.hide();
  }
}

function toggleOverlay() {
  if (overlay) {
    // If overlay is open, close/cancel it
    overlay.close();
    overlay = null;
    showHudToast('warn', 'ব্লার পজ করা হয়েছে (Blur Paused)', 'ব্লার বন্ধ করা হয়েছে', 2500, '⏸️');
    if (win) win.webContents.send('blur-overlay-cancelled');
    return;
  }
  openOverlay();
}

function openOverlay() {
  if (overlay) return;

  // Hide the recording HUD so it never covers the overlay instructions!
  hideHud();

  const d = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, fullscreenable: false,
    focusable: true,
    webPreferences: webPrefs
  });
  overlay.setContentProtection(true);        // box editor is NOT captured either
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlay.webContents.send('init-overlay', { boxes: cfg.boxes });
    overlay.focus();
  });
  overlay.on('closed', () => {
    overlay = null;
  });

  if (win) win.webContents.send('blur-overlay-opened');
}

function toMp4(src, dst, fps) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const args = [
      '-y', '-loglevel', 'error',
      '-i', src,
      '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:a', 'aac', '-b:a', '192k',
      dst
    ];
    const p = spawn(ffmpegPath, args);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0 && fs.existsSync(dst)));
  });
}

app.whenReady().then(() => {
  cfg = loadCfg();
  setDefaultSavePath();
  getHudWin(); // Pre-warm HUD window

  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const pid = String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === pid) || sources[0];
      cb({ video: src, audio: 'loopback' });
    }).catch(() => cb({}));
  }, { useSystemPicker: false });

  ipcMain.handle('get-config', () => cfg);
  ipcMain.handle('save-config', (_e, patch) => { Object.assign(cfg, patch); saveCfg(); return cfg; });
  ipcMain.handle('open-overlay', () => { toggleOverlay(); });
  ipcMain.handle('select-save-path', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'সেভ লোকেশন বাছুন'
    });
    if (!result.canceled && result.filePaths.length > 0) {
      cfg.savePath = result.filePaths[0];
      saveCfg();
      return cfg.savePath;
    }
    return null;
  });

  // HUD and Toast messaging
  ipcMain.on('show-toast', (_e, data) => {
    showHudToast(data.type, data.title, data.sub, data.duration, data.icon);
  });
  ipcMain.on('update-rec-hud', (_e, data) => {
    updateHudRec(data);
  });
  ipcMain.on('hide-rec-hud', () => {
    hideHud();
  });
  ipcMain.on('hud-stop-clicked', () => {
    if (win) win.webContents.send('hotkey', 'toggle-rec');
  });
  ipcMain.on('hud-mute-clicked', () => {
    if (win) win.webContents.send('hotkey', 'toggle-mute');
  });

  // Backward compatibility
  ipcMain.on('show-indicator', (_e, text, color) => {
    showHudToast('info', text, '', 2500);
  });
  ipcMain.on('hide-indicator', () => {
    hideHud();
  });
  ipcMain.on('show-countdown', (_e, number) => {
    updateHudRec({ active: true, time: `⏳ ${number}...` });
  });
  ipcMain.on('hide-countdown', () => {});

  ipcMain.handle('overlay-done', (_e, boxes) => {
    cfg.boxes = boxes; saveCfg();
    if (overlay) {
      overlay.close();
      overlay = null;
    }
    showHudToast('blue', 'ব্লার এরিয়া সেভ করা হয়েছে', `${boxes.length}টি এলাকা ব্লার করা হবে`, 2500);
    if (win) {
      win.webContents.send('boxes-updated', boxes);
      win.webContents.send('blur-status', { on: true, overlay: false });
    }
  });

  ipcMain.handle('overlay-cancel', () => {
    if (overlay) {
      overlay.close();
      overlay = null;
    }
    // Blue/warn notification for blur paused when Escape is pressed
    showHudToast('warn', 'ব্লার পজ করা হয়েছে (Blur Paused)', 'Escape চেপে ব্লার বন্ধ করা হয়েছে', 2500, '⏸️');
    if (win) win.webContents.send('blur-overlay-cancelled');
  });

  ipcMain.on('blur-overlay-opened', () => {
    if (win) win.webContents.send('blur-status', { on: true, overlay: true });
  });

  ipcMain.handle('rec-start', () => {
    const dir = cfg.savePath || path.join(app.getPath('videos'), 'SafeRecorder');
    fs.mkdirSync(dir, { recursive: true });
    const t = new Date(), z = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${z(t.getMonth() + 1)}${z(t.getDate())}-${z(t.getHours())}${z(t.getMinutes())}${z(t.getSeconds())}`;
    recPath = path.join(dir, `rec-${stamp}.webm`);
    recStream = fs.createWriteStream(recPath);
    return recPath;
  });
  ipcMain.on('rec-chunk', (_e, buf) => { if (recStream) recStream.write(Buffer.from(buf)); });
  ipcMain.handle('rec-stop', async (_e, convert, fps) => {
    if (overlay) {
      overlay.close();
      overlay = null;
    }
    if (!recStream) return { file: null };
    await new Promise((r) => recStream.end(r)); recStream = null;
    const webm = recPath;
    if (!convert) return { file: webm, converted: false };
    const mp4 = webm.replace(/\.webm$/, '.mp4');
    const ok = await toMp4(webm, mp4, fps || 30);
    if (ok) { try { fs.unlinkSync(webm); } catch (e) {} return { file: mp4, converted: true }; }
    return { file: webm, converted: false, error: 'MP4 convert failed; WebM kept' };
  });
  ipcMain.handle('show-file', (_e, f) => { if (f) shell.showItemInFolder(f); });

  createWin();

  // Safe global hotkeys:
  // Ctrl+Alt+R = Record Toggle
  // Ctrl+Alt+B = Blur Toggle / Drag Overlay
  // Ctrl+Alt+M = Mic Mute Toggle
  const keys = {
    'CommandOrControl+Alt+R': 'toggle-rec',
    'CommandOrControl+Alt+B': 'blur-drag',
    'CommandOrControl+Alt+M': 'toggle-mute'
  };
  const failed = [];
  for (const [k, name] of Object.entries(keys)) {
    const ok = globalShortcut.register(k, () => {
      if (name === 'blur-drag') {
        toggleOverlay();
      } else {
        if (win) win.webContents.send('hotkey', name);
      }
    });
    if (!ok) failed.push(k);
  }
  if (failed.length && win) win.webContents.once('did-finish-load', () => win.webContents.send('hotkey-fail', failed));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (hudWin && !hudWin.isDestroyed()) hudWin.destroy();
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
});
app.on('window-all-closed', () => app.quit());
