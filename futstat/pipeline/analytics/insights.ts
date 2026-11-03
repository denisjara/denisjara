/**
 * Frases automáticas (español, con números concretos) para la página de competición y la portada.
 * Cada frase solo se genera si hay datos que la respalden.
 */
import type {
  LeagueAverages,
  MatchSummary,
  PlayerSeasonRow,
  StandingGroup,
  TeamSeasonStats,
  ValuePick,
} from '../../src/types/data';
import { median, round } from '../../src/lib/models';

/** Número con coma decimal (es-ES), sin separador de miles. */
export function fmt(x: number, digits = 1): string {
  return round(x, digits).toFixed(digits).replace('.', ',');
}

/** Porcentaje entero a partir de una proporción 0..1. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

const teamName = (t: { short?: string; name: string }) => t.short || t.name;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function bestBy<T>(xs: T[], score: (x: T) => number): T | undefined {
  let best: T | undefined;
  let bs = -Infinity;
  for (const x of xs) {
    const s = score(x);
    if (Number.isFinite(s) && s > bs) {
      bs = s;
      best = x;
    }
  }
  return best;
}

/**
 * 5–8 frases sobre la competición: liderato, goles, ambos marcan, ventaja local, mejor ataque/defensa,
 * rendimiento frente al xG, forma, goleador, jugador en forma, córners, tarjetas y goles tardíos.
 */
export function competitionInsights(
  stats: TeamSeasonStats[],
  avgs: LeagueAverages,
  players: PlayerSeasonRow[],
  standings?: StandingGroup | StandingGroup[],
): string[] {
  const out: string[] = [];
  const groups = standings ? (Array.isArray(standings) ? standings : [standings]) : [];

  // Liderato (solo con una única tabla)
  if (groups.length === 1 && groups[0].rows.length >= 2) {
    const rows = [...groups[0].rows].sort((a, b) => a.rank - b.rank);
    const [a, b] = rows;
    if (a.played > 0) {
      const diff = a.points - b.points;
      out.push(
        diff > 0
          ? `${teamName(a.team)} lidera con ${plural(a.points, 'punto', 'puntos')}, ${plural(diff, 'punto', 'puntos')} más que ${teamName(b.team)}.`
          : `${teamName(a.team)} y ${teamName(b.team)} comparten el liderato con ${plural(a.points, 'punto', 'puntos')}.`,
      );
    }
  }

  const hasMatches = avgs.goalsPerMatch > 0 || avgs.homeWinPct + avgs.drawPct + avgs.awayWinPct > 0;
  if (hasMatches) {
    out.push(
      `Se marcan ${fmt(avgs.goalsPerMatch, 2)} goles por partido: el ${pct(avgs.over25Pct)} de los encuentros supera los 2,5 goles y en el ${pct(avgs.bttsPct)} marcan ambos equipos.`,
    );
    out.push(
      `Los locales ganan el ${pct(avgs.homeWinPct)} de los partidos, los visitantes el ${pct(avgs.awayWinPct)} y el ${pct(avgs.drawPct)} acaba en empate.`,
    );
  }

  const minPlayed = Math.max(3, Math.floor(0.5 * median(stats.map((s) => s.played.all)) || 0));
  const eligible = stats.filter((s) => s.played.all >= minPlayed);
  if (eligible.length >= 2) {
    const att = bestBy(eligible, (s) => s.goalsFor.all);
    if (att) out.push(`${teamName(att.team)} tiene el mejor ataque: ${fmt(att.goalsFor.all, 2)} goles por partido.`);
    const def = bestBy(eligible, (s) => -s.goalsAgainst.all);
    if (def) out.push(`${teamName(def.team)} es la defensa menos goleada: ${fmt(def.goalsAgainst.all, 2)} goles encajados por partido.`);
  }

  const scorer = bestBy(players, (p) => p.goals * 10_000 - p.minutes / 10_000);
  if (scorer && scorer.goals > 0) {
    out.push(
      `Máximo goleador: ${scorer.player.name} (${teamName(scorer.team)}) con ${plural(scorer.goals, 'gol', 'goles')} en ${plural(scorer.apps, 'partido', 'partidos')}.`,
    );
  }
  const hot = bestBy(players, (p) => p.formIndex);
  if (hot && hot !== scorer && hot.formIndex > 0) {
    out.push(`Jugador más en forma: ${hot.player.name} (${teamName(hot.team)}), índice ${Math.round(hot.formIndex)}/100.`);
  }

  if (eligible.length >= 2) {
    const withXg = eligible.filter((s) => s.xgFor.all > 0);
    if (withXg.length >= Math.max(2, eligible.length / 2)) {
      const over = bestBy(withXg, (s) => s.goalsFor.all - s.xgFor.all);
      if (over && over.goalsFor.all - over.xgFor.all >= 0.2) {
        out.push(
          `${teamName(over.team)} marca ${fmt(over.goalsFor.all - over.xgFor.all, 2)} goles por partido más de lo que predice su xG (${fmt(over.goalsFor.all, 2)} frente a ${fmt(over.xgFor.all, 2)}).`,
        );
      }
    }

    const form = bestBy(eligible, (s) => s.formIndex);
    if (form) {
      out.push(
        `${teamName(form.team)} es el equipo en mejor forma (índice ${Math.round(form.formIndex)}/100${form.formString ? `, racha ${form.formString}` : ''}).`,
      );
    }
    const corners = bestBy(eligible, (s) => s.corners.all);
    if (corners && corners.corners.all > 0) {
      out.push(
        `${teamName(corners.team)} es el equipo con más córners a favor: ${fmt(corners.corners.all)} por partido (media de la liga: ${fmt(avgs.cornersPerMatch / 2)}).`,
      );
    }
    const cards = bestBy(eligible, (s) => s.cards.all);
    if (cards && cards.cards.all > 0) {
      out.push(`${teamName(cards.team)} es el equipo más amonestado: ${fmt(cards.cards.all)} tarjetas por partido.`);
    }
  }

  const periods = stats.map((s) => s.goalsByPeriod).filter((g): g is number[] => !!g && g.length === 6);
  if (periods.length) {
    const tot = [0, 0, 0, 0, 0, 0];
    for (const g of periods) g.forEach((x, i) => (tot[i] += x));
    const all = tot.reduce((a, b) => a + b, 0);
    if (all >= 20) out.push(`El ${pct(tot[5] / all)} de los goles llega a partir del minuto 76.`);
  }

  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Portada
// ---------------------------------------------------------------------------

export interface HomeHighlightsInput {
  /** partidos de hoy */
  today: MatchSummary[];
  /** partidos populares (ordenados por popularidad) */
  popular?: MatchSummary[];
  /** terminados recientes (con predictionHit cuando existe) */
  recent?: MatchSummary[];
  topValue?: { match: MatchSummary; pick: ValuePick }[];
  hotPlayers?: PlayerSeasonRow[];
  modelHeadline?: { matches: number; accuracy: number; rps: number; marketRps?: number };
  /** partidos programados en los próximos días (para cuando hoy no hay partidos) */
  upcomingCount?: number;
}

const vs = (m: MatchSummary) => `${teamName(m.home)} – ${teamName(m.away)}`;

/** 4–8 frases cortas para la portada del día. */
export function homeHighlights(input: HomeHighlightsInput): string[] {
  const out: string[] = [];
  const today = input.today.filter((m) => m.status !== 'cancelled' && m.status !== 'postponed');
  if (today.length) {
    const comps = new Set(today.map((m) => m.compId)).size;
    out.push(`Hoy se disputan ${plural(today.length, 'partido', 'partidos')} de ${plural(comps, 'competición', 'competiciones')}.`);
  } else if (input.upcomingCount) {
    out.push(`Hoy no hay partidos en las competiciones seguidas; hay ${plural(input.upcomingCount, 'partido', 'partidos')} programados en los próximos días.`);
  }

  const featured = (input.popular ?? []).find((m) => m.prediction && m.status === 'scheduled');
  if (featured?.prediction) {
    const p = featured.prediction.p;
    out.push(
      `Partido destacado: ${vs(featured)} (${featured.compName}). Modelo: ${pct(p.home)} local, ${pct(p.draw)} empate, ${pct(p.away)} visitante.`,
    );
  }

  const pool = new Map<string, MatchSummary>();
  for (const m of [...today, ...(input.popular ?? [])]) if (m.prediction && m.status === 'scheduled') pool.set(m.id, m);
  const candidates = [...pool.values()];
  const fav = bestBy(candidates, (m) => Math.max(m.prediction!.p.home, m.prediction!.p.away));
  if (fav?.prediction) {
    const homeFav = fav.prediction.p.home >= fav.prediction.p.away;
    const p = homeFav ? fav.prediction.p.home : fav.prediction.p.away;
    if (p >= 0.55) {
      out.push(
        `Mayor favorito: ${teamName(homeFav ? fav.home : fav.away)} (${pct(p)}) ante ${teamName(homeFav ? fav.away : fav.home)}.`,
      );
    }
  }
  const goals = bestBy(candidates, (m) => m.prediction!.xgHome + m.prediction!.xgAway);
  if (goals?.prediction) {
    const xg = goals.prediction.xgHome + goals.prediction.xgAway;
    out.push(`Más goles esperados: ${vs(goals)} (${fmt(xg)} goles; ${pct(goals.prediction.over25)} de más de 2,5).`);
  }

  const value = input.topValue?.[0];
  if (value) {
    out.push(
      `Mejor valor: ${value.pick.selection} (${value.pick.market}) en ${vs(value.match)} a cuota ${fmt(value.pick.odds, 2)} (EV +${fmt(value.pick.ev * 100)}%).`,
    );
  }

  const judged = (input.recent ?? []).filter((m) => m.predictionHit !== undefined);
  if (judged.length >= 3) {
    const hits = judged.filter((m) => m.predictionHit).length;
    out.push(`El modelo acertó ${hits} de ${judged.length} resultados en las últimas 48 h.`);
  }

  const hot = input.hotPlayers?.[0];
  if (hot) out.push(`Jugador más en forma: ${hot.player.name} (${teamName(hot.team)}), índice ${Math.round(hot.formIndex)}/100.`);

  const mh = input.modelHeadline;
  if (mh && mh.matches > 0) {
    out.push(
      `Backtest: ${pct(mh.accuracy)} de aciertos en ${mh.matches} partidos (RPS ${fmt(mh.rps, 3)}${mh.marketRps !== undefined ? `; mercado ${fmt(mh.marketRps, 3)}` : ''}).`,
    );
  }
  return out.slice(0, 8);
}
