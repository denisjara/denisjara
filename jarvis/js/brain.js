/* =========================================================
   BRAIN — Motor de intenciones y respuestas
   Comandos locales + Wikipedia + clima + Claude (opcional)
   ========================================================= */
const Brain = (() => {
  const history = [];
  const WORDS = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
    once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, cien: 100 };

  const sites = {
    youtube: "https://youtube.com", google: "https://google.com", gmail: "https://mail.google.com",
    github: "https://github.com", spotify: "https://open.spotify.com", netflix: "https://netflix.com",
    whatsapp: "https://web.whatsapp.com", maps: "https://maps.google.com", mapas: "https://maps.google.com",
    twitter: "https://x.com", x: "https://x.com", instagram: "https://instagram.com", facebook: "https://facebook.com",
    linkedin: "https://linkedin.com", wikipedia: "https://es.wikipedia.org", amazon: "https://amazon.com",
    chatgpt: "https://chatgpt.com", claude: "https://claude.ai", twitch: "https://twitch.tv", reddit: "https://reddit.com",
    calendario: "https://calendar.google.com", drive: "https://drive.google.com", traductor: "https://translate.google.com"
  };

  const jokes = [
    "¿Por qué los programadores confunden Halloween con Navidad? Porque OCT 31 es igual a DEC 25.",
    "Hay 10 tipos de personas: las que entienden binario y las que no.",
    "Le pregunté a mi servidor si me quería. Me respondió con un error 418: soy una tetera.",
    "Mi código no tiene bugs. Tiene características no documentadas, señor.",
    "Un SQL entra a un bar, se acerca a dos mesas y pregunta: ¿puedo unirme?",
    "He calculado catorce millones de futuros posibles. En todos usted olvida guardar el archivo.",
    "¿Cuál es el colmo de un robot? Tener un corazón de lata y no poder abrirlo."
  ];

  const name = () => Store.get("userName", "señor");
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[¿?¡!.,]/g, " ").replace(/\s+/g, " ").trim();
  const num = s => { if (!s) return NaN; const n = parseFloat(String(s).replace(",", ".")); return isNaN(n) ? (WORDS[s] ?? NaN) : n; };

  function greeting() {
    const h = new Date().getHours();
    return h < 6 ? "Buenas noches" : h < 13 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches";
  }

  function mathEval(expr) {
    let e = " " + norm(expr) + " ";
    e = e.replace(/raiz cuadrada de\s*([\d.]+)/g, "Math.sqrt($1)")
      .replace(/(\d+(?:\.\d+)?)\s*(?:por ciento|%)\s*de\s*(\d+(?:\.\d+)?)/g, "($1/100*$2)")
      .replace(/\bmas\b/g, "+").replace(/\bmenos\b/g, "-")
      .replace(/\b(multiplicado por|por|x|veces)\b/g, "*").replace(/×/g, "*")
      .replace(/\b(dividido entre|dividido por|dividido|entre)\b/g, "/").replace(/÷/g, "/")
      .replace(/\b(elevado a|a la)\b/g, "**").replace(/\^/g, "**")
      .replace(/\bal cuadrado\b/g, "**2").replace(/\bal cubo\b/g, "**3")
      .replace(/\b(cuanto es|cuanto son|calcula|calcular|resultado de|cuanto da)\b/g, "");
    e = e.trim();
    if (!/^[\d\s+\-*/().]*(Math\.sqrt\([\d.]+\)[\d\s+\-*/().]*)*$/.test(e) || !/\d/.test(e)) return null;
    try {
      const r = Function('"use strict";return (' + e + ")")();
      if (typeof r !== "number" || !isFinite(r)) return null;
      return Math.round(r * 1e8) / 1e8;
    } catch { return null; }
  }

  async function wiki(q) {
    const term = q.trim().replace(/^(el|la|los|las|un|una)\s+/i, "");
    try {
      const s = await fetch(`https://es.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&limit=1&search=${encodeURIComponent(term)}`).then(r => r.json());
      const title = s[1] && s[1][0];
      if (!title) return null;
      const d = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then(r => r.json());
      if (!d.extract) return null;
      const sentences = d.extract.split(/(?<=\.)\s+/).slice(0, 3).join(" ");
      return { text: sentences, link: d.content_urls?.desktop?.page, title: d.title };
    } catch { return null; }
  }

  async function claude(text) {
    const key = Store.get("apiKey", "");
    if (!key) return null;
    history.push({ role: "user", content: text });
    while (history.length > 16) history.shift();
    const now = new Date().toLocaleString("es-ES");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: Store.get("model", "claude-opus-5-5"),
        max_tokens: 700,
        system: `Eres J.A.R.V.I.S., el asistente personal de IA de ${name()}. Personalidad: elegante, británico en el trato, leal, ingenioso con humor seco sutil, extremadamente competente. Responde SIEMPRE en español, de forma concisa (2-4 frases salvo que te pidan detalle) porque tus respuestas se leen en voz alta: evita markdown, listas largas y emojis. Dirígete al usuario como "${name()}" ocasionalmente. Fecha y hora actual: ${now}.`,
        messages: history
      })
    });
    if (!res.ok) {
      history.pop();
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const out = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    history.push({ role: "assistant", content: out });
    return out;
  }

  /* ---------- Intenciones ---------- */
  const intents = [
    { re: /^(hola|hey|buenas|buenos dias|buenas tardes|buenas noches|que tal|saludos)\b/, run: () =>
      `${greeting()}, ${name()}. Todos los sistemas operativos al cien por ciento. ¿En qué puedo ayudarle?` },
    { re: /(como estas|que tal estas|como te encuentras)/, run: () =>
      pick([`Funcionando dentro de parámetros óptimos, ${name()}. Gracias por preguntar.`, "Mejor que nunca. Mis núcleos están fríos y mi humor, cálido."]) },
    { re: /(quien eres|como te llamas|que eres|presentate)/, run: () =>
      "Soy J.A.R.V.I.S.: Just A Rather Very Intelligent System. Su asistente personal, a su servicio." },
    { re: /(que puedes hacer|ayuda|comandos|funciones)/, run: () => {
      App.openPanel("help");
      return "Puedo decirle la hora, el clima, buscar en internet y Wikipedia, abrir sitios, hacer cálculos, crear notas y temporizadores, cambiar de tema y activar protocolos. Con una clave de Claude, puedo conversar sobre cualquier tema.";
    } },
    { re: /(?:me llamo|mi nombre es|llamame)\s+([a-zñ ]{2,30})$/, run: m => {
      const n = m[1].trim().replace(/\b\w/g, c => c.toUpperCase());
      Store.set("userName", n);
      return `Encantado, ${n}. Lo recordaré.`;
    } },
    { re: /(que hora es|dime la hora|la hora|hora actual)/, run: () =>
      `Son las ${new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}, ${name()}.` },
    { re: /(que dia es|fecha de hoy|que fecha|dia de hoy|la fecha)/, run: () =>
      `Hoy es ${new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.` },
    { re: /(?:clima|tiempo|temperatura|pronostico)(?:\s+(?:hace\s+)?(?:en|de|para)\s+(.+))?/, run: async m => App.weather(m[1]) },
    { re: /(?:temporizador|alarma|cronometro|timer|avisame)\s*(?:de|en|para|por)?\s*(\d+(?:[.,]\d+)?|\w+)\s*(segundos?|minutos?|horas?|min|seg)/, run: m => {
      const n = num(m[1]); if (isNaN(n)) return null;
      const mult = /^h/.test(m[2]) ? 3600 : /^s/.test(m[2]) ? 1 : 60;
      App.addTimer(n * mult, `${m[1]} ${m[2]}`);
      return `Temporizador de ${m[1]} ${m[2]} activado. Le avisaré.`;
    } },
    { re: /(media hora)/, run: () => { App.addTimer(1800, "media hora"); return "Temporizador de media hora activado."; } },
    { re: /^(?:anota|apunta|toma nota|nota|recuerda que|recuerdame que|recuerdame|guarda)\s*(?:que|de)?\s*(.+)/, run: m => {
      App.addNote(m[1]); return "Nota registrada en la base de datos."; } },
    { re: /(lee|leer|muestra|mostrar|ver|cuales son)\s+(mis\s+)?notas/, run: () => {
      const notes = Store.get("notes", []); App.openPanel("notes");
      if (!notes.length) return "No tiene notas guardadas.";
      return `Tiene ${notes.length} nota${notes.length > 1 ? "s" : ""}. ` + notes.slice(0, 5).map((n, i) => `${i + 1}: ${n.text}.`).join(" ");
    } },
    { re: /(borra|elimina|limpia)\s+(todas\s+)?(las\s+|mis\s+)?notas/, run: () => { Store.set("notes", []); App.refreshPanel(); return "Notas eliminadas."; } },
    { re: /(chiste|hazme reir|algo gracioso)/, run: () => pick(jokes) },
    { re: /(lanza|tira)\s+(una\s+)?moneda/, run: () => `Ha salido ${Math.random() < 0.5 ? "cara" : "cruz"}.` },
    { re: /(lanza|tira)\s+(un\s+)?dado/, run: () => `Ha salido un ${1 + Math.floor(Math.random() * 6)}.` },
    { re: /numero aleatorio(?:\s+(?:entre|del)\s+(\d+)\s+(?:y|al)\s+(\d+))?/, run: m => {
      const a = +m[1] || 1, b = +m[2] || 100; return `Su número es el ${a + Math.floor(Math.random() * (b - a + 1))}.`; } },
    { re: /(?:modo|tema|color|cambia a|pon el tema)\s+(rojo|mark|iron ?man|verde|matrix|violeta|morado|nebula|dorado|oro|gold|azul|cian|arc|normal)/, run: m => {
      const map = { rojo: "mark", mark: "mark", ironman: "mark", "iron man": "mark", verde: "matrix", matrix: "matrix", violeta: "nebula", morado: "nebula", nebula: "nebula", dorado: "gold", oro: "gold", gold: "gold", azul: "arc", cian: "arc", arc: "arc", normal: "arc" };
      App.setTheme(map[m[1]]); return `Interfaz recalibrada. Tema ${m[1]} aplicado.`;
    } },
    { re: /protocolo\s+(fiesta|party|alerta|defensa|silencio|enfoque|concentracion|reinicio|casa limpia|normal)/, run: m => App.protocol(m[1]) },
    { re: /(estado del sistema|diagnostico|estado de los sistemas|bateria|como esta el sistema)/, run: () => { App.openPanel("diag"); return App.systemReport(); } },
    { re: /(pantalla completa|fullscreen)/, run: () => { App.fullscreen(); return "Modo inmersivo activado."; } },
    { re: /(sube|aumenta)\s+(el\s+)?volumen/, run: () => { SFX.setVolume(Math.min(1, SFX.volume + 0.15)); return "Volumen aumentado."; } },
    { re: /(baja|disminuye|reduce)\s+(el\s+)?volumen/, run: () => { SFX.setVolume(Math.max(0, SFX.volume - 0.15)); return "Volumen reducido."; } },
    { re: /(abre|abrir|muestra)\s+(el\s+|la\s+)?(panel\s+(de\s+)?)?(ajustes|configuracion|clima|notas|temporizadores|protocolos|diagnostico)$/, run: m => {
      const map = { ajustes: "settings", configuracion: "settings", clima: "weather", notas: "notes", temporizadores: "timers", protocolos: "protocols", diagnostico: "diag" };
      App.openPanel(map[m[5]]); return `Abriendo ${m[5]}.`;
    } },
    { re: /^(?:abre|abrir|ir a|lanza|entra en|entra a|ve a)\s+(.+)/, run: m => {
      const s = m[1].replace(/\s/g, "").replace(/\.com$/, "");
      const url = sites[s] || (/\.\w{2,}$/.test(m[1].trim()) ? "https://" + m[1].trim().replace(/\s/g, "") : null);
      if (!url) return null;
      App.openUrl(url); return `Abriendo ${m[1]}.`;
    } },
    { re: /^(?:pon|reproduce|reproducir|quiero escuchar|ponme)\s+(.+)/, run: m => {
      App.openUrl("https://www.youtube.com/results?search_query=" + encodeURIComponent(m[1])); return `Buscando ${m[1]} en YouTube.`; } },
    { re: /^(?:busca|buscar|googlea|investiga)\s+(?:en\s+youtube\s+)(.+)/, run: m => {
      App.openUrl("https://www.youtube.com/results?search_query=" + encodeURIComponent(m[1])); return `Buscando ${m[1]} en YouTube.`; } },
    { re: /^(?:busca|buscar|googlea|investiga)\s+(?:en\s+google\s+)?(.+)/, run: m => {
      App.openUrl("https://www.google.com/search?q=" + encodeURIComponent(m[1])); return `Buscando ${m[1]} en la red.`; } },
    { re: /(cuanto es|cuanto son|calcula|cuanto da|raiz cuadrada|^[\d\s+\-*/().x^]+$)/, run: (m, raw) => {
      const r = mathEval(raw); return r === null ? null : `El resultado es ${String(r).replace(".", ",")}.`; } },
    { re: /^(?:que es|que son|quien es|quien fue|quienes son|hablame de|hablame sobre|informacion sobre|define|que significa)\s+(.+)/, run: async (m, raw) => {
      const ai = Store.get("apiKey", "") ? await claude(raw).catch(() => null) : null;
      if (ai) return ai;
      const w = await wiki(m[1]);
      return w ? { text: w.text, html: `${w.text} <a href="${w.link}" target="_blank" rel="noopener">[Wikipedia: ${w.title}]</a>` } : null;
    } },
    { re: /^(gracias|muchas gracias|te lo agradezco)/, run: () => pick(["Siempre a su servicio.", "Un placer, " + name() + ".", "Para eso estoy."]) },
    { re: /(silencio|callate|para de hablar|deja de hablar)/, run: () => { Voice.cancel(); return { text: "", silent: true }; } },
    { re: /^(adios|apagate|desconectate|hasta luego|buenas noches jarvis|apagar)/, run: () => { setTimeout(() => App.shutdown(), 2600); return `Hasta pronto, ${name()}. Entrando en modo de reposo.`; } }
  ];

  async function think(raw) {
    const text = norm(raw);
    if (!text) return null;
    for (const it of intents) {
      const m = text.match(it.re);
      if (m) {
        const out = await it.run(m, raw);
        if (out) return typeof out === "string" ? { text: out } : out;
      }
    }
    // Fallbacks: Claude → cálculo → Wikipedia
    try {
      const ai = await claude(raw);
      if (ai) return { text: ai };
    } catch (e) {
      return { text: `Error en el enlace neuronal: ${e.message}. Revise su clave en Ajustes.`, error: true };
    }
    const r = mathEval(raw);
    if (r !== null) return { text: `El resultado es ${String(r).replace(".", ",")}.` };
    const w = await wiki(raw);
    if (w) return { text: w.text, html: `${w.text} <a href="${w.link}" target="_blank" rel="noopener">[Wikipedia]</a>` };
    return { text: `No he entendido la instrucción, ${name()}. Diga "ayuda" para ver mis capacidades, o configure una clave de Claude en Ajustes para conversación libre.`, error: true };
  }

  return { think, sites, resetMemory() { history.length = 0; } };
})();
