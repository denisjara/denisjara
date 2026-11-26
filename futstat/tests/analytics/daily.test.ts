/**
 * Apartado «Pronósticos del día»: candidatos de las familias adicionales (tiros, faltas, jugadores) coherentes,
 * resolución (incluido el nulo cuando el jugador no juega), ausencia de fuga (un partido «del futuro» con estadísticas
 * y líneas absurdas no cambia los candidatos anteriores), regla de selección diaria, combinadas y récord fuera de
 * muestra (los resultados de un tramo no cambian lo que se selecciona en él).
 */
import { describe, expect, it } from 'vitest';
import { convolve, mulberry32, nbPmfArray, overUnderFromDist, sampleNegBin, samplePoisson } from '../../src/lib/models';
import type { PlayerProp, StatProjection } from '../../src/types/data';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../../pipeline/types';
import {
  CONFIDENCE_FAMILIES,
  DAILY_EXTRA_FAMILIES,
  DEFAULT_RULE_OPTIONS,
  FAMILY_BY_ID,
  confidenceCandidates,
  confidenceHistory,
  confidenceRulesFrom,
  settleCandidate,
  settleDataOf,
  upcomingCandidates,
  walkForwardConfidence,
  walkForwardInput,
  type ConfidenceCandidate,
  type ConfidenceFamily,
  type ConfidenceHistoryItem,
  type ConfidenceRule,
  type ConfidenceRules,
  type ConfidenceSettle,
  type HitStats,
  type SettledCandidate,
} from '../../pipeline/analytics/confidence';
import {
  COMBO_MAX_PER_FAMILY,
  DAILY_MAX_PER_CATEGORY,
  DAILY_MAX_PER_MATCH,
  bestPerMatch,
  buildCombos,
  dailyHistory,
  dailyScore,
  dailyWalkForward,
  evaluateExtras,
  extraCandidates,
  extraInputOf,
  extraSettleDataOf,
  preMatchCandidates,
  preMatchRecord,
  recentPlayers,
  redundancyGroup,
  selectDailyPicks,
  upcomingExtraCandidates,
  type ExtraInput,
  type ScoreContext,
} from '../../pipeline/analytics/daily';
import { projectMatchStats } from '../../pipeline/analytics/projections';
import { computeWalkForward, createContext, statContext } from '../../pipeline/publish/context';

const DAY = 86_400_000;

function projection(key: 'shotsOnTarget' | 'shots' | 'fouls', home: number, away: number, r: number): StatProjection {
  const maxK = key === 'shotsOnTarget' ? 30 : key === 'shots' ? 60 : 50;
  return { key, label: key, home, away, total: home + away, totalDist: convolve(nbPmfArray(home, r, maxK), nbPmfArray(away, r, maxK), maxK * 2), lines: [] };
}

function prop(id: string, teamId: string, p: Partial<PlayerProp>): PlayerProp {
  return {
    player: { id, name: `Jugador ${id}`, short: `J. ${id}`, position: 'F', teamId },
    apps: 12,
    minutes: 950,
    goals: 6,
    assists: 2,
    expMinutes: 85,
    formIndex: 70,
    pGoal: 0.4,
    pAssist: 0.2,
    pGoalOrAssist: 0.5,
    pShots1: 0.9,
    pShots2: 0.7,
    pSot1: 0.6,
    pSot2: 0.3,
    pCard: 0.1,
    ...p,
  };
}

const INPUT: ExtraInput = {
  homeName: 'Local FC',
  awayName: 'Visitante CF',
  homeId: 'h',
  awayId: 'a',
  projections: [projection('shotsOnTarget', 5.2, 4.1, 30), projection('shots', 14, 12, 25), projection('fouls', 11.5, 12.2, 40)],
  segment: 'mercado',
  players: {
    home: [prop('9', 'h', { pShots1: 0.92, pShots2: 0.72, pSot1: 0.66, pGoal: 0.45 }), prop('10', 'h', { pShots1: 0.8, pShots2: 0.5, pSot1: 0.5, pGoal: 0.2 })],
    away: [prop('7', 'a', { pShots1: 0.86, pShots2: 0.6, pSot1: 0.55, pGoal: 0.3 })],
  },
};

describe('candidatos de las familias adicionales', () => {
  const all = extraCandidates(INPUT, { minProb: 0, maxProb: 1 });
  const fam = (id: ConfidenceFamily) => all.filter((c) => c.family === id);

  it('familias del catálogo adicional (nunca las de confidence.json), probabilidades en [0,1] y cuota justa = 1/p', () => {
    const extraIds = new Set<string>(DAILY_EXTRA_FAMILIES.map((f) => f.id));
    const baseIds = new Set<string>(CONFIDENCE_FAMILIES.map((f) => f.id));
    expect(all.length).toBeGreaterThan(25);
    for (const c of all) {
      expect(extraIds.has(c.family)).toBe(true);
      expect(baseIds.has(c.family)).toBe(false);
      expect(c.theme).toBe(FAMILY_BY_ID.get(c.family)!.theme);
      expect(['tiros', 'faltas', 'jugadores']).toContain(c.theme);
      expect(c.prob).toBeGreaterThanOrEqual(0);
      expect(c.prob).toBeLessThanOrEqual(1);
      expect(c.fairOdds).toBeCloseTo(Math.min(1000, 1 / c.prob), 6);
      expect(c.segment).toBe('mercado');
      expect(c.marketOdds).toBeUndefined();
    }
    // identificadores únicos por partido (familia + mercado + selección)
    expect(new Set(all.map((c) => `${c.family}|${c.marketId}|${c.selection}`)).size).toBe(all.length);
  });

  it('totales coherentes con la distribución y monótonos en la línea', () => {
    const sot = INPUT.projections![0].totalDist;
    expect(fam('sot-over-6.5')[0].prob).toBeCloseTo(overUnderFromDist(sot, 6.5).over, 9);
    expect(fam('sot-under-12.5')[0].prob).toBeCloseTo(overUnderFromDist(sot, 12.5).under, 9);
    expect(fam('sot-over-6.5')[0].prob).toBeGreaterThan(fam('sot-over-7.5')[0].prob);
    expect(fam('sot-over-7.5')[0].prob).toBeGreaterThan(fam('sot-over-8.5')[0].prob);
    expect(fam('sot-under-13.5')[0].prob).toBeGreaterThan(fam('sot-under-11.5')[0].prob);
    expect(fam('shots-over-19.5')[0].prob).toBeGreaterThan(fam('shots-over-23.5')[0].prob);
    expect(fam('shots-under-35.5')[0].prob).toBeGreaterThan(fam('shots-under-31.5')[0].prob);
    expect(fam('fouls-over-17.5')[0].prob).toBeGreaterThan(fam('fouls-over-19.5')[0].prob);
    expect(fam('fouls-under-31.5')[0].prob).toBeGreaterThan(fam('fouls-under-27.5')[0].prob);
    expect(fam('sot-over-6.5')[0].selection).toBe('Más de 6.5 tiros a puerta');
    expect(fam('sot-over-6.5')[0].marketId).toBe('sot-ou-6.5');
    expect(fam('fouls-under-29.5')[0].settle).toEqual({ kind: 'stat', stat: 'fouls', side: 'under', line: 29.5 });
  });

  it('tiros a puerta por equipo: un candidato por equipo, mayor para el que más remata', () => {
    const t = fam('sot-team-over-2.5');
    expect(t.map((c) => c.marketId).sort()).toEqual(['sot-away-ou-2.5', 'sot-home-ou-2.5']);
    const home = t.find((c) => c.marketId === 'sot-home-ou-2.5')!;
    const away = t.find((c) => c.marketId === 'sot-away-ou-2.5')!;
    expect(home.selection).toBe('Local FC: más de 2.5 tiros a puerta');
    expect(home.prob).toBeGreaterThan(away.prob);
    expect(home.settle).toEqual({ kind: 'stat', stat: 'shotsOnTarget', team: 'home', side: 'over', line: 2.5 });
    expect(home.prob).toBeGreaterThan(fam('sot-team-over-3.5').find((c) => c.marketId === 'sot-home-ou-3.5')!.prob);
  });

  it('props de jugador: probabilidad de sus props, jugador adjunto y resolución por su id', () => {
    const shots = fam('player-shot-1');
    expect(shots.length).toBe(3);
    const nine = shots.find((c) => c.player?.id === '9')!;
    expect(nine.prob).toBeCloseTo(0.92, 9);
    expect(nine.selection).toBe('Jugador 9 (Local FC): al menos 1 tiro');
    expect(nine.player).toMatchObject({ id: '9', teamId: 'h', position: 'F', expMinutes: 85 });
    expect(nine.settle).toEqual({ kind: 'player', playerId: '9', stat: 'shots', min: 1 });
    expect(fam('player-shot-2').find((c) => c.player?.id === '9')!.settle).toEqual({ kind: 'player', playerId: '9', stat: 'shots', min: 2 });
    expect(fam('player-sot-1').find((c) => c.player?.id === '7')!.prob).toBeCloseTo(0.55, 9);
    expect(fam('player-goal').find((c) => c.player?.id === '9')!.settle).toEqual({ kind: 'player', playerId: '9', stat: 'goals', min: 1 });
  });

  it('por defecto solo entre 0.5 y 0.93; la selección natural es la más probable de cada familia', () => {
    const def = extraCandidates(INPUT);
    expect(def.length).toBeGreaterThan(5);
    for (const c of def) {
      expect(c.prob).toBeGreaterThanOrEqual(0.5);
      expect(c.prob).toBeLessThanOrEqual(0.93);
    }
    expect(def.some((c) => c.family === 'player-goal')).toBe(false); // 45 %: no es de alta confianza
    const natural = extraCandidates(INPUT, { natural: true });
    expect(new Set(natural.map((c) => c.family)).size).toBe(natural.length);
    expect(natural.length).toBe(DAILY_EXTRA_FAMILIES.length);
    expect(natural.find((c) => c.family === 'player-shot-1')!.player?.id).toBe('9');
    expect(natural.find((c) => c.family === 'sot-team-over-2.5')!.marketId).toBe('sot-home-ou-2.5');
  });

  it('historial insuficiente de una estadística: sin candidatos de esa estadística; sin props si no hay jugadores', () => {
    const few = extraCandidates({ ...INPUT, statGames: { shotsOnTarget: 2, shots: 12, fouls: 12 } }, { minProb: 0, maxProb: 1 });
    expect(few.some((c) => c.family.startsWith('sot-'))).toBe(false);
    expect(few.some((c) => c.family.startsWith('shots-'))).toBe(true);
    const noPlayers = extraCandidates({ ...INPUT, players: undefined }, { minProb: 0, maxProb: 1 });
    expect(noPlayers.some((c) => c.theme === 'jugadores')).toBe(false);
    expect(extraCandidates({ ...INPUT, projections: [], players: undefined })).toEqual([]);
  });

  it('las familias adicionales no entran en confidence.json: ni candidatos ni reglas por defecto', () => {
    expect(confidenceCandidates({ homeName: 'A', awayName: 'B', p: { home: 0.5, draw: 0.3, away: 0.2 }, matrix: [], projections: INPUT.projections }, { minProb: 0, maxProb: 1 }).some((c) => c.theme === 'tiros' || c.theme === 'faltas' || c.theme === 'jugadores')).toBe(false);
    const hist = synthFamilyHistory(['shots-over-19.5'], 1500, 5);
    const rules = confidenceRulesFrom(hist);
    expect(rules.rules).toEqual([]);
    expect(rules.rejected.every((r) => CONFIDENCE_FAMILIES.some((f) => f.id === r.family))).toBe(true);
    expect(confidenceRulesFrom(hist, { familyDefs: DAILY_EXTRA_FAMILIES }).rules.map((r) => r.family)).toEqual(['shots-over-19.5']);
  });
});

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

describe('resolución de las familias adicionales', () => {
  const c = (settle: ConfidenceSettle) => ({ settle });
  const d = { hg: 1, ag: 0, shotsOnTarget: { home: 5, away: 3 }, shots: { home: 14, away: 9 }, fouls: { home: 12, away: 15 } };

  it('totales y por equipo con las estadísticas del partido; sin dato no se evalúa', () => {
    expect(settleCandidate(c({ kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 6.5 }), d)).toBe('hit');
    expect(settleCandidate(c({ kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 8.5 }), d)).toBe('miss');
    expect(settleCandidate(c({ kind: 'stat', stat: 'shotsOnTarget', side: 'under', line: 11.5 }), d)).toBe('hit');
    expect(settleCandidate(c({ kind: 'stat', stat: 'shotsOnTarget', team: 'home', side: 'over', line: 3.5 }), d)).toBe('hit');
    expect(settleCandidate(c({ kind: 'stat', stat: 'shotsOnTarget', team: 'away', side: 'over', line: 3.5 }), d)).toBe('miss');
    expect(settleCandidate(c({ kind: 'stat', stat: 'shots', side: 'over', line: 21.5 }), d)).toBe('hit');
    expect(settleCandidate(c({ kind: 'stat', stat: 'shots', side: 'under', line: 21.5 }), d)).toBe('miss');
    expect(settleCandidate(c({ kind: 'stat', stat: 'fouls', side: 'under', line: 27.5 }), d)).toBe('hit');
    expect(settleCandidate(c({ kind: 'stat', stat: 'fouls', side: 'over', line: 27.5 }), d)).toBe('miss');
    expect(settleCandidate(c({ kind: 'stat', stat: 'shots', side: 'over', line: 21.5 }), { hg: 1, ag: 0 })).toBeUndefined();
    expect(settleCandidate(c({ kind: 'stat', stat: 'fouls', side: 'over', line: 17.5 }), { hg: 1, ag: 0, shots: d.shots })).toBeUndefined();
  });

  it('props: acierto según la línea del jugador; NULO si no jugó; sin líneas de jugador no se evalúa', () => {
    const players = new Map([
      ['9', { minutes: 90, shots: 3, shotsOnTarget: 1, goals: 0 }],
      ['10', { minutes: 25, shots: 0, shotsOnTarget: 0, goals: 0 }],
      ['11', { minutes: 0, shots: 0, shotsOnTarget: 0, goals: 0 }],
    ]);
    const pd = { hg: 1, ag: 0, players };
    const pc = (playerId: string, stat: 'shotsOnTarget' | 'shots' | 'goals', min = 1) => c({ kind: 'player', playerId, stat, min });
    expect(settleCandidate(pc('9', 'shots'), pd)).toBe('hit');
    expect(settleCandidate(pc('9', 'shots', 2), pd)).toBe('hit');
    expect(settleCandidate(pc('9', 'shots', 4), pd)).toBe('miss');
    expect(settleCandidate(pc('9', 'shotsOnTarget'), pd)).toBe('hit');
    expect(settleCandidate(pc('9', 'goals'), pd)).toBe('miss');
    // jugó (salió del banquillo) y no tiró: fallo, no nulo
    expect(settleCandidate(pc('10', 'shots'), pd)).toBe('miss');
    // no aparece en las líneas del partido o aparece sin minutos: nulo (la casa devuelve la apuesta)
    expect(settleCandidate(pc('99', 'shots'), pd)).toBe('void');
    expect(settleCandidate(pc('11', 'shots'), pd)).toBe('void');
    // partido sin resumen descargado
    expect(settleCandidate(pc('9', 'shots'), { hg: 1, ag: 0 })).toBeUndefined();
  });

  it('grupos de redundancia: misma estadística y sentido, mismo resultado, mismo jugador', () => {
    const g = (settle: ConfidenceSettle) => redundancyGroup({ settle });
    expect(g({ kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 6.5 })).toBe(g({ kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 7.5 }));
    expect(g({ kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 6.5 })).not.toBe(g({ kind: 'stat', stat: 'shotsOnTarget', side: 'under', line: 12.5 }));
    expect(g({ kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 6.5 })).not.toBe(g({ kind: 'stat', stat: 'shots', side: 'over', line: 19.5 }));
    expect(g({ kind: 'stat', stat: 'shotsOnTarget', team: 'home', side: 'over', line: 2.5 })).toBe(g({ kind: 'stat', stat: 'shotsOnTarget', team: 'home', side: 'over', line: 3.5 }));
    expect(g({ kind: 'stat', stat: 'shotsOnTarget', team: 'home', side: 'over', line: 2.5 })).not.toBe(g({ kind: 'stat', stat: 'shotsOnTarget', team: 'away', side: 'over', line: 2.5 }));
    expect(g({ kind: 'outcome', win: ['home', 'draw'] })).toBe(g({ kind: 'dnb', side: 'home' }));
    expect(g({ kind: 'dnb', side: 'home' })).toBe(g({ kind: 'handicap', side: 'home', line: 1.5 }));
    expect(g({ kind: 'total', stat: 'goals', side: 'over', line: 1.5 })).toBe(g({ kind: 'total', stat: 'goals', side: 'over', line: 2.5 }));
    expect(g({ kind: 'total', stat: 'cards', side: 'over', line: 1.5 })).not.toBe(g({ kind: 'total', stat: 'cards', side: 'under', line: 6.5 }));
    expect(g({ kind: 'player', playerId: '9', stat: 'shots', min: 1 })).toBe(g({ kind: 'player', playerId: '9', stat: 'shotsOnTarget', min: 1 }));
    expect(g({ kind: 'player', playerId: '9', stat: 'shots', min: 1 })).not.toBe(g({ kind: 'player', playerId: '7', stat: 'shots', min: 1 }));
  });
});

// ---------------------------------------------------------------------------
// Walk-forward sin fuga (mundo sintético con estadísticas de tiros y líneas de jugador)
// ---------------------------------------------------------------------------

const LIGA: CompetitionConfig = { id: 'liga-a', slug: 'syn.1', name: 'Liga A', shortName: 'Liga A', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 8 };
const POSITIONS: PlayerLine['position'][] = ['G', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'F', 'F', 'F', 'M', 'F'];

/** 13 líneas por equipo: 11 titulares (el delantero 10 sale en el 70) y un suplente que juega 20 minutos. */
function linesOf(m: MatchRecord, rng: () => number): PlayerLine[] {
  const out: PlayerLine[] = [];
  for (const side of ['home', 'away'] as const) {
    const team = m[side];
    const opp = side === 'home' ? m.away : m.home;
    POSITIONS.forEach((position, i) => {
      const minutes = i < 11 ? (i === 10 ? 70 : 90) : i === 11 ? 20 : 0;
      if (!minutes) return; // la fuente solo trae a quien jugó
      const shots = samplePoisson((position === 'F' ? 2.6 : position === 'M' ? 1.2 : position === 'D' ? 0.4 : 0) * (minutes / 90), rng);
      out.push({
        matchId: m.id,
        compId: m.compId,
        date: m.date,
        teamId: team.id,
        opponentId: opp.id,
        isHome: side === 'home',
        playerId: `${team.id}-p${i}`,
        name: `Jugador ${i} ${team.name}`,
        short: `J. ${i}`,
        position,
        starter: i < 11,
        minutes,
        goals: 0,
        assists: 0,
        shots,
        shotsOnTarget: Math.min(shots, samplePoisson(shots * 0.4, rng)),
        yellow: 0,
        red: 0,
        foulsCommitted: samplePoisson(1, rng),
        foulsSuffered: samplePoisson(1, rng),
        offsides: 0,
        ownGoals: 0,
      });
    });
  }
  return out;
}

/** Liga de 12 equipos, una jornada por semana desde 2025-01 hasta 2026-10 (temporada actual desde 2026-08-01). */
function leagueWorld(seed = 3): CompetitionStore {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, name: `Equipo ${i}`, short: `Eq${i}`, abbr: `E${i}`, att: 1.45 - 0.07 * i, def: 0.7 + 0.06 * i }));
  const matches: MatchRecord[] = [];
  const players: PlayerLine[] = [];
  let id = 5000;
  const start = Date.UTC(2025, 0, 4, 15);
  const end = Date.UTC(2026, 9, 25);
  for (let t = start; t < end; t += 7 * DAY) {
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let k = 0; k < 6; k++) {
      const h = order[2 * k];
      const a = order[2 * k + 1];
      const hg = samplePoisson(1.2 * h.att * a.def * 1.2, rng);
      const ag = samplePoisson(1.2 * a.att * h.def, rng);
      const date = t + k * 3_600_000;
      const stats = (goals: number, att: number, home: boolean) => {
        const shots = Math.max(goals, sampleNegBin((home ? 13.5 : 11) * att, 25, rng));
        return {
          goals,
          shots,
          shotsOnTarget: Math.max(goals, Math.min(shots, sampleNegBin((home ? 4.7 : 3.9) * att, 30, rng))),
          corners: sampleNegBin(home ? 5.4 : 4.4, 12, rng),
          fouls: sampleNegBin(home ? 11.5 : 12.2, 40, rng),
          yellow: samplePoisson(home ? 1.9 : 2.2, rng),
          red: 0,
        };
      };
      const m: MatchRecord = {
        id: String(id++),
        compId: LIGA.id,
        season: new Date(date).getUTCFullYear(),
        currentSeason: date >= Date.UTC(2026, 7, 1),
        date: new Date(date).toISOString(),
        status: 'finished',
        home: { id: h.id, name: h.name, short: h.short, abbr: h.abbr },
        away: { id: a.id, name: a.name, short: a.short, abbr: a.abbr },
        score: { home: hg, away: ag },
        stats: { home: stats(hg, h.att, true), away: stats(ag, a.att, false) },
        summaryFetched: true,
      };
      matches.push(m);
      players.push(...linesOf(m, rng));
    }
  }
  return { compId: LIGA.id, slug: LIGA.slug, updatedAt: '2026-11-01T00:00:00Z', matches, players, standings: [] };
}

describe('walk-forward sin fuga de las familias adicionales', () => {
  const store = leagueWorld();
  const now = new Date('2026-11-01T00:00:00Z');
  const current = store.matches.filter((m) => m.currentSeason);
  const target = current[Math.floor(current.length / 2)];
  const t = Date.parse(target.date);
  // partido «del futuro» entre los mismos equipos con estadísticas y líneas de jugador absurdas
  const future: MatchRecord = {
    ...target,
    id: '999999',
    date: new Date(t + 10 * DAY).toISOString(),
    score: { home: 0, away: 9 },
    stats: { home: { goals: 0, shots: 80, shotsOnTarget: 40, corners: 30, fouls: 60, yellow: 9, red: 2 }, away: { goals: 9, shots: 70, shotsOnTarget: 35, corners: 25, fouls: 55, yellow: 8, red: 1 } },
  };
  const futureLines = linesOf(future, mulberry32(1)).map((l) => ({ ...l, shots: 15, shotsOnTarget: 12, goals: 2 }));
  const ctxA = createContext({ stores: [store], configs: [LIGA], now });
  computeWalkForward(ctxA);
  const ctxB = createContext({ stores: [{ ...store, matches: [...store.matches, future], players: [...store.players, ...futureLines] }], configs: [LIGA], now });
  computeWalkForward(ctxB);
  const candidatesOf = (ctx: typeof ctxA) => {
    const input = walkForwardInput(ctx, target)!;
    return extraCandidates(extraInputOf(ctx, target, input, statContext(ctx, LIGA.id, t), t));
  };

  it('los candidatos de un partido jugado no cambian si se añade un partido posterior', () => {
    const a = candidatesOf(ctxA);
    const b = candidatesOf(ctxB);
    expect(a.length).toBeGreaterThan(8);
    expect(a.some((c) => c.theme === 'tiros')).toBe(true);
    expect(a.some((c) => c.theme === 'jugadores')).toBe(true);
    expect(b).toEqual(a);
    expect(recentPlayers(ctxB, target.home.id, t)).toEqual(recentPlayers(ctxA, target.home.id, t));
  });

  it('control: con datos POSTERIORES (proyecciones y líneas actuales) el partido futuro sí los cambiaría', () => {
    const leaky = (ctx: typeof ctxA) => {
      const input = walkForwardInput(ctx, target)!;
      const sc = statContext(ctx, LIGA.id);
      return extraCandidates(extraInputOf(ctx, target, { ...input, projections: projectMatchStats(target.home.id, target.away.id, sc) }, sc, ctx.now), { minProb: 0, maxProb: 1 });
    };
    expect(leaky(ctxB)).not.toEqual(leaky(ctxA));
  });

  it('jugadores elegibles: jugaron alguno de los 2 últimos partidos del equipo, con minutos esperados y acumulados suficientes', () => {
    const input = walkForwardInput(ctxA, target)!;
    const ein = extraInputOf(ctxA, target, input, statContext(ctxA, LIGA.id, t), t);
    const recent = recentPlayers(ctxA, target.home.id, t);
    expect(recent.size).toBeGreaterThanOrEqual(11);
    expect(ein.players!.home.length).toBeGreaterThan(0);
    for (const p of [...ein.players!.home, ...ein.players!.away]) {
      expect(p.expMinutes).toBeGreaterThanOrEqual(60);
      expect(p.minutes).toBeGreaterThanOrEqual(270);
    }
    for (const p of ein.players!.home) expect(recent.has(p.player.id)).toBe(true);
    // el suplente de 20 minutos nunca es elegible
    expect(ein.players!.home.some((p) => p.player.id.endsWith('-p11'))).toBe(false);
  });

  it('historial: mismos partidos que el de confianza (sin cambiarlo) y candidatos resueltos con el dato real', () => {
    const h = dailyHistory(ctxA);
    expect(h.base).toEqual(confidenceHistory(ctxA));
    expect(h.extra.map((x) => x.matchId)).toEqual(h.base.map((x) => x.matchId));
    const item = h.extra.find((x) => x.matchId === target.id)!;
    expect(item.candidates.length).toBeGreaterThan(8);
    const d = extraSettleDataOf(ctxA, target, settleDataOf(target)!);
    expect(d.shotsOnTarget).toEqual({ home: target.stats!.home.shotsOnTarget, away: target.stats!.away.shotsOnTarget });
    expect(d.players!.size).toBe(24);
    for (const c of item.candidates) expect(settleCandidate(c, d)).toBe(c.result);
    expect(Object.keys(item.base ?? {}).length).toBeGreaterThan(10);
    // todos los candidatos del historial son de familias adicionales
    expect(h.extra.every((x) => x.candidates.every((c) => DAILY_EXTRA_FAMILIES.some((f) => f.id === c.family)))).toBe(true);
  });

  it('si el jugador no juega el partido, sus props son nulos; sin líneas del partido, no hay props', () => {
    const h = dailyHistory(ctxA);
    const item = h.extra.find((x) => x.matchId === target.id)!;
    const some = item.candidates.find((c) => c.theme === 'jugadores')!;
    const out = some.player!.id;
    const without = createContext({ stores: [{ ...store, players: store.players.filter((l) => !(l.matchId === target.id && l.playerId === out)) }], configs: [LIGA], now });
    computeWalkForward(without);
    const item2 = dailyHistory(without).extra.find((x) => x.matchId === target.id)!;
    const mine = item2.candidates.filter((c) => c.player?.id === out);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c) => c.result === 'void')).toBe(true);
    // el resto de candidatos del partido no cambia
    const rest = (xs: SettledCandidate[]) => xs.filter((c) => c.player?.id !== out);
    expect(rest(item2.candidates)).toEqual(rest(item.candidates));
    // partido sin resumen (sin líneas): no se generan ni evalúan props
    const noLines = createContext({ stores: [{ ...store, players: store.players.filter((l) => l.matchId !== target.id) }], configs: [LIGA], now });
    computeWalkForward(noLines);
    const item3 = dailyHistory(noLines).extra.find((x) => x.matchId === target.id)!;
    expect(item3.candidates.some((c) => c.theme === 'jugadores')).toBe(false);
    expect(item3.candidates.filter((c) => c.theme !== 'jugadores')).toEqual(item.candidates.filter((c) => c.theme !== 'jugadores'));
  });

  it('partido en juego: se analiza como antes del saque (sin marcador ni estadísticas y con la última cuota previa)', () => {
    const pre = { provider: 'Test', home: 1.8, draw: 3.6, away: 4.6 };
    const live: MatchRecord = {
      ...target,
      id: 'live-1',
      date: new Date(now.getTime() - 40 * 60_000).toISOString(),
      status: 'live',
      statusDetail: "40'",
      score: { home: 3, away: 0 },
      stats: { home: { goals: 3, shots: 25, shotsOnTarget: 14, fouls: 2 }, away: { goals: 0, shots: 1, shotsOnTarget: 0, fouls: 20 } },
      events: [{ minute: 5, clock: "5'", type: 'goal', teamId: target.home.id }],
      odds: { provider: 'Test', home: 1.02, draw: 15, away: 40 }, // cuota EN DIRECTO (con 3-0): no se usa
      oddsHistory: [{ provider: 'Test', home: 1.9, draw: 3.5, away: 4.2 }, pre],
    };
    const rec = preMatchRecord(live);
    expect(rec.status).toBe('scheduled');
    expect([rec.score, rec.stats, rec.events, rec.statusDetail]).toEqual([undefined, undefined, undefined, undefined]);
    expect(rec.odds).toEqual(pre);
    expect(preMatchRecord({ ...live, oddsHistory: undefined }).odds).toBeUndefined();
    expect(live.score).toEqual({ home: 3, away: 0 }); // no modifica el registro original
    // mismos candidatos que el mismo partido todavía programado con esa cuota previa: el marcador y la cuota en directo no influyen
    const ctxLive = createContext({ stores: [{ ...store, matches: [...store.matches, live] }], configs: [LIGA], now });
    const sched: MatchRecord = { ...rec, id: 'sched-1' };
    const ctxSched = createContext({ stores: [{ ...store, matches: [...store.matches, sched] }], configs: [LIGA], now });
    const a = preMatchCandidates(ctxLive, ctxLive.matchById.get('live-1')!);
    const b = [...upcomingCandidates(ctxSched, ctxSched.matchById.get('sched-1')!), ...upcomingExtraCandidates(ctxSched, ctxSched.matchById.get('sched-1')!)];
    expect(a.candidates.length).toBeGreaterThan(10);
    expect(a.candidates).toEqual(b);
    expect(a.candidates.every((c) => c.segment === 'mercado')).toBe(true);
    expect(a.fp.result.quick.p.home).toBeLessThan(0.9); // nada parecido al 1,02 en directo
    expect(ctxLive.predictions.has('live-1')).toBe(false); // no toca la caché de la ficha del partido
  });

  it('datos de resolución: prórroga excluida, tiros a 0 ausentes y props solo con líneas de los dos equipos', () => {
    const base = settleDataOf(target)!;
    const et = extraSettleDataOf(ctxA, target, { ...base, extraTime: true });
    expect([et.shots, et.shotsOnTarget, et.fouls, et.players]).toEqual([undefined, undefined, undefined, undefined]);
    const zero = extraSettleDataOf(ctxA, { ...target, stats: { home: { goals: 0, shots: 0, shotsOnTarget: 0, fouls: 0 }, away: { goals: 0, shots: 0, shotsOnTarget: 0, fouls: 0 } } }, base);
    expect([zero.shots, zero.shotsOnTarget, zero.fouls]).toEqual([undefined, undefined, undefined]);
    const oneSide = createContext({ stores: [{ ...store, players: store.players.filter((l) => !(l.matchId === target.id && l.teamId === target.away.id)) }], configs: [LIGA], now });
    expect(extraSettleDataOf(oneSide, target, base).players).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Puntuación, selección diaria y combinadas
// ---------------------------------------------------------------------------

const STATS = (n: number, rate: number): HitStats => ({ n, hits: Math.round(n * rate), voids: 0, hitRate: rate, wilsonLow: rate - 0.04, wilsonHigh: rate + 0.03, avgProb: rate });

function rule(family: ConfidenceFamily, threshold = 0.8): ConfidenceRule {
  return { family, theme: FAMILY_BY_ID.get(family)!.theme, segment: 'mercado', threshold, goldThreshold: threshold, tail: STATS(300, 0.9), oro: STATS(300, 0.9), candidates: 1000 };
}

function rulesOf(families: ConfidenceFamily[]): ConfidenceRules {
  return { from: '', to: '', matches: 0, options: { ...DEFAULT_RULE_OPTIONS }, rules: families.map((f) => rule(f)), rejected: [] };
}

function mk(family: ConfidenceFamily, prob: number, settle: ConfidenceSettle, marketId: string = family, selection: string = family): ConfidenceCandidate {
  return { family, theme: FAMILY_BY_ID.get(family)!.theme, marketId, market: family, selection, prob, fairOdds: 1 / prob, settle, segment: 'mercado' };
}

describe('puntuación del apartado diario', () => {
  it('crece con la probabilidad recalibrada y con el récord fuera de muestra; 0..100', () => {
    const oos = { n: 400, hits: 356, hitRate: 0.89 };
    const a = dailyScore(0.85, oos, 0.8).score;
    const b = dailyScore(0.92, oos, 0.8).score;
    expect(b).toBeGreaterThan(a);
    expect(dailyScore(0.9, { n: 400, hits: 372, hitRate: 0.93 }, 0.8).score).toBeGreaterThan(dailyScore(0.9, { n: 400, hits: 340, hitRate: 0.85 }, 0.8).score);
    // misma tasa, menos muestra: Wilson más bajo, menos puntuación
    expect(dailyScore(0.9, { n: 40, hits: 36, hitRate: 0.9 }, 0.8).score).toBeLessThan(dailyScore(0.9, { n: 4000, hits: 3600, hitRate: 0.9 }, 0.8).score);
    for (const s of [dailyScore(0.5, oos, 0.99), dailyScore(1, { n: 5000, hits: 5000, hitRate: 1 }, 0)]) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(s.score)).toBe(true);
    }
  });

  it('penaliza las familias sin lift (acierto estructural) y premia el lift positivo', () => {
    const oos = { n: 500, hits: 450, hitRate: 0.9 };
    const none = dailyScore(0.9, oos, 0.92);
    const zero = dailyScore(0.9, oos, 0.9);
    const small = dailyScore(0.9, oos, 0.89);
    const big = dailyScore(0.9, oos, 0.7);
    expect(none.lift).toBeCloseTo(-0.02, 9);
    expect(zero.lift).toBeCloseTo(0, 9);
    expect(big.lift).toBeCloseTo(0.2, 9);
    expect(none.score).toBeLessThan(zero.score);
    expect(small.score - zero.score).toBeGreaterThanOrEqual(8); // salto de la penalización
    expect(big.score).toBeGreaterThan(small.score);
    // sin récord o sin tasa base: sin lift y sin penalización
    expect(dailyScore(0.9, undefined, 0.9).lift).toBeUndefined();
    expect(dailyScore(0.9, oos, undefined).lift).toBeUndefined();
    expect(dailyScore(0.9, oos, undefined).score).toBeGreaterThan(zero.score);
  });
});

describe('selección diaria de un partido', () => {
  const families: ConfidenceFamily[] = [
    'dc', 'dnb', 'ah+1.5', 'ou-1.5-over', 'ou-2.5-over', 'ou-4.5-under', 'team-score', 'corners-over-6.5', 'corners-over-7.5', 'cards-over-1.5', 'cards-under-6.5',
    'sot-over-6.5', 'sot-over-7.5', 'shots-over-19.5', 'sot-team-over-2.5', 'fouls-under-29.5', 'fouls-under-31.5', 'player-shot-1', 'player-shot-2',
  ];
  const rules = rulesOf(families);
  const sc: ScoreContext = { validation: new Map(families.map((f) => [`${f}|mercado`, { n: 300, hits: 270, hitRate: 0.9 }])), baseRates: Object.fromEntries(families.map((f) => [f, { n: 1000, hitRate: 0.82 }])) };
  const player = (id: string) => ({ id, name: `J${id}`, short: `J${id}`, teamId: 'h' });
  const cands: ConfidenceCandidate[] = [
    mk('dc', 0.9, { kind: 'outcome', win: ['home', 'draw'] }),
    mk('dnb', 0.88, { kind: 'dnb', side: 'home' }),
    mk('ah+1.5', 0.91, { kind: 'handicap', side: 'home', line: 1.5 }),
    mk('ou-1.5-over', 0.9, { kind: 'total', stat: 'goals', side: 'over', line: 1.5 }),
    mk('ou-2.5-over', 0.85, { kind: 'total', stat: 'goals', side: 'over', line: 2.5 }),
    mk('ou-4.5-under', 0.86, { kind: 'total', stat: 'goals', side: 'under', line: 4.5 }),
    mk('team-score', 0.89, { kind: 'team-total', team: 'home', side: 'over', line: 0.5 }),
    mk('corners-over-6.5', 0.9, { kind: 'total', stat: 'corners', side: 'over', line: 6.5 }),
    mk('corners-over-7.5', 0.84, { kind: 'total', stat: 'corners', side: 'over', line: 7.5 }),
    mk('cards-over-1.5', 0.92, { kind: 'total', stat: 'cards', side: 'over', line: 1.5 }),
    mk('cards-under-6.5', 0.87, { kind: 'total', stat: 'cards', side: 'under', line: 6.5 }),
    mk('sot-over-6.5', 0.9, { kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 6.5 }),
    mk('sot-over-7.5', 0.86, { kind: 'stat', stat: 'shotsOnTarget', side: 'over', line: 7.5 }),
    mk('shots-over-19.5', 0.92, { kind: 'stat', stat: 'shots', side: 'over', line: 19.5 }),
    mk('sot-team-over-2.5', 0.88, { kind: 'stat', stat: 'shotsOnTarget', team: 'home', side: 'over', line: 2.5 }),
    mk('fouls-under-29.5', 0.9, { kind: 'stat', stat: 'fouls', side: 'under', line: 29.5 }),
    mk('fouls-under-31.5', 0.93, { kind: 'stat', stat: 'fouls', side: 'under', line: 31.5 }),
    { ...mk('player-shot-1', 0.91, { kind: 'player', playerId: '9', stat: 'shots', min: 1 }, 'player-9-shots-1'), player: player('9') },
    { ...mk('player-shot-2', 0.85, { kind: 'player', playerId: '9', stat: 'shots', min: 2 }, 'player-9-shots-2'), player: player('9') },
    { ...mk('player-shot-1', 0.88, { kind: 'player', playerId: '7', stat: 'shots', min: 1 }, 'player-7-shots-1'), player: player('7') },
    { ...mk('player-shot-1', 0.87, { kind: 'player', playerId: '5', stat: 'shots', min: 1 }, 'player-5-shots-1'), player: player('5') },
    // por debajo del umbral y familia sin regla: nunca se publican
    mk('sot-under-12.5', 0.92, { kind: 'stat', stat: 'shotsOnTarget', side: 'under', line: 12.5 }),
    mk('btts-no', 0.7, { kind: 'btts', yes: false }),
  ];
  const picks = selectDailyPicks(cands, rules, sc);

  it('como mucho 8 por partido y 2 por categoría, ordenados por puntuación', () => {
    expect(picks.length).toBe(DAILY_MAX_PER_MATCH);
    const perTheme = new Map<string, number>();
    for (const p of picks) perTheme.set(p.theme, (perTheme.get(p.theme) ?? 0) + 1);
    for (const n of perTheme.values()) expect(n).toBeLessThanOrEqual(DAILY_MAX_PER_CATEGORY);
    for (let i = 1; i < picks.length; i++) expect(picks[i].score).toBeLessThanOrEqual(picks[i - 1].score);
    for (const p of picks) {
      expect(p.tier).toBe('oro');
      expect(p.prob).toBeGreaterThanOrEqual(p.threshold);
      expect(p.lift).toBeCloseTo(0.08, 9);
    }
    const all = selectDailyPicks(cands, rules, sc, { maxPerMatch: 99 });
    expect(all.length).toBeGreaterThan(DAILY_MAX_PER_MATCH);
    expect(all.filter((p) => p.theme === 'jugadores').length).toBe(2);
    expect(all.filter((p) => p.theme === 'tiros').length).toBe(2);
    expect(all.filter((p) => p.theme === 'goles').length).toBe(2);
  });

  it('sin redundancias: un solo pick de resultado, por estadística y sentido, y por jugador', () => {
    const all = selectDailyPicks(cands, rules, sc, { maxPerMatch: 99, maxPerCategory: 99 });
    expect(new Set(all.map((p) => p.group)).size).toBe(all.length);
    expect(all.filter((p) => p.theme === 'resultado').map((p) => p.family)).toEqual(['ah+1.5']); // el de mejor puntuación
    const fams = all.map((p) => p.family);
    expect(fams).toContain('sot-over-6.5');
    expect(fams).not.toContain('sot-over-7.5');
    expect(fams).toContain('ou-1.5-over');
    expect(fams).not.toContain('ou-2.5-over');
    expect(fams).toContain('fouls-under-31.5');
    expect(fams).not.toContain('fouls-under-29.5');
    expect(fams).not.toContain('player-shot-2'); // mismo jugador que su «1+ tiro»
    expect(all.filter((p) => p.family === 'player-shot-1').map((p) => p.player!.id).sort()).toEqual(['5', '7', '9']);
    // sin regla o por debajo del umbral
    expect(fams).not.toContain('sot-under-12.5');
    expect(fams).not.toContain('btts-no');
    expect(selectDailyPicks([mk('dc', 0.79, { kind: 'outcome', win: ['home', 'draw'] })], rules, sc)).toEqual([]);
  });

  it('la franja debe ser oro: una regla cuya franja acierta menos del 85 % no publica', () => {
    const weak: ConfidenceRules = { ...rules, rules: [{ ...rule('dc'), goldThreshold: undefined, oro: undefined, plata: STATS(300, 0.83), tail: STATS(300, 0.83) }] };
    expect(selectDailyPicks([mk('dc', 0.9, { kind: 'outcome', win: ['home', 'draw'] })], weak, sc)).toEqual([]);
  });
});

describe('combinadas', () => {
  const leg = (family: string, score: number, calibratedProb: number, extra: { lift?: number; marketOdds?: number } = {}) => ({ family, score, prob: calibratedProb - 0.01, calibratedProb, ...extra });
  const day = [
    { matchId: 'm1', picks: [leg('dc', 80, 0.9, { lift: 0.05, marketOdds: 1.2 }), leg('cards-over-1.5', 90, 0.95, { lift: -0.01 })] },
    { matchId: 'm2', picks: [leg('ou-1.5-over', 85, 0.92, { lift: 0.1, marketOdds: 1.15 })] },
    { matchId: 'm3', picks: [leg('sot-over-6.5', 70, 0.88, { lift: 0.12, marketOdds: 1.1 })] },
    { matchId: 'm4', picks: [leg('shots-over-19.5', 75, 0.93, { lift: 0.02 })] },
    { matchId: 'm5', picks: [leg('fouls-under-29.5', 60, 0.86, { lift: 0.03 })] },
    { matchId: 'm6', picks: [leg('cards-over-1.5', 95, 0.96, { lift: -0.02 })] },
  ];
  const combos = buildCombos(day);

  it('2, 3 y 5 patas de partidos distintos; probabilidad = producto de las recalibradas; cuota justa = 1/prob', () => {
    expect(combos.map((c) => [c.id, c.legs.length])).toEqual([
      ['segura', 2],
      ['equilibrada', 3],
      ['atrevida', 5],
    ]);
    for (const c of combos) {
      expect(new Set(c.legs.map((l) => l.matchId)).size).toBe(c.legs.length);
      expect(c.prob).toBeCloseTo(c.legs.reduce((p, l) => p * l.pick.calibratedProb, 1), 12);
      expect(c.fairOdds).toBeCloseTo(1 / c.prob, 12);
    }
    expect(combos[0].prob).toBeGreaterThan(combos[1].prob);
    expect(combos[1].prob).toBeGreaterThan(combos[2].prob);
  });

  it('prioriza las patas con lift positivo (y dentro, la puntuación); cuota de mercado solo si todas la tienen', () => {
    // m6 solo tiene una pata sin lift (95 puntos): queda detrás de todas las de lift positivo
    expect(combos[2].legs.map((l) => l.matchId)).toEqual(['m2', 'm1', 'm4', 'm3', 'm5']);
    // de m1 se elige la de lift positivo aunque la otra puntúe más
    expect(combos[0].legs.find((l) => l.matchId === 'm1')!.pick.family).toBe('dc');
    expect(combos[0].marketOdds).toBeCloseTo(1.15 * 1.2, 12);
    expect(combos[1].marketOdds).toBeUndefined(); // m4 no tiene cuota
  });

  it('sin partidos suficientes no se propone; nunca más de 2 patas de la misma familia', () => {
    expect(buildCombos(day.slice(0, 1))).toEqual([]);
    expect(buildCombos(day.slice(0, 2)).map((c) => c.id)).toEqual(['segura']);
    expect(buildCombos(day.slice(0, 3)).map((c) => c.id)).toEqual(['segura', 'equilibrada']);
    expect(buildCombos(day.slice(0, 4)).map((c) => [c.id, c.legs.length])).toEqual([['segura', 2], ['equilibrada', 3], ['atrevida', 4]]);
    const same = Array.from({ length: 6 }, (_, i) => ({ matchId: `s${i}`, picks: [leg('shots-over-19.5', 90 - i, 0.95, { lift: 0.02 }), leg(i % 2 ? 'dc' : 'ou-1.5-over', 60 - i, 0.88, { lift: 0.05 })] }));
    for (const c of buildCombos(same)) {
      const perFamily = new Map<string, number>();
      for (const l of c.legs) perFamily.set(l.pick.family, (perFamily.get(l.pick.family) ?? 0) + 1);
      for (const n of perFamily.values()) expect(n).toBeLessThanOrEqual(COMBO_MAX_PER_FAMILY);
      expect(new Set(c.legs.map((l) => l.matchId)).size).toBe(c.legs.length);
    }
    expect(buildCombos(same).find((c) => c.id === 'atrevida')!.legs.length).toBe(5);
  });

  it('bestPerMatch: uno por partido, por orden, con tope por familia', () => {
    const cmp = (a: { score: number }, b: { score: number }) => b.score - a.score;
    const top = bestPerMatch(day, cmp, 1);
    expect(top.map((t) => `${t.matchId}:${t.pick.family}`)).toEqual(['m6:cards-over-1.5', 'm2:ou-1.5-over', 'm1:dc', 'm4:shots-over-19.5', 'm3:sot-over-6.5', 'm5:fouls-under-29.5']);
    expect(bestPerMatch(day, cmp, 3, 2).map((t) => t.matchId)).toEqual(['m6', 'm1']);
  });
});

// ---------------------------------------------------------------------------
// Récord fuera de muestra de la regla diaria
// ---------------------------------------------------------------------------

/** Historial sintético calibrado (acierto = probabilidad) con un candidato por familia y partido, cada 2 horas. */
function synthFamilyHistory(families: ConfidenceFamily[], n: number, seed: number, opts: { voidRate?: number } = {}): ConfidenceHistoryItem[] {
  const rng = mulberry32(seed);
  const t0 = Date.UTC(2026, 0, 1);
  const out: ConfidenceHistoryItem[] = [];
  for (let i = 0; i < n; i++) {
    const candidates: SettledCandidate[] = families.map((family) => {
      const prob = 0.55 + 0.38 * rng();
      const isPlayer = family.startsWith('player-');
      const voided = isPlayer && rng() < (opts.voidRate ?? 0);
      const hit = rng() < prob;
      const settle: ConfidenceSettle = isPlayer ? { kind: 'player', playerId: `p${i}`, stat: 'shots', min: 1 } : { kind: 'stat', stat: 'shots', side: 'over', line: 19.5 };
      const c: SettledCandidate = { ...mk(family, prob, family === 'ou-4.5-under' ? { kind: 'total', stat: 'goals', side: 'under', line: 4.5 } : family === 'cards-over-1.5' ? { kind: 'total', stat: 'cards', side: 'over', line: 1.5 } : settle), result: voided ? 'void' : hit ? 'hit' : 'miss' };
      if (isPlayer) c.player = { id: `p${i}`, name: `Jugador ${i}`, short: `J${i}`, teamId: 't' };
      return c;
    });
    out.push({
      matchId: `m${String(i).padStart(5, '0')}`,
      compId: 'liga',
      date: new Date(t0 + i * 2 * 3_600_000).toISOString(),
      home: 'A',
      away: 'B',
      score: { home: 1, away: 0 },
      cards: 4,
      candidates,
      base: Object.fromEntries(families.map((f) => [f, rng() < 0.8 ? 'hit' : 'miss'])),
    });
  }
  return out;
}

describe('récord fuera de muestra de la regla diaria (walk-forward mensual)', () => {
  const N = 3000;
  const baseHist = synthFamilyHistory(['ou-4.5-under', 'cards-over-1.5'], N, 71);
  const extraHist = synthFamilyHistory(['shots-over-19.5', 'player-shot-1'], N, 72, { voidRate: 0.08 });
  const run = (b: ConfidenceHistoryItem[], e: ConfidenceHistoryItem[]) => {
    const base = walkForwardConfidence(b, { select: { maxPerMatch: 2 } });
    const extra = evaluateExtras(e);
    return { base, extra, wf: dailyWalkForward(base, extra.wf, b, e, 'Europe/Madrid') };
  };
  const r = run(baseHist, extraHist);

  it('las familias adicionales se validan con el mismo procedimiento: reglas publicadas solo con >= 30 picks y >= 80 %', () => {
    expect(r.extra.rules.rules.length).toBeGreaterThan(0);
    for (const rule of r.extra.rules.rules) {
      const v = r.extra.validation.get(`${rule.family}|${rule.segment}`)!;
      expect(v.n).toBeGreaterThanOrEqual(30);
      expect(v.hitRate).toBeGreaterThanOrEqual(0.8);
      expect(rule.platt).toBeDefined();
    }
    // en el primer tramo no hay ninguna regla validada todavía
    expect(r.extra.wf.foldRules[0].published.rules).toEqual([]);
    expect(r.extra.wf.folds.length).toBe(r.base.folds.length);
    expect(r.extra.wf.folds.map((f) => f.start)).toEqual(r.base.folds.map((f) => f.start));
  });

  it('cifras coherentes: global = suma de categorías, nulos aparte, tasa base por categoría y combinadas por día', () => {
    const wf = r.wf;
    expect(wf.picks.length).toBeGreaterThan(200);
    expect(wf.overall.n + wf.overall.voids).toBe(wf.picks.length);
    const themes = Object.values(wf.byTheme);
    expect(themes.reduce((s, g) => s + g!.picks, 0)).toBe(wf.overall.picks);
    expect(themes.reduce((s, g) => s + g!.hits, 0)).toBe(wf.overall.hits);
    expect(wf.byTheme.jugadores!.voids).toBeGreaterThan(0);
    expect(wf.overall.hitRate).toBeGreaterThan(0.8);
    for (const g of themes) expect(g!.baseRate).toBeCloseTo(0.8, 1);
    const firstFold = Date.parse(r.base.folds[0].start);
    for (const p of wf.picks) expect(Date.parse(p.date)).toBeGreaterThanOrEqual(firstFold);
    expect(wf.folds.reduce((s, f) => s + f.picks, 0)).toBe(wf.picks.length);
    // regla diaria: como mucho 2 por categoría y 8 por partido también fuera de muestra
    const perMatch = new Map<string, string[]>();
    for (const p of wf.picks) perMatch.set(p.matchId, [...(perMatch.get(p.matchId) ?? []), p.theme]);
    for (const themesOf of perMatch.values()) {
      expect(themesOf.length).toBeLessThanOrEqual(DAILY_MAX_PER_MATCH);
      for (const th of new Set(themesOf)) expect(themesOf.filter((x) => x === th).length).toBeLessThanOrEqual(DAILY_MAX_PER_CATEGORY);
    }
    expect(wf.combos.map((c) => c.id)).toEqual(['segura', 'equilibrada', 'atrevida']);
    for (const c of wf.combos) {
      expect(c.days).toBeGreaterThan(10);
      expect(c.hits).toBeLessThanOrEqual(c.days);
      expect(c.hitRate).toBeCloseTo(c.hits / c.days, 12);
      expect(c.avgFairOdds).toBeGreaterThan(1);
    }
    expect(wf.combos[0].avgLegs).toBe(2);
    expect(wf.combos[2].avgLegs).toBeGreaterThanOrEqual(4);
    expect(wf.combos[0].hitRate).toBeGreaterThan(wf.combos[2].hitRate);
  });

  it('sin fuga: los resultados de un tramo no cambian qué se selecciona en él (solo si acierta)', () => {
    const lastStart = Date.parse(r.base.folds[r.base.folds.length - 1].start);
    const flip = (h: ConfidenceHistoryItem[]) =>
      h.map((it) =>
        Date.parse(it.date) >= lastStart
          ? { ...it, candidates: it.candidates.map((c) => ({ ...c, result: c.result === 'hit' ? ('miss' as const) : c.result === 'miss' ? ('hit' as const) : c.result })) }
          : it,
      );
    const r2 = run(flip(baseHist), flip(extraHist));
    const key = (p: (typeof r.wf.picks)[number]) => `${p.matchId}|${p.family}|${p.marketId}|${p.score}|${p.calibratedProb}`;
    expect(r2.wf.picks.map(key)).toEqual(r.wf.picks.map(key));
    const last = (w: typeof r.wf) => w.picks.filter((p) => Date.parse(p.date) >= lastStart && p.result !== 'void');
    const a = last(r.wf);
    const b = last(r2.wf);
    expect(a.length).toBeGreaterThan(50);
    expect(b.filter((p) => p.result === 'hit').length).toBe(a.filter((p) => p.result === 'miss').length);
    // los tramos anteriores no cambian en nada
    const before = (w: typeof r.wf) => w.picks.filter((p) => Date.parse(p.date) < lastStart).map((p) => `${key(p)}|${p.result}`);
    expect(before(r2.wf)).toEqual(before(r.wf));
  });
});
