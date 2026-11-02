const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked'); } catch (e) {}

const DEFAULTS = { boxes: [], strength: 24, fps: 30, bitrate: 12, codec: 'h264', mic: true, sys: true, mp4: true, savePath: '' };

// Set default save path to Downloads on first run
function setDefaultSavePath() {
  try {
    if (!fs.existsSync(cfgFile())) {
      const downloadsPath = app.getPath('downloads');
      cfg.savePath = downloadsPath;
      saveCfg();
    }
  } catch (e) {}
}
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg() { try { const data = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); return Object.assign({}, DEFAULTS, { ...data, boxes: [] }); } catch (e) { return Object.assign({}, DEFAULTS); } }
function saveCfg() { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2)); } catch (e) {} }

let win = null, overlay = null, indicator = null, cfg = null, recStream = null, recPath = null;
const webPrefs = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false };

function createWin() {
  win = new BrowserWindow({ width: 560, height: 820, title: 'Safe Recorder', backgroundColor: '#0b1630', webPreferences: webPrefs });
  win.setMenuBarVisibility(false);
  win.setContentProtection(true);            // this window is NOT captured in the recording
  win.loadFile('index.html');
  win.on('closed', () => { win = null; if (overlay) overlay.close(); });
}

function openOverlay() {
  if (overlay) return;
  const d = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, fullscreenable: false, webPreferences: webPrefs
  });
  overlay.setContentProtection(true);        // box editor is NOT captured either
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => { overlay.webContents.send('init-overlay', { boxes: cfg.boxes }); overlay.focus(); });
  overlay.on('closed', () => { overlay = null; });
  showIndicator('▭ এরিয়া সিলেক্ট করুন', '#f5b301');
}

function showIndicator(text, color) {
  if (indicator) {
    indicator.webContents.send('update-indicator', { text, color });
    return;
  }
  const d = screen.getPrimaryDisplay();
  indicator = new BrowserWindow({
    x: d.bounds.x + 20, y: d.bounds.y + 20, width: 200, height: 60,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    hasShadow: false, fullscreenable: false, webPreferences: { ...webPrefs, contextIsolation: false }
  });
  indicator.setContentProtection(true);        // indicator is NOT captured
  indicator.setAlwaysOnTop(true, 'screen-saver');
  indicator.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <html>
    <head>
      <style>
        body { margin: 0; padding: 15px 20px; font-family: 'Segoe UI', sans-serif; font-size: 18px; font-weight: bold; color: white; display: flex; align-items: center; gap: 10px; }
        .dot { width: 20px; height: 20px; border-radius: 50%; background: ${color}; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      </style>
    </head>
    <body>
      <div class="dot"></div>
      <span id="text">${text}</span>
    </body>
    </html>
  `)}`);
  indicator.on('closed', () => { indicator = null; });
}

function hideIndicator() {
  if (indicator) {
    indicator.close();
    indicator = null;
  }
}

function toMp4(src, dst, fps) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const p = spawn(ffmpegPath, ['-y', '-loglevel', 'error', '-i', src, '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', dst]);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0 && fs.existsSync(dst)));
  });
}

app.whenReady().then(() => {
  cfg = loadCfg();
  setDefaultSavePath();
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const pid = String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === pid) || sources[0];
      cb({ video: src, audio: 'loopback' });
    }).catch(() => cb({}));
  }, { useSystemPicker: false });

  ipcMain.handle('get-config', () => cfg);
  ipcMain.handle('save-config', (_e, patch) => { Object.assign(cfg, patch); saveCfg(); return cfg; });
  ipcMain.handle('open-overlay', () => { openOverlay(); });
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
  ipcMain.on('show-indicator', (_e, text, color) => showIndicator(text, color));
  ipcMain.on('hide-indicator', () => hideIndicator());
  ipcMain.handle('overlay-done', (_e, boxes) => {
    cfg.boxes = boxes; saveCfg();
    if (overlay) overlay.close();
    // Show blur indicator after overlay closes
    showIndicator('🛡 ব্লার ON', '#14a44d');
    if (win) win.webContents.send('boxes-updated', boxes);
  });
  ipcMain.handle('overlay-cancel', () => { if (overlay) overlay.close(); hideIndicator(); });

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

  const keys = { 'CommandOrControl+Alt+R': 'toggle-rec', 'CommandOrControl+Alt+B': 'blur-drag' };
  const failed = [];
  for (const [k, name] of Object.entries(keys)) {
    const ok = globalShortcut.register(k, () => { if (win) win.webContents.send('hotkey', name); });
    if (!ok) failed.push(k);
  }
  if (failed.length && win) win.webContents.once('did-finish-load', () => win.webContents.send('hotkey-fail', failed));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
