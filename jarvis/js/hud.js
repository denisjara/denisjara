/* =========================================================
   HUD — Renderizado: reactor holográfico, partículas, espectro
   ========================================================= */
const HUD = (() => {
  const css = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  let accentRGB = "0,229,255", accent2 = "#2b7cff";
  let state = "idle"; // idle | listening | thinking | speaking
  let t0 = performance.now(), fps = 60, frames = 0, lastFps = t0;
  const freq = new Uint8Array(256), mic = new Uint8Array(256);
  let smooth = new Float32Array(128);
  const fpsHist = [];

  function refreshColors() { accentRGB = css("--accent-rgb") || accentRGB; accent2 = css("--accent-2") || accent2; }

  function fit(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return dpr;
  }

  /* ---------- Fondo de partículas ---------- */
  const bg = document.getElementById("bg"), bctx = bg.getContext("2d");
  let parts = [];
  function seed() {
    fit(bg);
    const n = Math.min(110, Math.floor((bg.width * bg.height) / 26000));
    parts = Array.from({ length: n }, () => ({
      x: Math.random() * bg.width, y: Math.random() * bg.height,
      vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, r: Math.random() * 1.6 + .4
    }));
  }
  function drawBg(t, lvl) {
    const w = bg.width, h = bg.height;
    bctx.clearRect(0, 0, w, h);
    // grid en perspectiva
    bctx.strokeStyle = `rgba(${accentRGB},0.05)`; bctx.lineWidth = 1;
    const step = 60 * (window.devicePixelRatio || 1), off = (t * 0.02) % step;
    bctx.beginPath();
    for (let x = -off; x < w; x += step) { bctx.moveTo(x, 0); bctx.lineTo(x, h); }
    for (let y = off; y < h; y += step) { bctx.moveTo(0, y); bctx.lineTo(w, y); }
    bctx.stroke();
    // partículas conectadas
    const speed = 1 + lvl * 4;
    for (const p of parts) {
      p.x += p.vx * speed; p.y += p.vy * speed;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }
    const maxD = 140 * (window.devicePixelRatio || 1);
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      bctx.fillStyle = `rgba(${accentRGB},0.7)`;
      bctx.beginPath(); bctx.arc(a.x, a.y, a.r, 0, 7); bctx.fill();
      for (let j = i + 1; j < parts.length; j++) {
        const b = parts[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
        if (d < maxD * maxD) {
          bctx.strokeStyle = `rgba(${accentRGB},${(1 - Math.sqrt(d) / maxD) * 0.18})`;
          bctx.beginPath(); bctx.moveTo(a.x, a.y); bctx.lineTo(b.x, b.y); bctx.stroke();
        }
      }
    }
  }

  /* ---------- Reactor ---------- */
  const rc = document.getElementById("reactor"), rctx = rc.getContext("2d");
  function arc(ctx, r, a0, a1, w, alpha) {
    ctx.strokeStyle = `rgba(${accentRGB},${alpha})`; ctx.lineWidth = w;
    ctx.beginPath(); ctx.arc(0, 0, r, a0, a1); ctx.stroke();
  }
  function drawReactor(t, lvl, spectrum) {
    fit(rc);
    const W = rc.width, H = rc.height, R = Math.min(W, H) / 2;
    const ctx = rctx;
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.translate(W / 2, H / 2);
    ctx.lineCap = "round";
    ctx.shadowColor = `rgba(${accentRGB},0.9)`; ctx.shadowBlur = 12;
    const s = t / 1000;
    const spin = state === "thinking" ? 4 : state === "listening" ? 1.8 : state === "speaking" ? 1.4 : 1;

    // 1. Espectro radial exterior
    const bars = 128, rIn = R * 0.74;
    for (let i = 0; i < bars; i++) {
      const v = spectrum[i] || 0;
      const a = (i / bars) * Math.PI * 2 + s * 0.15;
      const len = R * 0.02 + v * R * 0.2;
      ctx.strokeStyle = `rgba(${accentRGB},${0.25 + v * 0.75})`;
      ctx.lineWidth = Math.max(1, R * 0.008);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * rIn, Math.sin(a) * rIn);
      ctx.lineTo(Math.cos(a) * (rIn + len), Math.sin(a) * (rIn + len));
      ctx.stroke();
    }

    // 2. Anillo de marcas (regla)
    ctx.save(); ctx.rotate(-s * 0.1 * spin);
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * Math.PI * 2, big = i % 15 === 0;
      const r1 = R * 0.68, r2 = r1 - (big ? R * 0.04 : R * 0.015);
      ctx.strokeStyle = `rgba(${accentRGB},${big ? 0.9 : 0.35})`; ctx.lineWidth = big ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); ctx.stroke();
    }
    ctx.restore();

    // 3. Segmentos de arco giratorios
    ctx.save(); ctx.rotate(s * 0.4 * spin);
    for (let i = 0; i < 3; i++) arc(ctx, R * 0.6, i * 2.094, i * 2.094 + 1.4, R * 0.018, 0.85);
    ctx.restore();
    ctx.save(); ctx.rotate(-s * 0.7 * spin);
    for (let i = 0; i < 6; i++) arc(ctx, R * 0.54, i * 1.047, i * 1.047 + 0.55, R * 0.008, 0.6);
    ctx.restore();
    ctx.save(); ctx.rotate(s * 1.2 * spin);
    arc(ctx, R * 0.49, 0, Math.PI * 0.6, 2, 0.9);
    arc(ctx, R * 0.49, Math.PI, Math.PI * 1.25, 2, 0.9);
    ctx.restore();

    // 4. Anillo punteado
    ctx.save(); ctx.rotate(s * 0.2);
    ctx.setLineDash([2, R * 0.03]); arc(ctx, R * 0.44, 0, Math.PI * 2, R * 0.02, 0.35);
    ctx.setLineDash([]); ctx.restore();

    // 5. Cargador de "pensando"
    if (state === "thinking") {
      ctx.save(); ctx.rotate(s * 6);
      arc(ctx, R * 0.4, 0, Math.PI * 0.5, R * 0.025, 1);
      ctx.rotate(Math.PI); arc(ctx, R * 0.4, 0, Math.PI * 0.5, R * 0.025, 1);
      ctx.restore();
    }

    // 6. Núcleo: bobinas del reactor
    const coreR = R * (0.3 + lvl * 0.05);
    ctx.save(); ctx.rotate(s * 0.25);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ctx.save(); ctx.rotate(a);
      ctx.fillStyle = `rgba(${accentRGB},${0.22 + lvl * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(coreR * 0.62, -coreR * 0.12); ctx.lineTo(coreR * 0.98, -coreR * 0.18);
      ctx.lineTo(coreR * 0.98, coreR * 0.18); ctx.lineTo(coreR * 0.62, coreR * 0.12);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    arc(ctx, coreR, 0, Math.PI * 2, 2, 0.9);
    arc(ctx, coreR * 0.6, 0, Math.PI * 2, 1.5, 0.7);

    // triángulo interior
    ctx.save(); ctx.rotate(-s * 0.5 * spin);
    ctx.strokeStyle = `rgba(${accentRGB},0.8)`; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) { const a = i * 2.094 - Math.PI / 2; ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * coreR * 0.5, Math.sin(a) * coreR * 0.5); }
    ctx.closePath(); ctx.stroke(); ctx.restore();

    // brillo central
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * (1.1 + lvl * 0.9));
    g.addColorStop(0, `rgba(255,255,255,${0.85})`);
    g.addColorStop(0.18, `rgba(${accentRGB},${0.7 + lvl * 0.3})`);
    g.addColorStop(0.6, `rgba(${accentRGB},${0.12 + lvl * 0.2})`);
    g.addColorStop(1, `rgba(${accentRGB},0)`);
    ctx.shadowBlur = 0; ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, coreR * (1.1 + lvl * 0.9), 0, 7); ctx.fill();

    // 7. Ondas expansivas al escuchar
    if (state === "listening") {
      for (let k = 0; k < 3; k++) {
        const p = ((s * 0.8 + k / 3) % 1);
        arc(ctx, R * (0.3 + p * 0.5), 0, Math.PI * 2, 2, (1 - p) * 0.6);
      }
    }

    // 8. Texto orbital
    ctx.shadowBlur = 0; ctx.fillStyle = `rgba(${accentRGB},0.7)`;
    ctx.font = `${Math.round(R * 0.032)}px "Share Tech Mono", monospace`;
    ctx.textAlign = "center";
    const label = { idle: "STANDBY", listening: "ESCUCHANDO", thinking: "PROCESANDO", speaking: "TRANSMITIENDO" }[state];
    ctx.fillText(`◆ ${label} ◆`, 0, -R * 0.84);
    ctx.fillText(`PWR ${(97 + Math.sin(s) * 2).toFixed(1)}%  ·  SYNC ${(lvl * 100).toFixed(0).padStart(3, "0")}`, 0, R * 0.88);
    ctx.restore();
  }

  /* ---------- Mini gráficos ---------- */
  const spark = document.getElementById("spark"), sctx = spark.getContext("2d");
  const wave = document.getElementById("wave"), wctx = wave.getContext("2d");
  const cpuHist = Array(60).fill(0);
  function drawSpark() {
    const w = spark.width, h = spark.height;
    sctx.clearRect(0, 0, w, h);
    sctx.strokeStyle = `rgba(${accentRGB},.9)`; sctx.lineWidth = 1.5;
    const grad = sctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `rgba(${accentRGB},.35)`); grad.addColorStop(1, `rgba(${accentRGB},0)`);
    sctx.beginPath();
    cpuHist.forEach((v, i) => { const x = i / (cpuHist.length - 1) * w, y = h - v * (h - 4) - 2; i ? sctx.lineTo(x, y) : sctx.moveTo(x, y); });
    sctx.stroke(); sctx.lineTo(w, h); sctx.lineTo(0, h); sctx.fillStyle = grad; sctx.fill();
  }
  function drawWave(spectrum) {
    const w = wave.width, h = wave.height;
    wctx.clearRect(0, 0, w, h);
    const n = 48, bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = spectrum[Math.floor(i * 1.6)] || 0, bh = Math.max(2, v * h);
      wctx.fillStyle = `rgba(${accentRGB},${0.35 + v * 0.65})`;
      wctx.fillRect(i * bw + 1, (h - bh) / 2, bw - 2, bh);
    }
  }

  /* ---------- Bucle principal ---------- */
  let simCpu = 0.2;
  function loop(now) {
    frames++;
    if (now - lastFps > 1000) {
      fps = Math.round(frames * 1000 / (now - lastFps)); frames = 0; lastFps = now;
      fpsHist.push(fps);
    }
    // Fuentes de nivel
    let lvl = 0;
    const an = SFX.analyser;
    if (an) an.getByteFrequencyData(freq);
    const useMic = Voice.listening && SFX.micAnalyser;
    if (useMic) SFX.micAnalyser.getByteFrequencyData(mic);
    const src = useMic ? mic : freq;
    const vlev = Voice.tick();
    for (let i = 0; i < 128; i++) {
      let v = (src[i] || 0) / 255;
      if (vlev > 0.02) v = Math.max(v, vlev * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.37 + now / 90))) * (1 - i / 180));
      if (state === "idle") v = Math.max(v, 0.04 + 0.04 * Math.sin(i * 0.3 + now / 600));
      smooth[i] += (v - smooth[i]) * 0.3;
      lvl += smooth[i];
    }
    lvl = Math.min(1, lvl / 128 * 2.2);

    simCpu += ((state === "thinking" ? 0.75 : state === "idle" ? 0.12 : 0.4) + Math.random() * 0.15 - simCpu) * 0.03;
    if (frames % 10 === 0) { cpuHist.push(simCpu); cpuHist.shift(); }

    drawBg(now, lvl);
    drawReactor(now, lvl, smooth);
    if (frames % 2 === 0) { drawSpark(); drawWave(smooth); }
    HUD.metrics = { fps, cpu: simCpu, lvl };
    requestAnimationFrame(loop);
  }

  return {
    start() { refreshColors(); seed(); window.addEventListener("resize", seed); requestAnimationFrame(loop); },
    setState(s) { state = s; },
    get state() { return state; },
    refreshColors, metrics: { fps: 60, cpu: 0, lvl: 0 }
  };
})();
