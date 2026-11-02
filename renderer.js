(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('cv'), ctx = canvas.getContext('2d', { alpha: false });
  let cfg = {}, blurOn = true, capStream = null, vid = null, timer = null, previewOn = false;
  let recorder = null, outStream = null, vtrack = null, audioCtx = null, micStream = null, chain = Promise.resolve();
  let recStartT = 0, clock = null, lastFile = null, busy = false;
  const msg = (t) => { $('msg').textContent = t || ''; };

  function paintUI() {
    const rec = recorder && recorder.state === 'recording';
    $('bRec').textContent = rec ? '⏹ রেকর্ড বন্ধ (Ctrl+Alt+R)' : '⏺ রেকর্ড শুরু (Ctrl+Alt+R)';
    $('bBlur').className = blurOn ? 'on' : 'off';
    $('bBlur').textContent = blurOn ? '🛡 ব্লার ON (Ctrl+Alt+B)' : '⚠ ব্লার OFF (Ctrl+Alt+B)';
    $('bPrev').textContent = previewOn ? '👁 প্রিভিউ বন্ধ' : '👁 প্রিভিউ';
    const n = (cfg.boxes || []).length;
    $('boxInfo').textContent = n ? `${n}টি ব্লার এলাকা সেট করা আছে` : 'কোনো ব্লার এলাকা নেই — Ctrl+Alt+B চাপুন';
    $('vS').textContent = cfg.strength;
    canvas.style.borderColor = blurOn ? '#2a3b6e' : '#e11d2e';
  }

  function loop() {
    if (!capStream) return;
    const t0 = performance.now();
    if (vid.readyState >= 2 && vid.videoWidth) {
      if (canvas.width !== vid.videoWidth || canvas.height !== vid.videoHeight) { canvas.width = vid.videoWidth; canvas.height = vid.videoHeight; }
      SafeComp.draw(ctx, vid, canvas.width, canvas.height, cfg.boxes, blurOn, cfg.strength);
      if (vtrack) vtrack.requestFrame();
    }
    timer = setTimeout(loop, Math.max(0, 1000 / cfg.fps - (performance.now() - t0)));
  }
  async function startCapture() {
    if (capStream) return;
    capStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: cfg.fps }, audio: true });
    vid = document.createElement('video'); vid.muted = true;
    vid.srcObject = new MediaStream(capStream.getVideoTracks());
    await vid.play();
    loop();
  }
  function stopCapture() {
    if (recorder && recorder.state === 'recording') return;
    if (previewOn) return;
    clearTimeout(timer); timer = null;
    if (capStream) capStream.getTracks().forEach((t) => t.stop());
    capStream = null; vid = null;
  }
  async function buildAudio() {
    audioCtx = new AudioContext(); const dest = audioCtx.createMediaStreamDestination(); let any = false;
    if (cfg.sys && capStream.getAudioTracks().length) { audioCtx.createMediaStreamSource(new MediaStream(capStream.getAudioTracks())).connect(dest); any = true; }
    if (cfg.mic) {
      try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
        audioCtx.createMediaStreamSource(micStream).connect(dest); any = true; } catch (e) { msg('মাইক পাওয়া যায়নি — মাইক ছাড়া রেকর্ড হচ্ছে'); }
    }
    return any ? dest.stream.getAudioTracks()[0] : null;
  }
  function pickMime() {
    const pref = { h264: 'video/webm;codecs=h264,opus', vp8: 'video/webm;codecs=vp8,opus', vp9: 'video/webm;codecs=vp9,opus' };
    return [pref[cfg.codec], pref.vp8, pref.vp9, 'video/webm'].find((m) => m && MediaRecorder.isTypeSupported(m));
  }
  async function startRec() {
    if (busy) return; busy = true;
    try {
      // 3 second countdown with screen indicator
      msg('রেকর্ডিং শুরু হচ্ছে...');
      window.api.showIndicator('⏳ 3...', '#f5b301');
      $('status').textContent = '⏳ 3...';
      await new Promise(r => setTimeout(r, 1000));
      window.api.showIndicator('⏳ 2...', '#f5b301');
      $('status').textContent = '⏳ 2...';
      await new Promise(r => setTimeout(r, 1000));
      window.api.showIndicator('⏳ 1...', '#f5b301');
      $('status').textContent = '⏳ 1...';
      await new Promise(r => setTimeout(r, 1000));

      msg('স্ক্রিন ক্যাপচার শুরু হচ্ছে...');
      await startCapture();
      msg('অডিও সেটআপ হচ্ছে...');
      outStream = canvas.captureStream(0); vtrack = outStream.getVideoTracks()[0];
      const at = await buildAudio(); if (at) outStream.addTrack(at);
      msg('রেকর্ডার শুরু হচ্ছে...');
      await window.api.recStart();
      recorder = new MediaRecorder(outStream, { mimeType: pickMime(), videoBitsPerSecond: cfg.bitrate * 1e6, audioBitsPerSecond: 192000 });
      chain = Promise.resolve();
      recorder.ondataavailable = (e) => { if (e.data.size) chain = chain.then(() => e.data.arrayBuffer()).then((b) => window.api.recChunk(b)); };
      recorder.onstop = async () => {
        await chain;
        window.api.hideIndicator();
        if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
        if (audioCtx) { audioCtx.close(); audioCtx = null; }
        vtrack = null; outStream = null; clearInterval(clock);
        $('status').textContent = '⏳ ফাইল সেভ হচ্ছে...'; msg(cfg.mp4 ? 'MP4 তৈরি হচ্ছে, একটু অপেক্ষা করুন...' : '');
        const r = await window.api.recStop(cfg.mp4, cfg.fps);
        lastFile = r.file; $('bOpen').disabled = !lastFile;
        $('status').textContent = '⏹ প্রস্তুত';
        msg(r.file ? `✅ সেভ হয়েছে: ${r.file}` + (r.error ? ` (${r.error})` : '') : 'কিছু সেভ হয়নি');
        recorder = null; stopCapture(); paintUI();
      };
      recorder.start(1000); recStartT = Date.now(); msg('');
      window.api.showIndicator('🔴 রেকর্ডিং', '#e11d2e');
      clock = setInterval(() => { const s = Math.floor((Date.now() - recStartT) / 1000);
        $('status').textContent = `🔴 রেকর্ড হচ্ছে ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` + (blurOn ? '' : '  ⚠ ব্লার OFF'); }, 500);
    } catch (e) {
      msg('শুরু করা যায়নি: ' + e.message);
      console.error('Recording error:', e);
      recorder = null; stopCapture(); window.api.hideIndicator();
    }
    busy = false; paintUI();
  }
  function toggleRec() { if (recorder && recorder.state === 'recording') recorder.stop(); else startRec(); paintUI(); }
  function setBlur(v) { blurOn = v; paintUI(); if (blurOn) window.api.showIndicator('🛡 ব্লার ON', '#14a44d'); else window.api.hideIndicator(); }
  async function togglePreview() {
    if (previewOn) { previewOn = false; stopCapture(); $('hint').textContent = 'প্রিভিউ বন্ধ।'; }
    else { try { previewOn = true; await startCapture(); $('hint').textContent = 'লাল বর্ডার = ব্লার OFF। এই উইন্ডো রেকর্ডিংয়ে আসে না।'; } catch (e) { previewOn = false; msg('প্রিভিউ শুরু হয়নি: ' + e.message); } }
    paintUI();
  }
  function save(p) { Object.assign(cfg, p); window.api.saveConfig(p); paintUI(); }

  async function init() {
    cfg = await window.api.getConfig();
    $('rS').value = cfg.strength; $('sF').value = String(cfg.fps); $('sB').value = String(cfg.bitrate); $('sC').value = cfg.codec;
    $('cM').checked = cfg.mic; $('cS').checked = cfg.sys; $('cP').checked = cfg.mp4;
    $('bRec').onclick = toggleRec; $('bPrev').onclick = togglePreview; $('bBlur').onclick = () => setBlur(!blurOn);
    $('bOpen').onclick = () => window.api.showFile(lastFile);
    $('bPath').onclick = async () => {
      const path = await window.api.selectSavePath();
      if (path) {
        $('pathInfo').textContent = `সেভ লোকেশন: ${path}`;
        msg('সেভ লোকেশন আপডেট হয়েছে');
      }
    };
    if (cfg.savePath) $('pathInfo').textContent = `সেভ লোকেশন: ${cfg.savePath}`;
    $('rS').oninput = (e) => save({ strength: +e.target.value });
    $('sF').onchange = (e) => save({ fps: +e.target.value }); $('sB').onchange = (e) => save({ bitrate: +e.target.value });
    $('sC').onchange = (e) => save({ codec: e.target.value });
    $('cM').onchange = (e) => save({ mic: e.target.checked }); $('cS').onchange = (e) => save({ sys: e.target.checked }); $('cP').onchange = (e) => save({ mp4: e.target.checked });
    window.api.onHotkey((k) => {
    if (k === 'toggle-rec') toggleRec();
    if (k === 'blur-drag') { blurOn = true; window.api.openOverlay(); }
  });
    window.api.onHotkeyFail((ks) => msg('এই হটকি অন্য প্রোগ্রাম ব্যবহার করছে: ' + ks.join(', ')));
    window.api.onBoxes((b) => { cfg.boxes = b; paintUI(); });
    paintUI();
  }
  init();
})();
