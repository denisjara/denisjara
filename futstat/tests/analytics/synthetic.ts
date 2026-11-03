/**
 * Datos sintéticos (deterministas) para los tests de analítica: dos ligas, una competición continental entre
 * ellas y una copa con equipos de categoría inferior. Goles ~ Poisson con fuerzas conocidas; estadísticas ~ NB.
 */
import { mulberry32, sampleNegBin, samplePoisson } from '../../src/lib/models';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord, TeamMatchStats } from '../../pipeline/types';
import type { OddsSnapshot, TeamRef } from '../../src/types/data';

const DAY = 86_400_000;

export const SYN_CONFIGS: CompetitionConfig[] = [
  { id: 'liga-a', slug: 'syn.1', name: 'Liga A', shortName: 'Liga A', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 8 },
  { id: 'liga-b', slug: 'syn.2', name: 'Liga B', shortName: 'Liga B', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 5 },
  { id: 'euro', slug: 'syn.euro', name: 'Copa Continental', shortName: 'Continental', country: 'Europa', flag: '🇪🇺', kind: 'continental', tier: 9 },
  { id: 'copa', slug: 'syn.copa', name: 'Copa Nacional', shortName: 'Copa', country: 'Sintetia', flag: '🏳️', kind: 'cup', tier: 5 },
];
export const SYN_CONFIG_MAP = new Map(SYN_CONFIGS.map((c) => [c.id, c]));

export interface TrueTeam {
  ref: TeamRef;
  att: number;
  def: number;
  /** multiplicador de córners a favor */
  corners: number;
  /** multiplicador de tarjetas recibidas */
  cards: number;
}

function team(id: string, name: string, att: number, def: number, corners = 1, cards = 1): TrueTeam {
  return { ref: { id, name, short: name, abbr: name.slice(0, 3).toUpperCase() }, att, def, corners, cards };
}

/** Liga A: A0 es el más fuerte, A9 el más débil. A1 saca muchos córners; A2 ve muchas tarjetas. */
export const TEAMS_A: TrueTeam[] = Array.from({ length: 10 }, (_, i) => {
  const t = i / 9;
  return team(`A${i}`, `Alfa ${i}`, 1.45 - 0.75 * t, 0.7 + 0.7 * t, i === 1 ? 1.6 : 1, i === 2 ? 1.7 : 1);
});
/** Liga B (más débil en conjunto): B0 el más fuerte. */
export const TEAMS_B: TrueTeam[] = Array.from({ length: 8 }, (_, i) => {
  const t = i / 7;
  return team(`B${i}`, `Beta ${i}`, 1.3 - 0.55 * t, 0.8 + 0.5 * t);
});
/** Equipos de categoría inferior que solo juegan la copa. */
export const TEAMS_LOW: TrueTeam[] = Array.from({ length: 4 }, (_, i) => team(`L${i}`, `Modesto ${i}`, 0.5, 1.9));

/** Diferencia de nivel entre ligas aplicada a los cruces (multiplicador de ataque de la liga B frente a la A). */
const LEAGUE_B_STRENGTH = 0.8;

function sampleStats(rng: () => number, goals: number, own: TrueTeam, isHome: boolean): TeamMatchStats {
  const cornersMean = (isHome ? 5.4 : 4.4) * own.corners;
  const cardsMean = (isHome ? 1.9 : 2.2) * own.cards;
  const shots = sampleNegBin((isHome ? 13.5 : 11) * Math.sqrt(own.att), 25, rng);
  return {
    goals,
    shots: Math.max(shots, goals),
    shotsOnTarget: Math.max(goals, Math.min(shots, sampleNegBin(isHome ? 4.7 : 3.9, 30, rng))),
    corners: sampleNegBin(cornersMean, 12, rng),
    fouls: sampleNegBin(isHome ? 11.5 : 12.2, 40, rng),
    yellow: samplePoisson(cardsMean, rng),
    red: rng() < 0.05 ? 1 : 0,
    offsides: samplePoisson(isHome ? 1.9 : 1.7, rng),
  };
}

let idSeq = 1000;

function playMatch(
  rng: () => number,
  compId: string,
  date: number,
  h: TrueTeam,
  a: TrueTeam,
  opts: { homeAdv?: number; neutral?: boolean; aMult?: number; hMult?: number; season?: number } = {},
): MatchRecord {
  const base = 1.15;
  const ha = opts.neutral ? 1 : opts.homeAdv ?? 1.25;
  const lh = base * h.att * (opts.hMult ?? 1) * a.def * ha;
  const la = base * a.att * (opts.aMult ?? 1) * h.def;
  const hg = samplePoisson(lh, rng);
  const ag = samplePoisson(la, rng);
  const d = new Date(date).toISOString();
  return {
    id: String(idSeq++),
    compId,
    season: opts.season ?? new Date(date).getUTCFullYear(),
    currentSeason: date >= Date.UTC(2026, 6, 1),
    date: d,
    status: 'finished',
    neutral: opts.neutral || undefined,
    home: h.ref,
    away: a.ref,
    score: { home: hg, away: ag },
    stats: { home: sampleStats(rng, hg, h, true), away: sampleStats(rng, ag, a, false) },
  };
}

/** Doble vuelta completa por temporada, una jornada cada 7 días. */
function leagueSeasons(rng: () => number, compId: string, teams: TrueTeam[], start: number, seasons: number): MatchRecord[] {
  const out: MatchRecord[] = [];
  let t = start;
  for (let s = 0; s < seasons; s++) {
    const pairs: [TrueTeam, TrueTeam][] = [];
    for (const h of teams) for (const a of teams) if (h !== a) pairs.push([h, a]);
    // baraja determinista
    for (let i = pairs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }
    const perRound = Math.floor(teams.length / 2);
    pairs.forEach((p, k) => {
      const round = Math.floor(k / perRound);
      out.push(playMatch(rng, compId, t + round * 3.5 * DAY + (k % perRound) * 3_600_000, p[0], p[1]));
    });
    t += Math.ceil(pairs.length / perRound) * 3.5 * DAY + 20 * DAY;
  }
  return out;
}

export interface SyntheticWorld {
  stores: CompetitionStore[];
  refDate: string;
}

function store(compId: string, matches: MatchRecord[]): CompetitionStore {
  const cfg = SYN_CONFIG_MAP.get(compId)!;
  return { compId, slug: cfg.slug, updatedAt: '2026-11-03T00:00:00Z', matches, players: [], standings: [] };
}

/** Mundo sintético completo (determinista para una semilla dada). */
export function syntheticWorld(seed = 7): SyntheticWorld {
  idSeq = 1000;
  const rng = mulberry32(seed);
  const start = Date.UTC(2025, 6, 1);
  const a = leagueSeasons(rng, 'liga-a', TEAMS_A, start, 2);
  const b = leagueSeasons(rng, 'liga-b', TEAMS_B, start + 2 * DAY, 2);
  // continental: cruces A vs B (ida y vuelta) repartidos en el tiempo
  const euro: MatchRecord[] = [];
  let t = start + 30 * DAY;
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < 6; i++) {
      const ta = TEAMS_A[(i + r) % TEAMS_A.length];
      const tb = TEAMS_B[(i * 2 + r) % TEAMS_B.length];
      euro.push(playMatch(rng, 'euro', t, ta, tb, { aMult: LEAGUE_B_STRENGTH }));
      euro.push(playMatch(rng, 'euro', t + 7 * DAY, tb, ta, { hMult: LEAGUE_B_STRENGTH }));
      t += 9 * DAY;
    }
    t += 60 * DAY;
  }
  // copa: equipos modestos vs liga A, y un clásico en campo neutral
  const copa: MatchRecord[] = [];
  let tc = start + 45 * DAY;
  for (let i = 0; i < TEAMS_LOW.length; i++) {
    copa.push(playMatch(rng, 'copa', tc, TEAMS_LOW[i], TEAMS_A[i + 3]));
    tc += 20 * DAY;
  }
  copa.push(playMatch(rng, 'copa', tc, TEAMS_A[0], TEAMS_A[1], { neutral: true }));
  const lastDate = Math.max(...[...a, ...b, ...euro, ...copa].map((m) => Date.parse(m.date)));
  return {
    stores: [store('liga-a', a), store('liga-b', b), store('euro', euro), store('copa', copa)],
    refDate: new Date(lastDate + DAY).toISOString(),
  };
}

/** Partido programado (sin marcador) entre dos equipos. */
export function scheduled(
  compId: string,
  date: string,
  home: TeamRef,
  away: TeamRef,
  extra: { odds?: OddsSnapshot; neutral?: boolean; homeForm?: string; awayForm?: string; id?: string } = {},
): MatchRecord {
  return {
    id: extra.id ?? `S-${home.id}-${away.id}`,
    compId,
    season: 2026,
    currentSeason: true,
    date,
    status: 'scheduled',
    neutral: extra.neutral,
    home,
    away,
    odds: extra.odds,
    homeForm: extra.homeForm,
    awayForm: extra.awayForm,
  };
}
