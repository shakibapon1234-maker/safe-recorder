const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (p) => ipcRenderer.invoke('save-config', p),
  openOverlay: () => ipcRenderer.invoke('open-overlay'),
  recStart: () => ipcRenderer.invoke('rec-start'),
  recChunk: (buf) => ipcRenderer.send('rec-chunk', buf),
  recStop: (convert, fps) => ipcRenderer.invoke('rec-stop', convert, fps),
  showFile: (f) => ipcRenderer.invoke('show-file', f),
  overlayDone: (b) => ipcRenderer.invoke('overlay-done', b),
  overlayCancel: () => ipcRenderer.invoke('overlay-cancel'),
  selectSavePath: () => ipcRenderer.invoke('select-save-path'),
  showIndicator: (text, color) => ipcRenderer.send('show-indicator', text, color),
  hideIndicator: () => ipcRenderer.send('hide-indicator'),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, k) => cb(k)),
  onHotkeyFail: (cb) => ipcRenderer.on('hotkey-fail', (_e, k) => cb(k)),
  onBoxes: (cb) => ipcRenderer.on('boxes-updated', (_e, b) => cb(b)),
  onInitOverlay: (cb) => ipcRenderer.on('init-overlay', (_e, d) => cb(d))
});
