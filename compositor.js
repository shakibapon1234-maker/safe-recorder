// Draws a video frame and blurs chosen boxes (boxes are fractions 0..1 of the frame).
// Blur = repeated halving then doubling with smoothing: very fast, and edge-safe (no transparency bleed).
(function (root) {
  const A = document.createElement('canvas'), B = document.createElement('canvas');
  function blurRegion(ctx, src, x, y, w, h, steps) {
    const bufs = [A, B]; let bi = 0;
    let cur = src, sx = x, sy = y, sw = w, sh = h;
    for (let i = 0; i < steps; i++) {                       // shrink
      const nw = Math.max(1, Math.ceil(sw / 2)), nh = Math.max(1, Math.ceil(sh / 2));
      const dst = bufs[bi]; dst.width = nw; dst.height = nh;
      const d = dst.getContext('2d'); d.imageSmoothingEnabled = true; d.imageSmoothingQuality = 'high';
      d.drawImage(cur, sx, sy, sw, sh, 0, 0, nw, nh);
      cur = dst; sx = 0; sy = 0; sw = nw; sh = nh; bi ^= 1;
    }
    for (let i = steps - 1; i >= 1; i--) {                  // grow back smoothly
      const nw = Math.max(1, Math.ceil(w / Math.pow(2, i))), nh = Math.max(1, Math.ceil(h / Math.pow(2, i)));
      const dst = bufs[bi]; dst.width = nw; dst.height = nh;
      const d = dst.getContext('2d'); d.imageSmoothingEnabled = true; d.imageSmoothingQuality = 'high';
      d.drawImage(cur, 0, 0, sw, sh, 0, 0, nw, nh);
      cur = dst; sw = nw; sh = nh; bi ^= 1;
    }
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, sw, sh, x, y, w, h); ctx.restore();
  }
  function draw(ctx, video, w, h, boxes, on, strength) {
    ctx.drawImage(video, 0, 0, w, h);
    if (!on || !boxes || !boxes.length) return;
    // Significantly increased blur strength for better privacy
    const k = Math.min(80, Math.max(20, (strength || 24) * 2.0));
    const steps = Math.round(Math.log2(k));
    for (const b of boxes) {
      let x = Math.max(0, Math.floor(b.x * w)), y = Math.max(0, Math.floor(b.y * h));
      let bw = Math.min(w - x, Math.ceil(b.w * w) + 1), bh = Math.min(h - y, Math.ceil(b.h * h) + 1);
      if (bw < 2 || bh < 2) continue;
      blurRegion(ctx, video, x, y, bw, bh, steps);
    }
  }
  root.SafeComp = { draw };
})(window);
