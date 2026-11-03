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
 * logos solo https en *.espncdn.com y ningún texto con `<script` ni `javascript:`.
 * Umbrales de cordura (desactivables con --no-sanity): suficientes competiciones con datos, partidos analizados,
 * algún partido próximo o reciente en la portada y tamaño total razonable — para no publicar datos degenerados.
 * Sale con código 1 si hay errores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL, OUTPUT_DIR } from '../pipeline/config';
import { poissonCdf } from '../src/lib/models';

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
  { expCorners: nonNeg, expCards: nonNeg, market: prob1x2, pick: valuePick },
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
    // matriz truncada (0..maxGoals): falta la cola de goleadas ⇒ suma ≈ P(X <= n)·P(Y <= n) con X, Y ~ Poisson(λ)
    const n = Array.isArray(v.scoreMatrix) ? v.scoreMatrix.length - 1 : -1;
    const s = c.matrixSum;
    c.matrixSum = undefined;
    if (s === undefined || n < 0 || typeof v.lambdaHome !== 'number' || typeof v.lambdaAway !== 'number') return;
    const expected = poissonCdf(n, v.lambdaHome) * poissonCdf(n, v.lambdaAway);
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
  },
  (v, at, c) => {
    const m = v.match as Record<string, unknown> | undefined;
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
  { modelHeadline: obj({ matches: count, accuracy: prob, rps: num({ min: 0, max: 1 }) }, { marketRps: num({ min: 0, max: 1 }) }) },
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

const ROOT_FILES = new Set(['meta.json', 'home.json', 'players.json', 'value.json', 'model.json']);
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
