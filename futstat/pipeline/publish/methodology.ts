/**
 * Secciones de metodología (español) de public/data/model.json, con los valores ajustados en este build.
 */
import type { BacktestSummary, ConfidenceFile, DailyFile, LongshotFile, ModelFile } from '../../src/types/data';
import { MODEL, UPCOMING_DAYS } from '../config';
import { MAX_EV } from '../analytics/value';
import { ELO_GOAL_WEIGHT_FACTOR, LOW_DATA_GAMES } from '../analytics/predict';
import { CUP_ONLY_TIER } from '../analytics/ratings';
import { PRIOR_N as STAT_PRIOR_N, HALF_LIFE_DAYS } from '../analytics/projections';
import {
  COMBO_MAX_LEGS,
  COMBO_MAX_ODDS,
  COMBO_MIN_LEGS,
  GATE_MIN_N,
  GATE_MIN_RATIO,
  LEG_MAX_ODDS,
  LEG_MIN_ODDS,
  LEG_MIN_PROB,
  MAX_PER_DAY,
  MAX_PER_KIND,
  MAX_SINGLE_ODDS,
  MIN_ODDS,
  SCORER_MIN_EXP_MINUTES,
  SCORER_MIN_PROB,
  UNPRICED_EV,
} from '../analytics/longshots';
import { lcFirst } from './util';
import type { BuildContext } from './context';

const n0 = (x: number) => Math.round(x).toLocaleString('es-ES');
const d = (x: number, k = 2) => x.toFixed(k).replace('.', ',');
const pc = (x: number, k = 0) => `${(x * 100).toFixed(k).replace('.', ',')} %`;
/** Porcentaje con el mismo redondeo que la interfaz (Intl es-ES): «Cuota alta 6+» repite cifras que la página muestra. */
const pcI = (x: number, k = 0) => `${new Intl.NumberFormat('es-ES', { minimumFractionDigits: k, maximumFractionDigits: k, useGrouping: false }).format(x * 100)} %`;

export interface MethodologyInput {
  ctx: BuildContext;
  backtest?: BacktestSummary;
  competitions: number;
  teams: number;
  players: number;
  valueBets: number;
  /** pronósticos de alta confianza publicados en este build (cifras del holdout) */
  confidence?: ConfidenceFile;
  /** pronósticos del día publicados en este build y resumen de sus familias adicionales (tiros, faltas, jugadores) */
  daily?: DailyFile;
  dailyFamilies?: DailyFamiliesSummary;
  /** apuestas de cuota alta (6+) publicadas en este build, con su historial fuera de muestra */
  longshots?: LongshotFile;
}

/** Reglas (familia · fuente) de las familias adicionales del apartado diario, con su validación fuera de muestra. */
export interface DailyFamiliesSummary {
  published: { label: string; source: string; n: number; hits: number }[];
  /** con regla pero sin validar (< 30 picks o < 80 % fuera de muestra) */
  unvalidated: { label: string; source: string; n: number; hits: number }[];
  /** familias sin ninguna regla (la probabilidad no llega a un 82 % recalibrado con muestra suficiente) */
  discarded: string[];
}

const day = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
};

/** Acierto con n e intervalo de Wilson al 90 %: «89,8 % (2.362/2.630; Wilson 88,8–90,7 %)». */
function rateWithCi(x: { hits: number; n: number; wilsonLow?: number; wilsonHigh?: number }): string {
  const ci = x.wilsonLow !== undefined && x.wilsonHigh !== undefined ? `; Wilson 90 %: ${pc(x.wilsonLow, 1)}–${pc(x.wilsonHigh, 1)}` : '';
  return `${pc(x.n ? x.hits / x.n : 0, 1)} (${n0(x.hits)}/${n0(x.n)}${ci})`;
}

const pp = (x: number) => `${x >= 0 ? '+' : '−'}${d(Math.abs(x * 100), 1)} pp`;

/** Sección «Pronósticos de alta confianza» con las cifras reales del holdout de este build. */
export function confidenceSection(cf: ConfidenceFile | undefined, bt: BacktestSummary | undefined): ModelFile['sections'][number] {
  const body: string[] = [
    `Qué es: el pronóstico 1X2 acierta ${bt ? pc(bt.model.accuracy, 1) : 'alrededor del 52 %'} de las veces${bt?.market ? ` (el mercado de cierre, ${pc(bt.market.accuracy, 1)})` : ''}, lo normal en fútbol, y no se puede llevar al 80 % para todos los partidos. Esta sección es otra cosa: entre más de 20 familias de mercados de cada partido (doble oportunidad, empate no apuesta, hándicap +1,5, más/menos goles, goles por equipo, córners y tarjetas) se publican selecciones MUY PROBABLES Y DE CUOTA BAJA. No son una ventaja frente a la casa: casi todo su acierto es estructural, como muestra la línea base de abajo.`,
  ];
  const t = cf?.track;
  const h = t?.holdout;
  if (cf && t && h && h.n > 0) {
    const cal = t.calibration;
    const b = t.baseline;
    body.push(
      `Línea base y lift: ${b ? `una estrategia fija SIN modelo (${b.label}) acierta ${rateWithCi(b)} en los mismos partidos del holdout, frente a ${rateWithCi(h)} de los pronósticos` : `los pronósticos aciertan ${rateWithCi(h)}`}.` +
        (t.expectedBaseRate !== undefined && t.lift !== undefined
          ? ` Si cada pronóstico acertara como la tasa base de su familia (su selección natural, sin umbral, en todos los partidos del holdout con dato), acertarían ${pc(t.expectedBaseRate, 1)}: el modelo añade ${pp(t.lift)}.`
          : '') +
        ` La cuota justa media es ${d(t.avgFairOdds)}.`,
    );
    const fams = t.byFamily.filter((f) => f.n > 0 && f.baseRate !== undefined);
    if (fams.length) {
      body.push(
        `Por familia (holdout; acierto frente a tasa base y lift): ${fams
          .map((f) =>
            f.n >= 50
              ? `${f.label.replace(/(\d)\.(\d)/g, '$1,$2')} ${pc(f.hitRate ?? 0, 1)} (n = ${n0(f.n)}; Wilson ${pc(f.wilsonLow ?? 0, 1)}–${pc(f.wilsonHigh ?? 1, 1)}) frente a ${pc(f.baseRate ?? 0, 1)}, ${pp(f.lift ?? 0)}`
              : `${f.label.replace(/(\d)\.(\d)/g, '$1,$2')}: muestra pequeña (n = ${n0(f.n)}), sin acierto propio`,
          )
          .join('; ')}. Un lift negativo significa que publicar esa familia en todos los partidos habría acertado más que filtrarla con el modelo.`,
      );
    }
    body.push(
      'Sin fuga de datos (walk-forward): cada partido terminado de la temporada actual se predice solo con información anterior a su inicio: Elo previo, Dixon-Coles re-ajustado con partidos anteriores, parámetros de pretemporada, proyecciones de córners y tarjetas con partidos de días anteriores y cuotas de cierre. Sin cuotas, resultado y goles exigen al menos 10 partidos previos de cada equipo; córners y tarjetas, al menos 5 con ese dato.',
      'Resolución: como las casas, a 90 minutos. En partidos con prórroga o penaltis, goles y resultado se reconstruyen con los eventos de gol hasta el minuto 90 (si los eventos no cuadran con el marcador, el partido se excluye) y córners y tarjetas se excluyen (la fuente los da con la prórroga incluida). Un total de 0 tarjetas cuenta como dato ausente: sin eventos de tarjeta no se distingue de un partido sin estadísticas.',
      `Umbrales: una regla por familia y por fuente de la predicción (con cuotas / sin cuotas). La probabilidad del modelo se recalibra (Platt) con el histórico; el umbral parte de la probabilidad cuya versión recalibrada llega al 82 % y la cola (probabilidad ≥ umbral) debe acertar ≥ 82 % con al menos 80 casos y un límite inferior de Wilson (90 %) ≥ 78 %. Solo se publica la franja oro: la que acierta ≥ ${pc(cf.rules.minHitRate || 0.85)} en el histórico con el que se ajustó su regla (la franja plata, 80–85 %, acertó 79,9 % fuera de muestra y se retiró). Como mucho ${cf.rules.maxPerMatch || 2} pronósticos por partido, de temas distintos (resultado, goles, córners, tarjetas). Por encima del 93 % la selección se considera trivial y no se publica.`,
      `Validación por regla: un walk-forward mensual repite TODO el procedimiento cada mes con los partidos anteriores. Una regla (familia y fuente) solo se publica si acumula, fuera de muestra en los meses anteriores, al menos ${cf.rules.validation?.minN ?? 30} pronósticos con un acierto ≥ ${pc(cf.rules.validation?.minRate ?? 0.8)}; ${cf.rules.unvalidated ? `${n0(cf.rules.unvalidated)} reglas del procedimiento no lo cumplen y no se publican` : 'todas las reglas del procedimiento lo cumplen'}.` +
        (t.excluded?.length ? ` Excluida de antemano: ${t.excluded.map((e) => `«${e.label.replace(/(\d)\.(\d)/g, '$1,$2').toLowerCase()}» (${e.reason})`).join('; ')}.` : ''),
    );
    body.push(
      `Calibración frente a holdout: las reglas que se miden se ajustan solo con el 60 % más antiguo de los partidos${cal ? ` (${day(cal.from)} – ${day(cal.to)}, ${n0(cal.matches)} partidos)` : ''}, la exigencia se elige con una validación interna dentro de esa ventana y la validación por regla usa solo meses anteriores al holdout. El holdout (${day(h.from)} – ${day(h.to)}, ${n0(h.matches ?? 0)} partidos) no se usó para ajustar umbrales: ${rateWithCi(h)}${h.voids ? `; ${n0(h.voids)} nulos (empate no apuesta con empate)` : ''}.` +
        (t.virgin && t.virgin.n > 0 ? ` Tramo final (${day(t.virgin.from)} – ${day(t.virgin.to)}): ${rateWithCi(t.virgin)}.` : '') +
        ' Transparencia: las correcciones de la revisión del 18 nov 2026 (solo oro, sin «más de 2,5 tarjetas», validación por regla y resolución a 90 minutos) se decidieron después de ver el holdout y el walk-forward, así que el holdout ya no es del todo virgen para ellas. Antes de esas correcciones, con datos hasta el 14 nov, el holdout acertaba 88,8 % (2.522/2.841; Wilson 87,8–89,7 %).',
    );
    const wf = t.walkForward;
    if (wf && wf.n > 0) {
      const rates = wf.folds.filter((f) => f.n >= 50).map((f) => f.hits / f.n);
      body.push(
        `Walk-forward mensual de todo el procedimiento (${day(wf.from)} – ${day(wf.to)}; cada mes, reglas reajustadas y validadas con lo anterior): ${rateWithCi(wf)}` +
          (rates.length ? `; por mes, entre ${pc(Math.min(...rates), 1)} y ${pc(Math.max(...rates), 1)} (meses con al menos 50 pronósticos).` : '.'),
      );
    }
    body.push(
      `Producción: el mismo procedimiento aplicado a todo el historial (${n0(cf.rules.matches)} partidos), con la validación de todo el walk-forward, da ${n0(cf.rules.active)} reglas publicadas para los partidos próximos. Cada pronóstico muestra el acierto fuera de muestra de su regla con su n y su intervalo; con menos de 50 casos no se da acierto propio («muestra pequeña»).`,
    );
    const roi = t.roi;
    const wroi = t.walkForward?.roi;
    const roiText = roi
      ? ` y, con cuotas de cierre, solo ${n0(roi.bets)} de ${n0(h.picks)} picks del holdout tienen precio${roi.synthetic === roi.bets ? ' (todos sintéticos de doble oportunidad o empate no apuesta, calculados desde el 1X2)' : ''}: apostar 1 unidad a cada uno habría dado un ROI de ${roi.roi >= 0 ? '+' : '−'}${pc(Math.abs(roi.roi), 1)}`
      : wroi
        ? `; en el holdout ningún pick publicado tiene cuota de cierre y en el walk-forward solo ${n0(wroi.bets)} de ${n0(t.walkForward!.picks)} la tienen${wroi.synthetic !== undefined && wroi.synthetic >= wroi.bets - 1 ? ' (casi todas sintéticas de doble oportunidad o empate no apuesta, calculadas desde el 1X2)' : ''}: apostar 1 unidad a cada uno habría dado un ROI de ${wroi.roi >= 0 ? '+' : '−'}${pc(Math.abs(wroi.roi), 1)}`
        : '';
    body.push(
      `Advertencias: alto acierto NO es beneficio. La cuota justa media es ${d(t.avgFairOdds)}${roiText}; para el resto (goles por equipo, hándicap, córners, tarjetas) la fuente no publica cuotas y la rentabilidad no se puede medir. La cobertura es casi total (${t.coverage.matches ? pc((t.coverage.matchesWithPick ?? 0) / t.coverage.matches) : '—'} de los partidos tienen pick, unos ${d(t.coverage.picksPerMatchDay ?? t.coverage.picksPerDay, 0)} al día con partidos): no es una lista exclusiva de "apuestas seguras".`,
      `Cuotas de cierre: ESPN las entrega en el resumen del partido con la fecha del partido como marca de tiempo, así que esa marca no demuestra que sean previas. Las pruebas son empíricas: ${bt?.market ? `el favorito de cierre acierta ${pc(bt.market.accuracy, 1)} con una log-loss de ${d(bt.market.logLoss, 3)}${bt.marketMatches ? ` (n = ${n0(bt.marketMatches)})` : ''}` : 'el favorito de cierre acierta 53,9 % con una log-loss de 0,961 (n = 2.919)'}, valores típicos de cuotas previas al partido (unas cuotas contaminadas por el resultado acertarían mucho más); en la revisión del 18 nov, frente al último registro previo al partido (n = 280) la probabilidad del resultado real solo subía 0,37 pp en el cierre, sin ningún caso de más de 15 pp, y re-prediciendo el holdout con las cuotas de APERTURA el acierto era 88,9 % (con cierre, 88,8 %).`,
      'Fugas residuales mínimas (medidas en la revisión del 18 nov): la liga doméstica asignada a cada equipo y el Elo inicial usan información posterior; rehaciendo todo el contexto solo con datos hasta el final de cada día, en 5 días del holdout (231 partidos) las probabilidades no cambian y en dos días anteriores la diferencia máxima es de 0,0005, sin cambiar ningún pronóstico. Los pesos del ensamble se ajustaron el 3 nov con partidos que incluyen el holdout: con pesos alternativos (0,2/0,2/0,6 y 0,7/0,3) y reglas reajustadas solo en calibración, el holdout acertaba 88,9 % (frente a 88,8 %).',
      `Límites de la validación: el holdout cubre solo unos dos meses; los picks sin cuotas (Nations League, copas, ligas sin precios) son pocos fuera de muestra${t.bySource?.find((x) => x.source === 'estadistico') ? ` (${n0(t.bySource.find((x) => x.source === 'estadistico')!.n)})` : ''}; los intervalos de Wilson suponen picks independientes (con 2 por partido no lo son del todo; un bootstrap por día da intervalos casi iguales). Las cifras se recalculan en cada actualización.`,
    );
  } else {
    body.push('Todavía no hay suficientes partidos terminados para medir el acierto fuera de muestra: no se publican pronósticos de alta confianza.');
  }
  body.push('Juego responsable: son estimaciones estadísticas, no garantías. Solo mayores de 18 años y con dinero que puedas permitirte perder.');
  return { title: 'Pronósticos de alta confianza', body };
}

/** Sección «Pronósticos del día» con las cifras reales (walk-forward) de este build. */
export function dailySection(df: DailyFile | undefined, fam: DailyFamiliesSummary | undefined): ModelFile['sections'][number] {
  const body: string[] = [
    'Qué es: para cada partido de hoy y de los días siguientes con partidos (máximo 4 días) se reúnen TODAS las selecciones que superan una regla validada fuera de muestra —las de alta confianza (resultado, goles, córners, tarjetas) y tres grupos propios de este apartado: tiros y tiros a puerta, faltas y jugadores— con los números esperados del partido, un análisis en viñetas y una frase por pronóstico con las cifras que lo sostienen. Como mucho 2 por categoría y 8 por partido, sin redundancias (nunca «más de 6,5» y «más de 7,5» de lo mismo, ni dos pronósticos de resultado, ni dos del mismo jugador).',
    'Familias propias, mismo rigor: tiros a puerta totales y por equipo, tiros totales y faltas salen de las proyecciones binomial negativa (con partidos de días anteriores); los pronósticos de jugador («1+ tiro», «2+ tiros», «1+ tiro a puerta», «marca gol») de sus tasas por 90 minutos con líneas de jugador anteriores al partido, solo para quien tiene 60 o más minutos esperados, jugó alguno de los 2 últimos partidos de su equipo y suma 270 minutos. Cada familia y fuente (con cuotas / sin cuotas) se recalibra (Platt), solo se usa su franja oro (85 % o más en su histórico) y solo se publica si en el walk-forward mensual acumula al menos 30 pronósticos con un 80 % o más de acierto. Se resuelven con las estadísticas del partido (sin dato no se evalúa; con prórroga se excluye); si el jugador no juega, el pronóstico es nulo, como hacen las casas.',
  ];
  if (fam) {
    const list = (xs: DailyFamiliesSummary['published']) => xs.map((x) => `${x.label} · ${x.source} (${n0(x.hits)}/${n0(x.n)})`).join('; ');
    body.push(
      `En este build: ${fam.published.length} reglas propias publicadas${fam.published.length ? ` — ${list(fam.published)}` : ''}.` +
        (fam.unvalidated.length ? ` No publicadas (sin validación suficiente fuera de muestra o sin franja oro): ${list(fam.unvalidated)}.` : '') +
        (fam.discarded.length ? ` Sin regla (su probabilidad no llega a un 82 % recalibrado con muestra suficiente): ${fam.discarded.join('; ')}.` : ''),
    );
  }
  const t = df?.track;
  const o = t?.overall;
  if (t && o && o.n > 0) {
    const b = t.baseline;
    body.push(
      `Récord fuera de muestra de esta misma regla de selección (walk-forward mensual del ${day(o.from)} al ${day(o.to)}, ${n0(o.matches ?? 0)} partidos; en cada mes, reglas ajustadas y validadas solo con lo anterior): ${rateWithCi(o)}${o.voids ? `, ${n0(o.voids)} nulos` : ''}.` +
        (b && b.n > 0 ? ` Una estrategia fija SIN modelo (${b.label}) acierta ${rateWithCi(b)} en los mismos partidos: casi todo el acierto es estructural.` : ''),
    );
    body.push(
      `Por categoría (acierto fuera de muestra frente a la tasa base de sus familias, es decir, su selección natural sin umbral): ${t.byCategory
        .map((x) => `${x.label} ${pc(x.hitRate, 1)} (${n0(x.hits)}/${n0(x.n)}${x.voids ? `, ${n0(x.voids)} nulos` : ''}${x.baseRate !== undefined ? `; base ${pc(x.baseRate, 1)}` : ''})`)
        .join('; ')}.`,
    );
    body.push(
      'Puntuación 0–100 de cada pronóstico: 50 % probabilidad recalibrada, 30 % límite inferior de Wilson (90 %) del récord fuera de muestra de su regla y 20 % lift sobre la tasa base de su familia; se restan 8 puntos si el lift es nulo o negativo (acierto puramente estructural). En el walk-forward la puntuación de cada mes solo usa el récord y las tasas base anteriores a ese mes. Los mejores del día: uno por partido, por puntuación, y como mucho 3 del mismo mercado.',
    );
    if (t.combos?.length) {
      body.push(
        `Combinadas: patas de partidos distintos (una por partido, primero las de lift positivo y como mucho 2 del mismo mercado); la probabilidad es el producto de las probabilidades recalibradas, suponiendo partidos independientes. Fuera de muestra, por día en que se pudieron formar: ${t.combos
          .map((x) => `${x.label.toLowerCase()} ${pc(x.hitRate, 1)} (${n0(x.hits)}/${n0(x.days)} días; ${d(x.avgLegs, 1)} patas, cuota justa media ${d(x.avgFairOdds)})`)
          .join('; ')}. Una pata nula no cuenta; cuantas más patas, más días falla.`,
      );
    }
    body.push(
      'Límites: son selecciones de cuota baja (alto acierto NO es beneficio ni ventaja frente a la casa, que cobra margen); la fuente no publica cuotas de tiros, faltas ni jugadores, así que su rentabilidad no se puede medir; los pronósticos de jugador dependen de la alineación, que no se conoce al calcularlos; los partidos de hoy ya terminados se muestran con sus pronósticos reconstruidos (reglas ajustadas sin ese partido) y resueltos, y los que están en juego con los calculados solo con información anterior al saque (última cuota previa), así que pueden diferir ligeramente de los que se vieron antes de empezar.',
    );
  } else {
    body.push('Todavía no hay suficientes partidos terminados para medir el acierto fuera de muestra: no se publican pronósticos del día.');
  }
  body.push('Juego responsable: son estimaciones estadísticas, no garantías. Solo mayores de 18 años y con dinero que puedas permitirte perder.');
  return { title: 'Pronósticos del día', body };
}

/**
 * Revisión independiente del historial de «Cuota alta 6+» (26-nov-2026): cifras FIJAS con fecha (no se recalculan; las
 * vigentes son las del párrafo de historial, que sí sale de cada build).
 */
export function longshotReviewNote(): string {
  return (
    'Revisión del 26-nov-2026 (1-jun → 25-nov, 152 días): un recálculo independiente de la regla (selecciones, recalibración, regla diaria, resolución a 90\' y ROI reimplementados aparte) dio exactamente las mismas cifras que el historial publicado: 185 aciertos en 1454 apuestas resueltas (12,7 %, el modelo esperaba 14,8 %) y ROI −19,8 % con la cuota de cierre (n = 709, −140,3 unidades). ' +
    'Las que el modelo veía con valor esperado POSITIVO perdieron más (337 apuestas, 34 aciertos, ROI −33,0 %) que el resto (372 apuestas, ROI −7,8 %): el valor esperado del modelo no sirve para ganar a la casa en este rango de cuotas. ' +
    'En las sorpresas la probabilidad media del modelo (14,95 %) era casi la implícita en la cuota de cierre con margen (14,93 %) y se acertó un 11,6 %: las cuotas altas pagan menos de lo que valen (sesgo favorito–no favorito), y la casa lo cobra. ' +
    'Por meses el resultado varía mucho (junio 0 de 65; julio ROI +6,2 %, n = 61; agosto −49,0 %, n = 171; noviembre +8,8 %, n = 136): un mes bueno no indica nada. Con las mismas entradas, confidence.json y daily.json no cambian al añadir este apartado.'
  );
}

/** Sección «Cuota alta 6+» con las cifras reales (walk-forward) de este build. */
export function longshotSection(lf: LongshotFile | undefined): ModelFile['sections'][number] {
  const body: string[] = [
    `Qué es: apuestas cuya cuota es ${MIN_ODDS} o más. Por definición aciertan como mucho 1 de cada ${MIN_ODDS} veces y solo se gana a la larga si la probabilidad real supera la implícita en la cuota (valor esperado positivo). Para cada apuesta se publica la probabilidad del modelo, la cuota justa (1/p), la cuota de la casa cuando la fuente la da (DraftKings vía ESPN: solo 1X2, más/menos y hándicap principales) y el valor esperado (p · cuota − 1).`,
    `Candidatos por partido (cuota de la casa si existe; si no, la justa): sorpresas 1X2 con cuota entre ${MIN_ODDS} y ${MAX_SINGLE_ODDS} (victoria del no favorito o empate); los 2 marcadores exactos más probables con cuota justa ${MIN_ODDS} o más (de la matriz de marcadores); goleadores con probabilidad de marcar entre ${d(SCORER_MIN_PROB)} y 1/${MIN_ODDS} y ${SCORER_MIN_EXP_MINUTES} o más minutos esperados (mismos jugadores elegibles que los pronósticos del día); y combinadas de ${COMBO_MIN_LEGS} a ${COMBO_MAX_LEGS} patas de PARTIDOS DISTINTOS con cuota de la casa (cada pata entre ${d(LEG_MIN_ODDS)} y ${d(LEG_MAX_ODDS)} y probabilidad de ${pcI(LEG_MIN_PROB)} o más; la de mayor valor esperado de cada partido) cuyo producto de cuotas queda entre ${MIN_ODDS} y ${COMBO_MAX_ODDS}. La probabilidad de una combinada es el producto de las de sus patas (partidos independientes).`,
    `Selección diaria: puntuación 0–100 = 40 % probabilidad respecto a la de cuota ${MIN_ODDS}, 40 % valor esperado (sin cuota de la casa se asume un valor esperado de −${pcI(Math.abs(UNPRICED_EV))}, el margen típico de marcador y goleador) y 20 % prestigio de la competición; como mucho ${MAX_PER_KIND} por tipo, sin repetir partido dentro de un tipo, y ${MAX_PER_DAY} por día. Las probabilidades se recalibran (Platt por grupo de selección, ajustado cada mes solo con días anteriores): sobre todo baja la de los goleadores, que el modelo inflaba.`,
  ];
  const t = lf?.track;
  const rows = (t?.byKind ?? []).filter((r) => r.bets > 0);
  if (t && rows.length) {
    body.push(
      `Historial FUERA DE MUESTRA (la misma regla aplicada a cada día del ${day(t.from)} al ${day(t.to)} con predicciones que solo usan datos anteriores a cada partido, resultado a 90'): ${rows
        .map((r) => {
          const settled = r.bets - (r.voids ?? 0);
          const roi = r.roi ? `; ROI contra la cuota de cierre ${r.roi.roi >= 0 ? '+' : '−'}${d(Math.abs(r.roi.roi * 100), 1)} % (n = ${n0(r.roi.bets)})` : '; sin cuota de la casa, ROI no medible';
          return `${lcFirst(r.label)}: ${n0(r.hits)} de ${n0(settled)} (${pcI(r.hitRate, 1)}; el modelo esperaba ${pcI(r.expectedHitRate, 1)}), cuota media ${d(r.avgOdds)}${roi}; racha más larga sin acertar ${r.longestLosingStreak ?? 0}`;
        })
        .join(' · ')}.`,
    );
    // total del apartado (suma de los tipos): aciertos sobre resueltas y ROI de las que tenían cuota de cierre en todas sus patas
    const hits = rows.reduce((s, r) => s + r.hits, 0);
    const settled = rows.reduce((s, r) => s + r.bets - (r.voids ?? 0), 0);
    const exp = settled ? rows.reduce((s, r) => s + r.expectedHitRate * (r.bets - (r.voids ?? 0)), 0) / settled : 0;
    const roiBets = rows.reduce((s, r) => s + (r.roi?.bets ?? 0), 0);
    const profit = rows.reduce((s, r) => s + (r.roi?.profit ?? 0), 0);
    if (settled > 0) {
      body.push(
        `En total: ${n0(hits)} aciertos en ${n0(settled)} apuestas resueltas (${pcI(hits / settled, 1)}${hits > 0 ? `, 1 de cada ${Math.round(settled / hits)}` : ''}; el modelo esperaba ${pcI(exp, 1)}: es optimista con las apuestas que elige)${
          roiBets > 0 ? ` y, con 1 unidad a cada una de las ${n0(roiBets)} que tenían cuota de cierre, ${profit >= 0 ? '+' : '−'}${d(Math.abs(profit), 1)} unidades (ROI ${profit >= 0 ? '+' : '−'}${d(Math.abs((profit / roiBets) * 100), 1)} %)` : ''
        }. ${
          rows.some((r) => r.roi) && rows.every((r) => !r.roi || r.roi.profit < 0)
            ? 'Ningún tipo con cuota de la casa ha ganado dinero fuera de muestra.'
            : 'Un ROI positivo con muestras así puede ser suerte: no garantiza nada.'
        }`,
      );
    }
    const cal = t.calibration.filter((b) => b.n > 0);
    if (cal.length) {
      body.push(
        `Calibración del modelo en la banda de probabilidad baja (1X2, los 3 marcadores más probables y goleadores, recalibrados walk-forward): ${cal
          .map((b) => `${pcI(b.from)}–${pcI(b.to)}: predicho ${pcI(b.predicted, 1)}, observado ${pcI(b.observed, 1)} (n = ${n0(b.n)})`)
          .join('; ')}.`,
      );
    }
    const ex = (t.byKind ?? []).filter((r) => r.excluded);
    body.push(
      ex.length
        ? `Tipos que no se publican como recomendación (exigencia: ${GATE_MIN_N} apuestas resueltas fuera de muestra y que el límite superior de Wilson del acierto llegue al ${pcI(GATE_MIN_RATIO)} de lo que prometía el modelo): ${ex.map((r) => `${lcFirst(r.label)} (${r.excluded})`).join('; ')}.`
        : `Todos los tipos cumplen la exigencia mínima para publicarse (${GATE_MIN_N} apuestas resueltas fuera de muestra y acierto compatible con al menos el ${pcI(GATE_MIN_RATIO)} de lo prometido), lo que NO significa que sean rentables.`,
    );
  } else {
    body.push('Todavía no hay historial suficiente para medir estas apuestas fuera de muestra: no se publica ninguna recomendación.');
  }
  body.push(
    'Límites: la casa no publica en la fuente cuotas de marcador exacto ni de goleador (sus márgenes suelen ser mucho mayores que en el 1X2), así que su valor esperado no se puede medir; el modelo apenas difiere del mercado en el 1X2 y, cuando lo hace, la casa suele tener razón; en las combinadas el margen se multiplica en cada pata; las de hoy ya jugadas se muestran con su resultado.',
  );
  body.push(
    'Cómo se mide el historial (y qué no es idéntico a producción): en los partidos pasados la fuente solo guarda la cuota de CIERRE (la última antes del saque), así que el historial la usa como entrada del modelo (componente de mercado del 1X2), para elegir las patas de las combinadas y el rango 6–15 de las sorpresas, y para el ROI. Es información anterior al partido, pero en producción las apuestas se publican con la cuota del momento, a veces días antes, y quien apueste lo hará a la cuota que encuentre. Los goleadores del historial solo se evalúan en partidos con alineaciones y minutos publicados (sin ellos no se pueden resolver); si el jugador no juega, la apuesta es nula y no cuenta en el porcentaje.',
  );
  body.push(longshotReviewNote());
  body.push('Juego responsable: la mayoría de estas apuestas pierden. Solo mayores de 18 años y con dinero que puedas permitirte perder.');
  return { title: 'Cuota alta 6+', body };
}

/**
 * Cambios de modelo integrados el 22-nov-2026 tras el banco de pruebas (pipeline/experiments, protocolo tuning / T1 / T2
 * y un único vistazo al holdout, registrado en .cache/holdout-looks.log). Cifras fijas, con fecha: no se recalculan.
 */
export function modelChangesSection(): ModelFile['sections'][number] {
  return {
    title: 'Cambios del modelo (22-nov-2026)',
    body: [
      'Protocolo: cada idea se probó en un banco de pruebas con las mismas predicciones walk-forward que producción, en una ventana de ajuste y dos de comprobación (T1 y T2), con intervalos bootstrap por días y comprobación automática de fuga. Solo lo que mejoró de forma estable se miró UNA vez en el holdout (16-sep → 21-nov-2026, 1.713 partidos, resultado a 90 minutos) antes de integrarlo.',
      `Adoptado: (1) contracción del total de goles hacia la media de la competición en partidos sin línea de goles de la casa (s = ${d(MODEL.totalShrink.s, 1)}, sin copas nacionales); (2) contracción más fuerte de las tasas de córners y tarjetas (${STAT_PRIOR_N} partidos ficticios en lugar de 6). Holdout (22-nov-2026): córners Brier 0,2463 → 0,2400 y tarjetas 0,2372 → 0,2295 (mejoras claras); más/menos 2,5 goles 0,2369 → 0,2368 y ambos marcan 0,2476 → 0,2472 (prácticamente igual); 1X2 sin cambio significativo (RPS 0,1978 → 0,1980, diferencia +0,0002 con intervalo [−0,0004; +0,0006]; acierto 55,2 % en ambos).`,
      'Probado y REVERTIDO: una ventaja local por grupo de competiciones para convertir el Elo en 1X2 (ligas europeas 50, copas europeas 25, continentales europeas 80, ligas americanas 70, continentales americanas 75 puntos). Mejoraba en ajuste y T2, pero en el holdout no se repitió (+0,00015 de RPS, n.s.; peor en competiciones continentales, +0,00122 [+0,00046; +0,00221]): se mantiene la ventaja de 65 puntos de los ratings.',
      'Probado y NO adoptado (no superaron el protocolo, sin llegar al holdout): goles «ajustados» con un xG aproximado por tiros en el ajuste de Dixon-Coles; un combinador aprendido (pool logarítmico reajustado cada mes) en lugar del pool lineal, que mejoraba poco en ajuste y T2 pero no en T1 (intervalo que cruza el 0) y empeoraba en las ligas top; y factores de contexto (descanso, partidos acumulados, competición europea, ascenso, inicio de temporada, movimiento de cuotas), sin mejora estable en T1 ni T2.',
      'Honestidad: el holdout ya se ha mirado una vez para estas decisiones; las cifras de acierto publicadas en el resto de secciones se recalculan en cada actualización con los datos del momento.',
    ],
  };
}

export function methodologySections(i: MethodologyInput): ModelFile['sections'] {
  const { ctx } = i;
  const s = ctx.suite;
  const dcs = [...s.dcModels.values()];
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rho = avg(dcs.map((m) => m.rho));
  const homeAdv = avg(dcs.map((m) => m.homeAdv));
  const finished = s.eloBuild.samples.length;
  const halfLife = Math.round(Math.log(2) / MODEL.dcXi);
  const bt = i.backtest;
  const sections: ModelFile['sections'] = [];

  sections.push({
    title: 'Fuentes de datos',
    body: [
      'Todos los datos proceden de la API pública de ESPN (sin clave): calendarios y resultados, clasificaciones, estadísticas de equipo por partido (tiros, tiros a puerta, córners, faltas, tarjetas, fueras de juego, posesión, paradas, pases), estadísticas individuales de cada jugador, eventos (goles, tarjetas, cambios) y cuotas de DraftKings.',
      `En este cálculo se han usado ${n0(finished)} partidos terminados de ${i.competitions} competiciones, ${n0(i.teams)} equipos con ficha y ${n0(i.players)} jugadores con minutos esta temporada. Se publican los partidos de los próximos ${UPCOMING_DAYS} días.`,
      'El pipeline se ejecuta varias veces al día: descarga los datos nuevos, re-ajusta todos los modelos y vuelve a publicar los JSON estáticos que lee la web. Los marcadores en vivo se consultan directamente desde el navegador.',
      'Limitaciones: ESPN no publica saques de banda ni saques de puerta, no hay xG basado en ocasiones (donde se muestra «xG» se trata de los goles esperados del modelo, λ) y no se modelan alineaciones confirmadas, lesiones ni sanciones.',
    ],
  });

  sections.push({
    title: 'Elo global',
    body: [
      'Un único rating Elo para todos los equipos de todas las competiciones, actualizado en orden cronológico: los partidos continentales e internacionales conectan la fuerza relativa entre ligas.',
      `Estilo World Football Elo: ΔR = K·G·(W − We), con K = ${MODEL.eloK} (×1,2 en competiciones continentales y ×0,9 en copas), ventaja de campo de ${MODEL.eloHomeAdv} puntos y multiplicador por diferencia de goles G (1 con uno o ninguno, 1,5 con dos y (11 + dif)/8 con tres o más).`,
      `Los equipos nuevos arrancan en ${MODEL.eloInit} + (tier − 5)·${MODEL.eloTierOffset} según el nivel de su liga doméstica; los recién ascendidos parten algo por debajo de la media de su liga. Los que solo aparecen en copas (categorías no cubiertas, incluso amateurs) arrancan con tier ${d(MODEL.cupOnlyTier, 0)} (${Math.round(MODEL.eloInit + (MODEL.cupOnlyTier - 5) * MODEL.eloTierOffset)} puntos)${Object.keys(CUP_ONLY_TIER).length ? `, y aún más abajo en las copas con rondas de clubes regionales (${Object.entries(CUP_ONLY_TIER).map(([id, t]) => `${ctx.compNames.get(id) ?? id}: ${Math.round(MODEL.eloInit + (t - 5) * MODEL.eloTierOffset)}`).join(', ')})` : ''}.`,
      'Las selecciones nacionales (Nations League) tienen su propio Elo y su propio ranking: el ranking Elo global se calcula solo entre clubes.',
      `El empate se modela explícitamente: P(empate) = base·exp(−(dif/escala)²), con base = ${d(s.eloBuild.drawParams.drawBase, 3)} y escala = ${Math.round(s.eloBuild.drawParams.drawScale)} ajustados por máxima verosimilitud.`,
    ],
  });

  sections.push({
    title: 'Dixon-Coles con decaimiento temporal',
    body: [
      'Modelo de Poisson bivariante de goles por liga: λ_local = base·ataque_local·defensa_visitante·ventaja_local y λ_visitante = base·ataque_visitante·defensa_local (ataque y defensa multiplicativos, 1 = media de la liga; defensa > 1 = encaja más).',
      `Corrección de Dixon-Coles para los marcadores bajos (0-0, 1-0, 0-1, 1-1) mediante el parámetro ρ ∈ [−0,2; 0,2]; en las ${dcs.length} ligas ajustadas ρ medio = ${d(rho, 3)} y la ventaja local media multiplica los goles del local por ${d(homeAdv)}.`,
      `Ponderación temporal w = exp(−ξ·días) con ξ = ${MODEL.dcXi} (vida media ≈ ${halfLife} días) sobre una ventana de ${MODEL.dcWindowDays} días, y regularización hacia la media de la liga para equipos con pocos partidos.`,
      `En copas y competiciones continentales, si ambos equipos comparten liga doméstica se usa su Dixon-Coles; si no, un modelo Elo→goles: supremacía = ${d(s.eloGoal.a, 3)} goles por cada 100 puntos Elo y total = media de goles de sus ligas × estilo de cada equipo (+${d(s.eloGoal.c, 3)}·(dif/100)²), calibrado con ${n0(s.eloGoal.n)} partidos. Esta parte pesa el ${pc(ELO_GOAL_WEIGHT_FACTOR)} del peso de Dixon-Coles en el ensamble.`,
    ],
  });

  sections.push({
    title: 'Mercado sin margen (método de Shin)',
    body: [
      'Las cuotas americanas de ESPN (DraftKings u otro proveedor) se convierten a decimales y se mide el margen de la casa: overround = Σ 1/cuota − 1.',
      'Para obtener la probabilidad que realmente descuenta el mercado se elimina el margen con el método de Shin, que modela la presencia de apostadores informados y corrige el sesgo favorito/no favorito mejor que el reparto proporcional.',
      'En los partidos ya jugados se usan las cuotas de cierre, que son la referencia más exigente para evaluar un modelo.',
    ],
  });

  sections.push({
    title: 'Ensamble y recalibración de λ',
    body: [
      `La probabilidad final 1X2 es un pool lineal. Con cuotas: Dixon-Coles ${pc(MODEL.wDixonColes)}, Elo ${pc(MODEL.wElo)} y mercado sin margen ${pc(MODEL.wMarket)}. Sin cuotas: Dixon-Coles ${pc(MODEL.wDixonColesNoMarket)} y Elo ${pc(MODEL.wEloNoMarket)}. Los dos juegos de pesos se eligen por separado con una rejilla sobre el backtest walk-forward (menor RPS).`,
      `El peso del mercado está limitado al ${pc(MODEL.wMarket)}: el backtest usa cuotas de cierre, más precisas que las cuotas previas con las que se predicen los partidos próximos, y copiar el mercado no aportaría una opinión propia. Si un equipo tiene menos de ${LOW_DATA_GAMES} partidos en el Elo (recién llegado, equipo de copa) y hay cuotas, el peso de Dixon-Coles y Elo baja de forma lineal a favor del mercado.`,
      'Después se recalibran los goles esperados: se buscan los (λ_local, λ_visitante) cuya matriz de Dixon-Coles reproduce el 1X2 del ensamble y la probabilidad de más de 2,5 goles (mezcla del modelo y de la línea de goles de la casa). Así todos los mercados derivados son coherentes con la probabilidad final.',
      `Partidos SIN línea de goles de la casa y fuera de las copas nacionales (desde el 22-nov-2026): el total de goles esperado se contrae hacia la media de la competición, T' = L + ${d(MODEL.totalShrink.s, 1)}·(T − L), manteniendo el 1X2. L son los goles por partido de la competición en los últimos ${MODEL.totalShrink.windowDays} días (vida media ${MODEL.totalShrink.halfLifeDays} días, ${MODEL.totalShrink.priorN} partidos ficticios hacia ${d(MODEL.totalShrink.globalTotal, 1)}), solo con partidos que empezaron antes. Motivo: sin mercado, los totales de Dixon-Coles estaban demasiado dispersos (donde predecía 1,78 goles hubo 2,12; donde 3,25, hubo 2,85). Las copas se excluyen porque contraerlas empeoraba (totales extremos reales en cruces entre categorías).`,
      'La confianza (0–1) combina el acuerdo entre fuentes (divergencia de Jensen-Shannon) y el volumen de datos de ambos equipos.',
    ],
  });

  sections.push({
    title: 'Mercados derivados de la matriz de marcadores',
    body: [
      `A partir de la matriz de marcadores (0–${MODEL.maxGoals} goles por equipo en la web; 0–10 en el cálculo) se obtienen de forma exacta: 1X2, doble oportunidad, empate no apuesta, más/menos 0,5–5,5, goles por equipo, goles exactos, par/impar, ambos marcan (y combinado con el resultado), hándicap asiático (−2,5 a +2,5 cada 0,25) y europeo, marcador exacto, margen de victoria, portería a cero, gana sin encajar y primer equipo en marcar.`,
      'Mitades: la primera parte usa el 45 % de los goles esperados y la segunda el 55 % (1X2 al descanso, más/menos por mitad y descanso/final).',
      'Cada selección muestra probabilidad, cuota justa (1/p), cuota de mercado cuando existe y valor esperado EV = p·cuota − 1.',
    ],
  });

  sections.push({
    title: 'Córners, tarjetas, tiros y faltas: binomial negativa',
    body: [
      'Para córners, tarjetas, tiros, tiros a puerta, faltas y fueras de juego se estima la media de cada equipo cruzando lo que genera (en casa o fuera) con lo que concede su rival, relativo a la media de la competición.',
      `Las tasas se contraen hacia la media con ${STAT_PRIOR_N} partidos ficticios (shrinkage empírico-bayesiano) y los partidos se ponderan por antigüedad (vida media de ${HALF_LIFE_DAYS} días). La contracción es más fuerte desde el 22-nov-2026 (antes 6 partidos ficticios, demasiado débil): en el holdout del 16-sep al 21-nov (1.713 partidos, mirado una sola vez) el Brier de córners bajó de 0,2463 a 0,2400 y el de tarjetas de 0,2372 a 0,2295.`,
      'Estas variables están sobredispersas (varianza mayor que la media), así que se modelan con una binomial negativa cuya dispersión se estima por el método de momentos sobre los residuos. El total sale de convolucionar las dos distribuciones: líneas de más/menos, total exacto y quién tendrá más.',
    ],
  });

  sections.push({
    title: 'Jugadores: estado de forma y props',
    body: [
      'Nota de partido 0–10 transparente: parte de 6,0 y suma goles (+1,2), asistencias (+0,8), tiros a puerta (+0,3) y tiros (+0,1), y resta tarjetas y autogoles; los porteros suman paradas y portería a cero. El índice de forma (0–100) es una media exponencial de las notas en los 5 últimos partidos del equipo (0 si no jugó) más un bonus por minutos.',
      'Props por partido: minutos esperados (media exponencial de los últimos partidos) y probabilidad de marcar, asistir, marcar o asistir, ≥1 y ≥2 tiros, ≥1 y ≥2 tiros a puerta, ver tarjeta y cometer ≥2 faltas.',
      'Las tasas por 90 minutos se contraen hacia la media de su posición; los goles, además, hacia un xG aproximado a partir de tiros y tiros a puerta. Se escalan con los goles esperados del equipo en ese partido y con lo que concede el rival (tiros, tiros a puerta, tarjetas y faltas proyectados).',
    ],
  });

  sections.push({
    title: 'Simulación Monte Carlo de temporada',
    body: [
      `Se simulan ${n0(MODEL.simIterations)} veces los partidos pendientes con goles de Poisson usando los goles esperados del modelo para cada cruce, partiendo de la clasificación actual (desempates: puntos, diferencia de goles, goles a favor y sorteo).`,
      'Resultado: puntos esperados, posición esperada, distribución completa de posiciones y probabilidad de cada zona (campeón, Champions, descenso, top 8...).',
      'Se usa el calendario real: en las temporadas que terminan el año siguiente (ligas europeas, fase de liga UEFA) también se descargan los partidos de enero a mayo. Solo si la fuente aún no los publica, en las ligas a doble vuelta se añaden los cruces que faltan y en la fase de liga UEFA se completan emparejamientos sintéticos hasta el número de partidos del formato.',
    ],
  });

  const btLine = bt
    ? `Backtest de la temporada actual: ${n0(bt.matches)} partidos; RPS ${d(bt.model.rps, 4)} (Elo ${bt.elo ? d(bt.elo.rps, 4) : '—'}, Dixon-Coles ${bt.dixonColes ? d(bt.dixonColes.rps, 4) : '—'}, frecuencias de la liga ${d(bt.baseline.rps, 4)}${bt.market ? `, mercado ${d(bt.market.rps, 4)} en ${n0(bt.marketMatches ?? 0)} partidos con cuotas` : ''}); acierto ${pc(bt.model.accuracy, 1)}.`
    : 'Aún no hay suficientes partidos terminados para un backtest.';
  sections.push({
    title: 'Backtest walk-forward y métricas',
    body: [
      'Cada partido terminado de la temporada actual se predice solo con la información disponible antes de jugarse: Elo previo al partido, Dixon-Coles re-ajustado cada semana con los partidos anteriores (más las cuotas de cierre cuando existen) y, para cada competición, los parámetros de empate del Elo, el modelo Elo→goles y las medias de goles ajustados solo con partidos anteriores al inicio de su temporada.',
      'Métricas: Brier multiclase (suma de errores cuadráticos de las 3 probabilidades), log-loss, RPS (Ranked Probability Score, la métrica de referencia para 1X2 porque respeta el orden local-empate-visitante) y porcentaje de acierto del resultado más probable. Menor es mejor salvo el acierto.',
      'La calibración agrupa las probabilidades en tramos del 10 %: un modelo bien calibrado acierta el 40 % de las veces cuando dice 40 %. También se evalúan más/menos 2,5 y ambos marcan, y se simula el ROI de apostar 1 unidad a la selección 1X2 de mayor valor contra las cuotas de cierre.',
      btLine,
    ],
  });

  sections.push(modelChangesSection());
  sections.push(confidenceSection(i.confidence, bt));
  if (i.daily) sections.push(dailySection(i.daily, i.dailyFamilies));
  if (i.longshots) sections.push(longshotSection(i.longshots));

  sections.push({
    title: 'Calidad de los datos',
    body: [
      'Cada respuesta de ESPN se comprueba antes de usarla (tamaño máximo, tipo JSON, estructura) y cada partido, jugador o fila de clasificación se normaliza por separado: un registro dañado se descarta sin afectar al resto. Los textos se limpian, los logos solo se aceptan desde el CDN de ESPN por https y los números imposibles (marcadores, porcentajes, estadísticas) se descartan.',
      'El almacén de datos se guarda de forma atómica con copia de seguridad; si un archivo apareciera dañado, se recupera la copia anterior.',
      'Antes de publicar, todos los JSON se validan contra el contrato de datos y contra umbrales de cordura (número de competiciones con datos, partidos analizados, partidos en portada). Si algo falla no se publica nada y la web sigue mostrando la última versión buena.',
    ],
  });

  sections.push({
    title: 'Apuestas de valor y criterio de Kelly fraccional',
    body: [
      `Una selección es de valor cuando EV = p·cuota − 1 ≥ ${pc(MODEL.minEv)}, la probabilidad del modelo es al menos del ${pc(MODEL.minProb)} y la cuota no supera ${MODEL.maxOdds}. Se descartan los EV superiores al ${pc(MAX_EV)} (casi siempre información que el modelo no tiene o una cuota mal capturada) y los cruces sin Dixon-Coles.`,
      `El stake sugerido usa el criterio de Kelly f = (p·cuota − 1)/(cuota − 1) en versión fraccional (${MODEL.kellyFraction} de Kelly) con un tope del ${pc(MODEL.kellyCap)} del bankroll, para reducir la varianza y el impacto de los errores del modelo.`,
      `Cada selección lleva edge (p − 1/cuota), cuota justa y una confianza alta/media/baja. Hoy hay ${n0(i.valueBets)} selecciones de valor en los próximos ${UPCOMING_DAYS} días.`,
    ],
  });

  sections.push({
    title: 'Juego responsable (+18)',
    body: [
      'FutStat Lab es una herramienta de análisis estadístico con fines informativos y educativos. No es una casa de apuestas ni un servicio de pronósticos, y ninguna probabilidad garantiza un resultado.',
      'Incluso con valor esperado positivo se pierde con frecuencia: la varianza es enorme y las casas ajustan sus cuotas con información que el modelo no tiene. Las cuotas de cierre suelen ser más precisas que cualquier modelo público.',
      'Si apuestas, hazlo solo si eres mayor de edad, con dinero que puedas permitirte perder y con límites de tiempo y gasto. Si el juego deja de ser un entretenimiento, pide ayuda: en España, jugarbien.es (Ministerio de Consumo) y la Federación Española de Jugadores de Azar Rehabilitados (FEJAR, 900 200 225).',
    ],
  });

  return sections;
}

/** Parámetros publicados: MODEL + valores ajustados en este build. */
export function modelParameters(ctx: BuildContext): Record<string, number | string> {
  const s = ctx.suite;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(MODEL)) {
    // parámetros compuestos (ventaja local por grupo, contracción del total): una clave plana por campo
    if (v && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) out[`${k}.${sk}`] = sv as number;
    else out[k] = v as number;
  }
  out.eloDrawBase = Math.round(s.eloBuild.drawParams.drawBase * 1000) / 1000;
  out.eloDrawScale = Math.round(s.eloBuild.drawParams.drawScale);
  out.eloGoalSupremacyPer100 = Math.round(s.eloGoal.a * 1000) / 1000;
  out.eloGoalTotalQuad = Math.round(s.eloGoal.c * 1000) / 1000;
  out.maxEv = MAX_EV;
  out.dixonColesLeagues = s.dcModels.size;
  out.refDate = ctx.refDate;
  return out;
}
