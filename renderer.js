(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('cv'), ctx = canvas.getContext('2d', { alpha: false });
  let cfg = {}, blurOn = true, capStream = null, vid = null, timer = null, previewOn = false;
  let recorder = null, outStream = null, vtrack = null, audioCtx = null, micStream = null, chain = Promise.resolve();
  let recStartT = 0, clock = null, lastFile = null, busy = false, audioMuted = false;
  let analyser = null, animFrame = null;
  const msg = (t) => { $('msg').textContent = t || ''; };

  function paintUI() {
    const rec = recorder && recorder.state === 'recording';
    $('bRec').textContent = rec ? '⏹ রেকর্ড বন্ধ (Ctrl+Alt+R)' : '⏺ রেকর্ড শুরু (Ctrl+Alt+R)';
    $('bBlur').className = blurOn ? 'on' : 'off';
    $('bBlur').textContent = blurOn ? '🛡 ব্লার ON (Ctrl+Alt+B)' : '⚠ ব্লার OFF (Ctrl+Alt+B)';
    $('bPrev').textContent = previewOn ? '👁 প্রিভিউ বন্ধ' : '👁 প্রিভিউ';
    $('bMute').disabled = !rec;
    $('bMute').textContent = audioMuted ? '🔇 আনমিউট (Ctrl+Alt+M)' : '🔊 মিউট (Ctrl+Alt+M)';
    $('bMute').className = audioMuted ? 'off' : '';
    const n = (cfg.boxes || []).length;
    $('boxInfo').textContent = n ? `${n}টি ব্লার এলাকা সেট করা আছে` : 'কোনো ব্লার এলাকা নেই — Ctrl+Alt+B চেপে তৈরি করুন';
    $('vS').textContent = cfg.strength;
    canvas.style.borderColor = blurOn ? '#2a3b6e' : '#e11d2e';
  }

  function loop() {
    if (!capStream) return;
    const t0 = performance.now();
    if (vid && vid.readyState >= 2 && vid.videoWidth) {
      if (canvas.width !== vid.videoWidth || canvas.height !== vid.videoHeight) {
        canvas.width = vid.videoWidth;
        canvas.height = vid.videoHeight;
      }
      SafeComp.draw(ctx, vid, canvas.width, canvas.height, cfg.boxes, blurOn, cfg.strength);
      if (vtrack) vtrack.requestFrame();
    }
    timer = setTimeout(loop, Math.max(0, 1000 / cfg.fps - (performance.now() - t0)));
  }

  async function startCapture() {
    if (capStream) return;
    capStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: cfg.fps }, audio: true });
    vid = document.createElement('video');
    vid.muted = true;
    vid.srcObject = new MediaStream(capStream.getVideoTracks());
    await vid.play();
    loop();
  }

  function stopCapture() {
    if (recorder && recorder.state === 'recording') return;
    if (previewOn) return;
    clearTimeout(timer);
    timer = null;
    if (capStream) {
      capStream.getTracks().forEach((t) => t.stop());
    }
    capStream = null;
    vid = null;
  }

  // Populate audio input device list
  async function enumerateAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      const sel = $('sMic');
      sel.innerHTML = '<option value="">ডিফল্ট মাইক্রোফোন (Default)</option>';
      mics.forEach((m, idx) => {
        const opt = document.createElement('option');
        opt.value = m.deviceId;
        opt.textContent = m.label || `মাইক্রোফোন ${idx + 1}`;
        if (cfg.micDevice && cfg.micDevice === m.deviceId) {
          opt.selected = true;
        }
        sel.appendChild(opt);
      });
    } catch (e) {
      console.warn('Could not enumerate audio devices:', e);
    }
  }

  // Setup real-time audio volume visualizer
  function setupAudioMeter(sourceNode) {
    if (!audioCtx) return;
    try {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      sourceNode.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const pct = Math.min(100, Math.round((avg / 128) * 100));
        $('audioLevel').style.width = pct + '%';
        $('meterText').textContent = pct + '%';
        animFrame = requestAnimationFrame(updateMeter);
      };
      updateMeter();
    } catch (e) {
      console.warn('Audio meter setup failed:', e);
    }
  }

  function stopAudioMeter() {
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
    analyser = null;
    $('audioLevel').style.width = '0%';
    $('meterText').textContent = '0%';
  }

  async function buildAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) {}
    }
    const dest = audioCtx.createMediaStreamDestination();
    let hasAudio = false;

    // 1. System sound capture
    if (cfg.sys && capStream && capStream.getAudioTracks().length) {
      try {
        const sysSource = audioCtx.createMediaStreamSource(new MediaStream(capStream.getAudioTracks()));
        sysSource.connect(dest);
        hasAudio = true;
      } catch (e) {
        console.warn('System audio connection error:', e);
      }
    }

    // 2. Microphone capture
    if (cfg.mic) {
      try {
        const constraints = {
          audio: {
            deviceId: cfg.micDevice ? { exact: cfg.micDevice } : undefined,
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true
          }
        };
        micStream = await navigator.mediaDevices.getUserMedia(constraints);
        const micSource = audioCtx.createMediaStreamSource(micStream);
        micSource.connect(dest);
        hasAudio = true;
        setupAudioMeter(micSource);
      } catch (e) {
        msg('মাইক পাওয়া যায়নি — মাইক ছাড়া রেকর্ড হচ্ছে');
        console.warn('Microphone error:', e);
      }
    }

    // If no audio source is present, feed a silent track so MediaRecorder and ffmpeg never fail
    if (!hasAudio) {
      try {
        const osc = audioCtx.createConstantSource();
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
      } catch (e) {}
    }

    return dest.stream.getAudioTracks()[0] || null;
  }

  function pickMime() {
    const pref = { h264: 'video/webm;codecs=h264,opus', vp8: 'video/webm;codecs=vp8,opus', vp9: 'video/webm;codecs=vp9,opus' };
    return [pref[cfg.codec], pref.vp8, pref.vp9, 'video/webm'].find((m) => m && MediaRecorder.isTypeSupported(m));
  }

  async function startRec() {
    if (busy) return;
    busy = true;
    try {
      // 3 second countdown directly in the Windows/Steam style red HUD bar
      msg('রেকর্ডিং শুরু হচ্ছে...');
      window.api.updateRecHud({ active: true, time: '⏳ 3...', blurOn: blurOn, muted: audioMuted });
      $('status').textContent = '⏳ 3...';
      await new Promise(r => setTimeout(r, 1000));

      window.api.updateRecHud({ active: true, time: '⏳ 2...', blurOn: blurOn, muted: audioMuted });
      $('status').textContent = '⏳ 2...';
      await new Promise(r => setTimeout(r, 1000));

      window.api.updateRecHud({ active: true, time: '⏳ 1...', blurOn: blurOn, muted: audioMuted });
      $('status').textContent = '⏳ 1...';
      await new Promise(r => setTimeout(r, 1000));

      msg('স্ক্রিন ক্যাপচার শুরু হচ্ছে...');
      await startCapture();

      msg('অডিও সেটআপ হচ্ছে...');
      outStream = canvas.captureStream(0);
      vtrack = outStream.getVideoTracks()[0];
      const at = await buildAudio();
      if (at) outStream.addTrack(at);

      msg('রেকর্ডার শুরু হচ্ছে...');
      await window.api.recStart();
      recorder = new MediaRecorder(outStream, {
        mimeType: pickMime(),
        videoBitsPerSecond: cfg.bitrate * 1e6,
        audioBitsPerSecond: 192000
      });

      chain = Promise.resolve();
      recorder.ondataavailable = (e) => {
        if (e.data.size) chain = chain.then(() => e.data.arrayBuffer()).then((b) => window.api.recChunk(b));
      };

      recorder.onstop = async () => {
        await chain;
        window.api.updateRecHud({ active: false });
        window.api.hideRecHud();
        stopAudioMeter();
        if (micStream) {
          micStream.getTracks().forEach((t) => t.stop());
          micStream = null;
        }
        if (audioCtx) {
          try { await audioCtx.close(); } catch (e) {}
          audioCtx = null;
        }
        vtrack = null;
        outStream = null;
        clearInterval(clock);
        $('status').textContent = '⏳ ফাইল সেভ হচ্ছে...';
        msg(cfg.mp4 ? 'MP4 তৈরি হচ্ছে, একটু অপেক্ষা করুন...' : '');

        const r = await window.api.recStop(cfg.mp4, cfg.fps);
        lastFile = r.file;
        $('bOpen').disabled = !lastFile;
        $('status').textContent = '⏹ প্রস্তুত';
        msg(r.file ? `✅ সেভ হয়েছে: ${r.file}` + (r.error ? ` (${r.error})` : '') : 'কিছু সেভ হয়নি');
        recorder = null;
        stopCapture();
        paintUI();
      };

      recorder.start(1000);
      recStartT = Date.now();
      audioMuted = false;
      msg('');

      // Show the red Windows/Steam recording HUD immediately
      window.api.updateRecHud({ active: true, time: '00:00', blurOn: blurOn, muted: false });

      clock = setInterval(() => {
        const s = Math.floor((Date.now() - recStartT) / 1000);
        const timeStr = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        $('status').textContent = `🔴 রেকর্ড হচ্ছে ${timeStr}` + (blurOn ? '' : '  ⚠ ব্লার OFF');
        // Update floating recording HUD bar
        window.api.updateRecHud({ active: true, time: timeStr, blurOn: blurOn, muted: audioMuted });
      }, 500);

    } catch (e) {
      msg('শুরু করা যায়নি: ' + e.message);
      console.error('Recording error:', e);
      recorder = null;
      stopCapture();
      stopAudioMeter();
      window.api.updateRecHud({ active: false });
      window.api.hideRecHud();
    }
    busy = false;
    paintUI();
  }

  function toggleRec() {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    } else {
      startRec();
    }
    paintUI();
  }

  function setBlur(v) {
    blurOn = v;
    paintUI();
    if (recorder && recorder.state === 'recording') {
      window.api.updateRecHud({ blurOn: blurOn });
    }
    if (blurOn) {
      window.api.showToast({
        type: 'blue',
        title: 'ব্লার মোড সক্রিয় (Blur Active)',
        sub: 'ব্লার অন করা হয়েছে',
        duration: 2500,
        icon: '🔷'
      });
      msg('✅ ব্লার অন করা হয়েছে');
      setTimeout(() => msg(''), 3000);
    } else {
      window.api.showToast({
        type: 'warn',
        title: 'ব্লার পজ করা হয়েছে (Blur Paused)',
        sub: 'ব্লার অফ করা হয়েছে',
        duration: 2500,
        icon: '⏸️'
      });
      msg('⚠ ব্লার অফ করা হয়েছে');
      setTimeout(() => msg(''), 3000);
    }
  }

  function toggleMute() {
    if (!recorder || recorder.state !== 'recording') return;
    audioMuted = !audioMuted;

    // Toggle track enabled states
    if (outStream) {
      outStream.getAudioTracks().forEach((track) => {
        track.enabled = !audioMuted;
      });
    }
    if (micStream) {
      micStream.getAudioTracks().forEach((track) => {
        track.enabled = !audioMuted;
      });
    }

    $('bMute').textContent = audioMuted ? '🔇 আনমিউট (Ctrl+Alt+M)' : '🔊 মিউট (Ctrl+Alt+M)';
    $('bMute').className = audioMuted ? 'off' : '';
    msg(audioMuted ? '🔇 অডিও মিউট করা হয়েছে' : '🔊 অডিও সক্রিয় করা হয়েছে');

    // Update floating HUD bar
    window.api.updateRecHud({ muted: audioMuted });

    // Show floating toast
    window.api.showToast({
      type: audioMuted ? 'warn' : 'info',
      title: audioMuted ? 'অডিও মিউট করা হয়েছে' : 'অডিও আনমিউট করা হয়েছে',
      sub: audioMuted ? 'Audio Muted' : 'Audio Active',
      duration: 2000,
      icon: audioMuted ? '🔇' : '🎙️'
    });

    setTimeout(() => msg(''), 3000);
  }

  async function togglePreview() {
    if (previewOn) {
      previewOn = false;
      stopCapture();
      stopAudioMeter();
      $('hint').textContent = 'প্রিভিউ বন্ধ।';
    } else {
      try {
        previewOn = true;
        await startCapture();
        $('hint').textContent = 'নীল বর্ডার = ব্লার ON, লাল বর্ডার = ব্লার OFF। এই উইন্ডো রেকর্ডিংয়ে আসে না।';
      } catch (e) {
        previewOn = false;
        msg('প্রিভিউ শুরু হয়নি: ' + e.message);
      }
    }
    paintUI();
  }

  function save(p) {
    Object.assign(cfg, p);
    window.api.saveConfig(p);
    paintUI();
  }

  async function init() {
    cfg = await window.api.getConfig();
    await enumerateAudioDevices();

    $('rS').value = cfg.strength;
    $('sF').value = String(cfg.fps);
    $('sB').value = String(cfg.bitrate);
    $('sC').value = cfg.codec;
    $('cM').checked = cfg.mic !== false;
    $('cS').checked = cfg.sys !== false;
    $('cP').checked = cfg.mp4 !== false;

    $('bRec').onclick = toggleRec;
    $('bPrev').onclick = togglePreview;
    $('bBlur').onclick = () => setBlur(!blurOn);
    $('bMute').onclick = toggleMute;
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
    $('sF').onchange = (e) => save({ fps: +e.target.value });
    $('sB').onchange = (e) => save({ bitrate: +e.target.value });
    $('sC').onchange = (e) => save({ codec: e.target.value });
    $('sMic').onchange = (e) => save({ micDevice: e.target.value });
    $('cM').onchange = (e) => save({ mic: e.target.checked });
    $('cS').onchange = (e) => save({ sys: e.target.checked });
    $('cP').onchange = (e) => save({ mp4: e.target.checked });

    // Global Hotkeys from main process
    window.api.onHotkey((k) => {
      if (k === 'toggle-rec') toggleRec();
      if (k === 'blur-drag') {
        blurOn = true;
        window.api.openOverlay();
        paintUI();
      }
      if (k === 'toggle-mute') toggleMute();
    });

    // In-window hotkey listeners
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && e.code === 'KeyR') {
        e.preventDefault();
        toggleRec();
      } else if (e.ctrlKey && e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        blurOn = true;
        window.api.openOverlay();
        paintUI();
      } else if ((e.ctrlKey && e.altKey && e.code === 'KeyM') || (e.code === 'KeyM' && !e.ctrlKey && !e.altKey && !['INPUT', 'SELECT'].includes(e.target.tagName))) {
        e.preventDefault();
        toggleMute();
      }
    });

    window.api.onHotkeyFail((ks) => msg('এই হটকি অন্য প্রোগ্রাম ব্যবহার করছে: ' + ks.join(', ')));
    window.api.onBoxes((b) => { cfg.boxes = b; paintUI(); });
    window.api.onBlurStatus((s) => {
      if (s.on && !s.overlay) {
        msg('✅ ব্লার অন করা হয়েছে');
      }
    });
    window.api.onBlurOverlayCancelled(() => {
      msg('⏸️ ব্লার পজ করা হয়েছে (Blur Paused)');
    });

    paintUI();
  }

  init();
})();
