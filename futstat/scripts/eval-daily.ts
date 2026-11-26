/**
 * Evaluación del apartado «Pronósticos del día» con los datos reales del data-store (sin escribir nada en public/):
 * familias adicionales (tiros, faltas, jugadores) publicadas y descartadas con sus cifras fuera de muestra, y récord
 * walk-forward de la regla de selección diaria (global, por categoría y por tipo de combinada).
 *
 *   npx tsx scripts/eval-daily.ts [--now=2026-11-24T12:00:00Z]
 */
import path from 'node:path';
import { COMPETITIONS, HOME_TIMEZONE } from '../pipeline/config';
import { loadAllStores } from '../pipeline/store';
import { computeWalkForward, createContext } from '../pipeline/publish/context';
import { DAILY_EXTRA_FAMILIES, GOLD_MIN_RATE, evaluateConfidence, familyBaseRates, fixedBaseline, type ConfidenceFamily, type ConfidenceTheme } from '../pipeline/analytics/confidence';
import { dailyHistory, dailyWalkForward, evaluateExtras } from '../pipeline/analytics/daily';
import { CONFIDENCE_MAX_PER_MATCH, CONFIDENCE_MIN_HIT_RATE } from '../pipeline/publish/confidence';

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)} %`;

function argValue(args: string[], name: string): string | undefined {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const i = a.indexOf('=');
  return i >= 0 ? a.slice(i + 1) : '';
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
  const h = dailyHistory(ctx, { log: (m) => console.log(m) });
  lap('historial (existentes + adicionales)', t);
  t = performance.now();
  const ev = evaluateConfidence(ctx, { history: h.base, select: { maxPerMatch: CONFIDENCE_MAX_PER_MATCH, minHitRate: CONFIDENCE_MIN_HIT_RATE } });
  lap('alta confianza (familias existentes)', t);
  t = performance.now();
  const ex = evaluateExtras(h.extra);
  lap('familias adicionales (walk-forward + producción)', t);
  t = performance.now();
  const wf = dailyWalkForward(ev.wf, ex.wf, h.base, h.extra, HOME_TIMEZONE);
  lap('récord de la regla diaria', t);

  console.log(`\nFutStat Lab · pronósticos del día · ${now.toISOString()}`);
  console.log(`Historial: ${h.base.length} partidos; candidatos adicionales resueltos: ${h.extra.reduce((s, it) => s + it.candidates.length, 0)}`);
  const withPlayers = h.extra.filter((it) => it.candidates.some((c) => c.theme === 'jugadores')).length;
  console.log(`Partidos con algún candidato de jugador: ${withPlayers}`);

  console.log('\n== Familias adicionales: candidatos, tasa base y validación fuera de muestra (walk-forward mensual) ==');
  const base = familyBaseRates(h.extra);
  const counts = new Map<string, number>();
  for (const it of h.extra) for (const c of it.candidates) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
  for (const f of DAILY_EXTRA_FAMILIES) {
    const b = base[f.id as ConfidenceFamily];
    console.log(`${f.id.padEnd(20)} ${f.label.padEnd(40)} candidatos ${String(counts.get(f.id) ?? 0).padStart(5)} · tasa base ${b && b.n ? `${pct(b.hitRate)} (n = ${b.n})` : '—'}`);
    for (const seg of ['mercado', 'estadistico'] as const) {
      const key = `${f.id}|${seg}`;
      const rule = ex.rules.rules.find((r) => r.family === f.id && r.segment === seg);
      const unval = ex.unvalidated.find((u) => u.key === key);
      const rej = ex.rejected.find((r) => r.family === f.id && r.segment === seg);
      const v = ex.validation.get(key);
      const vTxt = v ? `validación ${v.hits}/${v.n} = ${pct(v.hitRate)} [Wilson ${pct(v.wilsonLow)}–${pct(v.wilsonHigh)}]${v.voids ? `, ${v.voids} nulos` : ''}` : 'sin picks fuera de muestra';
      const band = rule ? (rule.goldThreshold !== undefined && rule.oro ? rule.oro : (rule.plata ?? rule.tail)) : undefined;
      const gold = !!band && band.n > 0 && band.hitRate >= GOLD_MIN_RATE - 1e-9;
      if (rule) console.log(`    ${gold ? 'PUBLICADA ' : 'validada, SIN franja oro (no publica)'} ${seg.padEnd(11)} umbral ${rule.threshold.toFixed(2)}${rule.goldThreshold !== undefined ? ` (oro ${rule.goldThreshold.toFixed(2)})` : ''} · histórico ${rule.tail.hits}/${rule.tail.n} = ${pct(rule.tail.hitRate)} · ${vTxt}`);
      else if (unval) console.log(`    no validada ${seg.padEnd(10)} ${vTxt} (se exigen >= 30 picks y >= 80 %)`);
      else console.log(`    descartada ${seg.padEnd(11)} ${rej?.reason ?? (ex.choice.exclude.includes(key) ? 'quitada en la validación interna (< 78 %)' : 'sin regla')}${v ? ` · ${vTxt}` : ''}`);
    }
  }
  console.log(`Nivel de exigencia elegido (producción): ${ex.choice.level}; reglas publicadas ${ex.rules.rules.length}; sin validar ${ex.unvalidated.length}`);
  for (const f of ex.wf.folds) {
    console.log(`  tramo ${f.start.slice(0, 10)}: ${f.matches} partidos, nivel ${f.level}, ${f.rules} reglas → ${f.publishedRules} validadas · publicados ${f.published.hits}/${f.published.n} = ${pct(f.published.hitRate)} · todas ${f.all.hits}/${f.all.n} = ${pct(f.all.hitRate)}`);
  }

  console.log('\n== Récord FUERA DE MUESTRA de la regla diaria (hasta 2 por categoría y 8 por partido) ==');
  const o = wf.overall;
  console.log(`Global: ${o.hits}/${o.n} = ${pct(o.hitRate)} [Wilson ${pct(o.wilsonLow)}–${pct(o.wilsonHigh)}] · ${o.picks} picks (${o.voids} nulos) en ${wf.matches} partidos (${wf.from.slice(0, 10)} → ${wf.to.slice(0, 10)})`);
  for (const [theme, g] of Object.entries(wf.byTheme) as [ConfidenceTheme, NonNullable<(typeof wf.byTheme)[ConfidenceTheme]>][]) {
    console.log(`  ${theme.padEnd(10)} ${g.hits}/${g.n} = ${pct(g.hitRate)} [${pct(g.wilsonLow)}–${pct(g.wilsonHigh)}]${g.voids ? ` · ${g.voids} nulos` : ''} · tasa base ${g.baseRate !== undefined ? pct(g.baseRate) : '—'}`);
  }
  console.log('Por familia:');
  for (const [f, g] of Object.entries(wf.byFamily).sort((a, b) => b[1]!.n - a[1]!.n)) console.log(`  ${f.padEnd(20)} ${g!.hits}/${g!.n} = ${pct(g!.hitRate)}${g!.voids ? ` · ${g!.voids} nulos` : ''}`);
  console.log('Por tramo:');
  for (const f of wf.folds) console.log(`  ${f.start.slice(0, 10)}: ${f.matches} partidos · ${f.hits}/${f.n} = ${pct(f.hitRate)}`);
  console.log('Combinadas (días en que se pudo formar):');
  for (const c of wf.combos) console.log(`  ${c.id.padEnd(12)} ${c.hits}/${c.days} = ${pct(c.hitRate)} · ${c.avgLegs.toFixed(2)} patas de media · cuota justa media ${c.avgFairOdds.toFixed(2)}`);
  const fb = fixedBaseline(ev.wf.items);
  console.log(`Línea base sin modelo en los mismos partidos: ${fb.hits}/${fb.n} = ${pct(fb.hitRate)}`);
  console.log(`\nAviso: alto acierto NO es ventaja frente a la casa (cuotas bajas, margen). Tiempo total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
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
