/**
 * Secciones de metodología (español) de public/data/model.json, con los valores ajustados en este build.
 */
import type { BacktestSummary, ModelFile } from '../../src/types/data';
import { MODEL, UPCOMING_DAYS } from '../config';
import { MAX_EV } from '../analytics/value';
import { ELO_GOAL_WEIGHT_FACTOR } from '../analytics/predict';
import { PRIOR_N as STAT_PRIOR_N, HALF_LIFE_DAYS } from '../analytics/projections';
import type { BuildContext } from './context';

const n0 = (x: number) => Math.round(x).toLocaleString('es-ES');
const d = (x: number, k = 2) => x.toFixed(k).replace('.', ',');
const pc = (x: number, k = 0) => `${(x * 100).toFixed(k).replace('.', ',')} %`;

export interface MethodologyInput {
  ctx: BuildContext;
  backtest?: BacktestSummary;
  competitions: number;
  teams: number;
  players: number;
  valueBets: number;
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
      `Los equipos nuevos arrancan en ${MODEL.eloInit} + (tier − 5)·${MODEL.eloTierOffset} según el nivel de su liga doméstica; los recién ascendidos parten algo por debajo de la media de su liga.`,
      `El empate se modela explícitamente: P(empate) = base·exp(−(dif/escala)²), con base = ${d(s.eloBuild.drawParams.drawBase, 3)} y escala = ${Math.round(s.eloBuild.drawParams.drawScale)} ajustados por máxima verosimilitud.`,
    ],
  });

  sections.push({
    title: 'Dixon-Coles con decaimiento temporal',
    body: [
      'Modelo de Poisson bivariante de goles por liga: λ_local = base·ataque_local·defensa_visitante·ventaja_local y λ_visitante = base·ataque_visitante·defensa_local (ataque y defensa multiplicativos, 1 = media de la liga; defensa > 1 = encaja más).',
      `Corrección de Dixon-Coles para los marcadores bajos (0-0, 1-0, 0-1, 1-1) mediante el parámetro ρ ∈ [−0,2; 0,2]; en las ${dcs.length} ligas ajustadas ρ medio = ${d(rho, 3)} y la ventaja local media multiplica los goles del local por ${d(homeAdv)}.`,
      `Ponderación temporal w = exp(−ξ·días) con ξ = ${MODEL.dcXi} (vida media ≈ ${halfLife} días) sobre una ventana de ${MODEL.dcWindowDays} días, y regularización hacia la media de la liga para equipos con pocos partidos.`,
      `En copas y competiciones continentales, si ambos equipos comparten liga doméstica se usa su Dixon-Coles; si no, un modelo Elo→goles: supremacía = ${d(s.eloGoal.a, 3)} goles por cada 100 puntos Elo y total = media de goles de sus ligas × estilo de cada equipo (+${d(s.eloGoal.c, 3)}·(dif/100)²), calibrado con ${n0(s.eloGoal.n)} partidos. Esta parte pesa ${d(ELO_GOAL_WEIGHT_FACTOR * MODEL.wDixonColes, 2)} en el ensamble.`,
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
      `La probabilidad final 1X2 es un pool lineal: Dixon-Coles ${pc(MODEL.wDixonColes)}, Elo ${pc(MODEL.wElo)} y mercado sin margen ${pc(MODEL.wMarket)}. Si falta una fuente (por ejemplo, sin cuotas) los pesos se renormalizan.`,
      'Después se recalibran los goles esperados: se buscan los (λ_local, λ_visitante) cuya matriz de Dixon-Coles reproduce el 1X2 del ensamble y la probabilidad de más de 2,5 goles (mezcla del modelo y de la línea de goles de la casa). Así todos los mercados derivados son coherentes con la probabilidad final.',
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
      `Las tasas se contraen hacia la media con ${STAT_PRIOR_N} partidos ficticios (shrinkage empírico-bayesiano) y los partidos se ponderan por antigüedad (vida media de ${HALF_LIFE_DAYS} días).`,
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
      'Cuando la fuente aún no publica el calendario completo (partidos del año siguiente), en las ligas a doble vuelta se añaden los cruces que faltan y en la fase de liga UEFA se completan emparejamientos sintéticos hasta el número de partidos del formato.',
    ],
  });

  const btLine = bt
    ? `Backtest de la temporada actual: ${n0(bt.matches)} partidos; RPS ${d(bt.model.rps, 4)} (Elo ${bt.elo ? d(bt.elo.rps, 4) : '—'}, Dixon-Coles ${bt.dixonColes ? d(bt.dixonColes.rps, 4) : '—'}, frecuencias de la liga ${d(bt.baseline.rps, 4)}${bt.market ? `, mercado ${d(bt.market.rps, 4)} en ${n0(bt.marketMatches ?? 0)} partidos con cuotas` : ''}); acierto ${pc(bt.model.accuracy, 1)}.`
    : 'Aún no hay suficientes partidos terminados para un backtest.';
  sections.push({
    title: 'Backtest walk-forward y métricas',
    body: [
      'Cada partido terminado de la temporada actual se predice solo con la información disponible antes de jugarse: Elo previo al partido y Dixon-Coles re-ajustado cada semana con los partidos anteriores (más las cuotas de cierre cuando existen).',
      'Métricas: Brier multiclase (suma de errores cuadráticos de las 3 probabilidades), log-loss, RPS (Ranked Probability Score, la métrica de referencia para 1X2 porque respeta el orden local-empate-visitante) y porcentaje de acierto del resultado más probable. Menor es mejor salvo el acierto.',
      'La calibración agrupa las probabilidades en tramos del 10 %: un modelo bien calibrado acierta el 40 % de las veces cuando dice 40 %. También se evalúan más/menos 2,5 y ambos marcan, y se simula el ROI de apostar 1 unidad a la selección 1X2 de mayor valor contra las cuotas de cierre.',
      btLine,
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
  for (const [k, v] of Object.entries(MODEL)) out[k] = v as number;
  out.eloDrawBase = Math.round(s.eloBuild.drawParams.drawBase * 1000) / 1000;
  out.eloDrawScale = Math.round(s.eloBuild.drawParams.drawScale);
  out.eloGoalSupremacyPer100 = Math.round(s.eloGoal.a * 1000) / 1000;
  out.eloGoalTotalQuad = Math.round(s.eloGoal.c * 1000) / 1000;
  out.maxEv = MAX_EV;
  out.dixonColesLeagues = s.dcModels.size;
  out.refDate = ctx.refDate;
  return out;
}
