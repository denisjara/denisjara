/* =========================================================
   APP — Orquestación de la interfaz J.A.R.V.I.S.
   ========================================================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ICONS = {
  mic: '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3"/>',
  sys: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  cloud: '<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z"/>',
  note: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 13h8M8 17h5"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 7.2 19.7l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.2 14H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.3 7.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.2V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 1-1 1.7M12 17h.01"/>'
};

const App = (() => {
  let weatherCache = null, timers = [], booted = false, currentPanel = null;

  /* ---------- BOOT ---------- */
  const bootLines = [
    "[OK] Inicializando kernel cuántico v7.3.1",
    "[OK] Montando matriz neuronal ............ 2048 nodos",
    "[OK] Calibrando sintetizador de audio .... 48 kHz",
    "[OK] Enlace de reconocimiento de voz ..... es-ES",
    "[OK] Proyector holográfico ............... en línea",
    "[OK] Protocolos de seguridad ............. armados",
    "[OK] Conexión con la red global .......... estable",
    ">>> TODOS LOS SISTEMAS EN LÍNEA"
  ];
  async function boot() {
    if (booted) return;
    booted = true;
    SFX.init();
    SFX.play("boot");
    const log = $("#bootLog"); log.textContent = "";
    $("#bootBtn").classList.add("hidden");
    for (const line of bootLines) {
      for (const ch of line) { log.textContent += ch; if (Math.random() < 0.3) SFX.play("type"); await sleep(6); }
      log.textContent += "\n"; await sleep(90);
    }
    await sleep(350);
    SFX.play("whoosh");
    $("#boot").classList.add("hidden");
    $("#hud").classList.remove("hidden");
    HUD.refreshColors();
    buildRadial(); toggleRadial(true);
    if (Store.get("hum", true)) SFX.hum(true);
    if (Store.get("wake", false)) setWake(true);
    const h = new Date().getHours();
    const g = h < 6 ? "Buenas noches" : h < 13 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches";
    respond({ text: `${g}, ${Store.get("userName", "señor")}. J.A.R.V.I.S. en línea. Todos los sistemas operativos. ¿En qué puedo ayudarle hoy?` });
  }

  /* ---------- RELOJ ---------- */
  function clock() {
    const d = new Date();
    $("#clockTime").textContent = d.toLocaleTimeString("es-ES");
    $("#clockDate").textContent = d.toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }

  /* ---------- MENÚ RADIAL ---------- */
  const radialItems = [
    { id: "mic", label: "VOZ", icon: "mic", run: () => toggleMic() },
    { id: "diag", label: "SISTEMA", icon: "sys", run: () => openPanel("diag") },
    { id: "weather", label: "CLIMA", icon: "cloud", run: () => openPanel("weather") },
    { id: "notes", label: "NOTAS", icon: "note", run: () => openPanel("notes") },
    { id: "timers", label: "TIEMPO", icon: "timer", run: () => openPanel("timers") },
    { id: "protocols", label: "PROTOCOLO", icon: "shield", run: () => openPanel("protocols") },
    { id: "settings", label: "AJUSTES", icon: "gear", run: () => openPanel("settings") },
    { id: "help", label: "AYUDA", icon: "help", run: () => openPanel("help") }
  ];
  function buildRadial() {
    const r = $("#radial"); r.innerHTML = "";
    radialItems.forEach((it, i) => {
      const b = document.createElement("button");
      b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[it.icon]}</svg>${it.label}`;
      b.dataset.sfx = ""; b.title = it.label;
      b.onclick = e => { e.stopPropagation(); it.run(); };
      b.dataset.i = i;
      r.appendChild(b);
    });
  }
  let radialOpen = false;
  function toggleRadial(open = !radialOpen) {
    radialOpen = open;
    const r = $("#radial"), btns = [...r.children], n = btns.length;
    r.classList.toggle("open", open);
    const size = $("#reactorWrap").getBoundingClientRect().width;
    const rad = size * 0.5 + (size < 420 ? 6 : 18);
    btns.forEach((b, i) => {
      // Arco de 290° dejando libre la zona inferior (subtítulos)
      const span = Math.PI * 2 * (290 / 360);
      const a = -Math.PI / 2 - span / 2 + (i / (n - 1)) * span;
      b.style.transitionDelay = (open ? i * 45 : (n - i) * 25) + "ms";
      b.style.transform = open ? `translate(${Math.cos(a) * rad}px, ${Math.sin(a) * rad}px) scale(1)` : "translate(0,0) scale(.2)";
    });
    SFX.play(open ? "open" : "close");
  }

  /* ---------- CHIPS ---------- */
  const chipList = ["¿Qué hora es?", "Clima", "Cuéntame un chiste", "¿Quién fue Nikola Tesla?", "Temporizador de 1 minuto", "Modo rojo", "Protocolo fiesta", "Estado del sistema"];
  function buildChips() {
    const c = $("#chips");
    c.innerHTML = chipList.map(t => `<button data-sfx>${esc(t)}</button>`).join("");
    c.onclick = e => { if (e.target.tagName === "BUTTON") handle(e.target.textContent); };
  }

  /* ---------- LOG + SUBTÍTULOS ---------- */
  function addLog(who, text, html) {
    const log = $("#log");
    const d = document.createElement("div");
    d.className = "msg " + who;
    const t = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    if (who === "sys") d.textContent = text;
    else d.innerHTML = `<small>${who === "user" ? "USTED" : "J.A.R.V.I.S."} · ${t}</small><span></span>`;
    log.appendChild(d);
    if (who !== "sys") {
      const span = d.querySelector("span");
      if (who === "jarvis") typeInto(span, text, html, () => (log.scrollTop = log.scrollHeight));
      else span.textContent = text;
    }
    log.scrollTop = log.scrollHeight;
  }
  function typeInto(el, text, html, onStep) {
    let i = 0;
    const step = () => {
      i += 2;
      el.textContent = text.slice(0, i);
      onStep && onStep();
      if (i % 6 === 0) SFX.play("type");
      if (i < text.length) requestAnimationFrame(step);
      else if (html) el.innerHTML = html;
    };
    step();
  }
  let subTimer = null;
  function subtitle(text, typing = true) {
    const s = $("#subtitle");
    clearTimeout(subTimer);
    if (!typing) { s.innerHTML = esc(text); return; }
    let i = 0;
    const tick = () => {
      s.innerHTML = esc(text.slice(0, i)) + '<span class="caret"></span>';
      if (i++ < text.length) subTimer = setTimeout(tick, 18);
    };
    tick();
  }

  /* ---------- FLUJO PRINCIPAL ---------- */
  async function handle(raw) {
    raw = String(raw || "").trim();
    if (!raw) return;
    addLog("user", raw);
    HUD.setState("thinking");
    subtitle("Procesando…");
    $("#coreLabel").textContent = "PROCESANDO";
    let out;
    try { out = await Brain.think(raw); }
    catch (e) { out = { text: "Se produjo una anomalía en mis circuitos: " + e.message, error: true }; }
    if (!out) out = { text: "Sin respuesta disponible.", error: true };
    respond(out);
  }
  function respond(out) {
    if (out.silent) { HUD.setState("idle"); $("#coreLabel").textContent = "TOCA PARA HABLAR"; subtitle("", false); return; }
    SFX.play(out.error ? "error" : "notify");
    addLog("jarvis", out.text, out.html);
    subtitle(out.text);
    HUD.setState("speaking");
    $("#coreLabel").textContent = "HABLANDO";
    Voice.speak(out.text, {
      onEnd: () => {
        HUD.setState(Voice.listening ? "listening" : "idle");
        $("#coreLabel").textContent = Voice.wake ? 'DIGA "JARVIS"' : "TOCA PARA HABLAR";
      }
    });
    if (!Store.get("tts", true) || !Voice.supported.tts) setTimeout(() => { HUD.setState("idle"); $("#coreLabel").textContent = "TOCA PARA HABLAR"; }, 1200);
  }

  /* ---------- MICRÓFONO ---------- */
  function toggleMic() {
    SFX.init();
    if (!Voice.supported.rec) { toast("Reconocimiento de voz no disponible. Use Chrome o Edge."); SFX.play("error"); return; }
    if (Voice.listening && !Voice.wake) { Voice.stop(); return; }
    SFX.attachMic();
    Voice.start();
  }
  function setWake(v) {
    if (v && !Voice.supported.rec) { toast("Modo vigilia no disponible en este navegador"); return; }
    Store.set("wake", v);
    Voice.setWake(v);
    $("#coreLabel").textContent = v ? 'DIGA "JARVIS"' : "TOCA PARA HABLAR";
    if (v) { SFX.attachMic(); toast('Modo vigilia: diga "Jarvis" seguido de su orden'); }
  }
  Voice.on("state", (s, err) => {
    $("#micBtn").classList.toggle("on", s === "listening");
    if (s === "listening") {
      SFX.play("listenStart"); HUD.setState("listening");
      $("#coreLabel").textContent = "ESCUCHANDO…";
      if (!Voice.wake) subtitle("Le escucho…");
    } else if (s === "idle") {
      if (HUD.state === "listening") { HUD.setState("idle"); SFX.play("listenEnd"); $("#coreLabel").textContent = Voice.wake ? 'DIGA "JARVIS"' : "TOCA PARA HABLAR"; }
    } else if (s === "error") {
      SFX.play("error");
      toast(err === "not-allowed" ? "Permiso de micrófono denegado" : "Error de voz: " + err);
      HUD.setState("idle");
    }
  });
  Voice.on("interim", t => { if (!Voice.wake || /jarvis/i.test(t)) subtitle(t, false); });
  Voice.on("result", t => handle(t));

  /* ---------- PANELES ---------- */
  const panels = {
    diag: { title: "DIAGNÓSTICO", render: renderDiag },
    weather: { title: "CLIMA", render: renderWeather },
    notes: { title: "NOTAS", render: renderNotes },
    timers: { title: "TEMPORIZADORES", render: renderTimers },
    protocols: { title: "PROTOCOLOS", render: renderProtocols },
    settings: { title: "AJUSTES", render: renderSettings },
    help: { title: "CAPACIDADES", render: renderHelp }
  };
  function openPanel(id) {
    const p = panels[id]; if (!p) return;
    const panel = $("#panel");
    const already = panel.classList.contains("open");
    currentPanel = id;
    $("#panelTitle").textContent = p.title;
    $("#panelBody").innerHTML = "";
    p.render($("#panelBody"));
    panel.classList.add("open"); panel.setAttribute("aria-hidden", "false");
    $$("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.panel === id));
    SFX.play(already ? "click" : "open");
  }
  function closePanel() {
    const panel = $("#panel");
    if (!panel.classList.contains("open")) return;
    panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true");
    $$("#tabs button").forEach(b => b.classList.remove("active"));
    currentPanel = null; SFX.play("close");
  }
  function refreshPanel() { if (currentPanel) { $("#panelBody").innerHTML = ""; panels[currentPanel].render($("#panelBody")); } }

  function renderDiag(el) {
    el.innerHTML = `<ul class="kv">${sysInfo().map(([k, v]) => `<li><span>${k}</span><span>${esc(v)}</span></li>`).join("")}</ul>
      <p class="hint" style="margin-top:14px">${esc(systemReport())}</p>
      <div class="row" style="margin-top:12px"><button class="btn" id="dSpeak">LEER INFORME</button><button class="btn" id="dFull">PANTALLA COMPLETA</button></div>`;
    el.querySelector("#dSpeak").onclick = () => handle("estado del sistema");
    el.querySelector("#dFull").onclick = fullscreen;
  }

  function renderWeather(el) {
    const w = weatherCache;
    if (!w) {
      el.innerHTML = `<p class="hint">Sin datos meteorológicos todavía.</p>
        <div class="field"><label>Ciudad</label><div class="row"><input id="wCity" placeholder="Ej: Madrid, Bogotá, CDMX" style="flex:1"/><button class="btn" id="wGo">CONSULTAR</button></div></div>
        <button class="btn" id="wGeo">USAR MI UBICACIÓN</button>`;
      el.querySelector("#wGo").onclick = () => handle("clima en " + el.querySelector("#wCity").value);
      el.querySelector("#wGeo").onclick = () => handle("clima");
      return;
    }
    el.innerHTML = `<div class="weather-hero"><div class="icon">${w.icon}</div><div class="temp">${Math.round(w.temp)}°</div>
      <div>${esc(w.desc)} · ${esc(w.place)}</div><small class="hint">Sensación ${Math.round(w.feels)}° · Humedad ${w.hum}% · Viento ${Math.round(w.wind)} km/h</small></div>
      <div class="forecast">${w.days.map(d => `<div><b>${d.day}</b>${d.icon}<br>${Math.round(d.max)}° / ${Math.round(d.min)}°</div>`).join("")}</div>
      <div class="field" style="margin-top:16px"><label>Otra ciudad</label><div class="row"><input id="wCity" placeholder="Ciudad" style="flex:1"/><button class="btn" id="wGo">CONSULTAR</button></div></div>`;
    el.querySelector("#wGo").onclick = () => handle("clima en " + el.querySelector("#wCity").value);
  }

  function renderNotes(el) {
    const notes = Store.get("notes", []);
    el.innerHTML = `<div class="field"><label>Nueva nota</label><textarea id="nText" rows="3" placeholder="Escriba aquí…"></textarea></div>
      <div class="row" style="margin-bottom:16px"><button class="btn" id="nAdd">GUARDAR</button>${notes.length ? '<button class="btn danger" id="nClear">BORRAR TODO</button>' : ""}</div>
      <div id="nList">${notes.length ? notes.map((n, i) => `<div class="note"><div><p>${esc(n.text)}</p><small>${new Date(n.t).toLocaleString("es-ES")}</small></div><button data-i="${i}" title="Eliminar">✕</button></div>`).join("") : '<p class="hint">No hay notas. Diga "anota que…" para crear una.</p>'}</div>`;
    el.querySelector("#nAdd").onclick = () => { const v = el.querySelector("#nText").value.trim(); if (v) { addNote(v); SFX.play("success"); } };
    const c = el.querySelector("#nClear"); if (c) c.onclick = () => { Store.set("notes", []); refreshPanel(); SFX.play("close"); };
    el.querySelector("#nList").onclick = e => {
      if (e.target.dataset.i === undefined) return;
      const n = Store.get("notes", []); n.splice(+e.target.dataset.i, 1); Store.set("notes", n); refreshPanel(); SFX.play("click");
    };
  }

  function renderTimers(el) {
    el.innerHTML = `<div class="row" style="margin-bottom:14px;flex-wrap:wrap">${[1, 5, 10, 25, 60].map(m => `<button class="btn" data-m="${m}">${m} MIN</button>`).join("")}</div>
      <div id="tList">${timers.length ? "" : '<p class="hint">Sin temporizadores activos. Diga "temporizador de 5 minutos".</p>'}</div>`;
    el.querySelector(".row").onclick = e => { const m = e.target.dataset.m; if (m) addTimer(m * 60, `${m} minutos`); };
    paintTimers();
  }
  function paintTimers() {
    const list = $("#tList"); if (!list || currentPanel !== "timers") return;
    if (!timers.length) { list.innerHTML = '<p class="hint">Sin temporizadores activos.</p>'; return; }
    list.innerHTML = timers.map(t => {
      const left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
      const mm = String(Math.floor(left / 60)).padStart(2, "0"), ss = String(left % 60).padStart(2, "0");
      return `<div class="timer"><div style="flex:1"><small class="hint">${esc(t.label)}</small><br><b>${mm}:${ss}</b><div class="tbar" style="width:${(left / t.total) * 100}%"></div></div><button data-id="${t.id}" title="Cancelar">✕</button></div>`;
    }).join("");
    list.onclick = e => { const id = e.target.dataset.id; if (id) { cancelTimer(+id); SFX.play("click"); } };
  }

  const protocolDefs = [
    { id: "fiesta", icon: "🎉", name: "FIESTA", desc: "Luces dinámicas y ambiente festivo" },
    { id: "alerta", icon: "🚨", name: "ALERTA ROJA", desc: "Modo defensa con sirena" },
    { id: "enfoque", icon: "🎯", name: "ENFOQUE", desc: "Sesión Pomodoro de 25 minutos" },
    { id: "silencio", icon: "🔇", name: "SILENCIO", desc: "Desactiva voz y efectos de sonido" },
    { id: "normal", icon: "✅", name: "NORMAL", desc: "Restaura todos los sistemas" },
    { id: "reinicio", icon: "♻️", name: "REINICIO", desc: "Reinicia la interfaz" }
  ];
  function renderProtocols(el) {
    el.innerHTML = protocolDefs.map(p => `<button class="proto" data-p="${p.id}" data-sfx><i>${p.icon}</i><div><b>${p.name}</b><span>${p.desc}</span></div></button>`).join("");
    el.onclick = e => { const b = e.target.closest("[data-p]"); if (b) handle("protocolo " + b.dataset.p); };
  }

  const THEMES = [["arc", "#00e5ff"], ["mark", "#ff4d3d"], ["matrix", "#34ff8a"], ["nebula", "#c46bff"], ["gold", "#ffd34d"]];
  function renderSettings(el) {
    const vs = Voice.voices;
    const cur = document.documentElement.dataset.theme;
    el.innerHTML = `
      <div class="field"><label>Su nombre</label><input id="sName" value="${esc(Store.get("userName", ""))}" placeholder="Cómo debo llamarle"/></div>
      <div class="field"><label>Tema holográfico</label><div class="theme-grid">${THEMES.map(([id, c]) => `<button data-theme="${id}" class="${id === cur ? "active" : ""}" style="background:${c};color:${c}" title="${id}"></button>`).join("")}</div></div>
      <div class="field"><label>Voz de J.A.R.V.I.S.</label><select id="sVoice">${vs.length ? vs.map(v => `<option ${Voice.voice && v.name === Voice.voice.name ? "selected" : ""} value="${esc(v.name)}">${esc(v.name)} (${v.lang})</option>`).join("") : "<option>No hay voces disponibles</option>"}</select></div>
      <div class="field"><label>Velocidad de voz: <span id="lRate">${Voice.rate.toFixed(2)}</span></label><input type="range" id="sRate" min="0.6" max="1.6" step="0.02" value="${Voice.rate}"/></div>
      <div class="field"><label>Tono de voz: <span id="lPitch">${Voice.pitch.toFixed(2)}</span></label><input type="range" id="sPitch" min="0.3" max="1.6" step="0.02" value="${Voice.pitch}"/></div>
      <div class="field"><label>Volumen de efectos</label><input type="range" id="sVol" min="0" max="1" step="0.05" value="${SFX.volume}"/></div>
      <div class="field"><label>Opciones</label>
        <label class="row"><input type="checkbox" id="sTts" ${Store.get("tts", true) ? "checked" : ""}/> Respuesta hablada</label>
        <label class="row"><input type="checkbox" id="sHum" ${Store.get("hum", true) ? "checked" : ""}/> Zumbido ambiental del reactor</label>
        <label class="row"><input type="checkbox" id="sSfx" ${SFX.enabled ? "checked" : ""}/> Efectos de sonido</label>
        <label class="row"><input type="checkbox" id="sWake" ${Voice.wake ? "checked" : ""}/> Modo vigilia (escucha continua de "Jarvis")</label>
      </div>
      <div class="field"><label>Cerebro IA · Clave API de Claude (opcional)</label>
        <input id="sKey" type="password" value="${esc(Store.get("apiKey", ""))}" placeholder="sk-ant-…"/>
        <select id="sModel">${["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map(m => `<option ${Store.get("model", "claude-opus-5-5") === m ? "selected" : ""}>${m}</option>`).join("")}</select>
        <span class="hint">Con una clave, J.A.R.V.I.S. puede conversar de cualquier tema. Se guarda solo en este navegador y se envía directamente a api.anthropic.com.</span>
      </div>
      <div class="row"><button class="btn" id="sTest">PROBAR VOZ</button><button class="btn danger" id="sReset">BORRAR MEMORIA</button></div>`;
    const q = s => el.querySelector(s);
    q("#sName").onchange = e => { Store.set("userName", e.target.value.trim() || "señor"); toast("Nombre actualizado"); };
    q(".theme-grid").onclick = e => { const t = e.target.dataset.theme; if (t) { setTheme(t); refreshPanel(); } };
    q("#sVoice").onchange = e => Voice.setVoice(e.target.value);
    q("#sRate").oninput = e => { Voice.setRate(+e.target.value); Store.set("rate", +e.target.value); q("#lRate").textContent = (+e.target.value).toFixed(2); };
    q("#sPitch").oninput = e => { Voice.setPitch(+e.target.value); Store.set("pitch", +e.target.value); q("#lPitch").textContent = (+e.target.value).toFixed(2); };
    q("#sVol").oninput = e => { SFX.setVolume(+e.target.value); Store.set("vol", +e.target.value); };
    q("#sVol").onchange = () => SFX.play("click");
    q("#sTts").onchange = e => Store.set("tts", e.target.checked);
    q("#sHum").onchange = e => { Store.set("hum", e.target.checked); SFX.hum(e.target.checked); };
    q("#sSfx").onchange = e => { SFX.setEnabled(e.target.checked); Store.set("sfx", e.target.checked); if (e.target.checked && Store.get("hum", true)) SFX.hum(true); };
    q("#sWake").onchange = e => setWake(e.target.checked);
    q("#sKey").onchange = e => { Store.set("apiKey", e.target.value.trim()); Brain.resetMemory(); toast(e.target.value.trim() ? "Enlace neuronal configurado" : "Clave eliminada"); SFX.play("success"); };
    q("#sModel").onchange = e => Store.set("model", e.target.value);
    q("#sTest").onclick = () => Voice.speak(`Prueba de voz completada. A su servicio, ${Store.get("userName", "señor")}.`);
    q("#sReset").onclick = () => { Brain.resetMemory(); toast("Memoria conversacional borrada"); };
  }

  function renderHelp(el) {
    const groups = [
      ["Conversación", ["Hola Jarvis", "¿Cómo estás?", "¿Quién eres?", "Me llamo Denis", "Gracias"]],
      ["Información", ["¿Qué hora es?", "¿Qué día es hoy?", "Clima en Madrid", "¿Quién fue Albert Einstein?", "¿Qué es un agujero negro?"]],
      ["Acciones web", ["Abre YouTube", "Busca recetas de pasta", "Pon música lo-fi", "Abre github.com"]],
      ["Productividad", ["Temporizador de 5 minutos", "Anota que debo llamar a mamá", "Lee mis notas", "Cuánto es 25 por 4 más 10"]],
      ["Interfaz", ["Modo rojo", "Tema verde", "Protocolo fiesta", "Protocolo alerta", "Protocolo enfoque", "Pantalla completa", "Estado del sistema"]],
      ["Diversión", ["Cuéntame un chiste", "Lanza una moneda", "Lanza un dado", "Número aleatorio entre 1 y 50"]]
    ];
    el.innerHTML = groups.map(([g, cmds]) => `<div class="field"><label>${g}</label><div class="chips" style="justify-content:flex-start">${cmds.map(c => `<button data-sfx>${esc(c)}</button>`).join("")}</div></div>`).join("")
      + `<p class="hint">Atajos: <b>Espacio</b> micrófono · <b>Ctrl+K</b> paleta de comandos · <b>Esc</b> cerrar · <b>M</b> menú radial.</p>`;
    el.onclick = e => { if (e.target.tagName === "BUTTON" && e.target.closest(".chips")) handle(e.target.textContent); };
  }

  /* ---------- SISTEMA ---------- */
  let battery = null;
  if (navigator.getBattery) navigator.getBattery().then(b => (battery = b)).catch(() => {});
  function sysInfo() {
    const c = navigator.connection || {};
    return [
      ["Núcleos lógicos", navigator.hardwareConcurrency || "—"],
      ["Memoria del dispositivo", navigator.deviceMemory ? navigator.deviceMemory + " GB" : "—"],
      ["Batería", battery ? `${Math.round(battery.level * 100)}% ${battery.charging ? "(cargando)" : ""}` : "—"],
      ["Red", navigator.onLine ? (c.effectiveType ? c.effectiveType.toUpperCase() : "EN LÍNEA") : "SIN CONEXIÓN"],
      ["Latencia estimada", c.rtt ? c.rtt + " ms" : "—"],
      ["Resolución", `${screen.width}×${screen.height} @${window.devicePixelRatio}x`],
      ["Plataforma", (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "—"],
      ["Idioma", navigator.language],
      ["FPS", HUD.metrics.fps],
      ["Reconocimiento de voz", Voice.supported.rec ? "DISPONIBLE" : "NO SOPORTADO"],
      ["Síntesis de voz", Voice.supported.tts ? "DISPONIBLE" : "NO SOPORTADO"],
      ["Cerebro IA", Store.get("apiKey", "") ? "CLAUDE ENLAZADO" : "LOCAL"],
      ["Tiempo en línea", Math.round(performance.now() / 60000) + " min"]
    ];
  }
  function systemReport() {
    const parts = [`Todos los sistemas operativos. Funcionando a ${HUD.metrics.fps} cuadros por segundo`];
    if (navigator.hardwareConcurrency) parts.push(`con ${navigator.hardwareConcurrency} núcleos de procesamiento`);
    let s = parts.join(" ") + ".";
    if (battery) s += ` Batería al ${Math.round(battery.level * 100)} por ciento${battery.charging ? ", cargando" : ""}.`;
    s += navigator.onLine ? " Conexión a la red estable." : " Atención: sin conexión a la red.";
    return s;
  }
  function updateMetrics() {
    const m = HUD.metrics;
    const set = (id, pct, txt) => { $("#m" + id).style.width = Math.max(0, Math.min(100, pct)) + "%"; $("#v" + id).textContent = txt; };
    set("Cpu", m.cpu * 100, Math.round(m.cpu * 100) + "%");
    if (performance.memory) {
      const used = performance.memory.usedJSHeapSize / 1048576, lim = performance.memory.jsHeapSizeLimit / 1048576;
      set("Mem", used / lim * 100 * 8, used.toFixed(0) + "MB");
    } else set("Mem", (navigator.deviceMemory || 4) / 16 * 100, (navigator.deviceMemory || "?") + "GB");
    if (battery) set("Bat", battery.level * 100, Math.round(battery.level * 100) + "%");
    else set("Bat", 100, "AC");
    set("Fps", m.fps / 60 * 100, m.fps);
    const c = navigator.connection || {};
    $("#kvNet").innerHTML = [
      ["ESTADO", navigator.onLine ? "● EN LÍNEA" : "○ OFFLINE"],
      ["TIPO", c.effectiveType ? c.effectiveType.toUpperCase() : "—"],
      ["BAJADA", c.downlink ? c.downlink + " Mbps" : "—"],
      ["IA", Store.get("apiKey", "") ? "CLAUDE" : "LOCAL"],
      ["VOZ", Voice.wake ? "VIGILIA" : Voice.listening ? "ACTIVA" : "STANDBY"]
    ].map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`).join("");
    if (currentPanel === "diag" && Math.random() < 0.2) refreshPanel();
  }

  /* ---------- CLIMA (Open-Meteo, sin clave) ---------- */
  const WMO = {
    0: ["☀️", "despejado"], 1: ["🌤️", "mayormente despejado"], 2: ["⛅", "parcialmente nublado"], 3: ["☁️", "nublado"],
    45: ["🌫️", "niebla"], 48: ["🌫️", "niebla helada"], 51: ["🌦️", "llovizna ligera"], 53: ["🌦️", "llovizna"], 55: ["🌧️", "llovizna intensa"],
    61: ["🌧️", "lluvia ligera"], 63: ["🌧️", "lluvia"], 65: ["🌧️", "lluvia intensa"], 71: ["🌨️", "nevada ligera"], 73: ["🌨️", "nieve"],
    75: ["❄️", "nevada intensa"], 80: ["🌦️", "chubascos"], 81: ["🌧️", "chubascos fuertes"], 82: ["⛈️", "chubascos violentos"],
    95: ["⛈️", "tormenta"], 96: ["⛈️", "tormenta con granizo"], 99: ["⛈️", "tormenta severa"]
  };
  function geo() {
    return new Promise(res => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude, name: "su ubicación" }), () => res(null), { timeout: 8000, maximumAge: 600000 });
    });
  }
  async function weather(city) {
    let loc = null;
    try {
      if (city) {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.trim())}&count=1&language=es`).then(r => r.json());
        const r = g.results && g.results[0];
        if (!r) return `No encuentro la ciudad ${city}.`;
        loc = { lat: r.latitude, lon: r.longitude, name: `${r.name}${r.country ? ", " + r.country : ""}` };
        Store.set("city", city.trim());
      } else {
        loc = await geo();
        if (!loc) {
          const c = Store.get("city", "Madrid");
          return weather(c);
        }
      }
      const d = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5`).then(r => r.json());
      const cur = d.current, w = WMO[cur.weather_code] || ["🌡️", "condiciones variables"];
      weatherCache = {
        place: loc.name, temp: cur.temperature_2m, feels: cur.apparent_temperature, hum: cur.relative_humidity_2m,
        wind: cur.wind_speed_10m, icon: w[0], desc: w[1],
        days: d.daily.time.map((t, i) => ({
          day: new Date(t + "T12:00").toLocaleDateString("es-ES", { weekday: "short" }).toUpperCase(),
          icon: (WMO[d.daily.weather_code[i]] || ["🌡️"])[0], max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i]
        }))
      };
      openPanel("weather");
      return `En ${loc.name}: ${w[1]}, ${Math.round(cur.temperature_2m)} grados, sensación térmica de ${Math.round(cur.apparent_temperature)}. Máxima de ${Math.round(d.daily.temperature_2m_max[0])} y mínima de ${Math.round(d.daily.temperature_2m_min[0])} grados.`;
    } catch { return "No pude conectar con los satélites meteorológicos."; }
  }

  /* ---------- NOTAS / TEMPORIZADORES ---------- */
  function addNote(text) {
    const n = Store.get("notes", []);
    n.unshift({ text: text.charAt(0).toUpperCase() + text.slice(1), t: Date.now() });
    Store.set("notes", n);
    toast("NOTA GUARDADA");
    if (currentPanel === "notes") refreshPanel();
  }
  let tid = 0;
  function addTimer(sec, label) {
    const t = { id: ++tid, end: Date.now() + sec * 1000, total: sec, label };
    timers.push(t);
    toast(`TEMPORIZADOR · ${label.toUpperCase()}`);
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    if (currentPanel === "timers") refreshPanel(); else openPanel("timers");
  }
  function cancelTimer(id) { timers = timers.filter(t => t.id !== id); paintTimers(); }
  function tickTimers() {
    const now = Date.now();
    timers.filter(t => t.end <= now).forEach(t => {
      SFX.play("alarm");
      respond({ text: `${Store.get("userName", "señor")}, el temporizador de ${t.label} ha finalizado.` });
      if ("Notification" in window && Notification.permission === "granted") new Notification("J.A.R.V.I.S.", { body: `Temporizador de ${t.label} finalizado` });
      document.body.classList.add("glitch"); setTimeout(() => document.body.classList.remove("glitch"), 800);
    });
    timers = timers.filter(t => t.end > now);
    paintTimers();
  }

  /* ---------- TEMAS / PROTOCOLOS ---------- */
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    Store.set("theme", t);
    document.body.classList.add("glitch");
    setTimeout(() => document.body.classList.remove("glitch"), 750);
    setTimeout(HUD.refreshColors, 30);
    SFX.play("whoosh");
  }
  function protocol(p) {
    document.body.classList.remove("party", "alert");
    switch (p) {
      case "fiesta": case "party":
        document.body.classList.add("party"); SFX.play("success");
        setTimeout(() => document.body.classList.remove("party"), 20000);
        return "Protocolo fiesta activado. Que comience la celebración.";
      case "alerta": case "defensa":
        document.body.classList.add("alert"); HUD.refreshColors(); SFX.play("alarm");
        setTimeout(() => { document.body.classList.remove("alert"); HUD.refreshColors(); }, 12000);
        return "Alerta roja. Protocolos de defensa armados. Escudos al máximo.";
      case "enfoque": case "concentracion":
        addTimer(25 * 60, "sesión de enfoque");
        return "Protocolo de enfoque iniciado. Veinticinco minutos de concentración absoluta. No le interrumpiré.";
      case "silencio":
        Store.set("tts", false); SFX.setEnabled(false);
        return "Protocolo silencio. Modo discreto activado.";
      case "reinicio":
        setTimeout(() => location.reload(), 2500);
        return "Reiniciando todos los sistemas.";
      default:
        Store.set("tts", true); SFX.setEnabled(true); HUD.refreshColors();
        if (Store.get("hum", true)) SFX.hum(true);
        return "Todos los sistemas restaurados a parámetros normales.";
    }
  }

  /* ---------- UTILIDADES ---------- */
  function toast(text) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = text;
    $("#toasts").appendChild(t);
    setTimeout(() => t.classList.add("out"), 2600);
    setTimeout(() => t.remove(), 3100);
  }
  function openUrl(url) { setTimeout(() => window.open(url, "_blank", "noopener"), 900); }
  function fullscreen() { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())?.catch?.(() => {}); }
  function shutdown() {
    SFX.play("power"); SFX.hum(false); Voice.setWake(false); Voice.stop();
    $("#hud").style.transition = "opacity 1.2s, filter 1.2s";
    $("#hud").style.opacity = 0; $("#hud").style.filter = "blur(10px)";
    setTimeout(() => {
      $("#hud").classList.add("hidden"); $("#hud").style.cssText = "";
      $("#boot").classList.remove("hidden"); $("#bootBtn").classList.remove("hidden");
      $("#bootLog").textContent = "Sistema en reposo.";
      booted = false;
    }, 1300);
  }

  /* ---------- PALETA DE COMANDOS ---------- */
  const actions = [
    ["Hablar con J.A.R.V.I.S.", "Espacio", () => toggleMic()],
    ["Abrir diagnóstico", "panel", () => openPanel("diag")],
    ["Consultar clima", "clima", () => handle("clima")],
    ["Notas", "panel", () => openPanel("notes")],
    ["Temporizadores", "panel", () => openPanel("timers")],
    ["Protocolos", "panel", () => openPanel("protocols")],
    ["Ajustes", "panel", () => openPanel("settings")],
    ["Ayuda / capacidades", "panel", () => openPanel("help")],
    ["Menú radial", "M", () => toggleRadial()],
    ["Pantalla completa", "F", () => fullscreen()],
    ...THEMES.map(([id]) => [`Tema: ${id}`, "tema", () => setTheme(id)]),
    ...protocolDefs.map(p => [`Protocolo ${p.name.toLowerCase()}`, "protocolo", () => handle("protocolo " + p.id)]),
    ["Contar un chiste", "diversión", () => handle("cuéntame un chiste")],
    ["Apagar", "sistema", () => handle("apágate")]
  ];
  let palSel = 0, palItems = [];
  function openPalette() {
    $("#paletteBg").classList.remove("hidden");
    $("#paletteInput").value = ""; renderPalette(); $("#paletteInput").focus(); SFX.play("open");
  }
  function closePalette() { $("#paletteBg").classList.add("hidden"); SFX.play("close"); }
  function renderPalette() {
    const q = $("#paletteInput").value.toLowerCase().trim();
    palItems = actions.filter(a => a[0].toLowerCase().includes(q));
    if (q) palItems.push([`Ejecutar: "${$("#paletteInput").value}"`, "↵", () => handle($("#paletteInput").value)]);
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    $("#paletteList").innerHTML = palItems.map((a, i) => `<li data-i="${i}" class="${i === palSel ? "sel" : ""}"><span>${esc(a[0])}</span><small>${esc(a[1])}</small></li>`).join("");
  }
  function runPalette(i) { const a = palItems[i]; if (!a) return; closePalette(); a[2](); }

  /* ---------- EVENTOS ---------- */
  function bind() {
    $("#bootBtn").onclick = boot;
    $("#coreBtn").onclick = () => toggleMic();
    $("#coreBtn").oncontextmenu = e => { e.preventDefault(); toggleRadial(); };
    $("#micBtn").onclick = () => toggleMic();
    $("#cmdForm").onsubmit = e => { e.preventDefault(); const v = $("#cmdInput").value; $("#cmdInput").value = ""; handle(v); };
    $("#panelClose").onclick = closePanel;
    $("#tabs").onclick = e => { const p = e.target.dataset.panel; if (p) currentPanel === p ? closePanel() : openPanel(p); };
    $("#paletteBg").onclick = e => { if (e.target.id === "paletteBg") closePalette(); };
    $("#paletteInput").oninput = () => { palSel = 0; renderPalette(); };
    $("#paletteList").onclick = e => { const li = e.target.closest("li"); if (li) runPalette(+li.dataset.i); };

    let lastHover = 0, lastEl = null;
    document.addEventListener("pointerover", e => {
      const el = e.target.closest("button, [data-sfx]");
      if (!el || el === lastEl) return;
      lastEl = el;
      const now = performance.now(); if (now - lastHover > 60) { SFX.play("hover"); lastHover = now; }
    });
    document.addEventListener("click", e => { if (e.target.closest("button") && booted) SFX.play("click"); }, true);

    document.addEventListener("keydown", e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (booted) ($("#paletteBg").classList.contains("hidden") ? openPalette() : closePalette()); return; }
      if (!$("#paletteBg").classList.contains("hidden")) {
        if (e.key === "ArrowDown") { palSel = (palSel + 1) % palItems.length; renderPalette(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { palSel = (palSel - 1 + palItems.length) % palItems.length; renderPalette(); e.preventDefault(); }
        else if (e.key === "Enter") { runPalette(palSel); e.preventDefault(); }
        else if (e.key === "Escape") closePalette();
        return;
      }
      if (e.key === "Escape") { closePanel(); if (typing) document.activeElement.blur(); return; }
      if (typing) return;
      if (!booted) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); boot(); } return; }
      if (e.code === "Space") { e.preventDefault(); toggleMic(); }
      else if (e.key.toLowerCase() === "m") toggleRadial();
      else if (e.key.toLowerCase() === "f") fullscreen();
      else if (e.key === "/") { e.preventDefault(); $("#cmdInput").focus(); }
    });
    window.addEventListener("resize", () => radialOpen && toggleRadial(true));
  }

  /* ---------- INICIO ---------- */
  function init() {
    document.documentElement.dataset.theme = Store.get("theme", "arc");
    SFX.setVolume(Store.get("vol", 0.7));
    SFX.setEnabled(Store.get("sfx", true));
    Voice.setRate(Store.get("rate", 1.02));
    Voice.setPitch(Store.get("pitch", 0.82));
    bind(); buildChips(); clock();
    setInterval(clock, 1000);
    setInterval(updateMetrics, 1000);
    setInterval(tickTimers, 1000);
    HUD.start();
    $("#bootLog").textContent = "> Sistema en espera. Esperando autorización del operador…";
  }

  return { init, openPanel, closePanel, refreshPanel, weather, addNote, addTimer, setTheme, protocol, systemReport, openUrl, fullscreen, shutdown, toast, handle };
})();

App.init();
