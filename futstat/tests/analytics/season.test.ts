import { describe, expect, it } from 'vitest';
import type { MatchSummary, PlayerSeasonRow, Prob1X2, SplitStat, StandingGroup, TeamRef, TeamSeasonStats } from '../../src/types/data';
import type { MatchEventRecord, MatchRecord, PlayerLine, TeamMatchStats } from '../../pipeline/types';
import { MODEL } from '../../pipeline/config';
import { toMatchSummary } from '../../pipeline/analytics/summary';
import {
  attachXPts,
  computeFormIndex,
  computeLeagueAverages,
  computeStandingsFromMatches,
  computeTeamSeasonStats,
  computeXPts,
  expectedPoints,
  periodIndex,
} from '../../pipeline/analytics/teamStats';
import { buildComparison, buildFormBlock, buildH2H } from '../../pipeline/analytics/form';
import { buildPlayerProps, buildPlayerSeasonRows, matchRating, playerFormIndex } from '../../pipeline/analytics/players';
import { resolveZone, simulateSeason } from '../../pipeline/analytics/simulation';
import { mergeBacktests, runBacktest, walkForwardDC, type BacktestItem } from '../../pipeline/analytics/backtest';
import { eloPercentile, popularityScore } from '../../pipeline/analytics/popularity';
import { competitionInsights, homeHighlights } from '../../pipeline/analytics/insights';
import { syntheticWorld } from './synthetic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T = (id: string): TeamRef => ({ id, name: `Equipo ${id}`, short: id, abbr: id.toUpperCase() });

function fin(
  id: string,
  date: string,
  h: string,
  a: string,
  hg: number,
  ag: number,
  extra: { stats?: { home: TeamMatchStats; away: TeamMatchStats }; events?: MatchEventRecord[]; compId?: string; neutral?: boolean } = {},
): MatchRecord {
  return {
    id,
    compId: extra.compId ?? 'x',
    season: 2026,
    currentSeason: true,
    date,
    status: 'finished',
    home: T(h),
    away: T(a),
    score: { home: hg, away: ag },
    stats: extra.stats,
    events: extra.events,
    neutral: extra.neutral,
  };
}

const ev = (minute: number, type: MatchEventRecord['type'], teamId: string): MatchEventRecord => ({
  minute,
  clock: `${minute}'`,
  type,
  teamId,
});

/** Escenario pequeño con valores calculables a mano. */
const SMALL: MatchRecord[] = [
  fin('m1', '2026-08-01T18:00:00Z', 'A', 'B', 2, 0, {
    stats: {
      home: { goals: 2, shots: 10, shotsOnTarget: 5, corners: 6, fouls: 10, yellow: 1, red: 0, possession: 60 },
      away: { goals: 0, shots: 4, shotsOnTarget: 1, corners: 2, fouls: 12, yellow: 2, red: 1, possession: 40 },
    },
    events: [ev(10, 'goal', 'A'), ev(46, 'penalty', 'A'), ev(50, 'yellow', 'B')],
  }),
  fin('m2', '2026-08-08T18:00:00Z', 'B', 'A', 1, 1, {
    stats: {
      home: { goals: 1, shots: 8, shotsOnTarget: 3, corners: 4, fouls: 11, yellow: 0, red: 0, possession: 45 },
      away: { goals: 1, shots: 6, shotsOnTarget: 2, corners: 3, fouls: 9, yellow: 3, red: 0, possession: 55 },
    },
    // el gol en propia puerta lleva el teamId del equipo beneficiado (A)
    events: [ev(30, 'goal', 'B'), ev(90, 'own-goal', 'A')],
  }),
  fin('m3', '2026-08-15T18:00:00Z', 'A', 'C', 3, 1),
  fin('m4', '2026-08-22T18:00:00Z', 'C', 'B', 0, 0),
  // partido no terminado y duplicado: deben ignorarse
  { ...fin('m5', '2026-08-29T18:00:00Z', 'A', 'B', 0, 0), status: 'scheduled', score: undefined },
  fin('m1', '2026-08-01T18:00:00Z', 'A', 'B', 2, 0),
];

const zeroSplit = (): SplitStat => ({ all: 0, home: 0, away: 0 });
function seasonStats(id: string, over: Partial<TeamSeasonStats> = {}): TeamSeasonStats {
  return {
    team: T(id),
    played: { all: 10, home: 5, away: 5 },
    goalsFor: zeroSplit(),
    goalsAgainst: zeroSplit(),
    xgFor: zeroSplit(),
    xgAgainst: zeroSplit(),
    shots: zeroSplit(),
    shotsAgainst: zeroSplit(),
    shotsOnTarget: zeroSplit(),
    shotsOnTargetAgainst: zeroSplit(),
    corners: zeroSplit(),
    cornersAgainst: zeroSplit(),
    cards: zeroSplit(),
    cardsAgainst: zeroSplit(),
    fouls: zeroSplit(),
    possession: zeroSplit(),
    over15Pct: 0,
    over25Pct: 0,
    over35Pct: 0,
    bttsPct: 0,
    cleanSheetPct: 0,
    failedToScorePct: 0,
    winPct: 0,
    drawPct: 0,
    lossPct: 0,
    formString: '',
    formIndex: 50,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// summary.ts
// ---------------------------------------------------------------------------

describe('toMatchSummary', () => {
  it('copia los campos, omite los desconocidos y aplica extra', () => {
    const m: MatchRecord = {
      ...fin('9', '2026-11-01T20:00:00Z', 'A', 'B', 2, 1),
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      statusDetail: 'FT',
      round: 'Jornada 11',
      homeForm: 'WWDLW',
      odds: { provider: 'DraftKings', home: 1.9, draw: 3.4, away: 4.2 },
    };
    const s = toMatchSummary(m, 'Liga X');
    expect(s).toMatchObject({ id: '9', compId: 'x', compName: 'Liga X', status: 'finished', statusDetail: 'FT', round: 'Jornada 11', hasDetail: false });
    expect(s.score).toEqual({ home: 2, away: 1, htHome: 1, htAway: 0 });
    expect(s.homeForm).toBe('WWDLW');
    expect('awayForm' in s).toBe(false);
    expect('venue' in s).toBe(false);
    expect(s.odds?.home).toBe(1.9);
    const s2 = toMatchSummary(m, 'Liga X', { hasDetail: true, popularity: 77, predictionHit: undefined });
    expect(s2.hasDetail).toBe(true);
    expect(s2.popularity).toBe(77);
    expect('predictionHit' in s2).toBe(false);
  });

  it('partidos programados sin marcador ni estado de detalle; aplazados con etiqueta española', () => {
    const sched: MatchRecord = { ...fin('10', '2026-11-08T20:00:00Z', 'A', 'B', 0, 0), status: 'scheduled', score: undefined };
    const s = toMatchSummary(sched, 'Liga X');
    expect(s.score).toBeUndefined();
    expect(s.statusDetail).toBeUndefined();
    const post = toMatchSummary({ ...sched, status: 'postponed' }, 'Liga X');
    expect(post.statusDetail).toBe('Aplazado');
  });
});

// ---------------------------------------------------------------------------
// teamStats.ts
// ---------------------------------------------------------------------------

describe('computeTeamSeasonStats', () => {
  const xg = new Map([['m1', { home: 1.5, away: 0.5 }]]);
  const stats = computeTeamSeasonStats(SMALL, { xg });
  const A = stats.find((s) => s.team.id === 'A')!;
  const B = stats.find((s) => s.team.id === 'B')!;

  it('cuenta partidos por split (ignora no terminados y duplicados)', () => {
    expect(stats.map((s) => s.team.id).sort()).toEqual(['A', 'B', 'C']);
    expect(A.played).toEqual({ all: 3, home: 2, away: 1 });
    expect(B.played).toEqual({ all: 3, home: 1, away: 2 });
  });

  it('medias por partido con split casa/fuera', () => {
    expect(A.goalsFor).toEqual({ all: 2, home: 2.5, away: 1 });
    expect(A.goalsAgainst).toEqual({ all: 0.67, home: 0.5, away: 1 });
    // tiros: solo partidos con estadísticas (m1 en casa = 10, m2 fuera = 6)
    expect(A.shots).toEqual({ all: 8, home: 10, away: 6 });
    expect(A.shotsAgainst).toEqual({ all: 6, home: 4, away: 8 });
    expect(A.corners).toEqual({ all: 4.5, home: 6, away: 3 });
    // tarjetas = amarillas + rojas
    expect(A.cards).toEqual({ all: 2, home: 1, away: 3 });
    expect(A.cardsAgainst).toEqual({ all: 1.5, home: 3, away: 0 });
    expect(A.possession).toEqual({ all: 57.5, home: 60, away: 55 });
    expect(A.xgFor).toEqual({ all: 1.5, home: 1.5, away: 0 });
    expect(B.xgAgainst.away).toBe(1.5);
  });

  it('porcentajes de mercados y resultados', () => {
    expect(A.over25Pct).toBeCloseTo(1 / 3, 3);
    expect(A.over15Pct).toBe(1);
    expect(A.bttsPct).toBeCloseTo(2 / 3, 3); // 1-1 y 3-1
    expect(A.cleanSheetPct).toBeCloseTo(1 / 3, 3);
    expect(A.failedToScorePct).toBe(0);
    expect(A.winPct).toBeCloseTo(2 / 3, 3);
    expect(A.drawPct).toBeCloseTo(1 / 3, 3);
    expect(A.lossPct).toBe(0);
    expect(B.failedToScorePct).toBeCloseTo(2 / 3, 3);
  });

  it('goles por tramo desde los eventos (incluye penaltis y goles en propia puerta)', () => {
    expect(periodIndex(15)).toBe(0);
    expect(periodIndex(45)).toBe(2);
    expect(periodIndex(46)).toBe(3);
    expect(periodIndex(120)).toBe(5);
    expect(A.goalsByPeriod).toEqual([1, 0, 0, 1, 0, 1]);
    expect(A.concededByPeriod).toEqual([0, 1, 0, 0, 0, 0]);
    // C no tiene partidos con eventos
    expect(stats.find((s) => s.team.id === 'C')!.goalsByPeriod).toBeUndefined();
  });

  it('forma: cadena cronológica e índice', () => {
    expect(A.formString).toBe('WDW');
    expect(B.formString).toBe('LDD');
    expect(A.formIndex).toBeGreaterThan(B.formIndex);
    expect(A.formIndex).toBeLessThanOrEqual(100);
    expect(B.formIndex).toBeGreaterThanOrEqual(0);
  });

  it('con el mundo sintético: partidos jugados coherentes y el mejor equipo con más goles', () => {
    const w = syntheticWorld(5);
    const ms = w.stores.find((s) => s.compId === 'liga-a')!.matches;
    const st = computeTeamSeasonStats(ms);
    expect(st).toHaveLength(10);
    expect(st.reduce((s, x) => s + x.played.all, 0)).toBe(2 * ms.length);
    for (const s of st) expect(s.played.home + s.played.away).toBe(s.played.all);
    const a0 = st.find((s) => s.team.id === 'A0')!;
    const a9 = st.find((s) => s.team.id === 'A9')!;
    expect(a0.goalsFor.all).toBeGreaterThan(a9.goalsFor.all);
    expect(a0.goalsAgainst.all).toBeLessThan(a9.goalsAgainst.all);
  });
});

describe('computeLeagueAverages', () => {
  it('medias de la competición', () => {
    const avg = computeLeagueAverages(SMALL);
    expect(avg.goalsPerMatch).toBe(2);
    expect(avg.homeGoals).toBe(1.5);
    expect(avg.awayGoals).toBe(0.5);
    expect(avg.homeWinPct).toBe(0.5);
    expect(avg.drawPct).toBe(0.5);
    expect(avg.awayWinPct).toBe(0);
    expect(avg.over25Pct).toBe(0.25);
    expect(avg.bttsPct).toBe(0.5);
    expect(avg.cornersPerMatch).toBe(7.5);
    expect(avg.cardsPerMatch).toBe(3.5);
    expect(avg.shotsPerMatch).toBe(14);
    expect(avg.shotsOnTargetPerMatch).toBe(5.5);
    expect(avg.foulsPerMatch).toBe(21);
  });

  it('sin partidos devuelve ceros', () => {
    expect(computeLeagueAverages([]).goalsPerMatch).toBe(0);
  });
});

describe('clasificación calculada y xPts', () => {
  it('ordena por puntos, diferencia y goles a favor', () => {
    const g = computeStandingsFromMatches(SMALL, { name: 'Liga X' });
    expect(g.name).toBe('Liga X');
    expect(g.rows.map((r) => r.team.id)).toEqual(['A', 'B', 'C']);
    expect(g.rows[0]).toMatchObject({ rank: 1, played: 3, won: 2, drawn: 1, lost: 0, gf: 6, ga: 2, gd: 4, points: 7, form: 'WDW' });
    expect(g.rows[2]).toMatchObject({ rank: 3, points: 1, gd: -2 });
  });

  it('desempate por goles a favor', () => {
    const ms = [fin('1', '2026-08-01T00:00:00Z', 'X', 'Z', 3, 2), fin('2', '2026-08-02T00:00:00Z', 'Y', 'W', 1, 0)];
    const g = computeStandingsFromMatches(ms);
    expect(g.rows[0].team.id).toBe('X');
    expect(g.rows[1].team.id).toBe('Y');
  });

  it('xPts = suma de puntos esperados por Poisson', () => {
    const xg = new Map([
      ['m1', { home: 1.5, away: 0.5 }],
      ['m3', { home: 2.0, away: 1.0 }],
    ]);
    const xp = computeXPts(SMALL, xg);
    const e1 = expectedPoints(1.5, 0.5);
    const e3 = expectedPoints(2.0, 1.0);
    expect(xp.get('A')).toBeCloseTo(e1.home + e3.home, 10);
    expect(xp.get('B')).toBeCloseTo(e1.away, 10);
    expect(e1.home).toBeGreaterThan(e1.away);
    // partido igualado: suma de puntos esperados entre 2 y 3
    const eq = expectedPoints(1.3, 1.3);
    expect(eq.home).toBeCloseTo(eq.away, 10);
    expect(eq.home + eq.away).toBeGreaterThan(2);
    expect(eq.home + eq.away).toBeLessThan(3);
    const g = computeStandingsFromMatches(SMALL, { xg });
    expect(g.rows[0].xPts).toBeCloseTo(xp.get('A')!, 1);
    expect(g.rows.find((r) => r.team.id === 'C')!.xPts).toBeDefined();
    const espn: StandingGroup = { name: 'ESPN', rows: g.rows.map((r) => ({ ...r, xPts: undefined })) };
    const att = attachXPts(espn, xp);
    expect(att.rows[0].xPts).toBeCloseTo(xp.get('A')!, 1);
  });
});

// ---------------------------------------------------------------------------
// form.ts
// ---------------------------------------------------------------------------

describe('buildFormBlock', () => {
  // A: L, D, W, W, W (alternando casa/fuera, empezando en casa)
  const seq: MatchRecord[] = [
    fin('f1', '2026-09-01T18:00:00Z', 'A', 'B', 0, 1, { stats: { home: { goals: 0, shots: 7, corners: 5, yellow: 2, red: 0 }, away: { goals: 1, corners: 3 } } }),
    fin('f2', '2026-09-08T18:00:00Z', 'C', 'A', 1, 1),
    fin('f3', '2026-09-15T18:00:00Z', 'A', 'D', 2, 0),
    fin('f4', '2026-09-22T18:00:00Z', 'E', 'A', 0, 1, { compId: 'copa' }),
    fin('f5', '2026-09-29T18:00:00Z', 'A', 'F', 3, 1),
    fin('other', '2026-09-30T18:00:00Z', 'B', 'C', 1, 1),
  ];
  const history = Array.from({ length: 20 }, (_, i) => ({ date: `2026-0${i < 10 ? 8 : 9}-${String((i % 9) + 1).padStart(2, '0')}T00:00:00Z`, elo: 1500 + i }));
  const xg = new Map([['f5', { home: 2.1, away: 0.7 }]]);
  const fb = buildFormBlock('A', seq, history, 'home', xg);

  it('últimos partidos (más reciente primero) con estadísticas', () => {
    expect(fb.team.id).toBe('A');
    expect(fb.last.map((m) => m.matchId)).toEqual(['f5', 'f4', 'f3', 'f2', 'f1']);
    expect(fb.last[0]).toMatchObject({ isHome: true, gf: 3, ga: 1, result: 'W', xg: 2.1, xga: 0.7, opponent: { id: 'F' } });
    expect(fb.last[1]).toMatchObject({ compId: 'copa', isHome: false, result: 'W' });
    expect(fb.last[4]).toMatchObject({ shots: 7, corners: 5, cornersAgainst: 3, cards: 2, result: 'L' });
  });

  it('cadena de forma, PPG y medias', () => {
    expect(fb.formString).toBe('LDWWW');
    expect(fb.ppg5).toBe(2);
    expect(fb.ppg10).toBe(2);
    expect(fb.gf5).toBe(1.4);
    expect(fb.ga5).toBe(0.6);
  });

  it('rachas en español', () => {
    expect(fb.streaks).toContain('3 victorias seguidas');
    expect(fb.streaks).toContain('Invicto en 4');
    expect(fb.streaks).toContain('Marca en los últimos 4');
    expect(fb.streaks).toContain('Under 2.5 en 4 de 5');
  });

  it('split por campo, Elo y tendencia', () => {
    expect(fb.venueSplit.played).toBe(3);
    expect(fb.venueSplit.ppg).toBe(2);
    expect(fb.venueSplit.gf).toBeCloseTo(5 / 3, 2);
    expect(fb.venueSplit.ga).toBeCloseTo(2 / 3, 2);
    const away = buildFormBlock('A', seq, history, 'away');
    expect(away.venueSplit).toMatchObject({ played: 2, ppg: 2 });
    expect(fb.elo).toBe(1519);
    expect(fb.eloTrend).toHaveLength(15);
    expect(fb.eloTrend[14]).toBe(1519);
  });

  it('opción before excluye el partido analizado y posteriores', () => {
    const pre = buildFormBlock('A', seq, history, 'home', xg, { before: '2026-09-29T18:00:00Z' });
    expect(pre.last[0].matchId).toBe('f4');
    expect(pre.formString).toBe('LDWW');
  });

  it('equipo sin partidos: bloque neutro', () => {
    const empty = buildFormBlock('Z', [], [], 'home', undefined, { team: T('Z') });
    expect(empty.team.id).toBe('Z');
    expect(empty.last).toEqual([]);
    expect(empty.formIndex).toBe(50);
    expect(empty.elo).toBe(MODEL.eloInit);
  });

  it('índice de forma: rango, orden y ajuste por Elo del rival', () => {
    const wins = Array.from({ length: 6 }, () => ({ pts: 3, gd: 2 }));
    const losses = Array.from({ length: 6 }, () => ({ pts: 0, gd: -2 }));
    expect(computeFormIndex(wins)).toBeGreaterThan(80);
    expect(computeFormIndex(losses)).toBeLessThan(20);
    expect(computeFormIndex([])).toBe(50);
    // misma secuencia; ganar al rival fuerte vale más que ganar al débil
    const strongWin = computeFormIndex([
      { pts: 0, gd: -1, oppElo: 1400 },
      { pts: 3, gd: 1, oppElo: 1800 },
    ]);
    const weakWin = computeFormIndex([
      { pts: 0, gd: -1, oppElo: 1800 },
      { pts: 3, gd: 1, oppElo: 1400 },
    ]);
    expect(strongWin).toBeGreaterThan(weakWin);
    // lo reciente pesa más
    expect(computeFormIndex([...losses, ...wins.slice(0, 3)])).toBeGreaterThan(computeFormIndex([...wins.slice(0, 3), ...losses]));
  });
});

describe('buildComparison', () => {
  const avgs = computeLeagueAverages(SMALL);
  it('usa split casa/fuera con >= 3 partidos y el total si no', () => {
    const home = seasonStats('H', {
      played: { all: 10, home: 5, away: 5 },
      goalsFor: { all: 2, home: 2.5, away: 1.5 },
      corners: { all: 5, home: 6, away: 4 },
      xgFor: { all: 1.8, home: 2, away: 1.6 },
      over25Pct: 0.6,
    });
    const away = seasonStats('W', {
      played: { all: 4, home: 2, away: 2 },
      goalsFor: { all: 1.2, home: 1.5, away: 0.9 },
      corners: { all: 4, home: 5, away: 3 },
      over25Pct: 0.4,
    });
    const rows = buildComparison(home, away, avgs);
    const gf = rows.find((r) => r.key === 'goalsFor')!;
    expect(gf).toMatchObject({ home: 2.5, away: 1.2, better: 'high', leagueAvg: 1 });
    expect(rows.find((r) => r.key === 'goalsAgainst')!.better).toBe('low');
    expect(rows.find((r) => r.key === 'corners')).toMatchObject({ home: 6, away: 4 });
    expect(rows.find((r) => r.key === 'xgFor')).toMatchObject({ home: 2, away: 0 });
    expect(rows.find((r) => r.key === 'over25Pct')).toMatchObject({ home: 0.6, away: 0.4, format: 'pct' });
    expect(rows.find((r) => r.key === 'cleanSheetPct')).toBeDefined();
    // filas sin datos en ningún equipo se omiten (tiros)
    expect(rows.find((r) => r.key === 'shots')).toBeUndefined();
    for (const r of rows) expect(r.label.length).toBeGreaterThan(3);
  });
});

describe('buildH2H', () => {
  it('historial directo relativo al local del partido analizado', () => {
    const ms = [
      fin('h1', '2026-01-01T00:00:00Z', 'A', 'B', 2, 0),
      fin('h2', '2026-03-01T00:00:00Z', 'B', 'A', 1, 1, { compId: 'copa' }),
      fin('h3', '2026-05-01T00:00:00Z', 'B', 'A', 2, 1),
      fin('h4', '2026-06-01T00:00:00Z', 'A', 'C', 5, 0),
      fin('h3', '2026-05-01T00:00:00Z', 'B', 'A', 2, 1),
    ];
    const h = buildH2H(ms, 'A', 'B', new Map([['x', 'Liga X'], ['copa', 'Copa']]));
    expect(h.matches.map((m) => m.id)).toEqual(['h3', 'h2', 'h1']);
    expect(h.matches[1].compName).toBe('Copa');
    expect(h).toMatchObject({ homeWins: 1, draws: 1, awayWins: 1 });
    expect(h.avgGoals).toBeCloseTo(7 / 3, 2);
    expect(h.bttsPct).toBeCloseTo(2 / 3, 3);
    expect(h.over25Pct).toBeCloseTo(1 / 3, 3);
    const rev = buildH2H(ms, 'B', 'A', { x: 'Liga X' });
    expect(rev).toMatchObject({ homeWins: 1, draws: 1, awayWins: 1 });
    expect(buildH2H(ms, 'A', 'B', {}, { before: '2026-04-01T00:00:00Z' }).matches).toHaveLength(2);
    expect(buildH2H(ms, 'A', 'Z', {}).matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// players.ts
// ---------------------------------------------------------------------------

function line(p: Partial<PlayerLine> & { matchId: string; date: string; playerId: string }): PlayerLine {
  return {
    compId: 'x',
    teamId: 'T1',
    opponentId: 'T2',
    isHome: true,
    name: `Jugador ${p.playerId}`,
    short: `J. ${p.playerId}`,
    position: 'M',
    starter: true,
    minutes: 90,
    goals: 0,
    assists: 0,
    shots: 0,
    shotsOnTarget: 0,
    yellow: 0,
    red: 0,
    foulsCommitted: 0,
    foulsSuffered: 0,
    offsides: 0,
    ownGoals: 0,
    ...p,
  };
}

const DATES = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06'].map((d) => `${d}T18:00:00Z`);

describe('nota de partido', () => {
  const base = { matchId: 'g', date: DATES[0], playerId: 'p' };
  it('heurística documentada', () => {
    expect(matchRating(line({ ...base, position: 'F', goals: 1, shots: 3, shotsOnTarget: 2, yellow: 1 }))).toBe(7.8);
    expect(matchRating(line({ ...base }))).toBe(6);
    // suplente 10': Δ = 1.6 escalado por 0.5 + 0.5·10/90
    expect(matchRating(line({ ...base, minutes: 10, starter: false, goals: 1, shots: 1, shotsOnTarget: 1 }))).toBe(6.9);
    // porteros
    expect(matchRating(line({ ...base, position: 'G', saves: 4, goalsConceded: 0 }))).toBe(7.8);
    expect(matchRating(line({ ...base, position: 'G', saves: 2, goalsConceded: 3 }))).toBe(5.6);
    expect(matchRating(line({ ...base, position: 'G', minutes: 30, saves: 0, goalsConceded: 0 }))).toBe(6);
    // recorte inferior
    expect(matchRating(line({ ...base, red: 1, ownGoals: 2 }))).toBe(3);
    expect(matchRating(line({ ...base, goals: 4, assists: 2, shots: 8, shotsOnTarget: 6 }))).toBe(10);
    expect(matchRating(line({ ...base, minutes: 0 }))).toBe(0);
  });

  it('índice de forma de jugador', () => {
    expect(playerFormIndex([6, 6, 6, 6, 6], [90, 90, 90, 90, 90])).toBe(66);
    expect(playerFormIndex([0, 0, 0, 0, 0], [0, 0, 0, 0, 0])).toBe(0);
    expect(playerFormIndex([8, 8, 8, 8, 8], [90, 90, 90, 90, 90])).toBeGreaterThan(playerFormIndex([6, 6, 6, 6, 6], [90, 90, 90, 90, 90]));
    expect(playerFormIndex([], [])).toBe(0);
  });
});

describe('buildPlayerSeasonRows', () => {
  const lines: PlayerLine[] = [];
  DATES.forEach((d, i) => {
    const matchId = `g${i + 1}`;
    lines.push(line({ matchId, date: d, playerId: 'P1', position: 'F', goals: i === 5 ? 1 : 0, shots: 2, shotsOnTarget: 1, yellow: i === 0 ? 1 : 0 }));
    if (i === 1 || i === 2) lines.push(line({ matchId, date: d, playerId: 'P2', minutes: 45, starter: false, assists: 1 }));
    if (i === 3) lines.push(line({ matchId, date: d, playerId: 'P3', minutes: 1, starter: false, goals: 1, shots: 1, shotsOnTarget: 1 }));
    lines.push(line({ matchId, date: d, playerId: 'GK', position: 'G', saves: 3, goalsConceded: 1 }));
    // otro equipo
    lines.push(line({ matchId, date: d, playerId: 'Q1', teamId: 'T2', opponentId: 'T1', isHome: false }));
  });
  const teams = new Map([
    ['T1', T('T1')],
    ['T2', { ...T('T2'), short: 'Rival' }],
  ]);
  const rows = buildPlayerSeasonRows(lines, teams, 'x');
  const get = (id: string) => rows.find((r) => r.player.id === id)!;

  it('totales, partidos y titularidades', () => {
    expect(rows).toHaveLength(5);
    const p1 = get('P1');
    expect(p1).toMatchObject({ apps: 6, starts: 6, minutes: 540, goals: 1, shots: 12, shotsOnTarget: 6, yellow: 1, compId: 'x' });
    expect(p1.team.id).toBe('T1');
    expect(get('P2')).toMatchObject({ apps: 2, starts: 0, minutes: 90, assists: 2 });
    expect(get('GK').saves).toBe(18);
    expect(p1.saves).toBeUndefined();
  });

  it('por 90 con minutos >= 1', () => {
    const p1 = get('P1');
    expect(p1.per90.goals).toBeCloseTo(90 / 540, 3);
    expect(p1.per90.shots).toBe(2);
    expect(p1.per90.cards).toBeCloseTo(90 / 540, 3);
    expect(get('P2').per90.assists).toBe(2);
    expect(get('P3').per90.goals).toBe(90);
  });

  it('últimos 5 partidos del equipo (0 si no jugó) e índice de forma', () => {
    const p2 = get('P2');
    expect(p2.formTrend).toHaveLength(5);
    expect(p2.formTrend[0]).toBeGreaterThan(0); // g2
    expect(p2.formTrend.slice(2)).toEqual([0, 0, 0]);
    expect(p2.last5[0]).toMatchObject({ matchId: 'g6', minutes: 0, rating: 0, opponent: 'Rival' });
    expect(p2.last5[4]).toMatchObject({ matchId: 'g2', minutes: 45, assists: 1 });
    expect(get('P1').formIndex).toBeGreaterThan(p2.formIndex);
    expect(rows[0].formIndex).toBeGreaterThanOrEqual(rows[rows.length - 1].formIndex);
    for (const r of rows) {
      expect(r.formIndex).toBeGreaterThanOrEqual(0);
      expect(r.formIndex).toBeLessThanOrEqual(100);
    }
  });
});

describe('buildPlayerProps', () => {
  const lines: PlayerLine[] = [];
  DATES.forEach((d, i) => {
    const matchId = `g${i + 1}`;
    // 15 habituales: el primero es un delantero goleador
    for (let k = 0; k < 15; k++) {
      lines.push(
        line({
          matchId,
          date: d,
          playerId: `R${k}`,
          position: k === 0 ? 'F' : k < 5 ? 'D' : 'M',
          goals: k === 0 && i % 2 === 0 ? 1 : 0,
          shots: k === 0 ? 4 : k % 3,
          shotsOnTarget: k === 0 ? 2 : Math.min(k % 3, k % 2),
          foulsCommitted: k % 4,
          yellow: k === 7 && i < 3 ? 1 : 0,
          minutes: k >= 11 ? 20 : 90,
          starter: k < 11,
        }),
      );
    }
    // jugó solo los dos primeros partidos (lesionado): excluido
    if (i < 2) lines.push(line({ matchId, date: d, playerId: 'OUT', position: 'F', goals: 2, shots: 5, shotsOnTarget: 4 }));
  });
  const base = {
    teamId: 'T1',
    opponentId: 'T2',
    lines,
    teamLambda: 1.5,
    teamAvgGoals: 0.5,
    oppShotsFactor: 1,
    oppSotFactor: 1,
    cardsFactor: 1,
    foulsFactor: 1,
  };
  const props = buildPlayerProps(base);

  it('máximo 14, ordenadas por P(gol), excluye a quien no jugó los 3 últimos', () => {
    expect(props).toHaveLength(14);
    expect(props.some((p) => p.player.id === 'OUT')).toBe(false);
    for (let i = 1; i < props.length; i++) expect(props[i - 1].pGoal).toBeGreaterThanOrEqual(props[i].pGoal);
    expect(props[0].player.id).toBe('R0');
  });

  it('minutos esperados, totales y coherencia de probabilidades', () => {
    const r0 = props.find((p) => p.player.id === 'R0')!;
    expect(r0.expMinutes).toBe(90);
    expect(r0).toMatchObject({ apps: 6, minutes: 540, goals: 3 });
    const sub = props.find((p) => p.player.id === 'R12');
    if (sub) expect(sub.expMinutes).toBe(20);
    for (const p of props) {
      for (const k of ['pGoal', 'pAssist', 'pGoalOrAssist', 'pShots1', 'pShots2', 'pSot1', 'pSot2', 'pCard'] as const) {
        expect(p[k]).toBeGreaterThanOrEqual(0);
        expect(p[k]).toBeLessThanOrEqual(1);
      }
      expect(p.pShots2).toBeLessThanOrEqual(p.pShots1);
      expect(p.pSot2).toBeLessThanOrEqual(p.pSot1);
      expect(p.pSot1).toBeLessThanOrEqual(p.pShots1);
      expect(p.pGoalOrAssist).toBeGreaterThanOrEqual(Math.max(p.pGoal, p.pAssist));
    }
    // λ_gol del delantero ≈ goles/90 contraídos · (λ equipo / media del equipo)
    expect(r0.pGoal).toBeGreaterThan(0.6);
  });

  it('escala con λ del equipo y los factores del rival', () => {
    const lowLambda = buildPlayerProps({ ...base, teamLambda: 0.5 });
    const r0 = (xs: typeof props) => xs.find((p) => p.player.id === 'R0')!;
    expect(r0(lowLambda).pGoal).toBeLessThan(r0(props).pGoal);
    const moreShots = buildPlayerProps({ ...base, oppShotsFactor: 1.5, cardsFactor: 2, foulsFactor: 1.5 });
    expect(r0(moreShots).pShots1).toBeGreaterThan(r0(props).pShots1);
    const r7 = (xs: typeof props) => xs.find((p) => p.player.id === 'R7');
    if (r7(props) && r7(moreShots)) expect(r7(moreShots)!.pCard).toBeGreaterThan(r7(props)!.pCard);
    expect(buildPlayerProps({ ...base, teamId: 'NADIE' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// simulation.ts
// ---------------------------------------------------------------------------

function tableOf(points: number[]): StandingGroup {
  return {
    name: 'Liga X',
    rows: points.map((p, i) => ({
      rank: i + 1,
      team: T(`S${i}`),
      played: 10,
      won: Math.floor(p / 3),
      drawn: p % 3,
      lost: 10 - Math.floor(p / 3) - (p % 3),
      gf: 10,
      ga: 10,
      gd: 0,
      points: p,
    })),
  };
}

function roundRobin(ids: string[]): { home: string; away: string }[] {
  const out: { home: string; away: string }[] = [];
  for (const h of ids) for (const a of ids) if (h !== a) out.push({ home: h, away: a });
  return out;
}

describe('simulateSeason', () => {
  const group = tableOf([25, 22, 20, 18, 12, 10]);
  const strength: Record<string, number> = { S0: 1.6, S1: 1.4, S2: 1.2, S3: 1.0, S4: 0.8, S5: 0.7 };
  const zones = [
    { label: 'Campeón', from: 1, to: 1 },
    { label: 'Top 2', from: 1, to: 2 },
    { label: 'Descenso', from: -2, to: -1 },
  ];
  const input = {
    group,
    remaining: roundRobin(group.rows.map((r) => r.team.id)),
    lambdas: (h: string, a: string) => ({ lambdaHome: 1.25 * strength[h] / strength[a] ** 0.5, lambdaAway: strength[a] / strength[h] ** 0.5 }),
    zones,
    iterations: 4000,
    seed: 123,
  };
  const sim = simulateSeason(input);

  it('las probabilidades suman 1 por columna Campeón y por posiciones', () => {
    expect(sim.columns).toEqual(['Campeón', 'Top 2', 'Descenso']);
    expect(sim.iterations).toBe(4000);
    expect(sim.remainingMatches).toBe(30);
    const sumCol = (label: string) => sim.rows.reduce((s, r) => s + r.probs[label], 0);
    expect(sumCol('Campeón')).toBeCloseTo(1, 2);
    expect(sumCol('Top 2')).toBeCloseTo(2, 2);
    expect(sumCol('Descenso')).toBeCloseTo(2, 2);
    for (let pos = 0; pos < 6; pos++) expect(sim.rows.reduce((s, r) => s + r.positionDist[pos], 0)).toBeCloseTo(1, 2);
    for (const r of sim.rows) {
      expect(r.positionDist).toHaveLength(6);
      expect(r.positionDist.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 2);
      expect(r.probs['Campeón']).toBeCloseTo(r.positionDist[0], 3);
      expect(r.probs['Descenso']).toBeCloseTo(r.positionDist[4] + r.positionDist[5], 3);
      expect(r.expectedPoints).toBeGreaterThanOrEqual(r.currentPoints);
      expect(r.expectedPoints).toBeLessThanOrEqual(r.currentPoints + 30);
    }
  });

  it('coherencia: el líder y más fuerte es favorito; filas ordenadas por puesto esperado', () => {
    expect(sim.rows[0].team.id).toBe('S0');
    expect(sim.rows[0].probs['Campeón']).toBeGreaterThan(0.5);
    expect(sim.rows[sim.rows.length - 1].probs['Descenso']).toBeGreaterThan(0.5);
    for (let i = 1; i < sim.rows.length; i++) expect(sim.rows[i].expectedRank).toBeGreaterThanOrEqual(sim.rows[i - 1].expectedRank);
  });

  it('reproducible con la misma semilla', () => {
    expect(simulateSeason(input)).toEqual(sim);
    expect(simulateSeason({ ...input, seed: 7 })).not.toEqual(sim);
  });

  it('sin partidos restantes: clasificación actual; empates exactos al sorteo', () => {
    const done = simulateSeason({ ...input, remaining: [], iterations: 2000 });
    expect(done.remainingMatches).toBe(0);
    expect(done.rows[0].probs['Campeón']).toBe(1);
    expect(done.rows[0].expectedPoints).toBe(25);
    const tied = simulateSeason({ ...input, group: tableOf([20, 20, 5]), remaining: [], iterations: 4000 });
    const p = tied.rows.map((r) => r.probs['Campeón']).sort();
    expect(p[0]).toBe(0);
    expect(p[1]).toBeGreaterThan(0.45);
    expect(p[2]).toBeLessThan(0.55);
  });

  it('zonas negativas desde abajo e ignora equipos desconocidos', () => {
    expect(resolveZone({ from: -3, to: -1 }, 20)).toEqual([18, 20]);
    expect(resolveZone({ from: -12, to: -1 }, 36)).toEqual([25, 36]);
    expect(resolveZone({ from: 9, to: 24 }, 36)).toEqual([9, 24]);
    const s = simulateSeason({ ...input, remaining: [...input.remaining, { home: 'S0', away: 'NADIE' }], iterations: 10 });
    expect(s.remainingMatches).toBe(30);
  });

  it('rendimiento: 10.000 iteraciones × 200 partidos en < 3 s', () => {
    const big = tableOf(Array.from({ length: 20 }, (_, i) => 30 - i));
    const ids = big.rows.map((r) => r.team.id);
    const remaining = roundRobin(ids).slice(0, 200);
    const t0 = performance.now();
    const s = simulateSeason({ group: big, remaining, lambdas: () => ({ lambdaHome: 1.5, lambdaAway: 1.1 }), zones, iterations: 10_000, seed: 1 });
    const ms = performance.now() - t0;
    expect(s.remainingMatches).toBe(200);
    expect(ms).toBeLessThan(3000);
    expect(s.rows.reduce((acc, r) => acc + r.probs['Campeón'], 0)).toBeCloseTo(1, 2);
  });
});

// ---------------------------------------------------------------------------
// backtest.ts
// ---------------------------------------------------------------------------

const P = (home: number, draw: number, away: number): Prob1X2 => ({ home, draw, away });

describe('runBacktest', () => {
  const m1 = fin('b1', '2026-08-01T00:00:00Z', 'A', 'B', 2, 0); // local
  const m2 = fin('b2', '2026-08-02T00:00:00Z', 'C', 'D', 1, 1); // empate
  const m3 = fin('b3', '2026-08-03T00:00:00Z', 'E', 'F', 0, 3); // visitante
  const uniform = P(1 / 3, 1 / 3, 1 / 3);

  it('predicciones perfectas: Brier 0, RPS 0, acierto 1', () => {
    const items: BacktestItem[] = [
      { match: m1, pred: { p: P(1, 0, 0), over25: 0, btts: 0 } },
      { match: m2, pred: { p: P(0, 1, 0), over25: 0, btts: 1 } },
      { match: m3, pred: { p: P(0, 0, 1), over25: 1, btts: 0 } },
    ];
    const bt = runBacktest(items, uniform);
    expect(bt.matches).toBe(3);
    expect(bt.from).toBe(m1.date);
    expect(bt.to).toBe(m3.date);
    expect(bt.model).toMatchObject({ brier: 0, rps: 0, accuracy: 1 });
    expect(bt.model.logLoss).toBeCloseTo(0, 6);
    expect(bt.baseline.brier).toBeCloseTo(2 / 3, 4);
    expect(bt.baseline.logLoss).toBeCloseTo(Math.log(3), 4);
    expect(bt.over25).toEqual({ brier: 0, accuracy: 1, n: 3 });
    expect(bt.btts).toEqual({ brier: 0, accuracy: 1, n: 3 });
    expect(bt.elo).toBeUndefined();
    expect(bt.market).toBeUndefined();
    expect(bt.roi).toBeUndefined();
    // calibración con las 3 clases: 9 probabilidades → bins 0 y 1
    expect(bt.calibration.reduce((s, b) => s + b.n, 0)).toBe(9);
    expect(bt.calibration.find((b) => b.from === 0)).toMatchObject({ n: 6, observed: 0 });
    expect(bt.calibration.find((b) => b.from === 0.9)).toMatchObject({ n: 3, observed: 1 });
  });

  it('fuentes, mercado desde cuotas de cierre y ROI de apuesta plana', () => {
    const closing = { home: 2.0, draw: 3.5, away: 4.0 };
    const items: BacktestItem[] = [
      // EV local = 0.6·2 − 1 = 0.2 → apuesta al local, gana (+1)
      { match: m1, pred: { p: P(0.6, 0.25, 0.15), over25: 0.3, sources: { elo: P(0.5, 0.3, 0.2), dc: P(0.6, 0.25, 0.15) } }, closing },
      // EV empate = 0.32·3.5 − 1 = 0.12 → apuesta al empate, gana (+2.5)
      { match: m2, pred: { p: P(0.4, 0.32, 0.28), over25: 0.6 }, closing },
      // EV local 0.2 → apuesta al local, pierde (−1)
      { match: m3, pred: { p: P(0.6, 0.25, 0.15), over25: 0.55 }, closing },
      // sin valor (EV < 5 %): no se apuesta
      { match: fin('b4', '2026-08-04T00:00:00Z', 'G', 'H', 1, 0), pred: { p: P(0.5, 0.27, 0.23) }, closing },
      // partido no terminado: se ignora
      { match: { ...m1, id: 'b5', status: 'scheduled', score: undefined }, pred: { p: P(0.9, 0.05, 0.05) }, closing },
    ];
    const bt = runBacktest(items, P(0.45, 0.27, 0.28));
    expect(bt.matches).toBe(4);
    expect(bt.elo).toBeDefined();
    expect(bt.dixonColes).toBeDefined();
    expect(bt.marketMatches).toBe(4);
    expect(bt.market).toBeDefined();
    expect(bt.roi).toEqual({ bets: 3, staked: 3, profit: 2.5, roi: 0.8333, hitRate: 0.6667, avgOdds: 2.5 });
    // over 2.5: 0.3 (y=0), 0.6 (y=0), 0.55 (y=1) → Brier medio (0.09 + 0.36 + 0.2025)/3
    expect(bt.over25!.n).toBe(3);
    expect(bt.over25!.brier).toBeCloseTo((0.09 + 0.36 + 0.2025) / 3, 4);
    expect(bt.over25!.accuracy).toBeCloseTo(2 / 3, 3);
    // la uniforme acierta (argmax=local) solo el partido de local y los partidos con victoria local
    const flat = runBacktest(items, uniform);
    expect(flat.baseline.accuracy).toBe(0.5);
  });

  it('filtros de prob. mínima y cuota máxima en el ROI', () => {
    const closing = { home: 1.2, draw: 7, away: 12 };
    // EV visitante = 0.1·12 − 1 = 0.2, pero p < minProb y cuota > maxOdds → no se apuesta
    const bt = runBacktest([{ match: m3, pred: { p: P(0.8, 0.1, 0.1) }, closing }], uniform);
    expect(bt.roi).toMatchObject({ bets: 0, profit: 0 });
    const loose = runBacktest([{ match: m3, pred: { p: P(0.8, 0.1, 0.1) }, closing }], uniform, { minProb: 0, maxOdds: 100 });
    expect(loose.roi).toMatchObject({ bets: 1, profit: 11 });
  });

  it('mergeBacktests pondera por partidos', () => {
    const a = runBacktest([{ match: m1, pred: { p: P(1, 0, 0) } }], uniform);
    const b = runBacktest([{ match: m2, pred: { p: P(1, 0, 0) } }], uniform);
    const merged = mergeBacktests([a, b])!;
    expect(merged.matches).toBe(2);
    expect(merged.model.accuracy).toBe(0.5);
    expect(merged.model.brier).toBe(1);
    expect(merged.from).toBe(m1.date);
    expect(merged.to).toBe(m2.date);
    expect(mergeBacktests([])).toBeUndefined();
  });
});

describe('walkForwardDC', () => {
  const world = syntheticWorld(3);
  const league = world.stores.find((s) => s.compId === 'liga-a')!.matches;
  const DAY = 86_400_000;

  it('cada modelo usa solo partidos anteriores al día del partido', () => {
    const t0 = performance.now();
    const wf = walkForwardDC(league, MODEL.dcXi, 7, { minMatches: 30 });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(wf.size).toBeGreaterThan(100);
    for (const m of league) {
      const model = wf.get(m.id);
      if (!model) continue;
      const day = Math.floor(Date.parse(m.date) / DAY) * DAY;
      const prior = league.filter((x) => Date.parse(x.date) < day).length;
      expect(model.nMatches).toBeLessThanOrEqual(prior);
      expect(model.nMatches).toBeGreaterThanOrEqual(30);
    }
    // re-ajustes semanales: menos modelos que partidos
    const fits = new Set(wf.values()).size;
    expect(fits).toBeGreaterThan(5);
    expect(fits).toBeLessThan(wf.size / 2);
  });

  it('sin fuga de información: cambiar resultados futuros no cambia el modelo', () => {
    const sorted = [...league].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const target = sorted[120];
    const cut = Math.floor(Date.parse(target.date) / DAY) * DAY;
    const altered = sorted.map((m) => (Date.parse(m.date) >= cut ? { ...m, score: { home: 9, away: 0 } } : m));
    const a = walkForwardDC(sorted, MODEL.dcXi, 7, { minMatches: 30 }).get(target.id)!;
    const b = walkForwardDC(altered, MODEL.dcXi, 7, { minMatches: 30 }).get(target.id)!;
    expect(a).toBeDefined();
    expect(b.attack).toEqual(a.attack);
    expect(b.homeAdv).toBe(a.homeAdv);
  });

  it('opción from y mínimo de partidos', () => {
    const sorted = [...league].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const from = sorted[150].date;
    const wf = walkForwardDC(sorted, MODEL.dcXi, 7, { from });
    for (const id of wf.keys()) expect(Date.parse(sorted.find((m) => m.id === id)!.date)).toBeGreaterThanOrEqual(Date.parse(from));
    expect(walkForwardDC(sorted.slice(0, 20), MODEL.dcXi, 7).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// popularity.ts
// ---------------------------------------------------------------------------

describe('popularityScore', () => {
  const base = { compTier: 10, eloHome: 1900, eloAway: 1900, eloP90: 1800, pHome: 0.36, pAway: 0.36, hoursToKickoff: 24 };
  it('rango y casos extremos', () => {
    expect(popularityScore(base)).toBe(100);
    const low = popularityScore({ compTier: 4, eloHome: 1300, eloAway: 1300, eloP90: 1800, pHome: 0.8, pAway: 0.05, hoursToKickoff: 10 });
    expect(Math.abs(low - 100 * (0.35 * 0.4 + 0.15 * 0.25))).toBeLessThanOrEqual(0.05 + 1e-9);
  });
  it('monótono en prestigio, calidad y equilibrio; penaliza la lejanía', () => {
    const mid = { ...base, eloHome: 1600, eloAway: 1550, pHome: 0.55, pAway: 0.2 };
    const s = popularityScore(mid);
    expect(popularityScore({ ...mid, compTier: 6 })).toBeLessThan(s);
    expect(popularityScore({ ...mid, eloHome: 1700 })).toBeGreaterThan(s);
    expect(popularityScore({ ...mid, pHome: 0.4, pAway: 0.33 })).toBeGreaterThan(s);
    expect(popularityScore({ ...mid, hoursToKickoff: 100 })).toBeCloseTo(s - 2.8, 1);
    expect(popularityScore({ ...mid, hoursToKickoff: 500 })).toBeCloseTo(s - 10, 1);
    expect(popularityScore({ ...mid, hoursToKickoff: -2 })).toBe(s);
    for (const x of [s, popularityScore({ ...mid, compTier: NaN })]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
    }
  });
  it('percentil de Elo', () => {
    expect(eloPercentile(Array.from({ length: 11 }, (_, i) => 1500 + 10 * i))).toBe(1590);
    expect(eloPercentile([])).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// insights.ts
// ---------------------------------------------------------------------------

describe('insights', () => {
  const world = syntheticWorld(9);
  const ms = world.stores.find((s) => s.compId === 'liga-a')!.matches;
  const stats = computeTeamSeasonStats(ms);
  const avgs = computeLeagueAverages(ms);
  const table = computeStandingsFromMatches(ms);
  const player: PlayerSeasonRow = {
    player: { id: 'p9', name: 'Goleador Uno', short: 'G. Uno', position: 'F', teamId: 'A0' },
    team: T('A0'),
    compId: 'liga-a',
    apps: 10,
    starts: 10,
    minutes: 900,
    goals: 11,
    assists: 2,
    shots: 40,
    shotsOnTarget: 20,
    yellow: 1,
    red: 0,
    foulsCommitted: 5,
    foulsSuffered: 9,
    offsides: 4,
    per90: { goals: 1.1, assists: 0.2, shots: 4, shotsOnTarget: 2, cards: 0.1, foulsCommitted: 0.5 },
    formIndex: 88,
    formTrend: [7, 8, 9, 7, 8],
    last5: [],
  };

  it('5–8 frases en español con números concretos', () => {
    const ins = competitionInsights(stats, avgs, [player], table);
    expect(ins.length).toBeGreaterThanOrEqual(5);
    expect(ins.length).toBeLessThanOrEqual(8);
    for (const s of ins) {
      expect(s).toMatch(/\d/);
      expect(s.endsWith('.')).toBe(true);
    }
    expect(ins.join(' ')).toMatch(/goles por partido/);
    expect(ins.some((s) => s.includes('Goleador Uno') && s.includes('11 goles'))).toBe(true);
    expect(ins[0]).toMatch(/lidera|comparten el liderato/);
  });

  it('sin datos no inventa frases', () => {
    expect(competitionInsights([], computeLeagueAverages([]), [])).toEqual([]);
  });

  it('frases de portada', () => {
    const mk = (id: string, h: string, a: string, p: Prob1X2, xgH: number, xgA: number): MatchSummary => ({
      id,
      compId: 'liga-a',
      compName: 'Liga A',
      date: '2026-11-03T20:00:00Z',
      status: 'scheduled',
      home: T(h),
      away: T(a),
      hasDetail: true,
      prediction: { p, xgHome: xgH, xgAway: xgA, over25: 0.62, btts: 0.55, likelyScore: '1-1', likelyScoreProb: 0.12, confidence: 0.7 },
    });
    const today = [mk('1', 'A', 'B', P(0.7, 0.18, 0.12), 2.1, 0.6), mk('2', 'C', 'D', P(0.4, 0.3, 0.3), 1.8, 1.6)];
    const recent = [true, false, true, true].map((hit, i) => ({ ...mk(`r${i}`, 'E', 'F', P(0.5, 0.3, 0.2), 1, 1), status: 'finished' as const, predictionHit: hit }));
    const hl = homeHighlights({
      today,
      popular: [today[1], today[0]],
      recent,
      topValue: [
        {
          match: today[1],
          pick: { marketId: '1x2', market: 'Resultado final', selection: 'Empate', prob: 0.3, odds: 3.8, fairOdds: 3.33, ev: 0.14, kelly: 0.01, edge: 0.04, confidence: 'media' },
        },
      ],
      hotPlayers: [player],
      modelHeadline: { matches: 500, accuracy: 0.51, rps: 0.201, marketRps: 0.195 },
    });
    expect(hl[0]).toBe('Hoy se disputan 2 partidos de 1 competición.');
    expect(hl.some((s) => s.startsWith('Partido destacado: C – D'))).toBe(true);
    expect(hl.some((s) => s.includes('Mayor favorito: A (70%)'))).toBe(true);
    expect(hl.some((s) => s.includes('Más goles esperados: C – D (3,4 goles'))).toBe(true);
    expect(hl.some((s) => s.includes('cuota 3,80') && s.includes('EV +14,0%'))).toBe(true);
    expect(hl.some((s) => s === 'El modelo acertó 3 de 4 resultados en las últimas 48 h.')).toBe(true);
    expect(hl.length).toBeLessThanOrEqual(8);
    expect(homeHighlights({ today: [], upcomingCount: 12 })[0]).toMatch(/Hoy no hay partidos/);
  });
});
