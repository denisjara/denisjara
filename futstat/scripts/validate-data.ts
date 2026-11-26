/**
 * Validación en tiempo de ejecución de los JSON publicados (public/data/) contra el contrato src/types/data.ts.
 * Es la PUERTA DE CALIDAD antes de publicar: el build (pipeline/build.ts) la ejecuta como librería sobre el
 * directorio temporal y solo sustituye public/data si pasa; CI la vuelve a ejecutar como CLI.
 *
 *   npx tsx scripts/validate-data.ts [dir] [--no-sanity]       (npm run data:validate)
 *
 * Comprueba: campos requeridos y tipos, ausencia de null/NaN/Infinity (el contrato omite los opcionales; JSON
 * convierte NaN en null), probabilidades en [0,1], 1X2 que suman ≈ 1, matrices de marcadores y distribuciones
 * ≈ 1, cuotas > 1, coherencia EV/Kelly, referencias (hasDetail ⇒ existe matches/<id>.json, compId válido,
 * fichas de equipo del índice, competiciones del meta), columnas de simulación, nombres de archivo seguros,
 * logos solo https en *.espncdn.com y ningún texto con `<script` ni `javascript:`. Apartados de apuestas: alta confianza
 * (confidence.json), pronósticos del día (daily.json) y cuota alta 6+ (longshots.json: cuota >= mínimo, prob en (0, 1),
 * cuota justa = 1/p, combinadas de partidos distintos con prob = producto, EV = p·cuota − 1, regla diaria, récord y aviso +18)
 * y combinada 6 (combo6.json: regla publicada —patas, categorías, banda de probabilidad, ventana de cuota—, productos,
 * cuotas estimadas marcadas y coherentes, historial con Wilson y aviso +18).
 * Umbrales de cordura (desactivables con --no-sanity): suficientes competiciones con datos, partidos analizados,
 * algún partido próximo o reciente en la portada y tamaño total razonable — para no publicar datos degenerados.
 * Sale con código 1 si hay errores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL, OUTPUT_DIR } from '../pipeline/config';
import { poissonCdf } from '../src/lib/models';

/** Goles máximos de la matriz completa del modelo (scoreMatrix por defecto 0..10), antes de recortarla para publicar. */
const MODEL_MATRIX_GOALS = 10;

// ---------------------------------------------------------------------------
// Mini-esquema
// ---------------------------------------------------------------------------

interface Ctx {
  file: string;
  errors: string[];
  /** referencias a comprobar al final */
  detailRefs: { id: string; at: string }[];
  compRefs: { id: string; at: string }[];
  /** suma de la última matriz de marcadores validada (para comprobarla con los λ) */
  matrixSum?: number;
  /** partidos "en juego" y "terminados" publicados (coherencia de estado con la fecha, al final) */
  statusRefs?: { status: 'live' | 'finished'; date: string; at: string }[];
}

type Check = (v: unknown, at: string, c: Ctx) => void;

const MAX_ERRORS_PER_FILE = 25;

function fail(c: Ctx, at: string, msg: string): void {
  const n = c.errors.filter((e) => e.startsWith(`${c.file}:`)).length;
  if (n < MAX_ERRORS_PER_FILE) c.errors.push(`${c.file}: ${at}: ${msg}`);
  else if (n === MAX_ERRORS_PER_FILE) c.errors.push(`${c.file}: (más errores omitidos)`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(opts: { min?: number; max?: number; int?: boolean; gt?: number } = {}): Check {
  return (v, at, c) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fail(c, at, `número esperado, recibido ${JSON.stringify(v)}`);
    if (opts.int && !Number.isInteger(v)) fail(c, at, `entero esperado, recibido ${v}`);
    if (opts.min !== undefined && v < opts.min - 1e-9) fail(c, at, `${v} < ${opts.min}`);
    if (opts.max !== undefined && v > opts.max + 1e-9) fail(c, at, `${v} > ${opts.max}`);
    if (opts.gt !== undefined && !(v > opts.gt)) fail(c, at, `${v} debe ser > ${opts.gt}`);
  };
}

function str(opts: { nonEmpty?: boolean; oneOf?: readonly string[]; iso?: boolean; pattern?: RegExp } = {}): Check {
  return (v, at, c) => {
    if (typeof v !== 'string') return fail(c, at, `texto esperado, recibido ${JSON.stringify(v)}`);
    if (opts.nonEmpty && !v.trim()) fail(c, at, 'texto vacío');
    if (opts.oneOf && !opts.oneOf.includes(v)) fail(c, at, `valor "${v}" no permitido (${opts.oneOf.join('|')})`);
    if (opts.iso && !(v === '' || Number.isFinite(Date.parse(v)))) fail(c, at, `fecha ISO inválida "${v}"`);
    if (opts.pattern && !opts.pattern.test(v)) fail(c, at, `"${v}" no cumple ${opts.pattern}`);
  };
}

const bool: Check = (v, at, c) => {
  if (typeof v !== 'boolean') fail(c, at, `booleano esperado, recibido ${JSON.stringify(v)}`);
};

function arr(item: Check, opts: { min?: number; max?: number; len?: number } = {}): Check {
  return (v, at, c) => {
    if (!Array.isArray(v)) return fail(c, at, `array esperado, recibido ${typeof v}`);
    if (opts.min !== undefined && v.length < opts.min) fail(c, at, `longitud ${v.length} < ${opts.min}`);
    if (opts.max !== undefined && v.length > opts.max) fail(c, at, `longitud ${v.length} > ${opts.max}`);
    if (opts.len !== undefined && v.length !== opts.len) fail(c, at, `longitud ${v.length} ≠ ${opts.len}`);
    v.forEach((x, i) => item(x, `${at}[${i}]`, c));
  };
}

function record(item: Check): Check {
  return (v, at, c) => {
    if (!isObj(v)) return fail(c, at, 'objeto esperado');
    for (const [k, x] of Object.entries(v)) item(x, `${at}.${k}`, c);
  };
}

/** Objeto con campos requeridos y opcionales; `refine` añade comprobaciones semánticas. */
function obj(req: Record<string, Check>, opt: Record<string, Check> = {}, refine?: (v: Record<string, unknown>, at: string, c: Ctx) => void): Check {
  return (v, at, c) => {
    if (!isObj(v)) return fail(c, at, `objeto esperado, recibido ${v === null ? 'null' : typeof v}`);
    for (const [k, chk] of Object.entries(req)) {
      if (!(k in v) || v[k] === undefined) fail(c, `${at}.${k}`, 'campo requerido ausente');
      else chk(v[k], `${at}.${k}`, c);
    }
    for (const [k, chk] of Object.entries(opt)) if (k in v && v[k] !== undefined) chk(v[k], `${at}.${k}`, c);
    if (refine) refine(v, at, c);
  };
}

const anyOf =
  (...cs: Check[]): Check =>
  (v, at, c) => {
    for (const chk of cs) {
      const probe: Ctx = { ...c, errors: [], detailRefs: [], compRefs: [] };
      chk(v, at, probe);
      if (!probe.errors.length) return chk(v, at, c);
    }
    fail(c, at, `valor no válido ${JSON.stringify(v).slice(0, 60)}`);
  };

/** Patrones que nunca deben aparecer en un texto publicado (defensa en profundidad frente a inyección). */
const DANGEROUS_TEXT = /<\s*script|(?:java|vb)script\s*:|data\s*:\s*text\/html/i;
/** Caracteres de control (salvo tabulador/saltos de línea) y de control bidi. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

/** Ninguna clave con null (NaN/Infinity se serializan como null) y ningún texto peligroso. */
function noNulls(v: unknown, at: string, c: Ctx): void {
  if (v === null) return fail(c, at, 'null/NaN/Infinity no permitido');
  if (typeof v === 'string') {
    if (DANGEROUS_TEXT.test(v)) fail(c, at, `texto potencialmente peligroso (<script / javascript:): ${JSON.stringify(v.slice(0, 60))}`);
    else if (CONTROL_CHARS.test(v)) fail(c, at, 'texto con caracteres de control');
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => noNulls(x, `${at}[${i}]`, c));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) noNulls(x, `${at}.${k}`, c);
}

// ---------------------------------------------------------------------------
// Tipos del contrato
// ---------------------------------------------------------------------------

const prob = num({ min: 0, max: 1 });
const odds = num({ gt: 1 });
const iso = str({ iso: true });
const nonNeg = num({ min: 0 });
const count = num({ min: 0, int: true });
const hex = str({ pattern: /^#?[0-9a-fA-F]{3,8}$/ });
/** Logos: solo https y en el CDN de ESPN (la web los carga como <img>; la CSP solo permite ese origen). */
const logoUrl = str({ pattern: /^https:\/\/([a-z0-9-]+\.)*espncdn\.com\/[^\s"'<>]*$/i });
/** Ids que acaban en nombres de archivo (equipos, partidos): tokens seguros, sin rutas. */
const safeId = str({ nonEmpty: true, pattern: /^[A-Za-z0-9_-]{1,40}$/ });
const outcome = str({ oneOf: ['W', 'D', 'L'] });
const formStr = str({ pattern: /^[WDL]*$/ });

const SUM_TOL = 0.011;

const prob1x2: Check = obj({ home: prob, draw: prob, away: prob }, {}, (v, at, c) => {
  const s = (v.home as number) + (v.draw as number) + (v.away as number);
  if (Number.isFinite(s) && Math.abs(s - 1) > SUM_TOL) fail(c, at, `1X2 suma ${s.toFixed(4)} (≠ 1)`);
});

const teamRef = obj(
  { id: safeId, name: str({ nonEmpty: true }), short: str(), abbr: str() },
  { logo: logoUrl, color: hex },
);

const playerRef = obj({ id: str({ nonEmpty: true }), name: str({ nonEmpty: true }), short: str(), position: str({ oneOf: ['G', 'D', 'M', 'F', '?'] }), teamId: str() });

const oddsSnapshot = obj(
  { provider: str() },
  {
    home: odds,
    draw: odds,
    away: odds,
    homeOpen: odds,
    drawOpen: odds,
    awayOpen: odds,
    totalLine: num(),
    over: odds,
    under: odds,
    overOpen: odds,
    underOpen: odds,
    spreadLine: num(),
    spreadHome: odds,
    spreadAway: odds,
    margin: num({ min: -0.05, max: 0.5 }),
    capturedAt: iso,
  },
);

const valuePick = obj(
  {
    marketId: str({ nonEmpty: true }),
    market: str({ nonEmpty: true }),
    selection: str({ nonEmpty: true }),
    prob,
    odds,
    fairOdds: num({ min: 1 }),
    ev: num(),
    kelly: num({ min: 0, max: 1 }),
    edge: num({ min: -1, max: 1 }),
    confidence: str({ oneOf: ['alta', 'media', 'baja'] }),
  },
  {},
  (v, at, c) => {
    const p = v.prob as number;
    const o = v.odds as number;
    if (v.kelly as number > MODEL.kellyCap + 1e-9) fail(c, at, `kelly ${v.kelly} > tope ${MODEL.kellyCap}`);
    if ((v.ev as number) < MODEL.minEv - 1e-3) fail(c, at, `EV ${v.ev} < mínimo ${MODEL.minEv}`);
    // EV asiático puede diferir de p·cuota−1 (medias apuestas/devoluciones)
    if (!String(v.marketId).startsWith('ah') && Math.abs(p * o - 1 - (v.ev as number)) > 0.01) fail(c, at, `EV incoherente (${v.ev} vs ${(p * o - 1).toFixed(4)})`);
  },
);

/**
 * Pronóstico de alta confianza: solo nivel oro (acierto histórico de la franja >= 85 %), prob >= umbral de su franja,
 * cuota justa = 1/p; acierto fuera de muestra (validación walk-forward de su regla y holdout de su familia) con n e
 * intervalo de Wilson que lo contiene.
 */
const CONF_FAMILY = /^[a-z0-9.+-]{1,40}$/;
const confidencePick = obj(
  {
    family: str({ nonEmpty: true, pattern: CONF_FAMILY }),
    marketId: str({ nonEmpty: true }),
    market: str({ nonEmpty: true }),
    selection: str({ nonEmpty: true }),
    prob: num({ min: 0.5, max: 1 }),
    fairOdds: num({ min: 1, max: 2 }),
    tier: str({ oneOf: ['oro'] }),
    historicalHitRate: num({ min: 0.85, max: 1 }),
    historicalN: num({ min: 1, int: true }),
  },
  {
    marketOdds: odds,
    oddsKind: str({ oneOf: ['directa', 'sintetica'] }),
    threshold: num({ min: 0.5, max: 1 }),
    calibratedProb: prob,
    source: str({ oneOf: ['mercado', 'estadistico'] }),
    validationHitRate: prob,
    validationN: num({ min: 1, int: true }),
    validationWilsonLow: prob,
    validationWilsonHigh: prob,
    holdoutHitRate: prob,
    holdoutN: num({ min: 1, int: true }),
    holdoutWilsonLow: prob,
    holdoutWilsonHigh: prob,
    baseRate: prob,
    result: str({ oneOf: ['hit', 'miss', 'void'] }),
  },
  (v, at, c) => {
    const p = v.prob as number;
    if (typeof p === 'number' && typeof v.fairOdds === 'number' && p > 0 && Math.abs((v.fairOdds as number) - 1 / p) > 0.01) {
      fail(c, at, `cuota justa ${v.fairOdds} incoherente con prob ${p} (1/p = ${(1 / p).toFixed(3)})`);
    }
    if (typeof v.threshold === 'number' && typeof p === 'number' && p < (v.threshold as number) - 1e-3) fail(c, at, `prob ${p} < umbral ${v.threshold}`);
    if (v.oddsKind !== undefined && v.marketOdds === undefined) fail(c, at, 'oddsKind sin marketOdds');
    if ((v.holdoutHitRate === undefined) !== (v.holdoutN === undefined)) fail(c, at, 'holdoutHitRate y holdoutN van juntos');
    if ((v.validationHitRate === undefined) !== (v.validationN === undefined)) fail(c, at, 'validationHitRate y validationN van juntos');
    for (const k of ['validation', 'holdout'] as const) {
      const r = v[`${k}HitRate`];
      const lo = v[`${k}WilsonLow`];
      const hi = v[`${k}WilsonHigh`];
      if ((lo === undefined) !== (hi === undefined)) fail(c, at, `${k}WilsonLow y ${k}WilsonHigh van juntos`);
      if (typeof r === 'number' && typeof lo === 'number' && typeof hi === 'number' && !(lo <= r + 1e-9 && r <= hi + 1e-9)) fail(c, at, `intervalo de Wilson (${k}) que no contiene el acierto`);
    }
    if (v.tier === 'oro' && typeof v.historicalHitRate === 'number' && (v.historicalHitRate as number) < 0.85 - 1e-9) fail(c, at, `nivel oro con acierto histórico ${v.historicalHitRate} < 0,85`);
  },
);

/** Hasta 2 picks por partido, de familias distintas. */
function confidenceList(max: number): Check {
  return (v, at, c) => {
    arr(confidencePick, { max })(v, at, c);
    if (!Array.isArray(v)) return;
    const fams = v.map((x) => (isObj(x) ? x.family : undefined));
    if (new Set(fams).size !== fams.length) fail(c, at, 'dos picks de la misma familia en un partido');
  };
}

const quickPrediction = obj(
  {
    p: prob1x2,
    xgHome: num({ min: 0, max: 8 }),
    xgAway: num({ min: 0, max: 8 }),
    over25: prob,
    btts: prob,
    likelyScore: str({ pattern: /^\d+-\d+$/ }),
    likelyScoreProb: prob,
    confidence: prob,
  },
  { expCorners: nonNeg, expCards: nonNeg, market: prob1x2, pick: valuePick, safe: confidencePick },
);

const score = obj({ home: count, away: count }, { htHome: count, htAway: count, penHome: count, penAway: count });

const STATUSES = ['scheduled', 'live', 'finished', 'postponed', 'cancelled'] as const;

const matchSummary: Check = obj(
  {
    id: safeId,
    compId: str({ nonEmpty: true }),
    compName: str({ nonEmpty: true }),
    date: iso,
    status: str({ oneOf: STATUSES }),
    home: teamRef,
    away: teamRef,
    hasDetail: bool,
  },
  {
    statusDetail: str(),
    round: str(),
    score,
    venue: str(),
    homeForm: formStr,
    awayForm: formStr,
    prediction: quickPrediction,
    odds: oddsSnapshot,
    popularity: num({ min: 0, max: 100 }),
    predictionHit: bool,
  },
  (v, at, c) => {
    if (v.hasDetail === true) c.detailRefs.push({ id: String(v.id), at });
    c.compRefs.push({ id: String(v.compId), at: `${at}.compId` });
    if (v.predictionHit !== undefined && v.status !== 'finished') fail(c, at, 'predictionHit en un partido no terminado');
    if (v.status === 'finished' && v.score === undefined) fail(c, at, 'partido terminado sin marcador');
    if ((v.status === 'live' || v.status === 'finished') && typeof v.date === 'string') {
      (c.statusRefs ??= []).push({ status: v.status, date: v.date, at: `${c.file}: ${at}` });
    }
  },
);

const marketSelection = obj(
  { label: str({ nonEmpty: true }), prob, fairOdds: num({ min: 1, max: 1000 }) },
  { marketOdds: odds, ev: num({ min: -1 }), note: str() },
);

const MARKET_GROUPS = ['Principales', 'Goles', 'Hándicap', 'Marcador', 'Mitades', 'Equipos', 'Córners', 'Tarjetas', 'Tiros', 'Faltas'] as const;

const market = obj(
  { id: str({ nonEmpty: true }), group: str({ oneOf: MARKET_GROUPS }), name: str({ nonEmpty: true }), selections: arr(marketSelection, { min: 1 }) },
  { line: num() },
  (v, at, c) => {
    // selecciones mutuamente excluyentes (todo salvo doble oportunidad): la suma debe ser ≈ 1
    // (en hándicap asiático `prob` es la probabilidad efectiva 1/cuota justa, que también suma 1)
    const id = String(v.id);
    const sels = v.selections as { prob: number }[];
    if (id !== 'dc' && Array.isArray(sels)) {
      const s = sels.reduce((t, x) => t + (typeof x?.prob === 'number' ? x.prob : 0), 0);
      if (Math.abs(s - 1) > 0.02) fail(c, at, `selecciones del mercado ${id} suman ${s.toFixed(4)}`);
    }
  },
);

function distSum(tol: number): Check {
  return (v, at, c) => {
    if (!Array.isArray(v)) return fail(c, at, 'array esperado');
    let s = 0;
    v.forEach((x, i) => {
      prob(x, `${at}[${i}]`, c);
      if (typeof x === 'number') s += x;
    });
    if (v.length && Math.abs(s - 1) > tol) fail(c, at, `la distribución suma ${s.toFixed(4)}`);
  };
}

const statProjection = obj(
  {
    key: str({ oneOf: ['corners', 'cards', 'shots', 'shotsOnTarget', 'fouls', 'offsides'] }),
    label: str({ nonEmpty: true }),
    home: nonNeg,
    away: nonNeg,
    total: nonNeg,
    totalDist: distSum(0.01),
    lines: arr(obj({ line: num(), over: prob, under: prob })),
  },
  { most: prob1x2, leagueAvg: nonNeg },
);

const formMatch = obj(
  { matchId: str(), date: iso, compId: str(), opponent: teamRef, isHome: bool, gf: count, ga: count, result: outcome },
  {
    shots: nonNeg,
    shotsOnTarget: nonNeg,
    corners: nonNeg,
    cornersAgainst: nonNeg,
    cards: nonNeg,
    fouls: nonNeg,
    possession: num({ min: 0, max: 100 }),
    xg: nonNeg,
    xga: nonNeg,
    hasDetail: bool,
  },
  (v, at, c) => {
    c.compRefs.push({ id: String(v.compId), at: `${at}.compId` });
    if (v.hasDetail === true) c.detailRefs.push({ id: String(v.matchId), at });
  },
);

const teamFormBlock = obj({
  team: teamRef,
  last: arr(formMatch, { max: 10 }),
  formString: formStr,
  ppg5: num({ min: 0, max: 3 }),
  ppg10: num({ min: 0, max: 3 }),
  gf5: nonNeg,
  ga5: nonNeg,
  formIndex: num({ min: 0, max: 100 }),
  streaks: arr(str()),
  elo: num({ min: 500, max: 3000 }),
  eloTrend: arr(num({ min: 500, max: 3000 })),
  venueSplit: obj({ played: count, ppg: num({ min: 0, max: 3 }), gf: nonNeg, ga: nonNeg }),
});

const comparisonRow = obj(
  { key: str(), label: str({ nonEmpty: true }), home: num(), away: num(), better: str({ oneOf: ['high', 'low'] }) },
  { leagueAvg: num(), format: str({ oneOf: ['int', 'dec1', 'dec2', 'pct'] }) },
);

const playerProp = obj(
  {
    player: playerRef,
    apps: count,
    minutes: nonNeg,
    goals: count,
    assists: count,
    expMinutes: num({ min: 0, max: 130 }),
    formIndex: num({ min: 0, max: 100 }),
    pGoal: prob,
    pAssist: prob,
    pGoalOrAssist: prob,
    pShots1: prob,
    pShots2: prob,
    pSot1: prob,
    pSot2: prob,
    pCard: prob,
  },
  { pFouls2: prob },
  (v, at, c) => {
    if ((v.pShots2 as number) > (v.pShots1 as number) + 1e-9) fail(c, at, 'P(>=2 tiros) > P(>=1 tiro)');
    if ((v.pSot1 as number) > (v.pShots1 as number) + 0.05) fail(c, at, 'P(>=1 a puerta) > P(>=1 tiro)');
  },
);

const ELO_RANGE = num({ min: 500, max: 3000 });

const modelBreakdown = obj(
  {
    lambdaHome: num({ min: 0.05, max: 6 }),
    lambdaAway: num({ min: 0.05, max: 6 }),
    rho: num({ min: -0.25, max: 0.25 }),
    elo: obj({ home: ELO_RANGE, away: ELO_RANGE, diff: num(), probs: prob1x2 }),
    ensemble: prob1x2,
    weights: obj({ dixonColes: prob, elo: prob, market: prob }, {}, (v, at, c) => {
      const s = (v.dixonColes as number) + (v.elo as number) + (v.market as number);
      if (Math.abs(s - 1) > 0.01) fail(c, at, `pesos suman ${s}`);
    }),
    scoreMatrix: (v, at, c) => {
      if (!Array.isArray(v) || !v.length) return fail(c, at, 'matriz vacía');
      let s = 0;
      v.forEach((row, i) => {
        if (!Array.isArray(row) || row.length !== v.length) fail(c, `${at}[${i}]`, 'la matriz debe ser cuadrada');
        else
          row.forEach((x, j) => {
            prob(x, `${at}[${i}][${j}]`, c);
            if (typeof x === 'number') s += x;
          });
      });
      if (s > 1.005) fail(c, at, `la matriz suma ${s.toFixed(4)} (> 1)`);
      c.matrixSum = s;
    },
    explanation: arr(str({ nonEmpty: true }), { min: 1 }),
    confidence: prob,
  },
  {
    dixonColes: obj({ probs: prob1x2, lambdaHome: nonNeg, lambdaAway: nonNeg }),
    market: obj({ probs: prob1x2, margin: num({ min: -0.05, max: 0.5 }), method: str() }),
  },
  (v, at, c) => {
    // matriz truncada (0..maxGoals): falta la cola de goleadas ⇒ suma ≈ P(X <= n)·P(Y <= n) con X, Y ~ Poisson(λ).
    // El modelo normaliza la matriz completa sobre 0..MODEL_MATRIX_GOALS (no hasta el infinito), así que hay que dividir
    // por esa masa: con λ altos (p. ej. 5.5 goles esperados en un partido muy desigual) la diferencia supera 0.02.
    const n = Array.isArray(v.scoreMatrix) ? v.scoreMatrix.length - 1 : -1;
    const s = c.matrixSum;
    c.matrixSum = undefined;
    if (s === undefined || n < 0 || typeof v.lambdaHome !== 'number' || typeof v.lambdaAway !== 'number') return;
    const full = poissonCdf(MODEL_MATRIX_GOALS, v.lambdaHome) * poissonCdf(MODEL_MATRIX_GOALS, v.lambdaAway);
    const expected = (poissonCdf(n, v.lambdaHome) * poissonCdf(n, v.lambdaAway)) / (full > 0 ? full : 1);
    if (Math.abs(s - expected) > 0.02) fail(c, `${at}.scoreMatrix`, `la matriz suma ${s.toFixed(4)} (esperado ≈ ${expected.toFixed(4)} con matriz 0..${n})`);
  },
);

const h2h = obj({
  matches: arr(matchSummary, { max: 20 }),
  homeWins: count,
  draws: count,
  awayWins: count,
  avgGoals: nonNeg,
  bttsPct: prob,
  over25Pct: prob,
});

const standingRow = obj(
  { rank: num({ min: 1, int: true }), team: teamRef, played: count, won: count, drawn: count, lost: count, gf: count, ga: count, gd: num({ int: true }), points: num({ int: true }) },
  { form: formStr, note: obj({ label: str(), color: str() }), xPts: nonNeg, elo: ELO_RANGE },
);

const standingGroup = obj({ name: str({ nonEmpty: true }), rows: arr(standingRow, { min: 1 }) });

const teamMatchStats = obj(
  { goals: count },
  {
    shots: nonNeg,
    shotsOnTarget: nonNeg,
    corners: nonNeg,
    fouls: nonNeg,
    yellow: nonNeg,
    red: nonNeg,
    offsides: nonNeg,
    possession: num({ min: 0, max: 100 }),
    saves: nonNeg,
    passes: nonNeg,
    passPct: num({ min: 0, max: 100 }),
    tackles: nonNeg,
  },
);

const matchEvent = obj(
  { minute: str(), type: str({ oneOf: ['goal', 'own-goal', 'penalty', 'yellow', 'red', 'sub'] }), teamId: str() },
  { player: str(), playerId: str(), detail: str() },
);

const split = obj({ all: num(), home: num(), away: num() });

const teamSeasonStats = obj(
  {
    team: teamRef,
    played: split,
    goalsFor: split,
    goalsAgainst: split,
    xgFor: split,
    xgAgainst: split,
    shots: split,
    shotsAgainst: split,
    shotsOnTarget: split,
    shotsOnTargetAgainst: split,
    corners: split,
    cornersAgainst: split,
    cards: split,
    cardsAgainst: split,
    fouls: split,
    possession: split,
    over15Pct: prob,
    over25Pct: prob,
    over35Pct: prob,
    bttsPct: prob,
    cleanSheetPct: prob,
    failedToScorePct: prob,
    winPct: prob,
    drawPct: prob,
    lossPct: prob,
    formString: formStr,
    formIndex: num({ min: 0, max: 100 }),
  },
  { goalsByPeriod: arr(count, { len: 6 }), concededByPeriod: arr(count, { len: 6 }) },
);

const eloPoint = obj({ date: iso, elo: ELO_RANGE });

const teamRating = obj(
  { team: teamRef, elo: ELO_RANGE, eloRank: num({ min: 1, int: true }), eloHistory: arr(eloPoint, { max: 30 }) },
  { globalEloRank: num({ min: 1, int: true }), attack: num({ gt: 0, max: 5 }), defence: num({ gt: 0, max: 5 }) },
);

const simRow = obj({
  team: teamRef,
  currentPoints: num(),
  expectedPoints: num(),
  expectedRank: num({ min: 1 }),
  probs: record(prob),
  positionDist: distSum(0.01),
});

const seasonSimulation = obj(
  { iterations: num({ min: 1, int: true }), group: str(), columns: arr(str({ nonEmpty: true }), { min: 1 }), rows: arr(simRow, { min: 2 }), remainingMatches: count },
  {},
  (v, at, c) => {
    const cols = v.columns as string[];
    (v.rows as { probs?: Record<string, unknown> }[]).forEach((r, i) => {
      const keys = Object.keys(r?.probs ?? {});
      for (const col of cols) if (!keys.includes(col)) fail(c, `${at}.rows[${i}].probs`, `falta la columna "${col}"`);
    });
  },
);

const per90 = obj({ goals: nonNeg, assists: nonNeg, shots: nonNeg, shotsOnTarget: nonNeg, cards: nonNeg, foulsCommitted: nonNeg });

const playerSeasonRow = obj(
  {
    player: playerRef,
    team: teamRef,
    compId: str({ nonEmpty: true }),
    apps: count,
    starts: count,
    minutes: nonNeg,
    goals: count,
    assists: count,
    shots: count,
    shotsOnTarget: count,
    yellow: count,
    red: count,
    foulsCommitted: count,
    foulsSuffered: count,
    offsides: count,
    per90,
    formIndex: num({ min: 0, max: 100 }),
    formTrend: arr(num({ min: 0, max: 10 }), { max: 5 }),
    last5: arr(
      obj({
        matchId: str(),
        date: iso,
        opponent: str(),
        minutes: nonNeg,
        goals: count,
        assists: count,
        shots: count,
        shotsOnTarget: count,
        cards: count,
        rating: num({ min: 0, max: 10 }),
      }),
      { max: 5 },
    ),
  },
  { saves: count },
  (v, at, c) => c.compRefs.push({ id: String(v.compId), at: `${at}.compId` }),
);

const leagueAverages = obj(
  {
  goalsPerMatch: nonNeg,
  homeGoals: nonNeg,
  awayGoals: nonNeg,
  homeWinPct: prob,
  drawPct: prob,
  awayWinPct: prob,
  over25Pct: prob,
  bttsPct: prob,
  cornersPerMatch: nonNeg,
  cardsPerMatch: nonNeg,
  shotsPerMatch: nonNeg,
  shotsOnTargetPerMatch: nonNeg,
  foulsPerMatch: nonNeg,
  },
  {},
  (v, at, c) => {
    // 1X2 de la liga: suma 1 cuando hay partidos; todo a 0 solo si aún no hay ninguno (sin goles ni partidos)
    const sum = Number(v.homeWinPct) + Number(v.drawPct) + Number(v.awayWinPct);
    if (!Number.isFinite(sum)) return;
    if (sum === 0) {
      if (Number(v.goalsPerMatch) > 0) fail(c, at, 'goles por partido > 0 con local/empate/visitante a 0');
    } else if (Math.abs(sum - 1) > 0.02) fail(c, at, `homeWinPct + drawPct + awayWinPct = ${sum.toFixed(3)} (debe ser 1)`);
  },
);

const scoreSet = obj({ brier: num({ min: 0, max: 2 }), logLoss: nonNeg, rps: num({ min: 0, max: 1 }), accuracy: prob });
const binaryScore = obj({ brier: num({ min: 0, max: 1 }), accuracy: prob, n: count });

const backtestSummary = obj(
  {
    matches: count,
    from: iso,
    to: iso,
    model: scoreSet,
    baseline: scoreSet,
    calibration: arr(obj({ from: prob, to: prob, predicted: prob, observed: prob, n: count })),
  },
  {
    elo: scoreSet,
    dixonColes: scoreSet,
    market: scoreSet,
    marketMatches: count,
    roi: obj({ bets: count, staked: nonNeg, profit: num(), roi: num({ min: -1 }), hitRate: prob, avgOdds: nonNeg }),
    over25: binaryScore,
    btts: binaryScore,
  },
);

const competitionMeta = obj(
  {
    id: str({ nonEmpty: true }),
    slug: str({ nonEmpty: true }),
    name: str({ nonEmpty: true }),
    shortName: str({ nonEmpty: true }),
    country: str(),
    flag: str(),
    kind: str({ oneOf: ['league', 'cup', 'continental'] }),
    tier: num({ min: 1, max: 10 }),
    hasTable: bool,
    hasSimulation: bool,
    upcomingCount: count,
    finishedCount: count,
  },
  { logo: logoUrl, logoDark: logoUrl, seasonLabel: str(), simulationColumns: arr(str()), color: hex, nextMatchDate: str({ iso: true, nonEmpty: true }), dataUpdatedAt: iso },
  (v, at, c) => {
    if (v.hasSimulation === true && !Array.isArray(v.simulationColumns)) fail(c, at, 'hasSimulation sin simulationColumns');
  },
);

const valueEntry = obj({ match: matchSummary, pick: valuePick });

// ---------------------------------------------------------------------------
// Factores del partido (MatchFile.factors): validación estricta (sin claves desconocidas)
// ---------------------------------------------------------------------------

/** Como obj(), pero rechaza claves no declaradas (contrato cerrado). */
function sobj(req: Record<string, Check>, opt: Record<string, Check> = {}, refine?: (v: Record<string, unknown>, at: string, c: Ctx) => void): Check {
  const base = obj(req, opt, refine);
  const known = new Set([...Object.keys(req), ...Object.keys(opt)]);
  return (v, at, c) => {
    base(v, at, c);
    if (isObj(v)) for (const k of Object.keys(v)) if (!known.has(k)) fail(c, `${at}.${k}`, 'clave no permitida');
  };
}
/** Texto no vacío y acotado (caracteres). */
const text = (max: number): Check => (v, at, c) => {
  str({ nonEmpty: true })(v, at, c);
  if (typeof v === 'string' && Array.from(v).length > max) fail(c, at, `texto de más de ${max} caracteres`);
};
const literal = (x: unknown): Check => (v, at, c) => {
  if (v !== x) fail(c, at, `debe ser ${JSON.stringify(x)}, recibido ${JSON.stringify(v)}`);
};
const goalsCount = num({ min: 0, max: 30, int: true });
const perMatch = num({ min: 0, max: 15 });
const refRatio = num({ min: 0.5, max: 2 });

const FACTOR_ABSENCE_REASON: Record<string, string> = {
  susp: 'sancionado (expulsado en el último partido)',
  miss2: 'no jugó los 2 últimos partidos',
  miss1s: 'no jugó el último partido',
  miss1o: 'no jugó el último partido (otra competición)',
};
const STAKE_STATUS = ['título', 'plazas continentales', 'ascenso', 'descenso', 'sin nada en juego'] as const;
const FORM_LABELS = ['rinde por encima de lo esperado', 'rinde por debajo de lo esperado', 'en línea con lo esperado'] as const;

const factorReferee = anyOf(
  sobj(
    { status: literal('conocido'), name: text(80), matches: count, cardsRatio: refRatio, usedInModel: bool },
    { cardsPerMatch: perMatch, foulsRatio: refRatio },
    (v, at, c) => {
      if (v.matches === 0 && v.cardsPerMatch !== undefined) fail(c, at, 'árbitro sin partidos previos con tarjetas por partido');
      // usado por el modelo: con partidos previos de tarjetas o, al menos, de faltas (foulsRatio)
      if (v.usedInModel === true && v.matches === 0 && v.foulsRatio === undefined) fail(c, at, 'árbitro sin partidos previos usado por el modelo');
      if (typeof v.matches === 'number' && v.matches > 0 && v.cardsPerMatch === undefined) fail(c, at, 'árbitro con partidos previos sin tarjetas por partido');
      if (v.matches === 0 && v.cardsRatio !== 1) fail(c, `${at}.cardsRatio`, 'sin partidos previos el ratio debe ser 1');
    },
  ),
  sobj({ status: literal('no publicado'), usedInModel: literal(false) }),
);

const tieScore = sobj({ home: goalsCount, away: goalsCount });
const factorTie = sobj(
  { leg: literal(2), firstLegId: safeId, firstLegDate: str({ iso: true, nonEmpty: true }), firstLeg: tieScore, aggregate: tieScore, leader: str({ oneOf: ['home', 'away', 'none'] }), summary: text(220), usedInModel: literal(false) },
  {},
  (v, at, c) => {
    const fl = v.firstLeg as { home: number; away: number } | undefined;
    const ag = v.aggregate as { home: number; away: number } | undefined;
    if (!isObj(fl) || !isObj(ag)) return;
    const same = fl.home === ag.home && fl.away === ag.away;
    const swapped = fl.home === ag.away && fl.away === ag.home;
    if (!same && !swapped) fail(c, `${at}.aggregate`, 'el global no corresponde al marcador de la ida');
    const leader = ag.home > ag.away ? 'home' : ag.home < ag.away ? 'away' : 'none';
    if (v.leader !== leader) fail(c, `${at}.leader`, `debe ser "${leader}" según el global`);
  },
);

function factorStakeSide(teams: number): Check {
  return sobj(
    { position: num({ min: 1, max: teams, int: true }), points: count, played: count, remaining: count, best: num({ min: 1, max: teams, int: true }), worst: num({ min: 1, max: teams, int: true }), status: str({ oneOf: STAKE_STATUS }), inPlay: arr(text(40), { max: 8 }) },
    {},
    (v, at, c) => {
      if ((v.best as number) > (v.worst as number)) fail(c, at, 'mejor posición posible > peor');
      const none = Array.isArray(v.inPlay) && v.inPlay.length === 0;
      if (none !== (v.status === 'sin nada en juego')) fail(c, at, '"sin nada en juego" ⇔ ninguna zona en juego');
      if (typeof v.points === 'number' && typeof v.played === 'number' && v.points > 3 * v.played) fail(c, at, 'más puntos que 3 por partido');
    },
  );
}
const factorStakes: Check = (v, at, c) => {
  const teams = isObj(v) && typeof v.teams === 'number' && Number.isInteger(v.teams) && v.teams >= 2 && v.teams <= 40 ? v.teams : 40;
  sobj({ teams: num({ min: 2, max: 40, int: true }), home: factorStakeSide(teams), away: factorStakeSide(teams), usedInModel: literal(false) }, {}, (o, a, cc) => {
    const h = o.home as Record<string, unknown> | undefined;
    const w = o.away as Record<string, unknown> | undefined;
    if (isObj(h) && isObj(w) && h.position === w.position) fail(cc, a, 'local y visitante con la misma posición');
    for (const s of [h, w]) if (isObj(s) && typeof s.played === 'number' && typeof s.remaining === 'number' && s.played + s.remaining !== 2 * (teams - 1)) fail(cc, a, 'jugados + restantes ≠ 2·(equipos − 1)');
  })(v, at, c);
};

const factorTeamForm = sobj(
  { last: num({ min: 3, max: 6, int: true }), goalsFor: perMatch, goalsAgainst: perMatch, netRes: num({ min: -4, max: 4 }), label: str({ oneOf: FORM_LABELS }) },
  { xgFor: perMatch, xgAgainst: perMatch },
  (v, at, c) => {
    const r = v.netRes as number;
    const want = r > 0.25 ? FORM_LABELS[0] : r < -0.25 ? FORM_LABELS[1] : FORM_LABELS[2];
    if (typeof r === 'number' && v.label !== want) fail(c, `${at}.label`, `con netRes ${r} debe ser "${want}"`);
    if ((v.xgFor === undefined) !== (v.xgAgainst === undefined)) fail(c, at, 'xgFor y xgAgainst van juntos');
  },
);
const factorForm = sobj({ usedInModel: literal(false) }, { home: factorTeamForm, away: factorTeamForm }, (v, at, c) => {
  if (v.home === undefined && v.away === undefined) fail(c, at, 'bloque de forma vacío');
});

const factorVenueSide = sobj(
  { played: num({ min: 1, int: true }), w: count, d: count, l: count, gfPerMatch: perMatch, gaPerMatch: perMatch, scope: str({ oneOf: ['competición', 'todas'] }) },
  {},
  (v, at, c) => {
    if ((v.w as number) + (v.d as number) + (v.l as number) !== v.played) fail(c, at, 'w + d + l ≠ played');
  },
);
const factorVenue = sobj({ usedInModel: literal(true), note: text(200) }, { home: factorVenueSide, away: factorVenueSide }, (v, at, c) => {
  if (v.home === undefined && v.away === undefined) fail(c, at, 'bloque casa/fuera vacío');
});

const factorAbsence = sobj(
  { playerId: str({ nonEmpty: true }), name: text(80), kind: str({ oneOf: Object.keys(FACTOR_ABSENCE_REASON) }), reason: text(80), minutesShare: prob, minutesFactor: num({ min: 0, max: 1.5 }), usedInModel: bool },
  {},
  (v, at, c) => {
    const want = Object.prototype.hasOwnProperty.call(FACTOR_ABSENCE_REASON, String(v.kind)) ? FACTOR_ABSENCE_REASON[String(v.kind)] : undefined;
    if (want && v.reason !== want) fail(c, `${at}.reason`, `no corresponde a kind "${String(v.kind)}"`);
    if (typeof v.minutesFactor === 'number' && v.usedInModel !== (v.minutesFactor !== 1)) fail(c, `${at}.usedInModel`, 'debe ser true ⇔ minutesFactor ≠ 1');
    if (v.kind === 'susp' && v.usedInModel === true && v.minutesFactor !== 0) fail(c, `${at}.minutesFactor`, 'un sancionado usado por el modelo no juega (0)');
  },
);
const absenceList: Check = (v, at, c) => {
  arr(factorAbsence, { max: 11 })(v, at, c);
  if (!Array.isArray(v)) return;
  const ids = v.map((x) => (isObj(x) ? x.playerId : undefined));
  if (new Set(ids).size !== ids.length) fail(c, at, 'jugadores repetidos');
};
const factorAbsences = sobj({ home: absenceList, away: absenceList }, {}, (v, at, c) => {
  if (Array.isArray(v.home) && Array.isArray(v.away) && !v.home.length && !v.away.length) fail(c, at, 'bloque de bajas vacío');
});

const inFormPlayer = sobj({ playerId: str({ nonEmpty: true }), name: text(80), formIndex: num({ min: 0, max: 100 }), note: text(120) });
const inFormList: Check = (v, at, c) => {
  arr(inFormPlayer, { max: 3 })(v, at, c);
  if (!Array.isArray(v)) return;
  for (let i = 1; i < v.length; i++) if (isObj(v[i]) && isObj(v[i - 1]) && (v[i].formIndex as number) > (v[i - 1].formIndex as number)) fail(c, at, 'no está ordenado por formIndex');
  const ids = v.map((x) => (isObj(x) ? x.playerId : undefined));
  if (new Set(ids).size !== ids.length) fail(c, at, 'jugadores repetidos');
};
const factorInForm = sobj({ home: inFormList, away: inFormList, usedInModel: literal(false) });

const matchFactors = sobj(
  { asOf: str({ iso: true, nonEmpty: true }), referee: factorReferee, notes: arr(text(240), { min: 1, max: 8 }) },
  { tie: factorTie, stakes: factorStakes, form: factorForm, venue: factorVenue, absences: factorAbsences, inForm: factorInForm },
);

/** Coherencia de los factores con el resto de la ficha (fecha del partido, props publicadas). */
function factorsVsFile(f: Record<string, unknown>, file: Record<string, unknown>, at: string, c: Ctx): void {
  const m = file.match as Record<string, unknown> | undefined;
  const date = typeof m?.date === 'string' ? Date.parse(m.date) : NaN;
  if (Number.isFinite(date)) {
    if (typeof f.asOf === 'string' && Date.parse(f.asOf) !== date) fail(c, `${at}.asOf`, 'debe ser el inicio del partido (match.date)');
    const tie = f.tie as Record<string, unknown> | undefined;
    if (isObj(tie) && typeof tie.firstLegDate === 'string' && !(Date.parse(tie.firstLegDate) < date)) fail(c, `${at}.tie.firstLegDate`, 'la ida debe ser anterior al partido');
    if (isObj(tie) && typeof m?.round === 'string' && !/·\s*Vuelta\b/.test(m.round)) fail(c, `${at}.tie`, 'eliminatoria en un partido que no es vuelta');
  }
  const players = file.players as Record<string, unknown> | undefined;
  for (const side of ['home', 'away'] as const) {
    const props = Array.isArray(players?.[side]) ? (players![side] as Record<string, unknown>[]) : [];
    const byId = new Map(props.filter(isObj).map((p) => [String((p.player as Record<string, unknown> | undefined)?.id), p]));
    const abs = (f.absences as Record<string, unknown> | undefined)?.[side];
    if (Array.isArray(abs)) {
      abs.forEach((a, i) => {
        if (isObj(a) && a.minutesFactor === 0 && byId.has(String(a.playerId))) fail(c, `${at}.absences.${side}[${i}]`, 'sancionado (minutesFactor 0) publicado en las props');
      });
    }
    const inf = (f.inForm as Record<string, unknown> | undefined)?.[side];
    if (Array.isArray(inf)) {
      inf.forEach((p, i) => {
        if (!isObj(p)) return;
        const prop = byId.get(String(p.playerId));
        if (!prop) fail(c, `${at}.inForm.${side}[${i}]`, 'jugador en forma que no está en las props');
        else if (prop.formIndex !== p.formIndex) fail(c, `${at}.inForm.${side}[${i}].formIndex`, 'no coincide con el de las props');
      });
    }
  }
}

/**
 * Valida un bloque de factores suelto (tests): contrato estricto y, con `file`, coherencia con la ficha. Devuelve los
 * errores (vacío = válido).
 */
export function validateMatchFactors(factors: unknown, file?: Record<string, unknown>): string[] {
  const c: Ctx = { file: 'factors', errors: [], detailRefs: [], compRefs: [] };
  noNulls(factors, '$', c);
  matchFactors(factors, '$', c);
  if (file && isObj(factors)) factorsVsFile(factors, file, '$', c);
  return c.errors;
}

// ---------------------------------------------------------------------------
// Archivos raíz
// ---------------------------------------------------------------------------

const matchFile = obj(
  {
    generatedAt: iso,
    match: matchSummary,
    model: modelBreakdown,
    markets: arr(market, { min: 1 }),
    projections: arr(statProjection),
    form: obj({ home: teamFormBlock, away: teamFormBlock }),
    h2h,
    comparison: arr(comparisonRow),
    players: obj({ home: arr(playerProp), away: arr(playerProp) }),
    valueBets: arr(valuePick),
  },
  {
    table: obj({ group: str(), rows: arr(standingRow, { min: 1 }) }, { homeRank: num({ min: 1, int: true }), awayRank: num({ min: 1, int: true }) }),
    actual: obj({ home: teamMatchStats, away: teamMatchStats }),
    events: arr(matchEvent),
    confidence: confidenceList(2),
    factors: matchFactors,
  },
  (v, at, c) => {
    const m = v.match as Record<string, unknown> | undefined;
    if (isObj(v.factors)) factorsVsFile(v.factors, v, `${at}.factors`, c);
    // alta confianza: próximos sin resultado; terminados con resultado; el primero coincide con prediction.safe
    const conf = v.confidence as Record<string, unknown>[] | undefined;
    if (Array.isArray(conf) && m) {
      const finished = m.status === 'finished';
      conf.forEach((p, i) => {
        if (!isObj(p)) return;
        if (finished && p.result === undefined) fail(c, `${at}.confidence[${i}]`, 'pick de un partido terminado sin resultado');
        if (!finished && p.result !== undefined) fail(c, `${at}.confidence[${i}]`, 'resultado en un partido no terminado');
      });
      const safe = (m.prediction as Record<string, unknown> | undefined)?.safe as Record<string, unknown> | undefined;
      if (safe && conf[0] && (safe.family !== conf[0].family || safe.selection !== conf[0].selection)) fail(c, at, 'prediction.safe no coincide con confidence[0]');
    }
    if (m && m.hasDetail !== true) fail(c, `${at}.match.hasDetail`, 'una ficha publicada debe tener hasDetail=true');
    const p = (m?.prediction as Record<string, unknown> | undefined)?.p as Record<string, number> | undefined;
    const e = (v.model as Record<string, unknown> | undefined)?.ensemble as Record<string, number> | undefined;
    if (p && e && Math.abs(p.home - e.home) > 0.002) fail(c, at, 'match.prediction.p y model.ensemble no coinciden');
    const mk = (v.markets as { id: string; selections: { prob: number }[] }[] | undefined)?.find((x) => x.id === '1x2');
    if (mk && e && Math.abs(mk.selections[0]?.prob - e.home) > 0.002) fail(c, at, 'mercado 1X2 y ensamble no coinciden');
  },
);

const competitionFile = obj({
  generatedAt: iso,
  meta: competitionMeta,
  standings: arr(standingGroup),
  upcoming: arr(matchSummary),
  results: arr(matchSummary),
  live: arr(matchSummary),
  teams: arr(teamSeasonStats),
  ratings: arr(teamRating),
  simulations: arr(seasonSimulation),
  players: arr(playerSeasonRow, { max: 150 }),
  leagueAverages,
  insights: arr(str({ nonEmpty: true })),
}, { backtest: backtestSummary }, (v, at, c) => {
  const meta = v.meta as Record<string, unknown>;
  const sims = v.simulations as { columns?: string[] }[];
  if (meta && Array.isArray(sims)) {
    if (meta.hasSimulation !== sims.length > 0) fail(c, at, 'meta.hasSimulation no coincide con simulations');
    const cols = meta.simulationColumns as string[] | undefined;
    for (const s of sims) if (cols && JSON.stringify(s.columns) !== JSON.stringify(cols)) fail(c, at, 'columnas de simulación distintas de meta.simulationColumns');
    if (meta.hasTable !== ((v.standings as unknown[]).length > 0)) fail(c, at, 'meta.hasTable no coincide con standings');
  }
  const players = v.players as { formIndex: number }[];
  for (let i = 1; i < players.length; i++) if (players[i].formIndex > players[i - 1].formIndex + 1e-9) {
    fail(c, `${at}.players`, 'no está ordenado por formIndex');
    break;
  }
});

const teamFile = obj(
  {
    generatedAt: iso,
    team: teamRef,
    competitions: arr(str({ nonEmpty: true }), { min: 1 }),
    primaryCompId: str({ nonEmpty: true }),
    elo: ELO_RANGE,
    globalEloRank: num({ min: 1, int: true }),
    eloHistory: arr(eloPoint),
    stats: teamSeasonStats,
    form: teamFormBlock,
    matches: arr(formMatch),
    upcoming: arr(matchSummary),
    players: arr(playerSeasonRow),
  },
  { standing: standingRow },
  (v, at, c) => {
    for (const id of (v.competitions as string[]) ?? []) c.compRefs.push({ id, at: `${at}.competitions` });
    c.compRefs.push({ id: String(v.primaryCompId), at: `${at}.primaryCompId` });
  },
);

const metaFile = obj(
  {
    generatedAt: iso,
    version: str({ nonEmpty: true }),
    dataSource: str({ nonEmpty: true }),
    competitions: arr(competitionMeta, { min: 1 }),
    counts: obj({ matchesAnalyzed: count, upcomingMatches: count, teams: count, players: count, valueBets: count }),
    teams: arr(obj({ id: safeId, name: str({ nonEmpty: true }), abbr: str(), compId: str({ nonEmpty: true }) }, { logo: logoUrl, color: hex })),
  },
  { dataUpdatedAt: iso },
  (v, at, c) => {
    if (typeof v.dataUpdatedAt === 'string' && typeof v.generatedAt === 'string' && Date.parse(v.dataUpdatedAt) > Date.parse(v.generatedAt) + 60_000) {
      fail(c, `${at}.dataUpdatedAt`, 'posterior a generatedAt');
    }
  },
);

/** hitRate = hits / n (n = resueltos) y hits <= n. */
function checkRate(v: Record<string, unknown>, at: string, c: Ctx, nKey = 'n'): void {
  const n = v[nKey] as number;
  const hits = v.hits as number;
  const rate = v.hitRate as number | undefined;
  if (typeof n !== 'number' || typeof hits !== 'number') return;
  if (hits > n) fail(c, at, `aciertos ${hits} > resueltos ${n}`);
  if (typeof rate === 'number' && n > 0 && Math.abs(rate - hits / n) > 1e-3) fail(c, at, `hitRate ${rate} ≠ ${hits}/${n}`);
  if (typeof rate === 'number' && n === 0 && rate !== 0) fail(c, at, 'hitRate sin picks resueltos');
  if (typeof v.picks === 'number' && nKey === 'n' && n > (v.picks as number)) fail(c, at, `resueltos ${n} > picks ${v.picks}`);
  if (typeof v.wilsonLow === 'number' && typeof rate === 'number' && n > 0 && !((v.wilsonLow as number) <= rate + 1e-9 && rate <= ((v.wilsonHigh as number) ?? 1) + 1e-9)) {
    fail(c, at, 'intervalo de Wilson que no contiene el acierto');
  }
}

const confidenceRecordFields = { picks: count, n: count, hits: count, hitRate: prob };
const confidenceRecordOpt = { wilsonLow: prob, wilsonHigh: prob, voids: count };
const confidenceRecord = obj({ ...confidenceRecordFields, from: iso, to: iso }, { ...confidenceRecordOpt, matches: count }, (v, at, c) => checkRate(v, at, c));

/** { match, pick } de alta confianza; settled = partido terminado con resultado. */
function confidenceEntry(settled: boolean): Check {
  return obj(
    { match: matchSummary, pick: confidencePick, ...(settled ? { hit: bool } : {}) },
    {},
    (v, at, c) => {
      const m = v.match as Record<string, unknown> | undefined;
      const p = v.pick as Record<string, unknown> | undefined;
      if (!m || !p) return;
      if (settled) {
        if (m.status !== 'finished') fail(c, at, 'pick resuelto de un partido no terminado');
        if (p.result === undefined) fail(c, at, 'pick resuelto sin resultado');
        if (v.hit !== (p.result === 'hit')) fail(c, at, 'hit no coincide con pick.result');
      } else {
        if (m.status !== 'scheduled') fail(c, at, `pick de alta confianza de un partido "${String(m.status)}" (debe estar programado)`);
        if (p.result !== undefined) fail(c, at, 'resultado en un pick no resuelto');
        // producción solo publica reglas validadas fuera de muestra (walk-forward: >= 30 picks y >= 80 %)
        if (p.validationN !== undefined && ((p.validationN as number) < 30 || (p.validationHitRate as number) < 0.8 - 1e-9)) {
          fail(c, at, `pick de una regla sin validar fuera de muestra (${String(p.validationHitRate)}, n = ${String(p.validationN)})`);
        }
      }
    },
  );
}

const confidenceFile = obj(
  {
    generatedAt: iso,
    picks: arr(confidenceEntry(false)),
    recent: arr(confidenceEntry(true)),
    track: obj(
      {
        holdout: confidenceRecord,
        byTier: arr(obj({ tier: str({ oneOf: ['oro'] }), ...confidenceRecordFields }, confidenceRecordOpt, (v, at, c) => checkRate(v, at, c)), { max: 1 }),
        byFamily: arr(
          obj(
            {
              family: str({ nonEmpty: true, pattern: CONF_FAMILY }),
              label: str({ nonEmpty: true }),
              theme: str({ oneOf: ['resultado', 'goles', 'corners', 'tarjetas'] }),
              active: bool,
              thresholds: arr(
                obj(
                  { source: str({ oneOf: ['mercado', 'estadistico'] }), threshold: num({ min: 0.5, max: 1 }) },
                  { goldThreshold: num({ min: 0.5, max: 1 }), validationN: count, validationHits: count, validationHitRate: prob },
                  (v, at, c) => {
                    // regla publicada ⇒ validada fuera de muestra
                    if (typeof v.validationN === 'number' && ((v.validationN as number) < 30 || ((v.validationHitRate as number) ?? 0) < 0.8 - 1e-9)) {
                      fail(c, at, `regla publicada sin validación fuera de muestra (n = ${String(v.validationN)}, ${String(v.validationHitRate)})`);
                    }
                  },
                ),
                { max: 2 },
              ),
              picks: count,
              n: count,
              hits: count,
            },
            {
              threshold: num({ min: 0.5, max: 1 }),
              hitRate: prob,
              wilsonLow: prob,
              wilsonHigh: prob,
              avgFairOdds: num({ min: 1 }),
              baseRate: prob,
              baseN: count,
              lift: num({ min: -1, max: 1 }),
              unpublished: arr(obj({ source: str({ oneOf: ['mercado', 'estadistico'] }), n: count, hits: count }, { hitRate: prob }), { max: 2 }),
              excluded: str({ nonEmpty: true }),
              walkForward: obj({ n: count, hits: count, hitRate: prob }, { wilsonLow: prob, wilsonHigh: prob }, (v, at, c) => checkRate(v, at, c)),
              note: str({ nonEmpty: true }),
            },
            (v, at, c) => {
              checkRate(v, at, c);
              if (v.n === 0 && v.hitRate !== undefined) fail(c, at, 'hitRate sin picks resueltos (debe omitirse)');
              const ths = v.thresholds as unknown[];
              if (v.active !== (Array.isArray(ths) && ths.length > 0)) fail(c, at, 'active no coincide con thresholds');
              if (v.excluded !== undefined && v.active) fail(c, at, 'familia excluida de antemano con reglas publicadas');
              if (typeof v.lift === 'number' && typeof v.hitRate === 'number' && typeof v.baseRate === 'number' && Math.abs((v.lift as number) - ((v.hitRate as number) - (v.baseRate as number))) > 1e-4) {
                fail(c, at, 'lift distinto de acierto − tasa base');
              }
            },
          ),
        ),
        coverage: obj({ picksPerDay: nonNeg }, { picksPerMatchDay: nonNeg, matches: count, matchesWithPick: count }),
        avgFairOdds: (v, at, c) => {
          num({ min: 0 })(v, at, c);
          if (typeof v === 'number' && v !== 0 && v < 1) fail(c, at, `cuota justa media ${v} < 1`);
        },
      },
      {
        virgin: confidenceRecord,
        calibration: obj({ from: iso, to: iso, matches: count }),
        bySource: arr(obj({ source: str({ oneOf: ['mercado', 'estadistico'] }), ...confidenceRecordFields }, confidenceRecordOpt, (v, at, c) => checkRate(v, at, c)), { max: 2 }),
        avgProb: prob,
        roi: obj({ bets: num({ min: 1, int: true }), roi: num({ min: -1 }) }, { profit: num(), hitRate: prob, avgOdds: num({ min: 1 }), synthetic: count }),
        baseline: obj({ label: str({ nonEmpty: true }), ...confidenceRecordFields }, { wilsonLow: prob, wilsonHigh: prob, matches: count }, (v, at, c) => checkRate(v, at, c)),
        expectedBaseRate: prob,
        lift: num({ min: -1, max: 1 }),
        walkForward: obj(
          { ...confidenceRecordFields, from: iso, to: iso, folds: arr(obj({ start: iso, end: iso, matches: count, picks: count, n: count, hits: count, hitRate: prob }, {}, (v, at, c) => checkRate(v, at, c))) },
          {
            ...confidenceRecordOpt,
            matches: count,
            roi: obj({ bets: num({ min: 1, int: true }), roi: num({ min: -1 }) }, { profit: num(), hitRate: prob, avgOdds: num({ min: 1 }), synthetic: count }),
          },
          (v, at, c) => checkRate(v, at, c),
        ),
        excluded: arr(obj({ family: str({ nonEmpty: true, pattern: /^[a-z0-9.+|-]{1,60}$/ }), label: str({ nonEmpty: true }), reason: str({ nonEmpty: true }) })),
      },
    ),
    rules: obj({
      level: count,
      targetRate: prob,
      from: iso,
      to: iso,
      matches: count,
      active: count,
      maxPerMatch: num({ min: 1, int: true }),
      minHitRate: num({ min: 0.85, max: 1 }),
    }, { unvalidated: count, validation: obj({ minN: num({ min: 1, int: true }), minRate: prob }) }),
    note: str({ nonEmpty: true }),
  },
  {},
  (v, at, c) => {
    const picks = v.picks as { match?: { id?: string; date?: string }; pick?: { family?: string } }[];
    if (Array.isArray(picks)) {
      for (let i = 1; i < picks.length; i++) {
        if (Date.parse(picks[i].match?.date ?? '') < Date.parse(picks[i - 1].match?.date ?? '')) {
          fail(c, `${at}.picks`, 'no está ordenado por fecha');
          break;
        }
      }
      // como mucho maxPerMatch por partido y de familias distintas
      const max = isObj(v.rules) && typeof v.rules.maxPerMatch === 'number' ? (v.rules.maxPerMatch as number) : 2;
      const byMatch = new Map<string, string[]>();
      for (const p of picks) {
        const id = String(p.match?.id);
        byMatch.set(id, [...(byMatch.get(id) ?? []), String(p.pick?.family)]);
      }
      for (const [id, fams] of byMatch) {
        if (fams.length > max) fail(c, `${at}.picks`, `${fams.length} picks del partido ${id} (máximo ${max})`);
        if (new Set(fams).size !== fams.length) fail(c, `${at}.picks`, `dos picks de la misma familia en el partido ${id}`);
      }
    }
    const recent = v.recent as { match?: { date?: string } }[];
    if (Array.isArray(recent)) {
      for (let i = 1; i < recent.length; i++) {
        if (Date.parse(recent[i].match?.date ?? '') > Date.parse(recent[i - 1].match?.date ?? '')) {
          fail(c, `${at}.recent`, 'no está ordenado del más reciente al más antiguo');
          break;
        }
      }
    }
  },
);


// ---------------------------------------------------------------------------
// Pronósticos del día (daily.json y HomeFile.daily)
// ---------------------------------------------------------------------------

const DAILY_CATEGORY_IDS = ['resultado', 'goles', 'tiros', 'corners', 'tarjetas', 'faltas', 'jugadores'] as const;
const DAILY_COMBO_LEGS: Record<string, [number, number]> = { segura: [2, 2], equilibrada: [3, 3], atrevida: [4, 5] };
const pickKey = (p: Record<string, unknown>) => `${String(p.family)}|${String(p.marketId)}|${String(p.selection)}`;

/**
 * Pick del apartado diario: un ConfidencePick (solo oro, prob >= umbral, cuota justa = 1/p) con categoría, puntuación
 * 0..100 y, en los props, el jugador. Sin resultado ⇒ su regla está validada fuera de muestra (>= 30 picks y >= 80 %).
 */
const dailyPick: Check = (v, at, c) => {
  confidencePick(v, at, c);
  if (!isObj(v)) return;
  obj(
    { category: str({ oneOf: DAILY_CATEGORY_IDS }) },
    {
      reason: str({ nonEmpty: true }),
      player: obj({ id: safeId, name: str({ nonEmpty: true }), short: str(), teamId: safeId }, { position: str({ oneOf: ['G', 'D', 'M', 'F', '?'] }), expMinutes: num({ min: 0, max: 130 }) }),
      score: num({ min: 0, max: 100 }),
      lift: num({ min: -1, max: 1 }),
    },
    (p, a, cc) => {
      if ((p.category === 'jugadores') !== (p.player !== undefined)) fail(cc, a, 'los picks de jugadores (y solo ellos) llevan `player`');
      if (typeof p.lift === 'number' && typeof p.validationHitRate === 'number' && typeof p.baseRate === 'number' && Math.abs((p.lift as number) - ((p.validationHitRate as number) - (p.baseRate as number))) > 1e-4) {
        fail(cc, a, 'lift distinto de acierto fuera de muestra − tasa base');
      }
      if (p.result === undefined) {
        if (typeof p.validationN !== 'number' || (p.validationN as number) < 30 || !(((p.validationHitRate as number) ?? 0) >= 0.8 - 1e-9)) {
          fail(cc, a, `pick del día de una regla sin validar fuera de muestra (${String(p.validationHitRate)}, n = ${String(p.validationN)})`);
        }
      }
    },
  )(v, at, c);
};

const statTriple = obj({ home: nonNeg, away: nonNeg, total: nonNeg }, {}, (v, at, c) => {
  const s = (v.home as number) + (v.away as number);
  if (Number.isFinite(s) && Math.abs(s - (v.total as number)) > 0.03) fail(c, at, `total ${String(v.total)} ≠ local + visitante (${s.toFixed(2)})`);
});

/** Grupo de redundancia deducible del pick publicado: misma estadística y sentido, o mismo jugador. */
function dailyGroup(p: Record<string, unknown>): string | undefined {
  if (isObj(p.player)) return `jugador-${String(p.player.id)}`;
  const id = String(p.marketId);
  const sel = String(p.selection);
  const m = /^(?:(sot|shots|fouls|corners|cards)-ou|ou)-[\d.]+$/.exec(id);
  if (m && /^(Más|Menos) de /.test(sel)) return `${m[1] ?? 'goles'}-${sel.startsWith('Más') ? 'over' : 'under'}`;
  return undefined;
}

const dailyMatch = obj(
  {
    match: matchSummary,
    picks: arr(dailyPick, { min: 1, max: 8 }),
    expected: obj({ goals: statTriple }, { shotsOnTarget: statTriple, shots: statTriple, corners: statTriple, cards: statTriple, fouls: statTriple }),
    analysis: arr(str({ nonEmpty: true }), { min: 2, max: 5 }),
  },
  {},
  (v, at, c) => {
    const m = v.match as Record<string, unknown> | undefined;
    const picks = v.picks as Record<string, unknown>[] | undefined;
    if (!isObj(m) || !Array.isArray(picks)) return;
    if (m.status !== 'scheduled' && m.status !== 'live' && m.status !== 'finished') fail(c, at, `pronósticos del día de un partido "${String(m.status)}" (programado, en juego o terminado)`);
    const perCat = new Map<string, number>();
    const keys = new Set<string>();
    const groups = new Set<string>();
    picks.forEach((p, i) => {
      if (!isObj(p)) return;
      perCat.set(String(p.category), (perCat.get(String(p.category)) ?? 0) + 1);
      if (keys.has(pickKey(p))) fail(c, `${at}.picks[${i}]`, 'pick repetido');
      keys.add(pickKey(p));
      const g = dailyGroup(p);
      if (g) {
        if (groups.has(g)) fail(c, `${at}.picks[${i}]`, `pick redundante con otro del mismo partido (${g})`);
        groups.add(g);
      }
      if (m.status !== 'finished' && p.result !== undefined) fail(c, `${at}.picks[${i}]`, 'resultado en un partido no terminado');
      if (m.status === 'finished' && p.result === undefined) fail(c, `${at}.picks[${i}]`, 'pick de un partido terminado sin resultado');
      if (i > 0 && isObj(picks[i - 1]) && typeof p.score === 'number' && typeof picks[i - 1].score === 'number' && (p.score as number) > (picks[i - 1].score as number) + 1e-9) {
        fail(c, `${at}.picks`, 'no está ordenado por puntuación');
      }
    });
    for (const [cat, n] of perCat) if (n > 2) fail(c, `${at}.picks`, `${n} picks de la categoría ${cat} (máximo 2)`);
  },
);

const dailyCombo = obj(
  {
    id: str({ oneOf: Object.keys(DAILY_COMBO_LEGS) }),
    label: str({ nonEmpty: true }),
    legs: arr(obj({ matchId: safeId, home: str({ nonEmpty: true }), away: str({ nonEmpty: true }), compName: str({ nonEmpty: true }), pick: dailyPick }), { min: 2, max: 5 }),
    prob,
    fairOdds: num({ min: 1 }),
  },
  { marketOdds: odds },
  (v, at, c) => {
    const legs = v.legs as { matchId?: string; pick?: Record<string, unknown> }[] | undefined;
    if (!Array.isArray(legs)) return;
    const range = DAILY_COMBO_LEGS[String(v.id)];
    if (range && (legs.length < range[0] || legs.length > range[1])) fail(c, at, `combinada ${String(v.id)} con ${legs.length} patas (${range[0]}–${range[1]})`);
    if (new Set(legs.map((l) => l?.matchId)).size !== legs.length) fail(c, at, 'dos patas del mismo partido');
    let product = 1;
    let market = 1;
    let allPriced = true;
    for (const l of legs) {
      const p = l?.pick;
      if (!isObj(p)) return;
      if (p.result !== undefined) fail(c, at, 'pata ya resuelta');
      product *= (typeof p.calibratedProb === 'number' ? p.calibratedProb : (p.prob as number)) as number;
      if (typeof p.marketOdds === 'number') market *= p.marketOdds;
      else allPriced = false;
    }
    if (typeof v.prob === 'number' && Math.abs((v.prob as number) - product) > 2e-3) fail(c, at, `prob ${String(v.prob)} ≠ producto de las patas (${product.toFixed(4)})`);
    if (typeof v.prob === 'number' && typeof v.fairOdds === 'number' && (v.prob as number) > 0 && Math.abs((v.fairOdds as number) * (v.prob as number) - 1) > 0.01) {
      fail(c, at, `cuota justa ${String(v.fairOdds)} incoherente con prob ${String(v.prob)}`);
    }
    if (v.marketOdds !== undefined && !allPriced) fail(c, at, 'marketOdds sin cuota en todas las patas');
    if (typeof v.marketOdds === 'number' && allPriced && Math.abs((v.marketOdds as number) / market - 1) > 0.01) fail(c, at, `marketOdds ${String(v.marketOdds)} ≠ producto de las cuotas (${market.toFixed(3)})`);
  },
);

const dailyDay = obj(
  {
    date: str({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    matches: arr(dailyMatch),
    top: arr(obj({ matchId: safeId, pick: dailyPick }), { max: 10 }),
    combos: arr(dailyCombo, { max: 3 }),
    counts: obj({ matches: count, picks: count, matchesAnalyzed: count }),
  },
  {},
  (v, at, c) => {
    const matches = v.matches as { match?: Record<string, unknown>; picks?: Record<string, unknown>[] }[] | undefined;
    const counts = v.counts as Record<string, number> | undefined;
    if (!Array.isArray(matches) || !isObj(counts)) return;
    const picksOf = new Map<string, { status: unknown; keys: Set<string> }>();
    let total = 0;
    const noon = Date.parse(`${String(v.date)}T12:00:00Z`);
    for (const m of matches) {
      if (!isObj(m?.match) || !Array.isArray(m.picks)) return;
      const id = String(m.match.id);
      if (picksOf.has(id)) fail(c, `${at}.matches`, `partido ${id} repetido`);
      picksOf.set(id, { status: m.match.status, keys: new Set(m.picks.filter(isObj).map(pickKey)) });
      total += m.picks.length;
      const t = Date.parse(String(m.match.date));
      if (Number.isFinite(noon) && Number.isFinite(t) && Math.abs(t - noon) > 38 * 3_600_000) fail(c, `${at}.matches`, `el partido ${id} (${String(m.match.date)}) no es del día ${String(v.date)}`);
    }
    if (counts.matches !== matches.length) fail(c, `${at}.counts`, `matches ${counts.matches} ≠ ${matches.length}`);
    if (counts.picks !== total) fail(c, `${at}.counts`, `picks ${counts.picks} ≠ ${total}`);
    if (counts.matchesAnalyzed < matches.length) fail(c, `${at}.counts`, 'matchesAnalyzed menor que los partidos con pick');
    const open = (matchId: unknown, pick: unknown, where: string) => {
      const e = picksOf.get(String(matchId));
      if (!e) return fail(c, where, `partido ${String(matchId)} ausente de matches`);
      if (e.status !== 'scheduled') fail(c, where, `pick de un partido "${String(e.status)}" (solo partidos por jugar)`);
      if (isObj(pick) && !e.keys.has(pickKey(pick))) fail(c, where, 'el pick no está entre los del partido');
    };
    const top = v.top as { matchId?: string; pick?: Record<string, unknown> }[];
    if (Array.isArray(top)) {
      if (new Set(top.map((t) => t?.matchId)).size !== top.length) fail(c, `${at}.top`, 'más de un pick del mismo partido');
      top.forEach((t, i) => {
        open(t?.matchId, t?.pick, `${at}.top[${i}]`);
        const prev = top[i - 1]?.pick;
        if (i > 0 && isObj(prev) && isObj(t?.pick) && typeof t.pick.score === 'number' && typeof prev.score === 'number' && (t.pick.score as number) > (prev.score as number) + 1e-9) {
          fail(c, `${at}.top`, 'no está ordenado por puntuación');
        }
      });
    }
    const combos = v.combos as { id?: string; legs?: { matchId?: string; pick?: unknown }[] }[];
    if (Array.isArray(combos)) {
      if (new Set(combos.map((x) => x?.id)).size !== combos.length) fail(c, `${at}.combos`, 'tipo de combinada repetido');
      combos.forEach((x, i) => (Array.isArray(x?.legs) ? x.legs : []).forEach((l, j) => open(l?.matchId, l?.pick, `${at}.combos[${i}].legs[${j}]`)));
    }
  },
);

const dailyBaseline = obj({ label: str({ nonEmpty: true }), ...confidenceRecordFields }, { wilsonLow: prob, wilsonHigh: prob, matches: count }, (v, at, c) => checkRate(v, at, c));

const dailyFile = obj(
  {
    generatedAt: iso,
    days: arr(dailyDay, { max: 4 }),
    categories: arr(obj({ id: str({ oneOf: DAILY_CATEGORY_IDS }), label: str({ nonEmpty: true }) }), { min: 1, max: DAILY_CATEGORY_IDS.length }),
    track: obj(
      {
        overall: confidenceRecord,
        byCategory: arr(
          obj({ category: str({ oneOf: DAILY_CATEGORY_IDS }), label: str({ nonEmpty: true }), ...confidenceRecordFields }, { ...confidenceRecordOpt, baseRate: prob }, (v, at, c) => checkRate(v, at, c)),
          { max: DAILY_CATEGORY_IDS.length },
        ),
      },
      {
        combos: arr(
          obj(
            { id: str({ oneOf: Object.keys(DAILY_COMBO_LEGS) }), label: str({ nonEmpty: true }), days: num({ min: 1, int: true }), hits: count, hitRate: prob, avgLegs: num({ min: 2, max: 5 }), avgFairOdds: num({ min: 1 }) },
            {},
            (v, at, c) => checkRate(v, at, c, 'days'),
          ),
          { max: 3 },
        ),
        baseline: dailyBaseline,
      },
    ),
    note: str({ nonEmpty: true }),
  },
  {},
  (v, at, c) => {
    const days = v.days as { date?: string; matches?: { match?: { status?: string } }[] }[];
    if (Array.isArray(days)) {
      for (let i = 1; i < days.length; i++) if (!(String(days[i]?.date) > String(days[i - 1]?.date))) fail(c, `${at}.days`, 'días repetidos o sin ordenar');
      // picks por jugar ⇒ existe un récord fuera de muestra que los respalda
      const openPicks = days.some((d) => (d?.matches ?? []).some((m) => m?.match?.status === 'scheduled'));
      const overall = isObj(v.track) && isObj(v.track.overall) ? (v.track.overall.n as number) : 0;
      if (openPicks && !(overall >= 30)) fail(c, `${at}.track.overall`, `picks del día publicados sin récord fuera de muestra suficiente (n = ${String(overall)})`);
    }
    for (const k of ['categories', 'byCategory'] as const) {
      const list = (k === 'categories' ? v.categories : isObj(v.track) ? v.track.byCategory : undefined) as Record<string, unknown>[] | undefined;
      if (Array.isArray(list)) {
        const ids = list.map((x) => (isObj(x) ? (k === 'categories' ? x.id : x.category) : undefined));
        if (new Set(ids).size !== ids.length) fail(c, `${at}.${k}`, 'categoría repetida');
      }
    }
  },
);

const homeDaily = obj(
  { date: str({ pattern: /^\d{4}-\d{2}-\d{2}$/ }), matches: count, picks: count, top: arr(obj({ match: matchSummary, pick: dailyPick }), { max: 4 }) },
  {},
  (v, at, c) => {
    const top = v.top as { match?: Record<string, unknown>; pick?: Record<string, unknown> }[];
    if (!Array.isArray(top)) return;
    if (new Set(top.map((x) => (isObj(x?.match) ? x.match.id : undefined))).size !== top.length) fail(c, `${at}.top`, 'más de un pick del mismo partido');
    for (const x of top) {
      if (isObj(x?.match) && x.match.status !== 'scheduled') fail(c, `${at}.top`, 'pick de un partido que no está por jugar');
      if (isObj(x?.pick) && x.pick.result !== undefined) fail(c, `${at}.top`, 'pick ya resuelto');
    }
  },
);

// ---------------------------------------------------------------------------
// Cuota alta 6+ (longshots.json y HomeFile.longshot)
// ---------------------------------------------------------------------------

const LONGSHOT_KINDS = ['combinada', 'sorpresa', 'marcador', 'goleador', 'otro'] as const;
const BET_RESULTS = ['hit', 'miss', 'void'] as const;
/** Tolerancia relativa de cuotas y probabilidades publicadas (redondeadas a 2–4 decimales). */
const REL_TOL = 0.01;
const relClose = (a: number, b: number, tol = REL_TOL) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);
const openProb = num({ gt: 0, max: 1 });

/** Pata: probabilidad en (0, 1), cuota justa = 1/p; partido y competición referenciados. */
const longshotLeg = obj(
  {
    matchId: safeId,
    compId: str({ nonEmpty: true }),
    compName: str({ nonEmpty: true }),
    date: iso,
    home: teamRef,
    away: teamRef,
    market: str({ nonEmpty: true }),
    selection: str({ nonEmpty: true }),
    prob: openProb,
    fairOdds: num({ min: 1 }),
  },
  {
    marketOdds: odds,
    category: str({ oneOf: DAILY_CATEGORY_IDS }),
    player: obj({ id: safeId, name: str({ nonEmpty: true }), short: str(), teamId: safeId }),
    result: str({ oneOf: BET_RESULTS }),
  },
  (v, at, c) => {
    c.compRefs.push({ id: String(v.compId), at: `${at}.compId` });
    const p = v.prob as number;
    if (typeof p === 'number' && p >= 1) fail(c, at, `prob ${p} debe ser < 1`);
    if (typeof p === 'number' && p > 0 && typeof v.fairOdds === 'number' && !relClose(v.fairOdds as number, 1 / p)) fail(c, at, `cuota justa ${String(v.fairOdds)} ≠ 1/prob (${(1 / p).toFixed(3)})`);
    if (v.player !== undefined && v.category !== undefined && v.category !== 'jugadores') fail(c, at, 'pata con jugador fuera de la categoría jugadores');
  },
);

/**
 * Apuesta: simples con 1 pata; combinadas con 2–4 patas de partidos distintos y prob = producto; cuota justa = 1/p;
 * cuota de la casa = producto de las patas (solo si todas la tienen); displayOdds = cuota de la casa o, si no, la justa;
 * EV = p·cuota − 1 (solo con cuota de la casa); oneIn ≈ 1/p; resultado coherente con el de las patas.
 */
const longshotBet = obj(
  {
    id: str({ nonEmpty: true, pattern: /^[A-Za-z0-9_.+-]{1,300}$/ }),
    kind: str({ oneOf: LONGSHOT_KINDS }),
    label: str({ nonEmpty: true }),
    legs: arr(longshotLeg, { min: 1, max: 4 }),
    prob: openProb,
    fairOdds: num({ min: 1 }),
    displayOdds: num({ gt: 1 }),
    oneIn: num({ min: 1, int: true }),
    score: num({ min: 0, max: 100 }),
    reason: str({ nonEmpty: true }),
  },
  { marketOdds: odds, ev: num({ min: -1 }), result: str({ oneOf: BET_RESULTS }) },
  (v, at, c) => {
    const legs = (Array.isArray(v.legs) ? v.legs : []).filter(isObj) as Record<string, unknown>[];
    const p = v.prob as number;
    if (typeof p !== 'number' || !legs.length) return;
    if (p >= 1) fail(c, at, `prob ${p} debe ser < 1`);
    if (v.kind === 'combinada') {
      if (legs.length < 2) fail(c, at, `combinada con ${legs.length} pata`);
      if (new Set(legs.map((l) => l.matchId)).size !== legs.length) fail(c, at, 'combinada con dos patas del mismo partido');
    } else if (legs.length !== 1) fail(c, at, `apuesta simple (${String(v.kind)}) con ${legs.length} patas`);
    if (v.kind === 'goleador' && legs.some((l) => !isObj(l.player))) fail(c, at, 'goleador sin jugador');
    const product = legs.reduce((x, l) => x * (typeof l.prob === 'number' ? (l.prob as number) : NaN), 1);
    if (Number.isFinite(product) && !(Math.abs(p - product) <= 2e-4 || relClose(p, product, 0.005))) fail(c, at, `prob ${p} ≠ producto de las patas (${product.toFixed(5)})`);
    if (p > 0 && typeof v.fairOdds === 'number' && !relClose(v.fairOdds as number, 1 / p)) fail(c, at, `cuota justa ${String(v.fairOdds)} ≠ 1/prob (${(1 / p).toFixed(3)})`);
    if (p > 0 && typeof v.oneIn === 'number' && Math.abs((v.oneIn as number) - 1 / p) > 0.51 + 0.01 / p) fail(c, at, `oneIn ${String(v.oneIn)} ≠ round(1/prob) (${(1 / p).toFixed(2)})`);
    const priced = legs.every((l) => typeof l.marketOdds === 'number');
    const market = legs.reduce((x, l) => x * (typeof l.marketOdds === 'number' ? (l.marketOdds as number) : 1), 1);
    if (v.marketOdds !== undefined && !priced) fail(c, at, 'marketOdds sin cuota de la casa en todas las patas');
    if (v.marketOdds === undefined && priced) fail(c, at, 'todas las patas tienen cuota de la casa pero falta marketOdds');
    if (typeof v.marketOdds === 'number' && priced && !relClose(v.marketOdds as number, market)) fail(c, at, `marketOdds ${String(v.marketOdds)} ≠ producto de las cuotas de las patas (${market.toFixed(3)})`);
    const shown = typeof v.marketOdds === 'number' ? (v.marketOdds as number) : (v.fairOdds as number);
    if (typeof v.displayOdds === 'number' && typeof shown === 'number' && !relClose(v.displayOdds as number, shown)) fail(c, at, `displayOdds ${String(v.displayOdds)} ≠ ${typeof v.marketOdds === 'number' ? 'marketOdds' : 'fairOdds'} (${shown})`);
    if ((v.ev === undefined) !== (v.marketOdds === undefined)) fail(c, at, 'ev y marketOdds van juntos');
    if (typeof v.ev === 'number' && typeof v.marketOdds === 'number' && Math.abs((v.ev as number) - (p * (v.marketOdds as number) - 1)) > 0.01) {
      fail(c, at, `EV ${String(v.ev)} incoherente con prob·cuota − 1 (${(p * (v.marketOdds as number) - 1).toFixed(4)})`);
    }
    // resultado: una pata fallada ⇒ fallada; todas resueltas ⇒ acierto (o nula si alguna lo es)
    const rs = legs.map((l) => l.result);
    const expected = rs.includes('miss') ? 'miss' : rs.some((r) => r === undefined) ? undefined : rs.includes('void') ? 'void' : 'hit';
    if (v.result !== expected) fail(c, at, `resultado ${String(v.result)} incoherente con el de las patas (${String(expected)})`);
  },
);

const longshotDay = obj({ date: str({ pattern: /^\d{4}-\d{2}-\d{2}$/ }), bets: arr(longshotBet, { max: 12 }) }, {}, (v, at, c) => {
  const bets = (Array.isArray(v.bets) ? v.bets : []).filter(isObj) as Record<string, unknown>[];
  const perKind = new Map<string, number>();
  const used = new Map<string, Set<string>>();
  const noon = Date.parse(`${String(v.date)}T12:00:00Z`);
  if (new Set(bets.map((b) => b.id)).size !== bets.length) fail(c, `${at}.bets`, 'apuesta repetida (id)');
  bets.forEach((b, i) => {
    const k = String(b.kind);
    perKind.set(k, (perKind.get(k) ?? 0) + 1);
    const u = used.get(k) ?? new Set<string>();
    for (const l of (Array.isArray(b.legs) ? b.legs : []).filter(isObj) as Record<string, unknown>[]) {
      if (u.has(String(l.matchId))) fail(c, `${at}.bets[${i}]`, `partido ${String(l.matchId)} repetido dentro del tipo ${k}`);
      u.add(String(l.matchId));
      const t = Date.parse(String(l.date));
      if (Number.isFinite(noon) && Number.isFinite(t) && Math.abs(t - noon) > 38 * 3_600_000) fail(c, `${at}.bets[${i}]`, `partido ${String(l.matchId)} (${String(l.date)}) que no es del día ${String(v.date)}`);
    }
    used.set(k, u);
    const prev = bets[i - 1];
    if (prev && typeof b.score === 'number' && typeof prev.score === 'number' && (b.score as number) > (prev.score as number) + 1e-9) fail(c, `${at}.bets`, 'no está ordenado por puntuación');
  });
  for (const [k, n] of perKind) if (n > 4) fail(c, `${at}.bets`, `${n} apuestas de tipo ${k} (máximo 4)`);
});

const longshotRecord = obj(
  {
    kind: str({ oneOf: LONGSHOT_KINDS }),
    label: str({ nonEmpty: true }),
    bets: count,
    hits: count,
    hitRate: prob,
    expectedHitRate: prob,
    avgOdds: nonNeg,
  },
  {
    wilsonLow: prob,
    wilsonHigh: prob,
    roi: obj({ bets: num({ min: 1, int: true }), staked: num({ gt: 0 }), profit: num(), roi: num({ min: -1 }) }),
    longestLosingStreak: count,
    voids: count,
    excluded: str({ nonEmpty: true }),
  },
  (v, at, c) => {
    const bets = v.bets as number;
    const settled = bets - ((v.voids as number | undefined) ?? 0);
    if (settled < 0) fail(c, at, `nulas ${String(v.voids)} > apuestas ${bets}`);
    checkRate({ ...v, n: settled }, at, c);
    if (bets > 0 && (v.avgOdds as number) < 1) fail(c, at, `cuota media ${String(v.avgOdds)} con ${bets} apuestas`);
    if (typeof v.longestLosingStreak === 'number' && (v.longestLosingStreak as number) > settled) fail(c, at, `racha ${String(v.longestLosingStreak)} > apuestas resueltas ${settled}`);
    const r = v.roi as Record<string, number> | undefined;
    if (isObj(r)) {
      if (r.bets > settled) fail(c, `${at}.roi`, `ROI sobre ${r.bets} apuestas > resueltas ${settled}`);
      if (Math.abs(r.staked - r.bets) > 1e-9) fail(c, `${at}.roi`, 'apuesta plana: staked ≠ bets');
      if (r.profit < -r.staked - 1e-6) fail(c, `${at}.roi`, `pérdida ${r.profit} mayor que lo apostado`);
      if (r.staked > 0 && Math.abs(r.roi - r.profit / r.staked) > 1e-3) fail(c, `${at}.roi`, `roi ${r.roi} ≠ profit/staked`);
    }
  },
);

const longshotFile = obj(
  {
    generatedAt: iso,
    minOdds: num({ min: 1.01 }),
    days: arr(longshotDay, { max: 4 }),
    track: obj({
      from: iso,
      to: iso,
      byKind: arr(longshotRecord, { max: LONGSHOT_KINDS.length }),
      calibration: arr(
        obj({ from: prob, to: prob, predicted: prob, observed: prob, n: num({ min: 1, int: true }) }, {}, (v, at, c) => {
          if ((v.from as number) < 0.05 - 1e-9 || (v.to as number) > 0.25 + 1e-9) fail(c, at, 'bin fuera de la banda 0,05–0,25');
          if ((v.predicted as number) < (v.from as number) - 1e-6 || (v.predicted as number) > (v.to as number) + 1e-6) fail(c, at, 'probabilidad media fuera de su bin');
        }),
      ),
    }),
    note: str({ nonEmpty: true }),
  },
  {},
  (v, at, c) => {
    const minOdds = v.minOdds as number;
    const days = (Array.isArray(v.days) ? v.days : []).filter(isObj) as Record<string, unknown>[];
    for (let i = 1; i < days.length; i++) if (!(String(days[i].date) > String(days[i - 1].date))) fail(c, `${at}.days`, 'días repetidos o sin ordenar');
    const track = isObj(v.track) ? v.track : {};
    const records = (Array.isArray(track.byKind) ? track.byKind : []).filter(isObj) as Record<string, unknown>[];
    if (new Set(records.map((r) => r.kind)).size !== records.length) fail(c, `${at}.track.byKind`, 'tipo repetido');
    const excluded = new Set(records.filter((r) => r.excluded !== undefined).map((r) => String(r.kind)));
    days.forEach((d, i) =>
      ((Array.isArray(d.bets) ? d.bets : []).filter(isObj) as Record<string, unknown>[]).forEach((b, j) => {
        const where = `${at}.days[${i}].bets[${j}]`;
        if (typeof b.displayOdds === 'number' && typeof minOdds === 'number' && (b.displayOdds as number) < minOdds - 1e-6) fail(c, where, `cuota ${String(b.displayOdds)} < mínimo ${minOdds}`);
        if (b.result === undefined && excluded.has(String(b.kind))) fail(c, where, `apuesta abierta de un tipo que no se publica (${String(b.kind)})`);
      }),
    );
    for (const r of records) if ((r.bets as number) > 0 && typeof minOdds === 'number' && (r.avgOdds as number) < minOdds - 1e-6) fail(c, `${at}.track.byKind`, `cuota media ${String(r.avgOdds)} < mínimo ${minOdds} (${String(r.kind)})`);
    if (typeof v.note === 'string' && !/18/.test(v.note as string)) fail(c, `${at}.note`, 'la nota debe recordar que es solo para mayores de 18 años');
  },
);

const homeLongshot = obj({ date: str({ pattern: /^\d{4}-\d{2}-\d{2}$/ }), bets: count }, { best: longshotBet }, (v, at, c) => {
  const b = v.best as Record<string, unknown> | undefined;
  if (isObj(b) && b.result !== undefined) fail(c, `${at}.best`, 'apuesta ya resuelta');
  if (isObj(b) && (v.bets as number) < 1) fail(c, at, 'mejor apuesta con 0 apuestas en el día');
});

// ---------------------------------------------------------------------------
// Combinada 6 (combo6.json y HomeFile.combo6)
// ---------------------------------------------------------------------------

const COMBO6_CATEGORY_IDS = ['ganador', 'goles', 'corners', 'tiros-puerta', 'tiros', 'tarjetas', 'faltas', 'jugadores'] as const;
const COMBO6_ODDS_SOURCES = ['casa', 'derivada', 'estimada'] as const;
/** Margen máximo admitido al estimar una cuota (justa / (1 + margen)). */
const COMBO6_MAX_MARGIN = 0.15;
const dayStr = str({ pattern: /^\d{4}-\d{2}-\d{2}$/ });

/**
 * Pata: prob en (0, 1), cuota justa = 1/p, cuota de la casa > 1, estimada ⇔ no es de la casa, una cuota estimada
 * por debajo de la justa (lleva margen) y no más de un 15 % por debajo.
 */
const combo6Leg = obj(
  {
    matchId: safeId,
    compId: str({ nonEmpty: true }),
    compName: str({ nonEmpty: true }),
    kickoff: iso,
    home: teamRef,
    away: teamRef,
    category: str({ oneOf: COMBO6_CATEGORY_IDS }),
    marketId: str({ nonEmpty: true, pattern: /^[A-Za-z0-9_.+-]{1,80}$/ }),
    market: str({ nonEmpty: true }),
    selection: str({ nonEmpty: true }),
    prob: openProb,
    fairOdds: num({ min: 1 }),
    bookOdds: odds,
    bookOddsEstimated: bool,
    oddsSource: str({ oneOf: COMBO6_ODDS_SOURCES }),
  },
  { reason: str({ nonEmpty: true }), result: str({ oneOf: BET_RESULTS }) },
  (v, at, c) => {
    c.compRefs.push({ id: String(v.compId), at: `${at}.compId` });
    const p = v.prob as number;
    if (typeof p === 'number' && p >= 1) fail(c, at, `prob ${p} debe ser < 1`);
    if (typeof p === 'number' && p > 0 && typeof v.fairOdds === 'number' && !relClose(v.fairOdds as number, 1 / p)) fail(c, at, `cuota justa ${String(v.fairOdds)} ≠ 1/prob (${(1 / p).toFixed(3)})`);
    if (typeof v.bookOddsEstimated === 'boolean' && v.bookOddsEstimated !== (v.oddsSource !== 'casa')) fail(c, at, `bookOddsEstimated ${String(v.bookOddsEstimated)} incoherente con oddsSource ${String(v.oddsSource)}`);
    if (v.oddsSource === 'estimada' && typeof v.bookOdds === 'number' && typeof v.fairOdds === 'number') {
      const b = v.bookOdds as number;
      const f = v.fairOdds as number;
      if (b > f * (1 + REL_TOL) || b < f / (1 + COMBO6_MAX_MARGIN) - 1e-3) fail(c, at, `cuota estimada ${b} incoherente con la justa ${f} (margen entre 0 y ${COMBO6_MAX_MARGIN * 100} %)`);
    }
    if (v.category === 'jugadores' && !/^player-/.test(String(v.marketId))) fail(c, at, 'pata de jugadores sin mercado de jugador');
  },
);

/**
 * Combinada: partidos distintos en orden cronológico; prob = producto, cuota justa = 1/prob, cuota de la casa =
 * producto de las patas, patas estimadas y categorías contadas, «1 de cada N», EV = p·cuota − 1, primer y último
 * saque, resultado coherente con las patas (nulas fuera; todas nulas ⇒ nula). La regla (nº de patas, categorías,
 * ventana de cuota y banda de probabilidad) se comprueba con `rule` en el archivo.
 */
const combo6Combo = obj(
  {
    id: str({ nonEmpty: true, pattern: /^[A-Za-z0-9_.+-]{1,300}$/ }),
    date: dayStr,
    scope: str({ nonEmpty: true, pattern: /^[a-z0-9-]{1,40}$/ }),
    label: str({ nonEmpty: true }),
    legs: arr(combo6Leg, { min: 1, max: 20 }),
    prob: openProb,
    fairOdds: num({ min: 1 }),
    bookOdds: odds,
    estimatedLegs: count,
    oneIn: num({ min: 1, int: true }),
    ev: num({ min: -1 }),
    categories: num({ min: 1, int: true }),
    firstKickoff: iso,
    lastKickoff: iso,
  },
  { result: str({ oneOf: BET_RESULTS }) },
  (v, at, c) => {
    const legs = (Array.isArray(v.legs) ? v.legs : []).filter(isObj) as Record<string, unknown>[];
    const p = v.prob as number;
    if (typeof p !== 'number' || !legs.length) return;
    if (v.scope !== 'todas') {
      c.compRefs.push({ id: String(v.scope), at: `${at}.scope` });
      if (legs.some((l) => l.compId !== v.scope)) fail(c, at, `combinada de ${String(v.scope)} con patas de otra competición`);
    }
    if (new Set(legs.map((l) => l.matchId)).size !== legs.length) fail(c, at, 'dos patas del mismo partido');
    const times = legs.map((l) => Date.parse(String(l.kickoff)));
    for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) fail(c, `${at}.legs`, 'patas sin orden cronológico');
    const product = legs.reduce((x, l) => x * (typeof l.prob === 'number' ? (l.prob as number) : NaN), 1);
    if (Number.isFinite(product) && !(Math.abs(p - product) <= 2e-5 || relClose(p, product, 0.002))) fail(c, at, `prob ${p} ≠ producto de las patas (${product.toFixed(6)})`);
    if (p > 0 && typeof v.fairOdds === 'number' && !relClose(v.fairOdds as number, 1 / p)) fail(c, at, `cuota justa ${String(v.fairOdds)} ≠ 1/prob (${(1 / p).toFixed(3)})`);
    if (p > 0 && typeof v.oneIn === 'number' && Math.abs((v.oneIn as number) - 1 / p) > 0.51 + 0.01 / p) fail(c, at, `oneIn ${String(v.oneIn)} ≠ round(1/prob) (${(1 / p).toFixed(2)})`);
    const book = legs.reduce((x, l) => x * (typeof l.bookOdds === 'number' ? (l.bookOdds as number) : NaN), 1);
    if (Number.isFinite(book) && typeof v.bookOdds === 'number' && !relClose(v.bookOdds as number, book, 0.002)) fail(c, at, `bookOdds ${String(v.bookOdds)} ≠ producto de las cuotas de las patas (${book.toFixed(3)})`);
    const est = legs.filter((l) => l.bookOddsEstimated === true).length;
    if (typeof v.estimatedLegs === 'number' && v.estimatedLegs !== est) fail(c, at, `estimatedLegs ${String(v.estimatedLegs)} ≠ patas estimadas (${est})`);
    const cats = new Set(legs.map((l) => l.category)).size;
    if (typeof v.categories === 'number' && v.categories !== cats) fail(c, at, `categories ${String(v.categories)} ≠ categorías distintas (${cats})`);
    if (typeof v.ev === 'number' && typeof v.bookOdds === 'number' && Math.abs((v.ev as number) - (p * (v.bookOdds as number) - 1)) > 0.005) {
      fail(c, at, `EV ${String(v.ev)} incoherente con prob·cuota − 1 (${(p * (v.bookOdds as number) - 1).toFixed(4)})`);
    }
    const iso0 = (t: number) => (Number.isFinite(t) ? t : NaN);
    if (iso0(Date.parse(String(v.firstKickoff))) !== Math.min(...times)) fail(c, at, 'firstKickoff ≠ primer saque de las patas');
    if (iso0(Date.parse(String(v.lastKickoff))) !== Math.max(...times)) fail(c, at, 'lastKickoff ≠ último saque de las patas');
    const noon = Date.parse(`${String(v.date)}T12:00:00Z`);
    for (const t of times) if (Number.isFinite(noon) && Number.isFinite(t) && Math.abs(t - noon) > 38 * 3_600_000) fail(c, at, `pata que no es del día ${String(v.date)}`);
    const rs = legs.map((l) => l.result);
    const expected = rs.includes('miss') ? 'miss' : rs.some((r) => r === undefined) ? undefined : rs.every((r) => r === 'void') ? 'void' : 'hit';
    if (v.result !== expected) fail(c, at, `resultado ${String(v.result)} incoherente con el de las patas (${String(expected)})`);
  },
);

interface Combo6RuleV {
  targetMin: number;
  targetMax: number;
  legMinProb: number;
  legMaxProb: number;
  minLegs: number;
  maxLegs: number;
  minCategories: number;
  maxPerCategory: number;
}

/** La combinada cumple la regla publicada: patas, categorías, tope por categoría, banda de probabilidad y ventana de cuota. */
function checkCombo6Rule(v: Record<string, unknown>, at: string, c: Ctx, r: Combo6RuleV): void {
  const legs = (Array.isArray(v.legs) ? v.legs : []).filter(isObj) as Record<string, unknown>[];
  if (legs.length < r.minLegs || legs.length > r.maxLegs) fail(c, at, `${legs.length} patas (regla: ${r.minLegs}–${r.maxLegs})`);
  const per = new Map<string, number>();
  for (const l of legs) per.set(String(l.category), (per.get(String(l.category)) ?? 0) + 1);
  if (per.size < r.minCategories) fail(c, at, `${per.size} categorías (regla: al menos ${r.minCategories})`);
  for (const [k, n] of per) if (n > r.maxPerCategory) fail(c, at, `${n} patas de ${k} (regla: como mucho ${r.maxPerCategory})`);
  legs.forEach((l, i) => {
    const p = l.prob as number;
    if (typeof p === 'number' && (p < r.legMinProb - 1e-4 || p > r.legMaxProb + 1e-4)) fail(c, `${at}.legs[${i}]`, `prob ${p} fuera de la banda ${r.legMinProb}–${r.legMaxProb}`);
  });
  const b = v.bookOdds as number;
  if (typeof b === 'number' && (b < r.targetMin * (1 - 0.003) || b > r.targetMax * (1 + 0.003))) fail(c, at, `cuota ${b} fuera de la ventana ${r.targetMin}–${r.targetMax}`);
}

const combo6Day = obj(
  {
    date: dayStr,
    byCompetition: arr(combo6Combo, { max: 10 }),
    counts: obj({ matches: count, eligibleMatches: count, candidateLegs: count }),
  },
  { main: combo6Combo, reason: str({ nonEmpty: true }) },
  (v, at, c) => {
    if (v.main === undefined && v.reason === undefined) fail(c, at, 'día sin combinada y sin motivo');
    if (v.main !== undefined && v.reason !== undefined) fail(c, at, 'día con combinada y con motivo');
    const main = isObj(v.main) ? v.main : undefined;
    if (main && main.scope !== 'todas') fail(c, `${at}.main`, `ámbito ${String(main.scope)} (debe ser «todas»)`);
    const all = [...(main ? [main] : []), ...((Array.isArray(v.byCompetition) ? v.byCompetition : []).filter(isObj) as Record<string, unknown>[])];
    for (const x of all) if (x.date !== v.date) fail(c, at, `combinada del día ${String(x.date)} en el día ${String(v.date)}`);
    const scopes = ((Array.isArray(v.byCompetition) ? v.byCompetition : []).filter(isObj) as Record<string, unknown>[]).map((x) => x.scope);
    if (scopes.includes('todas')) fail(c, `${at}.byCompetition`, 'combinada «todas» entre las de competición');
    if (new Set(scopes).size !== scopes.length) fail(c, `${at}.byCompetition`, 'competición repetida');
    const k = isObj(v.counts) ? v.counts : {};
    if (typeof k.eligibleMatches === 'number' && typeof k.matches === 'number' && (k.eligibleMatches as number) > (k.matches as number)) fail(c, `${at}.counts`, 'más partidos con patas que partidos');
    if (typeof k.eligibleMatches === 'number' && typeof k.candidateLegs === 'number' && (k.candidateLegs as number) < (k.eligibleMatches as number)) fail(c, `${at}.counts`, 'menos patas candidatas que partidos con patas');
    if (main && typeof k.eligibleMatches === 'number' && Array.isArray(main.legs) && main.legs.length > (k.eligibleMatches as number)) fail(c, `${at}.counts`, 'combinada con más patas que partidos con patas');
  },
);

const combo6CategoryRecord = obj(
  { category: str({ oneOf: COMBO6_CATEGORY_IDS }), label: str({ nonEmpty: true }), legs: count, hits: count, hitRate: prob, expectedHitRate: prob },
  { voids: count },
  (v, at, c) => checkRate(v, at, c, 'legs'),
);

const combo6History = obj(
  {
    from: str(),
    to: str(),
    days: count,
    combos: count,
    settled: count,
    hits: count,
    hitRate: prob,
    expectedHitRate: prob,
    avgLegs: nonNeg,
    avgBookOdds: nonNeg,
    avgFairOdds: nonNeg,
    longestLosingStreak: count,
    byCategory: arr(combo6CategoryRecord, { max: COMBO6_CATEGORY_IDS.length }),
    recent: arr(combo6Combo, { max: 14 }),
  },
  { voids: count, wilsonLow: prob, wilsonHigh: prob, warning: str({ nonEmpty: true }) },
  (v, at, c) => {
    checkRate(v, at, c, 'settled');
    const settled = v.settled as number;
    const voids = (v.voids as number | undefined) ?? 0;
    if (typeof v.combos === 'number' && settled + voids > (v.combos as number)) fail(c, at, `resueltas ${settled} + nulas ${voids} > combinadas ${String(v.combos)}`);
    if (typeof v.days === 'number' && typeof v.combos === 'number' && (v.combos as number) > (v.days as number)) fail(c, at, `combinadas ${String(v.combos)} > días ${String(v.days)}`);
    if (typeof v.longestLosingStreak === 'number' && (v.longestLosingStreak as number) > settled) fail(c, at, `racha ${String(v.longestLosingStreak)} > resueltas ${settled}`);
    if (typeof v.combos === 'number' && (v.combos as number) > 0 && (v.avgBookOdds as number) < 1) fail(c, at, `cuota media ${String(v.avgBookOdds)} con combinadas`);
    if (settled > 0 && (v.wilsonLow === undefined || v.wilsonHigh === undefined)) fail(c, at, 'falta el intervalo de Wilson');
    const recent = (Array.isArray(v.recent) ? v.recent : []).filter(isObj) as Record<string, unknown>[];
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].result === undefined) fail(c, `${at}.recent[${i}]`, 'combinada del historial sin resolver');
      if (i > 0 && !(String(recent[i].date) < String(recent[i - 1].date))) fail(c, `${at}.recent`, 'no está ordenado del más reciente al más antiguo');
    }
    if (recent.length > settled + voids) fail(c, `${at}.recent`, 'más combinadas recientes que resueltas');
  },
);

const combo6RuleCheck = obj(
  {
    targetMin: num({ gt: 1 }),
    targetMax: num({ gt: 1 }),
    legMinProb: openProb,
    legMaxProb: openProb,
    minLegs: num({ min: 2, int: true }),
    maxLegs: num({ min: 2, max: 20, int: true }),
    minCategories: num({ min: 1, int: true }),
    maxPerCategory: num({ min: 1, int: true }),
    margins: record(num({ min: 0, max: COMBO6_MAX_MARGIN })),
  },
  {},
  (v, at, c) => {
    if ((v.targetMax as number) < (v.targetMin as number)) fail(c, at, 'targetMax < targetMin');
    if ((v.legMaxProb as number) < (v.legMinProb as number)) fail(c, at, 'legMaxProb < legMinProb');
    if ((v.maxLegs as number) < (v.minLegs as number)) fail(c, at, 'maxLegs < minLegs');
    if (isObj(v.margins)) for (const k of Object.keys(v.margins)) if (!(COMBO6_CATEGORY_IDS as readonly string[]).includes(k)) fail(c, `${at}.margins`, `categoría desconocida ${k}`);
  },
);

const combo6File = obj(
  { generatedAt: iso, rule: combo6RuleCheck, days: arr(combo6Day, { max: 4 }), history: combo6History, note: str({ nonEmpty: true }) },
  {},
  (v, at, c) => {
    const rule = isObj(v.rule) ? (v.rule as unknown as Combo6RuleV) : undefined;
    const days = (Array.isArray(v.days) ? v.days : []).filter(isObj) as Record<string, unknown>[];
    for (let i = 1; i < days.length; i++) if (!(String(days[i].date) > String(days[i - 1].date))) fail(c, `${at}.days`, 'días repetidos o sin ordenar');
    const h = isObj(v.history) ? v.history : {};
    const combos: [Record<string, unknown>, string][] = [];
    days.forEach((d, i) => {
      if (isObj(d.main)) combos.push([d.main, `${at}.days[${i}].main`]);
      ((Array.isArray(d.byCompetition) ? d.byCompetition : []).filter(isObj) as Record<string, unknown>[]).forEach((x, j) => combos.push([x, `${at}.days[${i}].byCompetition[${j}]`]));
    });
    ((Array.isArray(h.recent) ? h.recent : []).filter(isObj) as Record<string, unknown>[]).forEach((x, j) => combos.push([x, `${at}.history.recent[${j}]`]));
    if (rule && typeof rule.targetMin === 'number') for (const [x, where] of combos) checkCombo6Rule(x, where, c, rule);
    const ids = combos.map(([x]) => x.id);
    if (new Set(ids).size !== ids.length) fail(c, at, 'combinada repetida (id)');
    if (typeof v.note === 'string') {
      if (!/18/.test(v.note as string)) fail(c, `${at}.note`, 'la nota debe recordar que es solo para mayores de 18 años');
      if (!/estimad/i.test(v.note as string)) fail(c, `${at}.note`, 'la nota debe avisar de que las cuotas son estimadas');
    }
  },
);

const homeCombo6 = obj({ date: dayStr, combo: combo6Combo }, {}, (v, at, c) => {
  const b = isObj(v.combo) ? v.combo : undefined;
  if (b && b.result !== undefined) fail(c, `${at}.combo`, 'combinada ya resuelta');
  if (b && b.date !== v.date) fail(c, `${at}.combo`, `combinada del día ${String(b.date)} anunciada para ${String(v.date)}`);
  if (b && b.scope !== 'todas') fail(c, `${at}.combo`, 'la portada anuncia la combinada del día (ámbito «todas»)');
});

const homeFile = obj(
  {
    generatedAt: iso,
    popular: arr(matchSummary, { max: 24 }),
    today: arr(matchSummary),
    tomorrow: arr(matchSummary),
    recent: arr(matchSummary),
    topValue: arr(valueEntry, { max: 12 }),
    hotPlayers: arr(playerSeasonRow, { max: 12 }),
    highlights: arr(str({ nonEmpty: true })),
  },
  {
    modelHeadline: obj({ matches: count, accuracy: prob, rps: num({ min: 0, max: 1 }) }, { marketRps: num({ min: 0, max: 1 }) }),
    topConfidence: (v, at, c) => {
      arr(confidenceEntry(false), { max: 8 })(v, at, c);
      if (Array.isArray(v) && new Set(v.map((x) => (isObj(x) && isObj(x.match) ? x.match.id : undefined))).size !== v.length) {
        fail(c, at, 'más de un pick del mismo partido');
      }
    },
    daily: homeDaily,
    longshot: homeLongshot,
    combo6: homeCombo6,
    confidenceHeadline: obj(
      { hitRate: prob, picks: num({ min: 1, int: true }), hits: count, from: iso, to: iso },
      { upcoming: count, wilsonLow: prob, wilsonHigh: prob, baselineRate: prob, avgFairOdds: num({ min: 1 }) },
      (v, at, c) => checkRate(v, at, c, 'picks'),
    ),
  },
);

const playersFile = obj({ generatedAt: iso, players: arr(playerSeasonRow, { max: 600 }) });

const valueFile = obj(
  { generatedAt: iso, bets: arr(valueEntry), minEv: num(), kellyFraction: num({ min: 0, max: 1 }) },
  { kellyCap: num({ min: 0, max: 1 }), minProb: prob, maxOdds: odds },
  (v, at, c) => {
  const bets = v.bets as { pick: { ev: number } }[];
  for (let i = 1; i < bets.length; i++) if (bets[i].pick.ev > bets[i - 1].pick.ev + 1e-9) {
    fail(c, `${at}.bets`, 'no está ordenado por EV');
    break;
  }
  },
);

const modelFile = obj({
  generatedAt: iso,
  sections: arr(obj({ title: str({ nonEmpty: true }), body: arr(str({ nonEmpty: true }), { min: 1 }) }), { min: 1 }),
  backtest: backtestSummary,
  perCompetition: arr(obj({ compId: str({ nonEmpty: true }), compName: str({ nonEmpty: true }), backtest: backtestSummary })),
  parameters: record(anyOf(num(), str())),
});

// ---------------------------------------------------------------------------
// Validación de un directorio
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  files: number;
  bytes: number;
  /** resumen de los indicadores de cordura (siempre calculado, aunque no se exijan) */
  sanity: { competitionsWithData: number; matchesAnalyzed: number; homeMatches: number; upcomingMatches: number };
}

/** Umbrales de cordura: por debajo de ellos los datos se consideran degenerados y NO se publican. */
export interface SanityThresholds {
  /** competiciones con datos (partidos terminados o próximos, resultados o clasificación) */
  minCompetitionsWithData: number;
  /** meta.counts.matchesAnalyzed mínimo */
  minMatchesAnalyzed: number;
  /** la portada debe tener al menos un partido (populares, hoy, mañana o recientes) o haber partidos próximos */
  requireHomeMatches: boolean;
  /** tamaño total máximo de los JSON (GitHub Pages admite 1 GB por sitio) */
  maxTotalBytes: number;
  /**
   * antigüedad máxima (horas) de la última descarga correcta de ESPN (meta.dataUpdatedAt) respecto al build. Si ESPN
   * lleva días caído no se publican datos viejos como nuevos: la web conserva la versión anterior (su indicador de
   * frescura se vuelve ámbar) y el workflow falla en rojo. Infinity = sin límite (--allow-stale).
   */
  maxDataAgeHours: number;
}

/** Umbrales de producción (28 competiciones configuradas; ~14.000 partidos analizados en noviembre de 2026). */
export const DEFAULT_SANITY: SanityThresholds = {
  minCompetitionsWithData: 15,
  minMatchesAnalyzed: 2000,
  requireHomeMatches: true,
  maxTotalBytes: 300 * 1024 * 1024,
  maxDataAgeHours: 72,
};

/** Un partido "en juego" más de esto después del saque es una foto vieja (la pasada que debía cerrarlo falló). */
const STALE_LIVE_HOURS = 12;

export interface ValidateOptions {
  /** umbrales de cordura; false = solo contrato (tests con mundos sintéticos pequeños, --no-sanity) */
  sanity?: Partial<SanityThresholds> | false;
  /**
   * salida parcial (build con --only): los compId de partidos de otras competiciones (forma, H2H, jugadores) pueden
   * no estar publicados, así que no se exige que existan en meta.json
   */
  partial?: boolean;
}

const ROOT_FILES = new Set(['meta.json', 'home.json', 'players.json', 'value.json', 'model.json', 'confidence.json', 'daily.json', 'longshots.json', 'combo6.json']);
const SUB_DIRS = new Set(['competitions', 'matches', 'teams']);
const SAFE_FILE = /^[A-Za-z0-9_-]{1,40}\.json$/;

/** Estructura del directorio: solo los archivos raíz y JSON con nombre seguro en competitions/, matches/ y teams/. */
function checkLayout(dir: string, errors: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push(`${dir}: no se puede leer el directorio (${(e as Error).message})`);
    return;
  }
  const unexpected: string[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) unexpected.push(`${e.name} (enlace simbólico)`);
    else if (e.isDirectory()) {
      if (!SUB_DIRS.has(e.name)) unexpected.push(`${e.name}/`);
      else
        for (const f of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) {
          if (!f.isFile() || !SAFE_FILE.test(f.name)) unexpected.push(`${e.name}/${f.name}`);
        }
    } else if (!ROOT_FILES.has(e.name)) unexpected.push(e.name);
  }
  for (const u of unexpected.slice(0, 20)) errors.push(`archivo inesperado en la salida: ${u}`);
  if (unexpected.length > 20) errors.push(`… y ${unexpected.length - 20} archivos inesperados más`);
}

function readJson(dir: string, rel: string, c: Ctx): unknown {
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) {
    c.errors.push(`${rel}: archivo ausente`);
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    c.errors.push(`${rel}: JSON inválido (${(e as Error).message})`);
    return undefined;
  }
}

function listJson(dir: string, sub: string): string[] {
  const d = path.join(dir, sub);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => `${sub}/${f}`);
}

/** Valida todos los JSON de `dir` (por defecto public/data) contra el contrato y, salvo `sanity: false`, la cordura. */
export function validateDataDir(dir: string = OUTPUT_DIR, opts: ValidateOptions = {}): ValidationResult {
  const c: Ctx = { file: '', errors: [], detailRefs: [], compRefs: [] };
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) {
    c.errors.push(`${dir}: el directorio no existe`);
    return { ok: false, errors: c.errors, files, bytes, sanity: { competitionsWithData: 0, matchesAnalyzed: 0, homeMatches: 0, upcomingMatches: 0 } };
  }
  checkLayout(dir, c.errors);
  const check = (rel: string, schema: Check): unknown => {
    c.file = rel;
    const v = readJson(dir, rel, c);
    if (v === undefined) return undefined;
    files++;
    bytes += fs.statSync(path.join(dir, rel)).size;
    noNulls(v, '$', c);
    schema(v, '$', c);
    return v;
  };

  const meta = check('meta.json', metaFile) as
    | {
        generatedAt?: string;
        dataUpdatedAt?: string;
        competitions?: { id: string }[];
        teams?: { id: string; compId: string }[];
        counts?: { matchesAnalyzed?: number; upcomingMatches?: number };
      }
    | undefined;
  const compIds = new Set((meta?.competitions ?? []).map((x) => x.id));
  const home = check('home.json', homeFile) as Record<string, unknown[] | undefined> | undefined;
  check('players.json', playersFile);
  check('value.json', valueFile);
  check('model.json', modelFile);
  check('confidence.json', confidenceFile);
  check('daily.json', dailyFile);
  const longshots = check('longshots.json', longshotFile) as { days?: { date?: string; bets?: { id?: string }[] }[] } | undefined;
  // portada ↔ longshots.json: la mejor apuesta es una de las del día que anuncia, con el mismo nº de apuestas
  const hl = (home as Record<string, unknown> | undefined)?.longshot as { date?: string; bets?: number; best?: { id?: string } } | undefined;
  if (hl && longshots) {
    const d = (longshots.days ?? []).find((x) => x?.date === hl.date);
    if (!d) c.errors.push(`home.json: longshot.date ${String(hl.date)} ausente de longshots.json`);
    else {
      if ((d.bets ?? []).length !== hl.bets) c.errors.push(`home.json: longshot.bets ${String(hl.bets)} ≠ apuestas del día en longshots.json (${(d.bets ?? []).length})`);
      if (hl.best && !(d.bets ?? []).some((b) => b?.id === hl.best!.id)) c.errors.push(`home.json: longshot.best (${String(hl.best.id)}) no está entre las apuestas del día en longshots.json`);
    }
  }

  const combo6 = check('combo6.json', combo6File) as { days?: { date?: string; main?: { id?: string } }[] } | undefined;
  // portada ↔ combo6.json: la combinada anunciada es la del día que dice
  const hc = (home as Record<string, unknown> | undefined)?.combo6 as { date?: string; combo?: { id?: string } } | undefined;
  if (hc && combo6) {
    const d = (combo6.days ?? []).find((x) => x?.date === hc.date);
    if (!d) c.errors.push(`home.json: combo6.date ${String(hc.date)} ausente de combo6.json`);
    else if (d.main?.id !== hc.combo?.id) c.errors.push(`home.json: combo6.combo (${String(hc.combo?.id)}) no es la combinada del día en combo6.json`);
  }

  const compFiles = listJson(dir, 'competitions');
  for (const id of compIds) if (!compFiles.includes(`competitions/${id}.json`)) c.errors.push(`meta.json: falta competitions/${id}.json`);
  let competitionsWithData = 0;
  for (const rel of compFiles) {
    const v = check(rel, competitionFile) as
      | {
          meta?: { id: string; finishedCount?: number; upcomingCount?: number; nextMatchDate?: string };
          results?: unknown[];
          upcoming?: unknown[];
          ratings?: unknown[];
          standings?: { rows?: unknown[] }[];
        }
      | undefined;
    // "con datos": partidos de la temporada (jugados, próximos o programados más adelante), clasificación o equipos.
    // Incluye el parón de verano (calendario nuevo publicado, aún sin partidos en 14 días).
    if (
      v &&
      ((v.meta?.finishedCount ?? 0) > 0 ||
        (v.meta?.upcomingCount ?? 0) > 0 ||
        !!v.meta?.nextMatchDate ||
        (v.results?.length ?? 0) > 0 ||
        (v.upcoming?.length ?? 0) > 0 ||
        (v.ratings?.length ?? 0) > 0 ||
        (v.standings ?? []).some((g) => (g?.rows?.length ?? 0) > 0))
    )
      competitionsWithData++;
    const id = path.basename(rel, '.json');
    if (v?.meta && v.meta.id !== id) c.errors.push(`${rel}: meta.id "${v.meta.id}" no coincide con el nombre del archivo`);
    if (!compIds.has(id)) c.errors.push(`${rel}: competición ausente en meta.json`);
  }

  const matchFiles = listJson(dir, 'matches');
  const matchIds = new Set(matchFiles.map((f) => path.basename(f, '.json')));
  for (const rel of matchFiles) {
    const v = check(rel, matchFile) as { match?: { id: string } } | undefined;
    if (v?.match && v.match.id !== path.basename(rel, '.json')) c.errors.push(`${rel}: match.id no coincide con el nombre del archivo`);
  }

  const teamFiles = listJson(dir, 'teams');
  const teamIds = new Set(teamFiles.map((f) => path.basename(f, '.json')));
  for (const rel of teamFiles) {
    const v = check(rel, teamFile) as { team?: { id: string } } | undefined;
    if (v?.team && v.team.id !== path.basename(rel, '.json')) c.errors.push(`${rel}: team.id no coincide con el nombre del archivo`);
  }
  for (const t of meta?.teams ?? []) {
    if (!teamIds.has(t.id)) c.errors.push(`meta.json: el índice de equipos referencia teams/${t.id}.json, que no existe`);
    if (!compIds.has(t.compId)) c.errors.push(`meta.json: equipo ${t.id} con compId desconocido "${t.compId}"`);
  }

  // referencias cruzadas
  const missingDetail = new Map<string, string>();
  for (const r of c.detailRefs) if (!matchIds.has(r.id) && !missingDetail.has(r.id)) missingDetail.set(r.id, r.at);
  for (const [id, at] of [...missingDetail].slice(0, 30)) c.errors.push(`hasDetail=true sin matches/${id}.json (${at})`);
  if (missingDetail.size > 30) c.errors.push(`… y ${missingDetail.size - 30} referencias hasDetail más sin archivo`);
  const badComp = new Map<string, string>();
  if (!opts.partial) for (const r of c.compRefs) if (!compIds.has(r.id) && !badComp.has(r.id)) badComp.set(r.id, r.at);
  for (const [id, at] of badComp) c.errors.push(`compId desconocido "${id}" (${at})`);

  // umbrales de cordura (datos degenerados: ESPN devolvió casi nada, almacén vacío o recortado, build roto...)
  const homeMatches = ['popular', 'today', 'tomorrow', 'recent'].reduce((n, k) => n + (Array.isArray(home?.[k]) ? home![k]!.length : 0), 0);
  const sanity = {
    competitionsWithData,
    matchesAnalyzed: meta?.counts?.matchesAnalyzed ?? 0,
    homeMatches,
    upcomingMatches: meta?.counts?.upcomingMatches ?? 0,
  };
  if (opts.sanity !== false) {
    const t: SanityThresholds = { ...DEFAULT_SANITY, ...(opts.sanity ?? {}) };
    if (sanity.competitionsWithData < t.minCompetitionsWithData) {
      c.errors.push(`cordura: solo ${sanity.competitionsWithData} competiciones con datos (mínimo ${t.minCompetitionsWithData}): ¿falló la descarga o el almacén está incompleto?`);
    }
    if (sanity.matchesAnalyzed < t.minMatchesAnalyzed) {
      c.errors.push(`cordura: meta.counts.matchesAnalyzed = ${sanity.matchesAnalyzed} (mínimo ${t.minMatchesAnalyzed}): demasiado pocos partidos para publicar modelos fiables`);
    }
    if (t.requireHomeMatches && sanity.homeMatches === 0 && sanity.upcomingMatches === 0) {
      c.errors.push('cordura: home.json no tiene ningún partido próximo ni reciente y no hay partidos próximos en ninguna competición: datos degenerados o desactualizados');
    }
    if (bytes > t.maxTotalBytes) {
      c.errors.push(`cordura: los JSON ocupan ${(bytes / 1048576).toFixed(1)} MB (máximo ${(t.maxTotalBytes / 1048576).toFixed(0)} MB)`);
    }
    // frescura real: la última descarga correcta de ESPN no puede ser de hace días
    const built = Date.parse(meta?.generatedAt ?? '');
    const dataAt = Date.parse(meta?.dataUpdatedAt ?? '');
    if (Number.isFinite(built) && Number.isFinite(dataAt) && Number.isFinite(t.maxDataAgeHours)) {
      const ageH = (built - dataAt) / 3_600_000;
      if (ageH > t.maxDataAgeHours) {
        c.errors.push(
          `cordura: la última descarga correcta de ESPN es de hace ${ageH.toFixed(0)} h (meta.dataUpdatedAt ${meta?.dataUpdatedAt}; máximo ${t.maxDataAgeHours} h): no se publican datos viejos como nuevos (usa --allow-stale para forzarlo)`,
        );
      }
    }
    // estados incoherentes con la fecha del build: "en juego" de hace horas o "terminado" en el futuro
    if (Number.isFinite(built)) {
      const bad = (c.statusRefs ?? []).filter((r) => {
        const d = Date.parse(r.date);
        return r.status === 'live' ? d < built - STALE_LIVE_HOURS * 3_600_000 : d > built + 3_600_000;
      });
      for (const r of bad.slice(0, 10)) c.errors.push(`cordura: ${r.at}: partido "${r.status === 'live' ? 'en juego' : 'terminado'}" con fecha ${r.date} incoherente con generatedAt`);
      if (bad.length > 10) c.errors.push(`cordura: … y ${bad.length - 10} partidos más con estado incoherente con la fecha`);
    }
  }

  return { ok: c.errors.length === 0, errors: c.errors, files, bytes, sanity };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(args: string[]): number {
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--no-sanity' && a !== '--allow-stale');
  if (unknown.length) {
    console.error(`Argumentos desconocidos: ${unknown.join(' ')} (uso: validate-data.ts [dir] [--no-sanity] [--allow-stale])`);
    return 2;
  }
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? OUTPUT_DIR);
  const t0 = performance.now();
  const r = validateDataDir(dir, {
    sanity: args.includes('--no-sanity') ? false : args.includes('--allow-stale') ? { maxDataAgeHours: Infinity } : undefined,
  });
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const mb = (r.bytes / 1024 / 1024).toFixed(2);
  const s = r.sanity;
  const sanityLine = `${s.competitionsWithData} competiciones con datos, ${s.matchesAnalyzed} partidos analizados, ${s.homeMatches} partidos en portada, ${s.upcomingMatches} próximos`;
  if (r.ok) {
    console.log(`✓ Datos válidos: ${r.files} archivos (${mb} MB) en ${path.relative(process.cwd(), dir) || dir} · ${secs} s`);
    console.log(`  ${sanityLine}`);
    return 0;
  }
  console.error(`✗ ${r.errors.length} errores en ${r.files} archivos (${mb} MB) — NO publicar estos datos:`);
  for (const e of r.errors.slice(0, 200)) console.error(`  - ${e}`);
  if (r.errors.length > 200) console.error(`  … ${r.errors.length - 200} errores más`);
  console.error(`  (${sanityLine})`);
  return 1;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) process.exitCode = main(process.argv.slice(2));
