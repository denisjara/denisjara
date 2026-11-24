/**
 * Rasgos de CONTEXTO de un partido (variantes «context*»), calculados SOLO con la vista del pasado (`HistoryView`,
 * partidos terminados con inicio anterior al del partido) y con el propio partido pre-partido (`PreMatch`: fecha,
 * competición, campo neutral y cuotas, sin resultado).
 *
 * Criterio de calendario: solo se usan partidos YA JUGADOS antes del inicio. Los partidos futuros ya programados
 * (p. ej. «el martes juega la Champions») NO están disponibles en los ganchos (la vista del pasado solo devuelve
 * partidos terminados), así que el rasgo «antes de competición europea» no se calcula (ver openIssues del informe).
 *
 * Todos los rasgos se expresan desde el punto de vista de cada equipo (sufijos H = local, A = visitante):
 *  - restH/restA      días desde el último partido (cualquier competición del conjunto de datos), recortados a [0, 30]
 *  - shortH/shortA    déficit de descanso: max(0, 4 − descanso) (0 con 4 días o más)
 *  - longH/longA      1 si el descanso es >= 10 días (parón, inicio de temporada)
 *  - n14H/n14A        partidos jugados en los 14 días anteriores
 *  - euroH/euroA      1 si el último partido (hace <= 4 días) fue continental y este no lo es
 *  - promH/promA      1 si el equipo no jugó esta liga la temporada anterior y la liga sí tiene datos de esa temporada
 *                     (recién ascendido o recién llegado); solo ligas
 *  - gamesH/gamesA    partidos jugados en esta competición y temporada
 *  - nCompH/nCompA    partidos del equipo en esta competición en los últimos 540 días (≈ muestra del Dixon-Coles)
 *  - lgHA             log(goles locales / goles visitantes) de la competición en los últimos 365 días, contraído hacia
 *                     el valor típico (0,25) con 60 partidos ficticios; 0 en campo neutral
 *  - teamHAH          ventaja local propia del equipo local: diferencia de goles media en casa − fuera en los últimos
 *                     540 días (todas las competiciones), contraída hacia la media de la liga con 30 partidos ficticios,
 *                     en goles por partido; 0 en campo neutral
 *  - mvHA, mvDraw     movimiento del mercado 1X2 apertura → cuota usada (cierre en partidos terminados): cambio del
 *                     log(pH/pA) y del log(pD) sin margen; 0 sin cuotas de apertura
 *  - mvOver           movimiento del logit de P(más) en la línea de totales; 0 sin cuotas de apertura
 *  - hasOpen          1 si hay cuotas 1X2 de apertura y de cierre
 *  - neutral, isLeague  campo neutral; la competición es una liga
 */
import { devig } from '../../../src/lib/models';
import type { CompetitionConfig } from '../../config';
import type { MatchRecord } from '../../types';
import type { FeatureContext, Features, HistoryView, PreMatch } from '../types';

const DAY_MS = 86_400_000;

function kindOf(configs: ReadonlyMap<string, CompetitionConfig>, compId: string): CompetitionConfig['kind'] | undefined {
  return configs.get(compId)?.kind;
}

interface TeamCtx {
  rest: number;
  short: number;
  long: number;
  n14: number;
  euro: number;
  prom: number;
  games: number;
  nComp: number;
}

function teamContext(ctx: FeatureContext, match: PreMatch, before: HistoryView, teamId: string): TeamCtx {
  const prev = before.teamMatches(teamId);
  const cutoff = before.cutoff;
  const last = prev[prev.length - 1];
  const rest = last ? Math.min(30, Math.max(0, (cutoff - Date.parse(last.date)) / DAY_MS)) : 30;
  let n14 = 0;
  for (let i = prev.length - 1; i >= 0; i--) {
    if (cutoff - Date.parse(prev[i].date) <= 14 * DAY_MS) n14++;
    else break;
  }
  const thisKind = ctx.comp.kind;
  const euro = last && rest <= 4 && thisKind !== 'continental' && kindOf(ctx.configs, last.compId) === 'continental' ? 1 : 0;
  let games = 0;
  let lastSeason = 0;
  let nComp = 0;
  for (const m of prev) {
    if (m.compId !== match.compId) continue;
    if (cutoff - Date.parse(m.date) <= 540 * DAY_MS) nComp++;
    if (m.season === match.season) games++;
    else if (m.season === match.season - 1) lastSeason++;
  }
  let prom = 0;
  if (thisKind === 'league' && lastSeason === 0) {
    // la liga tiene datos de la temporada anterior (si no, no se sabe quién ascendió)
    const comp = before.compMatches(match.compId);
    let any = 0;
    for (let i = comp.length - 1; i >= 0 && any < 50; i--) if (comp[i].season === match.season - 1) any++;
    if (any >= 50) prom = 1;
  }
  return { rest, short: Math.max(0, 4 - rest), long: rest >= 10 ? 1 : 0, n14, euro, prom, games, nComp };
}

/** log(goles locales / goles visitantes) reciente de la competición, contraído hacia 0,25 (60 partidos ficticios). */
function leagueHomeAdv(compMatches: readonly MatchRecord[], cutoff: number): number {
  let hg = 0;
  let ag = 0;
  let n = 0;
  for (let i = compMatches.length - 1; i >= 0; i--) {
    const m = compMatches[i];
    if (cutoff - Date.parse(m.date) > 365 * DAY_MS) break;
    if (m.neutral || !m.score) continue;
    hg += m.score.home;
    ag += m.score.away;
    n++;
  }
  const prior = 60;
  // goles medios típicos: 1,45 local / 1,13 visitante (log ≈ 0,25)
  return Math.log((hg + prior * 1.45) / (ag + prior * 1.13));
}

/** Ventaja local propia del equipo (goles por partido), contraída hacia 0 relativa a la media de sus partidos. */
function teamHomeAdv(prev: readonly MatchRecord[], teamId: string, cutoff: number): number {
  let gdHome = 0;
  let nHome = 0;
  let gdAway = 0;
  let nAway = 0;
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (cutoff - Date.parse(m.date) > 540 * DAY_MS) break;
    if (m.neutral || !m.score) continue;
    if (m.home.id === teamId) {
      gdHome += m.score.home - m.score.away;
      nHome++;
    } else {
      gdAway += m.score.away - m.score.home;
      nAway++;
    }
  }
  if (!nHome || !nAway) return 0;
  // (media en casa − media fuera)/2 = ventaja local propia; se contrae con 30 partidos ficticios por lado
  const k = 30;
  const raw = (gdHome / nHome - gdAway / nAway) / 2;
  const w = Math.min(nHome, nAway) / (Math.min(nHome, nAway) + k);
  return raw * w;
}

function validOdds(x: number | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 1;
}

const logit = (p: number) => Math.log(p / (1 - p));

function oddsMovement(match: PreMatch): { mvHA: number; mvDraw: number; mvOver: number; hasOpen: number } {
  const o = match.odds;
  const out = { mvHA: 0, mvDraw: 0, mvOver: 0, hasOpen: 0 };
  if (!o) return out;
  if (validOdds(o.home) && validOdds(o.draw) && validOdds(o.away) && validOdds(o.homeOpen) && validOdds(o.drawOpen) && validOdds(o.awayOpen)) {
    const c = devig([o.home, o.draw, o.away], 'multiplicative');
    const p = devig([o.homeOpen, o.drawOpen, o.awayOpen], 'multiplicative');
    if ([...c, ...p].every((x) => x > 0 && x < 1)) {
      out.mvHA = Math.log(c[0] / c[2]) - Math.log(p[0] / p[2]);
      out.mvDraw = Math.log(c[1]) - Math.log(p[1]);
      out.hasOpen = 1;
      // movimientos absurdos (error del proveedor) se recortan
      out.mvHA = Math.max(-1.5, Math.min(1.5, out.mvHA));
      out.mvDraw = Math.max(-1, Math.min(1, out.mvDraw));
    }
  }
  if (validOdds(o.over) && validOdds(o.under) && validOdds(o.overOpen) && validOdds(o.underOpen)) {
    const c = devig([o.over, o.under], 'multiplicative');
    const p = devig([o.overOpen, o.underOpen], 'multiplicative');
    if ([c[0], p[0]].every((x) => x > 0 && x < 1)) out.mvOver = Math.max(-1.5, Math.min(1.5, logit(c[0]) - logit(p[0])));
  }
  return out;
}

/** Rasgos de contexto de un partido (solo pasado + cuotas pre-partido). */
export function contextFeatures(ctx: FeatureContext, match: PreMatch, before: HistoryView): Features {
  const h = teamContext(ctx, match, before, match.home.id);
  const a = teamContext(ctx, match, before, match.away.id);
  const neutral = !!match.neutral;
  const lgHA = neutral ? 0 : leagueHomeAdv(before.compMatches(match.compId), before.cutoff);
  const teamHAH = neutral ? 0 : teamHomeAdv(before.teamMatches(match.home.id), match.home.id, before.cutoff);
  const mv = oddsMovement(match);
  return {
    restH: h.rest,
    restA: a.rest,
    shortH: h.short,
    shortA: a.short,
    longH: h.long,
    longA: a.long,
    n14H: h.n14,
    n14A: a.n14,
    euroH: h.euro,
    euroA: a.euro,
    promH: h.prom,
    promA: a.prom,
    gamesH: h.games,
    gamesA: a.games,
    nCompH: h.nComp,
    nCompA: a.nComp,
    lgHA,
    teamHAH,
    neutral: neutral ? 1 : 0,
    isLeague: ctx.comp.kind === 'league' ? 1 : 0,
    ...mv,
  };
}
