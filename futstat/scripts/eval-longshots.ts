/**
 * Evaluación del apartado «Cuota alta 6+» con los datos reales del data-store (sin escribir nada en public/): historial
 * FUERA DE MUESTRA de la regla diaria (la misma que publica longshots.json) por tipo —apuestas, aciertos, % con Wilson
 * 90 %, probabilidad media del modelo, cuota media, ROI plano contra cuotas de cierre y racha de derrotas— y calibración
 * del modelo en la banda 0,05–0,25, sin y con recalibración de Platt walk-forward. Al final, las apuestas de hoy.
 *
 *   npx tsx scripts/eval-longshots.ts [--now=2026-11-26T12:00:00Z] [--from=2026-06-01]
 */
import path from 'node:path';
import { COMPETITIONS, HOME_TIMEZONE } from '../pipeline/config';
import { loadAllStores } from '../pipeline/store';
import { computeWalkForward, createContext } from '../pipeline/publish/context';
import { dailyHistory } from '../pipeline/analytics/daily';
import { GENERATED_KINDS, KIND_LABEL, kindExclusion, longshotWalkForward, type KindRecord, type LongshotWalkForward } from '../pipeline/analytics/longshots';
import { LONGSHOT_CALIBRATE, buildLongshotFile, longshotCollector, prepareLongshots, seasonFrom } from '../pipeline/publish/longshots';
import { localDay } from '../pipeline/publish/util';

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)} %`;

function argValue(args: string[], name: string): string | undefined {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const i = a.indexOf('=');
  return i >= 0 ? a.slice(i + 1) : '';
}

function line(r: Omit<KindRecord, 'kind'> & { kind?: string }): string {
  const roi = r.roi ? `ROI ${pct(r.roi.roi)} (n = ${r.roi.bets}, ${r.roi.profit >= 0 ? '+' : ''}${r.roi.profit.toFixed(1)} u)` : 'ROI — (sin cuota de la casa)';
  return `${String(r.bets).padStart(5)} apuestas · ${String(r.hits).padStart(4)}/${String(r.n).padEnd(5)} = ${pct(r.hitRate).padStart(7)} [Wilson ${pct(r.wilsonLow)}–${pct(r.wilsonHigh)}] · esperado ${pct(r.expectedHitRate).padStart(7)} · cuota media ${r.avgOdds.toFixed(2).padStart(5)} · ${roi} · racha ${r.longestLosingStreak}${r.voids ? ` · ${r.voids} nulas` : ''}`;
}

function report(title: string, wf: LongshotWalkForward): void {
  console.log(`\n== ${title}: ${wf.from} → ${wf.to} (${wf.days} días) ==`);
  for (const r of wf.byKind) {
    const ex = kindExclusion(r);
    console.log(`  ${KIND_LABEL[r.kind].padEnd(18)} ${line(r)}${ex ? `\n      NO SE PUBLICA: ${ex}` : ''}`);
  }
  console.log(`  ${'TOTAL'.padEnd(18)} ${line(wf.overall)}`);
  console.log('  Calibración (banda 0,05–0,25; 1X2 completo, 3 marcadores más probables y goleadores elegibles):');
  for (const b of wf.calibration) console.log(`    ${b.from.toFixed(2)}–${b.to.toFixed(2)}: predicho ${pct(b.predicted)} · observado ${pct(b.observed)} · n = ${b.n}`);
  for (const [g, bins] of Object.entries(wf.calibrationByGroup)) {
    console.log(`    [${g}] ${(bins ?? []).map((b) => `${b.from.toFixed(2)}: ${pct(b.predicted)}→${pct(b.observed)} (${b.n})`).join(' · ')}`);
  }
}

export function main(args: string[]): number {
  const nowArg = argValue(args, 'now');
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now inválido: ${nowArg}`);
  const t0 = performance.now();
  const lap = (label: string, t: number) => console.log(`  · ${label}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const stores = loadAllStores();
  if (!stores.length) {
    console.error('No hay datos en data-store/: ejecuta antes `npm run data:fetch`.');
    return 1;
  }
  const ctx = createContext({ stores, configs: COMPETITIONS, now });
  computeWalkForward(ctx);
  lap('modelos y walk-forward de predicciones', t0);
  let t = performance.now();
  const col = longshotCollector(ctx);
  dailyHistory(ctx, { visitExtra: col.visit });
  lap(`historial walk-forward (${col.items.length} partidos, ${col.items.reduce((s, it) => s + it.selections.length, 0)} selecciones resueltas)`, t);
  const today = localDay(now.getTime(), HOME_TIMEZONE);
  const from = argValue(args, 'from') || seasonFrom(today);
  t = performance.now();
  const raw = longshotWalkForward(col.items, { timeZone: HOME_TIMEZONE, from, to: today, calibrate: false });
  const cal = longshotWalkForward(col.items, { timeZone: HOME_TIMEZONE, from, to: today, calibrate: true });
  lap('regla diaria walk-forward (sin y con Platt)', t);

  console.log(`\nFutStat Lab · cuota alta 6+ · ${now.toISOString()} · producción: ${LONGSHOT_CALIBRATE ? 'CON' : 'SIN'} recalibración de Platt`);
  report('Probabilidades del modelo SIN recalibrar', raw);
  report('Con recalibración de Platt walk-forward (mensual, solo días anteriores)', cal);
  if (cal.calibrator) {
    console.log('  Platt de producción (todo el historial):');
    for (const [g, f] of Object.entries(cal.calibrator)) console.log(`    ${g}: a = ${f!.a.toFixed(3)}, b = ${f!.b.toFixed(3)} (n = ${f!.n})`);
  }

  // por mes (producción)
  const prod = LONGSHOT_CALIBRATE ? cal : raw;
  const months = new Map<string, { n: number; hits: number; roiN: number; profit: number }>();
  for (const b of prod.bets) {
    if (b.result !== 'hit' && b.result !== 'miss') continue;
    const k = localDay(Date.parse(b.date), HOME_TIMEZONE).slice(0, 7);
    const e = months.get(k) ?? { n: 0, hits: 0, roiN: 0, profit: 0 };
    e.n++;
    if (b.result === 'hit') e.hits++;
    if (b.marketOdds !== undefined) {
      e.roiN++;
      e.profit += b.result === 'hit' ? b.marketOdds - 1 : -1;
    }
    months.set(k, e);
  }
  console.log('\nPor mes (producción):');
  for (const [k, e] of [...months].sort()) console.log(`  ${k}: ${e.hits}/${e.n} = ${pct(e.n ? e.hits / e.n : 0)} · ROI ${e.roiN ? pct(e.profit / e.roiN) : '—'} (n = ${e.roiN})`);

  // EV positivo en el historial (¿sirve filtrar por EV > 0?)
  const evPos = prod.bets.filter((b) => b.ev !== undefined && b.ev > 0 && (b.result === 'hit' || b.result === 'miss'));
  const evNeg = prod.bets.filter((b) => b.ev !== undefined && b.ev <= 0 && (b.result === 'hit' || b.result === 'miss'));
  const roiOf = (xs: typeof evPos) => xs.reduce((s, b) => s + (b.result === 'hit' ? b.marketOdds! - 1 : -1), 0) / Math.max(1, xs.length);
  console.log(`Apuestas con EV > 0 según el modelo: ${evPos.length} (acierto ${pct(evPos.filter((b) => b.result === 'hit').length / Math.max(1, evPos.length))}, ROI ${pct(roiOf(evPos))}); con EV <= 0: ${evNeg.length} (ROI ${pct(roiOf(evNeg))})`);

  // hoy
  t = performance.now();
  const state = prepareLongshots(ctx, col.items);
  const file = buildLongshotFile(ctx, state);
  lap('apuestas de hoy y días siguientes', t);
  console.log(`\nTipos publicables: ${GENERATED_KINDS.filter((k) => !state.excluded.has(k)).join(', ') || 'ninguno'}`);
  for (const [k, why] of state.excluded) console.log(`  sin publicar ${k}: ${why}`);
  for (const d of file.days) {
    const byKind = new Map<string, number>();
    for (const b of d.bets) byKind.set(b.kind, (byKind.get(b.kind) ?? 0) + 1);
    console.log(`\n${d.date}: ${d.bets.length} apuestas (${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')})`);
    for (const b of d.bets) {
      const legs = b.legs.map((l) => `${l.compName}: ${l.home.name}–${l.away.name} · ${l.selection} (${pct(l.prob, 0)}${l.marketOdds ? ` @ ${l.marketOdds}` : ''})${l.result ? ` [${l.result}]` : ''}`).join(' | ');
      console.log(`  [${b.score.toFixed(1)}] ${b.label} · cuota ${b.displayOdds}${b.marketOdds ? ' (casa)' : ' (justa)'} · p ${pct(b.prob)} · 1 de cada ${b.oneIn}${b.ev !== undefined ? ` · EV ${pct(b.ev)}` : ''}${b.result ? ` · ${b.result}` : ''}`);
      console.log(`      ${legs}`);
      console.log(`      ${b.reason}`);
    }
  }
  console.log(`\nNota: ${file.note}`);
  console.log(`\nTiempo total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) process.exitCode = main(process.argv.slice(2));
