/* =========================================================
   VOICE — Reconocimiento de voz + síntesis (Web Speech API)
   ========================================================= */
/* Almacenamiento local seguro */
const Store = {
  get(k, def = null) { try { const v = localStorage.getItem("jarvis:" + k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem("jarvis:" + k, JSON.stringify(v)); } catch {} }
};

const Voice = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  let rec = null, listening = false, wakeMode = false, speaking = false;
  let voices = [], voice = null, lang = "es-ES";
  let rate = 1.02, pitch = 0.82;
  let level = 0; // nivel "virtual" de la voz para animar el reactor
  const handlers = { result: () => {}, interim: () => {}, state: () => {}, speak: () => {} };

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices();
    if (!voice) {
      const saved = Store.get("voiceName");
      voice = voices.find(v => v.name === saved)
        || voices.find(v => /es[-_]/i.test(v.lang) && /(google|microsoft|jorge|pablo|alvaro|diego|raul|male)/i.test(v.name))
        || voices.find(v => /^es/i.test(v.lang))
        || voices[0] || null;
    }
  }
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

  function setupRec() {
    if (!SR) return null;
    const r = new SR();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = wakeMode;
    r.maxAlternatives = 1;
    r.onstart = () => { listening = true; handlers.state("listening"); };
    r.onend = () => {
      listening = false;
      handlers.state("idle");
      if (wakeMode && !speaking) setTimeout(() => { try { start(); } catch {} }, 300);
    };
    r.onerror = e => { if (e.error !== "no-speech" && e.error !== "aborted") handlers.state("error", e.error); };
    r.onresult = e => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        e.results[i].isFinal ? (final += t) : (interim += t);
      }
      if (interim) handlers.interim(interim);
      if (final) {
        final = final.trim();
        if (wakeMode) {
          const m = final.match(/\b(jarvis|yarvis|harvis|charlie|jarbis)\b[,\s]*(.*)/i);
          if (!m) return;
          handlers.result(m[2] || "hola");
        } else {
          handlers.result(final);
        }
      }
    };
    return r;
  }

  function start() {
    if (!SR) return false;
    if (listening) return true;
    if (speaking) synth.cancel();
    rec = setupRec();
    try { rec.start(); return true; } catch { return false; }
  }
  function stop() { if (rec) { const w = wakeMode; wakeMode = false; rec.stop(); wakeMode = w; } }

  function clean(text) {
    return text.replace(/<[^>]+>/g, "").replace(/[*_#`>]/g, "").replace(/https?:\/\/\S+/g, "enlace");
  }

  function speak(text, { onEnd } = {}) {
    if (!synth || !Store.get("tts", true)) { onEnd && onEnd(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(clean(text));
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang;
    u.rate = rate; u.pitch = pitch; u.volume = 1;
    u.onstart = () => { speaking = true; handlers.speak(true); if (listening && !wakeMode) rec.abort(); };
    u.onboundary = () => { level = 1; };
    u.onend = u.onerror = () => {
      speaking = false; handlers.speak(false); onEnd && onEnd();
      if (wakeMode && !listening) start();
    };
    synth.speak(u);
  }

  // Simula envolvente de voz para visualizar mientras habla
  function tick() {
    if (speaking) level = Math.max(level * 0.9, 0.25 + Math.random() * 0.35);
    else level *= 0.85;
    return level;
  }

  return {
    supported: { rec: !!SR, tts: !!synth },
    on(ev, fn) { handlers[ev] = fn; },
    start, stop, speak, tick,
    cancel() { synth && synth.cancel(); },
    get listening() { return listening; },
    get speaking() { return speaking; },
    get voices() { return voices.filter(v => /^es/i.test(v.lang)).concat(voices.filter(v => !/^es/i.test(v.lang))); },
    get voice() { return voice; },
    setVoice(name) { voice = voices.find(v => v.name === name) || voice; Store.set("voiceName", name); },
    setRate(v) { rate = v; }, setPitch(v) { pitch = v; },
    get rate() { return rate; }, get pitch() { return pitch; },
    setWake(v) {
      wakeMode = v;
      if (rec) { try { rec.abort(); } catch {} }
      if (v) setTimeout(start, 350);
    },
    get wake() { return wakeMode; }
  };
})();
