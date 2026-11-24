/**
 * Informe de los pronósticos de ALTA CONFIANZA (pipeline/analytics/confidence.ts) con los datos reales.
 *
 *   npx tsx scripts/eval-confidence.ts [--now=2026-11-15T12:00:00Z] [--out=ruta.json] [--ocultar-virgen] [--variant=baseline]
 *
 * Calcula el historial walk-forward (predicciones sin fuga de todos los partidos terminados de la temporada actual),
 * elige las reglas SOLO con la ventana de calibración (60 % más antiguo) y las mide en el holdout (el resto), que
 * nunca se usa para ajustar umbrales. Imprime: procedimiento, validación interna, por familia (umbral, validación
 * walk-forward, n y acierto en calibración y holdout, tasa base y lift), holdout global (picks, aciertos, %, intervalo
 * de Wilson al 90 %, periodo, línea base sin modelo), cobertura, cuota justa media, ROI plano de 1 unidad con cuotas
 * de cierre, tramo final, walk-forward mensual, partidos posteriores a la revisión y reglas de producción.
 *
 * --ocultar-virgen: muestra solo la primera parte del holdout (sin el tramo virgen final ni el total) y no escribe
 * esas cifras en el JSON. Sirve para mirar el holdout una vez y, si hubiera que corregir algo, publicar después una
 * cifra limpia con el tramo virgen.
 * --variant: (banco de pruebas) mismas predicciones de una variante de pipeline/experiments; `baseline` = el modelo
 * de producción anterior al 22-nov-2026, para comparar antes/después con el mismo procedimiento.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPETITIONS } from '../pipeline/config';
import { loadAllStores } from '../pipeline/store';
import { computeWalkForward, createContext } from '../pipeline/publish/context';
import {
  FIXED_BASELINE_LABEL,
  confidenceHistory,
  confidenceReport,
  evaluateConfidence,
  type ConfidenceEvaluation,
  type ConfidenceReport,
  type GroupReport,
} from '../pipeline/analytics/confidence';
import { CONFIDENCE_MAX_PER_MATCH, CONFIDENCE_MIN_HIT_RATE } from '../pipeline/publish/confidence';
import { loadVariant } from '../pipeline/experiments/load';
import { isEmptyVariant } from '../pipeline/experiments/types';

/** Fin de los datos de la revisión independiente: lo posterior no se había visto al tomar sus decisiones. */
const REVIEW_DATA_END = '2026-11-15T00:00:00Z';

/** Salida por defecto: .cache/ del proyecto (ignorada por git). */
const DEFAULT_OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'confidence-report.json');

/**
 * Registro honesto del desarrollo (qué se probó y qué se miró). Todo lo elegido se decidió con la ventana de
 * calibración y su validación interna; el holdout se lista aparte con cada vez que se miró.
 */
export const ATTEMPTS: string[] = [
  "Intento 1 (solo calibración): umbral por familia = mínimo de la rejilla cuya cola acierta >= 0,82 (n >= 80, Wilson 90 % >= 0,78). Validación interna 88,1 %, pero se detectó que la cola la sostienen los candidatos muy probables: en 'ah+1.5' el umbral bajaba a 0,63 y un pick de 0,63 (acierto real ~70 %) salía etiquetado como '87 %'. Se descartó por etiquetas engañosas.",
  'Intento 2 (solo calibración): recalibración de Platt por familia; el umbral parte de la probabilidad cuya recalibración llega al objetivo y después debe cumplir los mismos criterios de cola. Validación interna 89,9 % y etiquetas honestas (franja plata 86,8 %, picks marginales 87,9 %).',
  'Intento 3 (solo calibración): en la validación interna los partidos SIN cuotas acertaban 74,6 % (n = 59): fallos en equipos que el modelo apenas conoce (primera ronda de la DFB-Pokal con equipos fuera del dataset, recién ascendidos). Se añadió el requisito de historial (sin cuotas: >= 10 partidos Elo previos por equipo; córners/tarjetas: >= 5 partidos previos con el dato) y reglas separadas por fuente de la predicción (con mercado / estadística). Validación interna 90,6 % (n = 1.860).',
  'Holdout, mirada 1 (procedimiento ya cerrado), con --ocultar-virgen: solo el primer tramo del holdout (2026-09-16 → 2026-10-24, 963 partidos): 1.658 picks, 1.481 aciertos de 1.655 resueltos = 89,5 % (Wilson 90 %: 88,2–90,7 %). No se cambió nada del método después de mirarlo.',
  'Holdout, mirada 2: holdout completo con el tramo virgen (2026-10-25 → final), con el mismo código: 2.522/2.841 = 88,8 % (Wilson 87,8–89,7 %); oro 89,2 %, plata 79,9 % (107/134); cuota justa media 1,12.',
  'Revisión adversarial independiente (18 nov, datos hasta el 14 nov): confirma el 88,8 % y añade el contexto que obliga a cambiar la presentación: una estrategia fija sin modelo acierta 87,2 %; la plata no cumple su etiqueta; «más de 2,5 tarjetas» falla fuera de muestra (walk-forward 74,4 %); hay reglas de producción nunca validadas fuera de muestra; prórrogas resueltas a 120 minutos.',
  'Correcciones aplicadas DESPUÉS de ver el holdout y el walk-forward (el holdout ya no es del todo virgen para ellas): solo nivel oro (minHitRate 0,85), «más de 2,5 tarjetas» excluida en las dos fuentes, validación por regla en un walk-forward mensual (>= 30 picks y >= 80 % en los tramos anteriores; el walk-forward empieza el primer mes con >= 1.000 partidos previos, junio, como en la revisión; con 1.200, agosto, el holdout era idéntico), resolución a 90 minutos con eventos de gol (prórroga/penaltis: sin córners ni tarjetas) y 0 tarjetas = dato ausente. La única cifra limpia frente a estas decisiones es la de los partidos posteriores al 14 nov (se imprime aparte).',
];

function argValue(args: string[], name: string): string | undefined {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const i = a.indexOf('=');
  return i >= 0 ? a.slice(i + 1) : '';
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d).replace('.', ',')} %`;
const num = (x: number, d = 2) => x.toFixed(d).replace('.', ',');
const day = (iso: string) => iso.slice(0, 10);

const pp = (x: number) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x * 100), 1)} pp`;

function groupLine(g: GroupReport | undefined): string {
  if (!g) return '—';
  const roi = g.roi ? ` · ROI ${g.roi.roi >= 0 ? '+' : ''}${pct(g.roi.roi)} (${g.roi.bets} con cuota)` : '';
  const base = g.baseRate !== undefined ? ` · tasa base ${pct(g.baseRate)} (n = ${g.baseN})${g.lift !== undefined ? `, lift ${pp(g.lift)}` : ''}` : '';
  return `${g.hits}/${g.n} = ${pct(g.hitRate)} [Wilson 90 %: ${pct(g.wilsonLow)}–${pct(g.wilsonHigh)}]${g.voids ? ` · ${g.voids} nulos` : ''} · cuota justa media ${num(g.avgFairOdds)}${base}${roi}`;
}

function printReport(title: string, r: ConfidenceReport): void {
  console.log(`\n== ${title} ==`);
  console.log(`Periodo: ${day(r.from)} → ${day(r.to)} (${r.days} días, ${r.matchDays} con partidos) · ${r.matches} partidos evaluados`);
  console.log(`Picks: ${r.picks} · aciertos ${r.hits} · fallos ${r.n - r.hits} · nulos ${r.voids}`);
  console.log(`Acierto: ${pct(r.hitRate)}  (intervalo de Wilson al 90 %: ${pct(r.wilsonLow)} – ${pct(r.wilsonHigh)})`);
  console.log(
    `Cobertura: ${r.matchesWithPick} de ${r.matches} partidos con pick (${pct(r.matches ? r.matchesWithPick / r.matches : 0)}) · ` +
      `${num(r.picksPerMatchDay, 1)} picks por día con partidos · ${num(r.picksPerDay, 1)} por día natural`,
  );
  console.log(`Probabilidad media del modelo ${pct(r.avgProb)} · cuota justa media ${num(r.avgFairOdds)}`);
  const b = r.fixedBaseline;
  console.log(`Línea base SIN modelo (${FIXED_BASELINE_LABEL}): ${b.hits}/${b.n} = ${pct(b.hitRate)} [Wilson 90 %: ${pct(b.wilsonLow)}–${pct(b.wilsonHigh)}]`);
  if (r.expectedBaseRate !== undefined) console.log(`Tasa base esperada (cada pick como la base de su familia): ${pct(r.expectedBaseRate)} · lift ${pp(r.lift ?? 0)}`);
  if (r.roi) {
    console.log(
      `ROI plano (1 u. por pick) con cuotas de cierre: ${r.roi.bets} picks con cuota (${r.roi.synthetic} sintéticas DC/DNB), ` +
        `beneficio ${r.roi.profit >= 0 ? '+' : ''}${num(r.roi.profit)} u., ROI ${r.roi.roi >= 0 ? '+' : ''}${pct(r.roi.roi)}, acierto ${pct(r.roi.hitRate)}, cuota media ${num(r.roi.avgOdds)}`,
    );
  } else console.log('ROI: ningún pick con cuota de cierre.');
  for (const [k, g] of Object.entries(r.byTier)) console.log(`  nivel ${k.padEnd(6)} ${String(g!.picks).padStart(5)} picks · ${groupLine(g)}`);
  for (const [k, g] of Object.entries(r.bySegment)) console.log(`  fuente ${k.padEnd(11)} ${String(g!.picks).padStart(5)} picks · ${groupLine(g)}`);
}

function printFamilies(e: ConfidenceEvaluation, showHoldout: boolean): void {
  console.log('\n== Por familia (umbral elegido en calibración · cola en calibración · picks publicados en el holdout) ==');
  for (const f of e.byFamily) {
    const h = showHoldout && f.holdout ? groupLine(f.holdout) : showHoldout ? 'sin picks' : '(oculto)';
    console.log(`${f.family.padEnd(19)} ${f.label}`);
    for (const s of f.segments) {
      const seg = (s.segment ?? 'todas').padEnd(11);
      const pv = s.productionValidation;
      const prod = s.production
        ? ` · producción: umbral ${num(s.production.threshold)}, n = ${s.production.n}, ${pct(s.production.hitRate)}; validación WF ${pv ? `${pv.hits}/${pv.n} = ${pct(pv.hitRate)}` : 'sin picks'} → ${pv?.validated ? 'PUBLICADA' : 'no publicada'}`
        : ' · producción: descartada';
      if (s.threshold === undefined) {
        console.log(`    ${seg} no se mide en el holdout: ${s.rejectedReason}${prod}`);
      } else {
        const cv = s.calibrationValidation;
        console.log(
          `    ${seg} umbral ${num(s.threshold)}${s.goldThreshold !== undefined ? ` (oro ${num(s.goldThreshold)})` : ''} · calibración n = ${s.calibration.n}, ` +
            `${pct(s.calibration.hitRate)} (Wilson ${pct(s.calibration.wilsonLow)}) · validación WF antes del holdout ${cv ? `${cv.hits}/${cv.n}` : '—'}${prod}`,
        );
      }
    }
    console.log(`    holdout: ${f.holdout ? `${f.holdout.picks} picks · ` : ''}${h}${f.holdoutBase ? ` · tasa base de la familia ${pct(f.holdoutBase.hitRate)} (n = ${f.holdoutBase.n})` : ''}`);
    if (f.walkForward) console.log(`    walk-forward: ${groupLine(f.walkForward)}`);
  }
}

function hideVirgin(e: ConfidenceEvaluation): Record<string, unknown> {
  const out: Record<string, unknown> = { ...e };
  delete out.holdout;
  delete out.holdoutPicks;
  delete out.virgin;
  delete out.walkForward;
  delete out.recentSettled;
  out.byFamily = e.byFamily.map((f) => ({ ...f, holdout: undefined, holdoutBase: undefined, walkForward: undefined }));
  out.nota = 'Tramo virgen y holdout completo ocultos (--ocultar-virgen): solo se muestra holdoutEarly.';
  return out;
}

export async function main(args: string[]): Promise<number> {
  const variantName = argValue(args, 'variant');
  const loaded = variantName ? await loadVariant(variantName) : undefined;
  const variant = loaded && !isEmptyVariant(loaded) ? loaded : undefined;
  const nowArg = argValue(args, 'now');
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now inválido: ${nowArg}`);
  const out = path.resolve(argValue(args, 'out') || DEFAULT_OUT);
  const hide = argValue(args, 'ocultar-virgen') !== undefined;
  const t0 = performance.now();
  const stores = loadAllStores();
  if (!stores.length) {
    console.error('No hay datos en data-store/: ejecuta antes `npm run data:fetch`.');
    return 1;
  }
  const ctx = createContext({ stores, configs: COMPETITIONS, now, variant });
  computeWalkForward(ctx);
  const history = confidenceHistory(ctx, { log: (m) => console.log(m) });
  const e = evaluateConfidence(ctx, { history, select: { maxPerMatch: CONFIDENCE_MAX_PER_MATCH, minHitRate: CONFIDENCE_MIN_HIT_RATE } });
  const secs = (performance.now() - t0) / 1000;

  console.log(`FutStat Lab · pronósticos de alta confianza · ${now.toISOString()} (${num(secs, 1)} s)${loaded ? ` · variante ${loaded.name}` : ''}`);
  console.log(`Historial walk-forward: ${history.length} partidos terminados de la temporada actual (${day(history[0]?.date ?? '')} → ${day(history[history.length - 1]?.date ?? '')})`);
  console.log(`Calibración: ${e.split.calibration.matches} partidos (${day(e.split.calibration.from)} → ${day(e.split.calibration.to)})`);
  console.log(`Holdout:     ${e.split.holdout.matches} partidos (${day(e.split.holdout.from)} → ${day(e.split.holdout.to)}), nunca usado para elegir`);
  console.log(`Tramo virgen (final del holdout): ${e.split.virgin.matches} partidos desde ${day(e.split.virginCutoff)}`);
  console.log('\n== Procedimiento (pre-registrado) ==');
  for (const p of e.procedure) console.log(`- ${p}`);
  console.log('\n== Registro de intentos ==');
  for (const a of ATTEMPTS) console.log(`- ${a}`);

  console.log('\n== Validación interna de la calibración (elección de la exigencia) ==');
  for (const l of e.calibrationLog) {
    const v = l.validation;
    console.log(
      `nivel ${l.level} (objetivo ${l.options.targetRate}, Wilson ${l.options.minLower}): ${v.hits}/${v.n} = ${pct(v.hitRate)} (Wilson ${pct(v.wilsonLow)}), ` +
        `${day(v.from)} → ${day(v.to)}${l.dropped.length ? ` · quitadas: ${l.dropped.map((d) => `${d.key} (${pct(d.hitRate)}, n = ${d.n})`).join(', ')}` : ''} → ${l.accepted ? 'ACEPTADO' : 'no'}`,
    );
  }
  printFamilies(e, !hide);
  printReport('Calibración (dentro de muestra, optimista: solo referencia)', e.calibration);
  printReport(hide ? 'HOLDOUT (primer tramo; virgen oculto)' : 'HOLDOUT, primer tramo', e.holdoutEarly);
  if (!hide) {
    printReport('TRAMO FINAL DEL HOLDOUT', e.virgin);
    printReport('HOLDOUT COMPLETO (cifra publicada)', e.holdout);
    const freshT = Date.parse(REVIEW_DATA_END);
    const freshItems = history.filter((h) => Date.parse(h.date) >= freshT && Date.parse(h.date) >= Date.parse(e.split.cutoff));
    if (freshItems.length) {
      const ids = new Set(freshItems.map((h) => h.matchId));
      printReport(
        `PARTIDOS POSTERIORES A LA REVISIÓN (desde ${day(REVIEW_DATA_END)}; reglas de calibración, únicos limpios frente a las correcciones)`,
        confidenceReport(freshItems, e.holdoutPicks.filter((p) => ids.has(p.matchId))),
      );
    }
    printReport('WALK-FORWARD MENSUAL (procedimiento completo, reglas reajustadas y validadas cada mes)', e.walkForward);
    for (const f of e.walkForward.folds) {
      console.log(
        `  ${day(f.start)} → ${day(f.end)}: ${f.trainMatches} partidos previos, nivel ${f.level}, ${f.rules} reglas → ${f.publishedRules} validadas · ` +
          `publicados ${f.published.hits}/${f.published.n} = ${pct(f.published.hitRate)} · todas las reglas ${f.all.hits}/${f.all.n} = ${pct(f.all.hitRate)}`,
      );
    }
    console.log('\nPor competición (holdout completo):');
    for (const [k, g] of Object.entries(e.holdout.byComp).sort((a, b) => b[1].picks - a[1].picks)) console.log(`  ${k.padEnd(13)} ${String(g.picks).padStart(4)} picks · ${groupLine(g)}`);
    const rs = e.recentSettled;
    const rh = rs.filter((p) => p.result === 'hit').length;
    const rn = rs.filter((p) => p.result !== 'void').length;
    console.log(`\nResueltos recientes (walk-forward publicado, últimos 30 días): ${rs.length} picks, ${rh}/${rn} = ${pct(rn ? rh / rn : 0)}`);
    for (const p of rs.slice(0, 8)) {
      console.log(`  ${day(p.date)} ${p.home} ${p.score.home}-${p.score.away} ${p.away} · ${p.selection} (${pct(p.prob, 0)}, ${p.tier}) → ${p.result === 'hit' ? 'acierto' : p.result === 'miss' ? 'fallo' : 'nulo'}`);
    }
  }
  console.log('\n== Reglas de producción (mismo procedimiento con TODO el historial) ==');
  console.log(`Nivel elegido ${e.productionChoice.level} (objetivo ${e.productionChoice.options.targetRate}); reglas publicadas (validadas): ${e.rules.rules.length}; sin validar: ${e.unvalidated.length}`);
  for (const u of e.unvalidated) console.log(`  no publicada ${u.key.padEnd(30)} validación WF ${u.n ? `${u.hits}/${u.n} = ${pct(u.hitRate)}` : 'sin picks'}`);
  for (const x of e.excluded) console.log(`  excluida de antemano ${x.key}: ${x.reason}`);
  for (const r of e.rules.rules) {
    console.log(
      `  ${`${r.family}|${r.segment ?? 'todas'}`.padEnd(32)} umbral ${num(r.threshold)}${r.goldThreshold !== undefined ? ` (oro ${num(r.goldThreshold)})` : ''} · n = ${r.tail.n}, ${pct(r.tail.hitRate)}`,
    );
  }
  console.log('\nAviso: alto acierto NO es beneficio ni ventaja frente a la casa. Son selecciones muy probables de cuota baja (la línea base sin modelo acierta casi lo mismo) y las casas cobran margen; el ROI con cuotas de cierre lo muestra.');

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const payload = hide ? hideVirgin(e) : { ...e, attempts: ATTEMPTS };
  fs.writeFileSync(out, JSON.stringify({ ...payload, attempts: ATTEMPTS }, null, 1));
  console.log(`\nInforme JSON: ${out}`);
  return 0;
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
