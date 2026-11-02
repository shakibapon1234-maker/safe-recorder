(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('cv'), ctx = canvas.getContext('2d', { alpha: false });
  let cfg = {}, blurOn = true, capStream = null, vid = null, timer = null, previewOn = false;
  let recorder = null, outStream = null, vtrack = null, audioCtx = null, micStream = null, chain = Promise.resolve();
  let masterGain = null;
  let clock = null, lastFile = null, busy = false, audioMuted = false, isRecPaused = false, recSeconds = 0;
  let analyser = null, animFrame = null;
  const msg = (t) => { $('msg').textContent = t || ''; };

  const formatTime = (totalSec) => {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  function paintUI() {
    const isRecording = recorder && (recorder.state === 'recording' || recorder.state === 'paused');
    $('bRec').textContent = isRecording ? '⏹ রেকর্ড বন্ধ (Ctrl+Alt+R)' : '⏺ রেকর্ড শুরু (Ctrl+Alt+R)';
    $('bRec').className = isRecording ? 'off' : 'rec';

    // Pause button state
    $('bPause').disabled = !isRecording;
    if (isRecording) {
      if (isRecPaused) {
        $('bPause').textContent = '▶️ পুনরায় চালু (Ctrl+Alt+P)';
        $('bPause').className = 'paused';
      } else {
        $('bPause').textContent = '⏸️ পজ (Ctrl+Alt+P)';
        $('bPause').className = '';
      }
    } else {
      $('bPause').textContent = '⏸️ পজ (Ctrl+Alt+P)';
      $('bPause').className = '';
    }

    $('bBlur').className = blurOn ? 'on' : 'off';
    $('bBlur').textContent = blurOn ? '🛡 ব্লার ON (Ctrl+Alt+B)' : '⚠ ব্লার OFF (Ctrl+Alt+B)';
    $('bPrev').textContent = previewOn ? '👁 প্রিভিউ বন্ধ' : '👁 প্রিভিউ';

    // Mute button state
    $('bMute').disabled = !isRecording;
    if (audioMuted) {
      $('bMute').textContent = '🔇 আনমিউট (Ctrl+Alt+M) [মিউট আছে]';
      $('bMute').className = 'off';
    } else {
      $('bMute').textContent = '🎙️ মিউট (Ctrl+Alt+M) [মাইক চালু]';
      $('bMute').className = 'on';
    }

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
    if (recorder && (recorder.state === 'recording' || recorder.state === 'paused')) return;
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

  // Real-time audio volume visualizer loop
  function startAudioMeterLoop() {
    if (!analyser) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const updateMeter = () => {
      if (!analyser) return;

      if (audioMuted) {
        $('audioLevel').style.width = '0%';
        $('meterText').textContent = '🔇 MUTED (0%)';
        $('meterLabel').textContent = '🔇 অডিও মিউট করা আছে (Muted)';
        animFrame = requestAnimationFrame(updateMeter);
        return;
      }

      $('meterLabel').textContent = '🎙️ অডিও লেভেল ইন্ডিকেটর (Active)';
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
  }

  function stopAudioMeter() {
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
    analyser = null;
    $('audioLevel').style.width = '0%';
    $('meterText').textContent = '0%';
    $('meterLabel').textContent = '🎙️ অডিও লেভেল ইন্ডিকেটর';
  }

  async function buildAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) {}
    }
    const dest = audioCtx.createMediaStreamDestination();

    // masterGain controls 100% volume for recording & visualizer
    masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(audioMuted ? 0 : 1, audioCtx.currentTime);
    masterGain.connect(dest);

    // Analyser is connected directly to masterGain so muted state shows 0%
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    masterGain.connect(analyser);

    let hasAudio = false;

    // 1. System sound capture
    if (cfg.sys && capStream && capStream.getAudioTracks().length) {
      try {
        const sysSource = audioCtx.createMediaStreamSource(new MediaStream(capStream.getAudioTracks()));
        sysSource.connect(masterGain);
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
        micSource.connect(masterGain);
        hasAudio = true;
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

    startAudioMeterLoop();
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
      window.api.updateRecHud({ active: true, time: '⏳ 3...', blurOn: blurOn, muted: audioMuted, paused: false });
      $('status').textContent = '⏳ 3...';
      await new Promise(r => setTimeout(r, 1000));

      window.api.updateRecHud({ active: true, time: '⏳ 2...', blurOn: blurOn, muted: audioMuted, paused: false });
      $('status').textContent = '⏳ 2...';
      await new Promise(r => setTimeout(r, 1000));

      window.api.updateRecHud({ active: true, time: '⏳ 1...', blurOn: blurOn, muted: audioMuted, paused: false });
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
        masterGain = null;
        vtrack = null;
        outStream = null;
        clearInterval(clock);
        clock = null;
        isRecPaused = false;
        recSeconds = 0;
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
      recSeconds = 0;
      isRecPaused = false;
      audioMuted = false;
      msg('');

      // Show the red Windows/Steam recording HUD immediately
      window.api.updateRecHud({ active: true, time: '00:00', blurOn: blurOn, muted: false, paused: false });

      clock = setInterval(() => {
        if (!isRecPaused) {
          recSeconds++;
          const timeStr = formatTime(recSeconds);
          $('status').textContent = `🔴 রেকর্ড হচ্ছে ${timeStr}` + (blurOn ? '' : '  ⚠ ব্লার OFF');
          window.api.updateRecHud({ active: true, time: timeStr, blurOn: blurOn, muted: audioMuted, paused: false });
        }
      }, 1000);

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
    if (recorder && (recorder.state === 'recording' || recorder.state === 'paused')) {
      recorder.stop();
    } else {
      startRec();
    }
    paintUI();
  }

  // Pause / Resume Recording toggle
  function togglePause() {
    if (!recorder || recorder.state === 'inactive') return;

    if (recorder.state === 'recording') {
      recorder.pause();
      isRecPaused = true;
      paintUI();
      $('status').textContent = `⏸️ রেকর্ডিং স্থগিত (${formatTime(recSeconds)})`;
      msg('⏸️ রেকর্ডিং সাময়িক পজ করা হয়েছে');

      window.api.updateRecHud({
        active: true,
        paused: true,
        time: formatTime(recSeconds),
        blurOn: blurOn,
        muted: audioMuted
      });

      window.api.showToast({
        type: 'warn',
        title: 'রেকর্ডিং পজ করা হয়েছে (Paused)',
        sub: 'পুনরায় চালু করতে ▶️ বা Ctrl+Alt+P চাপুন',
        duration: 2500,
        icon: '⏸️'
      });
    } else if (recorder.state === 'paused') {
      recorder.resume();
      isRecPaused = false;
      paintUI();
      $('status').textContent = `🔴 রেকর্ড হচ্ছে ${formatTime(recSeconds)}` + (blurOn ? '' : '  ⚠ ব্লার OFF');
      msg('▶️ রেকর্ডিং পুনরায় শুরু হয়েছে');

      window.api.updateRecHud({
        active: true,
        paused: false,
        time: formatTime(recSeconds),
        blurOn: blurOn,
        muted: audioMuted
      });

      window.api.showToast({
        type: 'blue',
        title: 'রেকর্ডিং চালু হয়েছে (Resumed)',
        sub: 'রেকর্ডিং পুনরায় শুরু হয়েছে',
        duration: 2000,
        icon: '▶️'
      });
    }
  }

  function setBlur(v) {
    blurOn = v;
    paintUI();
    if (recorder && (recorder.state === 'recording' || recorder.state === 'paused')) {
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
    audioMuted = !audioMuted;

    // 1. Direct hardware gain cut to 0 via Web Audio API (Guaranteed absolute silence in recorded file!)
    if (masterGain && audioCtx) {
      masterGain.gain.setValueAtTime(audioMuted ? 0 : 1, audioCtx.currentTime);
    }

    // 2. Track enable toggles for redundancy
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

    paintUI();

    // 3. Update Audio level meter display immediately
    if (audioMuted) {
      $('audioLevel').style.width = '0%';
      $('meterText').textContent = '🔇 MUTED (0%)';
      $('meterLabel').textContent = '🔇 অডিও মিউট করা আছে (Muted)';
    } else {
      $('meterLabel').textContent = '🎙️ অডিও লেভেল ইন্ডিকেটর (Active)';
    }

    msg(audioMuted ? '🔇 অডিও মিউট করা হয়েছে (সাউন্ড রেকর্ড হবে না)' : '🎙️ অডিও সক্রিয় করা হয়েছে (সাউন্ড রেকর্ড হচ্ছে)');

    // 4. Update floating HUD bar (turns red with crossed-out mic icon)
    window.api.updateRecHud({ muted: audioMuted });

    // 5. Show unmistakable floating toast
    window.api.showToast({
      type: audioMuted ? 'warn' : 'blue',
      title: audioMuted ? '🔇 অডিও মিউট করা হয়েছে (Audio Muted)' : '🎙️ অডিও সক্রিয় (Audio Active)',
      sub: audioMuted ? 'রেকর্ডিংয়ে কোনো সাউন্ড রেকর্ড হবে না' : 'মাইক্রোফোন ও সাউন্ড স্বাভাবিক আছে',
      duration: 2500,
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
    $('bPause').onclick = togglePause;
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
      if (k === 'toggle-pause') togglePause();
      if (k === 'blur-drag') {
        paintUI();
      }
      if (k === 'toggle-mute') toggleMute();
    });

    // In-window hotkey listeners
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && e.code === 'KeyR') {
        e.preventDefault();
        toggleRec();
      } else if (e.ctrlKey && e.altKey && e.code === 'KeyP') {
        e.preventDefault();
        togglePause();
      } else if (e.ctrlKey && e.altKey && e.code === 'KeyB') {
        e.preventDefault();
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
