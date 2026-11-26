/**
 * Banco de pruebas de modelos: evalúa variantes (pipeline/experiments/<nombre>.ts) frente a la línea base ("baseline":
 * la versión de producción ANTERIOR al 22-nov-2026) con predicciones walk-forward SIN fuga de todos los partidos
 * terminados de la temporada actual. "production" es la producción actual (variante vacía).
 *
 *   npx tsx scripts/eval-model.ts --variant=<nombre>[,<nombre>…] [--window=tuning|T1|T2|pre|prev|pooled] [--final]
 *                                 [--no-leak-check] [--no-cache]
 *
 *   --variant        variantes a evaluar (archivos de pipeline/experiments; 'production' = producción actual,
 *                    'baseline' = producción anterior)
 *   --window         ventana del informe: tuning (2026-06-01 → 2026-09-15, por defecto), T1 (06-01 → 07-31) o
 *                    T2 (08-01 → 09-15). Una mejora debe aparecer en T1 Y en T2. Auxiliar: pre (2026-01-01 →
 *                    05-31, anterior al ajuste; casi todo sin cuotas: para ideas del segmento sin cuotas).
 *                    Confirmatoria: prev (partidos de temporadas PASADAS del 2026-01-01 al 05-31: ligas europeas
 *                    2025-26, eliminatorias UEFA, copas…; regla de decisión pre-registrada en el README) y pooled
 *                    (tuning + prev juntas).
 *   --final          HOLDOUT (2026-09-16 en adelante). Solo el agente de combinación, UNA vez. Cada ejecución queda
 *                    registrada en .cache/holdout-looks.log. Sin --final el holdout no se muestra nunca.
 *   --no-leak-check  omite la comprobación de fuga (envenenamiento del futuro); no lo uses para decidir nada
 *   --no-cache       recalcula la línea base aunque esté en caché
 *
 * Métricas (ventana pedida): 1X2 RPS/log-loss/Brier/acierto; más/menos 2,5 y ambos marcan Brier/log-loss/acierto;
 * deviance Poisson de los goles de cada equipo; córners (Brier de 8,5/9,5/10,5, MAE del total, log-verosimilitud del
 * total exacto), tarjetas (3,5/4,5), faltas (20,5/22,5/24,5), tiros (22,5/24,5/26,5) y tiros a puerta (7,5/8,5/9,5);
 * por equipo: goles más de 0,5/1,5 (Poisson de los λ finales), tarjetas 1,5/2,5 y córners 3,5/4,5/5,5; props de
 * jugadores (goleador, >= 1 tiro a puerta, >= 2 tiros, tarjeta: Brier y log-loss de los pares partido-jugador que
 * publican la base y la variante; quien no jugó cuenta como 0); segmentos (con/sin cuotas, ligas/copas/continentales,
 * top/resto, árbitro conocido, vuelta de eliminatoria, final de liga, falta un habitual) con las métricas principales;
 * diferencia con la base e intervalo bootstrap por día (1.000 réplicas). Resultado a 90 minutos (prórrogas
 * reconstruidas con los eventos de gol; estadísticas y props de partidos con prórroga excluidas; 0 tarjetas = dato
 * ausente).
 *
 * Salida: informe en consola y JSON en .cache/eval/<variante>-<ventana>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { COMPETITIONS, ROOT_DIR } from '../pipeline/config';
import { loadAllStores } from '../pipeline/store';
import {
  CACHE_DIR,
  CARD_LINES,
  CORNER_LINES,
  FOUL_LINES,
  SHOT_LINES,
  SOT_LINES,
  TEAM_CARD_LINES,
  TEAM_CORNER_LINES,
  TEAM_GOAL_LINES,
  WINDOWS,
  busiestDay,
  compare,
  dataNow,
  leakCheck,
  matchInfos,
  runBaseline,
  runVariant,
  storeFingerprint,
  type DiffCI,
  type EvalData,
  type EvalReport,
  type Metrics,
  type WindowName,
} from '../pipeline/experiments/bench';
import { loadVariant } from '../pipeline/experiments/load';
import type { ModelVariant } from '../pipeline/experiments/types';

export const HOLDOUT_LOG = path.join(ROOT_DIR, '.cache', 'holdout-looks.log');

function argValue(args: string[], name: string): string | undefined {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const i = a.indexOf('=');
  return i >= 0 ? a.slice(i + 1) : '';
}

// ---------------------------------------------------------------------------
// Formato (español)
// ---------------------------------------------------------------------------

const num = (x: number | undefined, d = 4) => (x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d).replace('.', ','));
const signed = (x: number | undefined, d = 4) => (x === undefined || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d).replace('.', ',')}`);
const pct = (x: number | undefined, d = 1) => (x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d).replace('.', ',')} %`);
const pp = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} pp`);
const int = (n: number) => n.toLocaleString('es-ES');
const ciTxt = (c: DiffCI | undefined, d = 4) => (c && Number.isFinite(c.lo) ? `[${signed(c.lo, d)}; ${signed(c.hi, d)}]  P(mejora) ${pct(c.pBetter, 0)}` : '');

function line(label: string, b: number | undefined, v: number | undefined, opts: { d?: number; ci?: DiffCI; percent?: boolean } = {}): string {
  const d = opts.d ?? 4;
  const fb = opts.percent ? pct(b) : num(b, d);
  const fv = opts.percent ? pct(v) : num(v, d);
  // Δ e intervalo con un decimal más: las mejoras reales de RPS son del orden de 1e-4
  const delta = b !== undefined && v !== undefined ? (opts.percent ? pp(v - b) : signed(v - b, d + 1)) : '—';
  return `  ${label.padEnd(30)} ${fb.padStart(10)} ${fv.padStart(10)} ${delta.padStart(10)}   ${ciTxt(opts.ci, d + 1)}`;
}

function teamBlock(title: string, lines: number[], b: Metrics['teamGoals'], v: Metrics['teamGoals'], ci: DiffCI | undefined): string[] {
  if (!b || !v) return [`${title}: sin datos en la ventana`];
  const out = [`${title} (n = ${int(v.n)} partidos, local y visitante)`];
  lines.forEach((l, i) => out.push(line(`Brier más de ${String(l).replace('.', ',')}`, b.brier[i], v.brier[i])));
  out.push(line('Brier medio de las líneas', b.brierMean, v.brierMean, { ci }));
  return out;
}

function statBlock(title: string, lines: number[], b: Metrics['corners'], v: Metrics['corners'], ci: DiffCI | undefined): string[] {
  if (!b || !v) return [`${title}: sin datos en la ventana`];
  const out = [`${title} (n = ${int(v.n)})`];
  lines.forEach((l, i) => out.push(line(`Brier más de ${String(l).replace('.', ',')}`, b.brier[i], v.brier[i])));
  out.push(line('Brier medio de las líneas', b.brierMean, v.brierMean, { ci }));
  out.push(line('MAE del total', b.mae, v.mae, { d: 3 }));
  out.push(line('Log-verosim. neg. del total', b.nll, v.nll, { d: 4 }));
  return out;
}

export function formatReport(r: EvalReport): string {
  const w = WINDOWS[r.window];
  const b = r.baseline;
  const v = r.model;
  const out: string[] = [];
  out.push('');
  out.push(`=== Variante «${r.variant}» — ${r.description}`);
  out.push(
    `Ventana: ${w.label} ${r.from} → ${r.window === 'holdout' ? 'final de los datos' : r.to} · ${int(r.n)} partidos en ${int(r.days)} días` +
      (r.missing ? ` · ${int(r.missing)} sin predicción de la variante (excluidos)` : ''),
  );
  out.push(`Datos ${r.data.fingerprint} (referencia ${r.data.now.slice(0, 16)}Z) · resultado a 90'`);
  out.push(`  ${''.padEnd(30)} ${'base'.padStart(10)} ${'variante'.padStart(10)} ${'Δ'.padStart(10)}   IC 95 % bootstrap por día de Δ`);
  out.push(`1X2 (n = ${int(v.n)})`);
  out.push(line('RPS', b.x12.rps, v.x12.rps, { ci: r.ci.rps }));
  out.push(line('Log-loss', b.x12.logLoss, v.x12.logLoss, { ci: r.ci.logLoss }));
  out.push(line('Brier', b.x12.brier, v.x12.brier, { ci: r.ci.brier }));
  out.push(line('Acierto', b.x12.accuracy, v.x12.accuracy, { percent: true }));
  out.push('Más/menos 2,5');
  out.push(line('Brier', b.ou25.brier, v.ou25.brier, { ci: r.ci.ouBrier }));
  out.push(line('Log-loss', b.ou25.logLoss, v.ou25.logLoss));
  out.push(line('Acierto', b.ou25.accuracy, v.ou25.accuracy, { percent: true }));
  out.push('Ambos marcan');
  out.push(line('Brier', b.btts.brier, v.btts.brier, { ci: r.ci.bttsBrier }));
  out.push(line('Log-loss', b.btts.logLoss, v.btts.logLoss));
  out.push(line('Acierto', b.btts.accuracy, v.btts.accuracy, { percent: true }));
  out.push('Goles por equipo');
  out.push(line('Deviance Poisson', b.goalsDeviance, v.goalsDeviance, { ci: r.ci.deviance }));
  out.push(...teamBlock('Goles por equipo (Poisson de los λ finales)', TEAM_GOAL_LINES, b.teamGoals, v.teamGoals, r.ci.teamGoals));
  out.push(...statBlock('Córners', CORNER_LINES, b.corners, v.corners, r.ci.corners));
  out.push(...teamBlock('Córners por equipo', TEAM_CORNER_LINES, b.teamCorners, v.teamCorners, r.ci.teamCorners));
  out.push(...statBlock('Tarjetas', CARD_LINES, b.cards, v.cards, r.ci.cards));
  out.push(...teamBlock('Tarjetas por equipo', TEAM_CARD_LINES, b.teamCards, v.teamCards, r.ci.teamCards));
  out.push(...statBlock('Faltas', FOUL_LINES, b.fouls, v.fouls, r.ci.fouls));
  out.push(...statBlock('Tiros', SHOT_LINES, b.shots, v.shots, r.ci.shots));
  out.push(...statBlock('Tiros a puerta', SOT_LINES, b.sot, v.sot, r.ci.sot));
  const props = r.main.filter((m) => m.key.startsWith('p'));
  if (props.length && r.playerSets) {
    const ps = r.playerSets;
    out.push(
      `Props de jugadores (${int(ps.matches)} partidos; ${int(ps.common)} pares en ambas; solo base ${int(ps.onlyBaseline)} (jugaron ${int(ps.onlyBaselinePlayed)}); solo variante ${int(ps.onlyVariant)} (jugaron ${int(ps.onlyVariantPlayed)}))`,
    );
    for (const m of props) out.push(line(m.label, m.baseline, m.variant, { ci: m.ci }));
  } else out.push('Props de jugadores: sin partidos con líneas de jugador en la ventana');
  out.push(`Composición: ${Object.entries(r.composition).map(([c, n]) => `${c} ${n}`).join(', ')}`);
  out.push('Segmentos (1X2)');
  out.push(`  ${'segmento'.padEnd(20)} ${'n'.padStart(6)} ${'RPS base'.padStart(9)} ${'RPS var'.padStart(9)} ${'Δ RPS'.padStart(9)}  ${'acierto b/v'.padStart(15)}   IC 95 % de Δ RPS`);
  for (const s of r.segments) {
    if (!s.n) {
      out.push(`  ${s.label.padEnd(20)} ${'0'.padStart(6)}`);
      continue;
    }
    out.push(
      `  ${s.label.padEnd(20)} ${int(s.n).padStart(6)} ${num(s.baseline.rps).padStart(9)} ${num(s.variant.rps).padStart(9)} ${signed(s.variant.rps - s.baseline.rps, 5).padStart(9)}  ${`${pct(s.baseline.accuracy, 1)}/${pct(s.variant.accuracy, 1)}`.padStart(15)}   ${ciTxt(s.rps, 5)}`,
    );
  }
  out.push('Segmentos (métricas principales: n · base → variante · Δ [IC 95 %])');
  const SEG_KEYS = ['ouBrier', 'teamGoals', 'corners', 'cards', 'teamCards', 'fouls', 'pScorer', 'pCard'];
  for (const s of r.segments) {
    if (!s.n) continue;
    const parts = s.main
      .filter((m) => SEG_KEYS.includes(m.key))
      .map((m) => `${m.key} ${int(m.n)}: ${num(m.baseline)}→${num(m.variant)} ${signed(m.ci.diff, 5)} [${signed(m.ci.lo, 5)}; ${signed(m.ci.hi, 5)}]`);
    out.push(`  ${s.label.padEnd(20)} ${parts.join(' · ')}`);
  }
  const rb = r.references.baseline;
  const rv = r.references.variant;
  out.push('Referencias: cada fuente sola (1X2)');
  out.push(line('Elo solo · RPS', rb.elo.rps, rv.elo.rps));
  out.push(line('Fuente de goles sola · RPS', rb.goal.rps, rv.goal.rps));
  if (rb.market && rv.market) {
    out.push(`  Partidos con cuotas (n = ${int(rv.market.n)}):`);
    out.push(line('Mercado de cierre · RPS', rb.market.market.rps, rv.market.market.rps));
    out.push(line('Ensamble · RPS', rb.market.ensemble.rps, rv.market.ensemble.rps));
    out.push(line('Mercado de cierre · acierto', rb.market.market.accuracy, rv.market.market.accuracy, { percent: true }));
  }
  if (r.leak) {
    out.push(
      `Comprobación de fuga (partidos del futuro envenenados): ${r.leak.ok ? 'OK' : '¡FUGA DETECTADA!'} · ` +
        r.leak.days.map((d) => `${d.day}: ${d.matches} partidos, máx. dif. ${d.maxDiff === 0 ? '0' : d.maxDiff.toExponential(2)}${d.worst && d.maxDiff > r.leak!.tolerance ? ` (${d.worst})` : ''}`).join(' · '),
    );
    if (!r.leak.ok) out.push('  ✗ RESULTADOS NO VÁLIDOS: algún gancho usa información posterior al inicio del partido.');
  } else {
    out.push('Comprobación de fuga: no ejecutada' + (r.variant === 'baseline' ? ' (línea base)' : ' (--no-leak-check)'));
  }
  out.push(`Tiempo: base ${r.seconds.baseline.toFixed(1)} s · variante ${r.seconds.variant.toFixed(1)} s${r.seconds.leak !== undefined ? ` · fuga ${r.seconds.leak.toFixed(1)} s` : ''}`);
  return out.join('\n');
}

function holdoutLine(r: EvalReport): string {
  const b = r.baseline;
  const v = r.model;
  const c = (x: DiffCI | undefined) => (x ? `Δ ${signed(x.diff)} [${signed(x.lo)}; ${signed(x.hi)}]` : '');
  return [
    new Date().toISOString(),
    `variante=${r.variant}`,
    `ventana=holdout (${r.from} →)`,
    `datos=${r.data.fingerprint}`,
    `n=${r.n}`,
    `1X2 RPS ${num(v.x12.rps)} (base ${num(b.x12.rps)}, ${c(r.ci.rps)})`,
    `log-loss ${num(v.x12.logLoss)} (base ${num(b.x12.logLoss)})`,
    `acierto ${pct(v.x12.accuracy)} (base ${pct(b.x12.accuracy)})`,
    `O/U2,5 Brier ${num(v.ou25.brier)} (base ${num(b.ou25.brier)})`,
    `BTTS Brier ${num(v.btts.brier)} (base ${num(b.btts.brier)})`,
    `córners Brier ${num(v.corners?.brierMean)} (base ${num(b.corners?.brierMean)})`,
    `tarjetas Brier ${num(v.cards?.brierMean)} (base ${num(b.cards?.brierMean)})`,
    `fuga=${r.leak ? (r.leak.ok ? 'OK' : 'DETECTADA') : 'no comprobada'}`,
  ].join(' | ');
}

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

export async function main(args: string[]): Promise<number> {
  const known = new Set(['variant', 'window', 'final', 'no-leak-check', 'no-cache']);
  const unknown = args.filter((a) => !known.has(a.replace(/^--/, '').split('=')[0]));
  if (unknown.length) {
    console.error(`Argumentos desconocidos: ${unknown.join(' ')}`);
    return 1;
  }
  const names = (argValue(args, 'variant') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) {
    console.error('Uso: npx tsx scripts/eval-model.ts --variant=<nombre>[,<nombre>…] [--window=tuning|T1|T2|pre|prev|pooled] [--final]');
    return 1;
  }
  const final = argValue(args, 'final') !== undefined;
  const winArg = argValue(args, 'window');
  let window: WindowName;
  if (final) {
    if (winArg && winArg !== 'holdout') {
      console.error('Con --final la ventana es siempre el holdout (2026-09-16 en adelante): quita --window.');
      return 1;
    }
    window = 'holdout';
  } else {
    if (winArg === 'holdout') {
      console.error(
        'El holdout (2026-09-16 en adelante) no se muestra sin --final. Solo el agente de combinación lo mira, UNA vez, con --final (queda registrado en .cache/holdout-looks.log).',
      );
      return 1;
    }
    if (winArg && !['tuning', 'T1', 'T2', 'pre', 'prev', 'pooled'].includes(winArg)) {
      console.error(`--window debe ser tuning, T1, T2, pre, prev o pooled (recibido: ${winArg})`);
      return 1;
    }
    window = (winArg || 'tuning') as WindowName;
  }
  const leakCheckOn = argValue(args, 'no-leak-check') === undefined;
  const noCache = argValue(args, 'no-cache') !== undefined;

  // variantes primero (errores de sintaxis/forma antes del trabajo pesado)
  const variants: ModelVariant[] = [];
  for (const n of names) variants.push(await loadVariant(n));

  const t0 = performance.now();
  const stores = loadAllStores();
  if (!stores.length) {
    console.error('No hay datos en data-store/: ejecuta antes `npm run data:fetch`.');
    return 1;
  }
  const data: EvalData = { stores, configs: COMPETITIONS, now: dataNow(stores), fingerprint: storeFingerprint() };
  console.log(`FutStat Lab · banco de pruebas · datos ${data.fingerprint} (referencia ${data.now.toISOString().slice(0, 16)}Z) · ventana ${window}${final ? ' (FINAL)' : ''}`);
  const base = runBaseline(data, { noCache });
  const infos = matchInfos(base.ctx!);
  console.log(`  línea base: ${int(base.rows.size)} partidos con predicción walk-forward (${base.fromCache ? 'caché' : 'calculada'}, ${base.seconds.toFixed(1)} s)`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let exit = 0;
  for (const variant of variants) {
    const isBase = variant.name === 'baseline';
    const run = isBase ? base : runVariant(variant, data, { reuse: base, infos });
    if (!isBase) console.log(`  variante ${variant.name}: ${int(run.rows.size)} partidos (${run.seconds.toFixed(1)} s)`);
    const report = compare(base, run, infos, window, data);
    // también para 'production' (variante vacía): el núcleo actual debe pasar la misma comprobación
    if (leakCheckOn && !isBase) {
      const tl = performance.now();
      // T1 y T2 siempre; con pre o prev, también el día con más partidos de esa ventana (otro tipo de partidos)
      const leakWindows: WindowName[] = window === 'pre' || window === 'prev' ? ['T1', 'T2', window] : window === 'pooled' ? ['T1', 'T2', 'prev'] : ['T1', 'T2'];
      const days = [...new Set(leakWindows.map((w) => busiestDay(infos, w, run.rows)).filter((d): d is string => !!d))];
      report.leak = leakCheck(variant, data, run, days);
      report.seconds.leak = (performance.now() - tl) / 1000;
      if (!report.leak.ok) exit = 2;
    }
    if (final) {
      fs.mkdirSync(path.dirname(HOLDOUT_LOG), { recursive: true });
      fs.appendFileSync(HOLDOUT_LOG, `${holdoutLine(report)}\n`);
    }
    console.log(formatReport(report));
    const file = path.join(CACHE_DIR, `${variant.name}-${window}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    console.log(`Informe: ${path.relative(process.cwd(), file)}`);
    if (final) console.log(`Mirada al holdout registrada en ${path.relative(process.cwd(), HOLDOUT_LOG)}`);
  }
  console.log(`\nTiempo total: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return exit;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : e);
      process.exitCode = 1;
    },
  );
}
