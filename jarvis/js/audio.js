/* =========================================================
   SFX — Motor de audio futurista sintetizado (Web Audio API)
   Ningún archivo de audio: todo se genera en tiempo real.
   ========================================================= */
const SFX = (() => {
  let ctx = null, master, sfxBus, reverb, analyser, humNodes = null, micSource = null;
  let enabled = true, volume = 0.7;

  function init() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = volume;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;

    // Bus de efectos con reverb sintética + eco
    sfxBus = ctx.createGain();
    reverb = ctx.createConvolver();
    reverb.buffer = impulse(2.4, 2.8);
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    const delay = ctx.createDelay(); delay.delayTime.value = 0.18;
    const fb = ctx.createGain(); fb.gain.value = 0.25;
    const dly = ctx.createGain(); dly.gain.value = 0.18;

    sfxBus.connect(master);
    sfxBus.connect(reverb); reverb.connect(wet); wet.connect(master);
    sfxBus.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(dly); dly.connect(master);

    const comp = ctx.createDynamicsCompressor();
    master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);
    return ctx;
  }

  function impulse(seconds, decay) {
    const rate = ctx.sampleRate, len = rate * seconds;
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function noiseBuffer(sec = 1) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Tono con envolvente
  function tone({ f = 440, f2 = null, type = "sine", t = 0, dur = 0.15, gain = 0.2, attack = 0.005, q = null, cutoff = null, detune = 0 }) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime + t;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f, now);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, now + dur);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    let node = o;
    if (cutoff) {
      const fl = ctx.createBiquadFilter();
      fl.type = "lowpass"; fl.frequency.value = cutoff; if (q) fl.Q.value = q;
      o.connect(fl); node = fl;
    }
    node.connect(g); g.connect(sfxBus);
    o.start(now); o.stop(now + dur + 0.05);
  }

  function sweepNoise({ t = 0, dur = 0.5, from = 200, to = 4000, gain = 0.15, type = "bandpass", q = 4 }) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime + t;
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(dur + 0.1);
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(from, now);
    fl.frequency.exponentialRampToValueAtTime(to, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(fl); fl.connect(g); g.connect(sfxBus);
    src.start(now); src.stop(now + dur + 0.1);
  }

  const sounds = {
    hover() { tone({ f: 2400, f2: 2800, type: "sine", dur: 0.04, gain: 0.03 }); },
    click() {
      tone({ f: 1800, f2: 900, type: "square", dur: 0.06, gain: 0.05, cutoff: 3000 });
      tone({ f: 3600, type: "sine", t: 0.02, dur: 0.05, gain: 0.03 });
    },
    open() {
      sweepNoise({ dur: 0.35, from: 400, to: 6000, gain: 0.08 });
      tone({ f: 600, f2: 1400, type: "triangle", dur: 0.25, gain: 0.08 });
    },
    close() {
      sweepNoise({ dur: 0.3, from: 5000, to: 300, gain: 0.07 });
      tone({ f: 1200, f2: 400, type: "triangle", dur: 0.22, gain: 0.07 });
    },
    listenStart() {
      tone({ f: 880, type: "sine", dur: 0.12, gain: 0.12 });
      tone({ f: 1320, type: "sine", t: 0.09, dur: 0.18, gain: 0.12 });
    },
    listenEnd() {
      tone({ f: 1320, type: "sine", dur: 0.1, gain: 0.1 });
      tone({ f: 660, type: "sine", t: 0.08, dur: 0.16, gain: 0.1 });
    },
    success() {
      [523, 659, 784, 1046].forEach((f, i) => tone({ f, type: "triangle", t: i * 0.06, dur: 0.3, gain: 0.07 }));
    },
    error() {
      tone({ f: 220, type: "sawtooth", dur: 0.18, gain: 0.08, cutoff: 1200 });
      tone({ f: 180, type: "sawtooth", t: 0.16, dur: 0.25, gain: 0.08, cutoff: 1000 });
    },
    notify() {
      tone({ f: 1567, type: "sine", dur: 0.25, gain: 0.08 });
      tone({ f: 2093, type: "sine", t: 0.12, dur: 0.4, gain: 0.08 });
    },
    type() { tone({ f: 4000 + Math.random() * 2000, type: "square", dur: 0.012, gain: 0.012, cutoff: 6000 }); },
    alarm() {
      for (let i = 0; i < 4; i++) {
        tone({ f: 740, f2: 980, type: "sawtooth", t: i * 0.5, dur: 0.24, gain: 0.07, cutoff: 2400 });
        tone({ f: 980, f2: 740, type: "sawtooth", t: i * 0.5 + 0.25, dur: 0.24, gain: 0.07, cutoff: 2400 });
      }
    },
    boot() {
      // Barrido sub-grave + acorde que se abre + chispas
      tone({ f: 40, f2: 120, type: "sawtooth", dur: 2.2, gain: 0.18, attack: 0.6, cutoff: 400, q: 8 });
      sweepNoise({ dur: 2.0, from: 80, to: 9000, gain: 0.1, q: 6 });
      [220, 277.18, 329.63, 440, 554.37].forEach((f, i) =>
        tone({ f, type: "triangle", t: 1.1 + i * 0.09, dur: 2.4, gain: 0.06, attack: 0.25, detune: (i % 2 ? 6 : -6) }));
      for (let i = 0; i < 14; i++) tone({ f: 2000 + Math.random() * 3000, type: "sine", t: 0.2 + i * 0.1, dur: 0.05, gain: 0.025 });
    },
    whoosh() { sweepNoise({ dur: 0.6, from: 150, to: 3000, gain: 0.12, q: 1.2 }); },
    power() {
      tone({ f: 60, f2: 30, type: "sine", dur: 0.8, gain: 0.3 });
      sweepNoise({ dur: 0.5, from: 3000, to: 100, gain: 0.08, type: "lowpass", q: 1 });
    }
  };

  // Zumbido ambiental de "nave"
  function hum(on) {
    if (!ctx) return;
    if (on && !humNodes) {
      const g = ctx.createGain(); g.gain.value = 0;
      const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = 320; fl.Q.value = 5;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08;
      const lfoG = ctx.createGain(); lfoG.gain.value = 180;
      lfo.connect(lfoG); lfoG.connect(fl.frequency);
      const oscs = [55, 55.4, 110.2, 164.8].map((f, i) => {
        const o = ctx.createOscillator(); o.type = i < 2 ? "sawtooth" : "sine"; o.frequency.value = f;
        o.connect(fl); o.start(); return o;
      });
      fl.connect(g); g.connect(master);
      lfo.start();
      g.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 2);
      humNodes = { g, oscs, lfo };
    } else if (!on && humNodes) {
      const { g, oscs, lfo } = humNodes;
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
      setTimeout(() => { oscs.forEach(o => o.stop()); lfo.stop(); }, 900);
      humNodes = null;
    }
  }

  // Conecta el micrófono al analizador (sin salida a altavoces)
  async function attachMic() {
    if (!ctx || micSource) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micSource = ctx.createMediaStreamSource(stream);
      const micAn = ctx.createAnalyser(); micAn.fftSize = 512; micAn.smoothingTimeConstant = 0.8;
      micSource.connect(micAn);
      SFX.micAnalyser = micAn;
      return true;
    } catch { return false; }
  }

  return {
    init, hum, attachMic, micAnalyser: null,
    play(name) { if (ctx && ctx.state === "suspended") ctx.resume(); sounds[name] && sounds[name](); },
    get analyser() { return analyser; },
    get ctx() { return ctx; },
    setEnabled(v) { enabled = v; if (!v) hum(false); },
    get enabled() { return enabled; },
    setVolume(v) { volume = v; if (master) master.gain.value = v; },
    get volume() { return volume; }
  };
})();
