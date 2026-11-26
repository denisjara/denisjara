/**
 * Revisión adversarial (26-nov-2026) del bloque «Factores del partido» y de los ajustes de producción de las props por
 * el CAMINO COMPLETO DEL BUILD (createContext → buildMatchFile): no por buildMatchFactors con una vista hecha a mano.
 *
 * La comprobación de fuga del banco pone el veneno en una copa ficticia; aquí el veneno va en la MISMA competición
 * (partidos terminados de los mismos equipos y con el mismo árbitro justo después del inicio y a la misma hora, con
 * tarjetas, faltas y rojas extremas, y sus líneas de jugador) y en la contabilidad del árbitro (el mismo id con otro
 * nombre, partidos suyos en otra competición, partidos programados suyos con estadísticas). Además se llenan antes las
 * cachés del contexto (refereeMemo, oppFactorCache) con partidos posteriores. Ni el bloque `factors` publicado ni las
 * props del partido pueden cambiar.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32, samplePoisson } from '../../src/lib/models';
import { COMPETITION_BY_ID, type CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../../pipeline/types';
import { computeWalkForward, createContext } from '../../pipeline/publish/context';
import { buildMatchFile } from '../../pipeline/publish/matches';

const DAY = 86_400_000;
const LALIGA = COMPETITION_BY_ID.get('laliga')!;
const COPA = COMPETITION_BY_ID.get('copadelrey')!;
const CONFIGS: CompetitionConfig[] = [LALIGA, COPA];
const NOW = new Date('2026-10-23T12:00:00Z');
const TEAMS = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, name: `Equipo ${i}`, short: `Eq${i}`, abbr: `E${i}` }));
/** inicio de la jornada 1; jornada r (1..18) el sábado r-1 semanas después */
const R1 = Date.UTC(2026, 6, 4, 16);

/** Calendario a doble vuelta (método del círculo): 18 jornadas de 5 partidos. */
function fixtures(): [number, number][][] {
  const n = TEAMS.length;
  const arr = Array.from({ length: n }, (_, i) => i);
  const rounds: [number, number][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [number, number][] = [];
    for (let k = 0; k < n / 2; k++) pairs.push(r % 2 ? [arr[k], arr[n - 1 - k]] : [arr[n - 1 - k], arr[k]]);
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop()!);
  }
  return [...rounds, ...rounds.map((p) => p.map(([h, a]) => [a, h] as [number, number]))];
}

function line(m: MatchRecord, teamId: string, k: number, o: Partial<PlayerLine> = {}): PlayerLine {
  const isHome = m.home.id === teamId;
  return {
    matchId: m.id,
    compId: m.compId,
    date: m.date,
    teamId,
    opponentId: isHome ? m.away.id : m.home.id,
    isHome,
    playerId: `${teamId}p${k}`,
    name: `Jugador ${k} ${teamId}`,
    short: `J${k}`,
    position: k === 0 ? 'G' : k < 5 ? 'D' : k < 9 ? 'M' : 'F',
    starter: k < 11,
    minutes: k < 11 ? 90 : 25,
    goals: 0,
    assists: 0,
    shots: 1,
    shotsOnTarget: 0,
    yellow: 0,
    red: 0,
    foulsCommitted: 1,
    foulsSuffered: 1,
    offsides: 0,
    ownGoals: 0,
    ...o,
  };
}

interface World {
  league: MatchRecord[];
  cup: MatchRecord[];
  lines: PlayerLine[];
}

/**
 * 15 jornadas jugadas (recta final: hay «lo que se juega»), la 16 jugada el 2026-10-17 (partido objetivo terminado) y
 * las 17-18 programadas (después de NOW, 23-oct). Cuatro árbitros. Líneas de 13 jugadores por equipo; el jugador 1 de cada
 * equipo ve la roja en su partido de la jornada 15 (sanción probable en la 16) y el 2 no juega las jornadas 14-15.
 */
function world(): World {
  const rng = mulberry32(11);
  const league: MatchRecord[] = [];
  const lines: PlayerLine[] = [];
  // temporada pasada (4 vueltas, miércoles y sábados): parámetros de pretemporada sin fuga como en producción
  const past = [...fixtures(), ...fixtures()];
  past.forEach((pairs, r) => {
    pairs.forEach(([h, a], k) => {
      const hg = samplePoisson(1.5 + (a - h) * 0.05, rng);
      const ag = samplePoisson(1.1, rng);
      league.push({
        id: `P${r + 1}-${k}`,
        compId: LALIGA.id,
        season: 2025,
        currentSeason: false,
        date: new Date(Date.UTC(2025, 6, 2, 16) + Math.floor(r / 2) * 7 * DAY + (r % 2) * 3 * DAY + k * 3_600_000).toISOString(),
        status: 'finished',
        round: `Jornada ${(r % 18) + 1}`,
        home: TEAMS[h],
        away: TEAMS[a],
        score: { home: hg, away: ag },
        stats: {
          home: { goals: hg, shots: 9 + samplePoisson(4, rng), shotsOnTarget: 3, corners: 4, fouls: 10 + samplePoisson(3, rng), yellow: samplePoisson(2, rng), red: 0 },
          away: { goals: ag, shots: 7 + samplePoisson(4, rng), shotsOnTarget: 2, corners: 3, fouls: 11 + samplePoisson(3, rng), yellow: samplePoisson(2.3, rng), red: 0 },
        },
        referee: { id: `R${(r + k) % 4}`, name: `Árbitro ${(r + k) % 4}` },
      });
    });
  });
  fixtures().forEach((pairs, r) => {
    pairs.forEach(([h, a], k) => {
      const date = R1 + r * 7 * DAY + k * 3_600_000;
      const played = r < 16;
      const hg = samplePoisson(1.5 + (a - h) * 0.05, rng);
      const ag = samplePoisson(1.1, rng);
      const m: MatchRecord = {
        id: `L${r + 1}-${k}`,
        compId: LALIGA.id,
        season: 2026,
        currentSeason: true,
        date: new Date(date).toISOString(),
        status: played ? 'finished' : 'scheduled',
        round: `Jornada ${r + 1}`,
        home: TEAMS[h],
        away: TEAMS[a],
        referee: { id: `R${(r + k) % 4}`, name: `Árbitro ${(r + k) % 4}` },
      };
      if (played) {
        m.score = { home: hg, away: ag };
        m.stats = {
          home: { goals: hg, shots: 9 + samplePoisson(4, rng), shotsOnTarget: 3 + samplePoisson(1, rng), corners: 3 + samplePoisson(2, rng), fouls: 9 + samplePoisson(3, rng), yellow: samplePoisson(2, rng), red: 0 },
          away: { goals: ag, shots: 7 + samplePoisson(4, rng), shotsOnTarget: 2 + samplePoisson(1, rng), corners: 2 + samplePoisson(2, rng), fouls: 10 + samplePoisson(3, rng), yellow: samplePoisson(2.3, rng), red: 0 },
        };
        if (r === 14) {
          m.events = [{ minute: 70, clock: "70'", type: 'red', teamId: m.home.id, playerId: `${m.home.id}p1`, player: `Jugador 1 ${m.home.id}` }];
          m.stats.home.red = 1;
        }
        for (const side of ['home', 'away'] as const) {
          const tid = m[side].id;
          for (let p = 0; p < 13; p++) {
            if (p === 2 && (r === 13 || r === 14)) continue;
            const goals = p >= 9 && p < 11 && rng() < 0.25 ? 1 : 0;
            lines.push(line(m, tid, p, { goals, shots: p >= 9 ? 2 + samplePoisson(1, rng) : samplePoisson(0.6, rng), shotsOnTarget: p >= 9 ? 1 : 0, yellow: rng() < 0.12 ? 1 : 0, red: r === 14 && side === 'home' && p === 1 ? 1 : 0 }));
          }
        }
      }
      league.push(m);
    });
  });
  // copa: una ronda previa (la competición ya existe antes del partido objetivo)
  const cup: MatchRecord[] = [0, 1, 2].map((k) => ({
    id: `C1-${k}`,
    compId: COPA.id,
    season: 2026,
    currentSeason: true,
    date: new Date(Date.UTC(2026, 8, 2, 19) + k * 3_600_000).toISOString(),
    status: 'finished',
    round: 'Primera ronda',
    home: TEAMS[2 * k],
    away: TEAMS[2 * k + 1],
    score: { home: 1, away: 0 },
    stats: { home: { goals: 1, yellow: 2, red: 0, fouls: 12 }, away: { goals: 0, yellow: 3, red: 0, fouls: 13 } },
    referee: { id: `R${k}`, name: `Árbitro ${k}` },
  }));
  return { league, cup, lines };
}

function stores(w: World): CompetitionStore[] {
  return [
    { compId: COPA.id, slug: COPA.slug, updatedAt: NOW.toISOString(), matches: w.cup, players: w.lines.filter((l) => l.compId === COPA.id), standings: [] },
    { compId: LALIGA.id, slug: LALIGA.slug, updatedAt: NOW.toISOString(), matches: w.league, players: w.lines.filter((l) => l.compId === LALIGA.id), standings: [] },
  ];
}

/**
 * Veneno POSTERIOR al inicio de `target` (o a la misma hora), en la misma competición, con los mismos equipos y el mismo
 * árbitro, y contabilidad del árbitro falsa.
 */
function poison(w: World, target: MatchRecord): World {
  const t = Date.parse(target.date);
  const ref = target.referee!;
  const league = w.league.map((m) => ({ ...m }));
  const cup = [...w.cup];
  const lines = [...w.lines];
  const mk = (id: string, at: number, home: MatchRecord['home'], away: MatchRecord['away'], round: string, compId = LALIGA.id, refName = ref.name): MatchRecord => ({
    id,
    compId,
    season: 2026,
    currentSeason: true,
    date: new Date(at).toISOString(),
    status: 'finished',
    round,
    home,
    away,
    score: { home: 7, away: 0 },
    stats: {
      home: { goals: 7, shots: 40, shotsOnTarget: 20, corners: 20, fouls: 45, yellow: 9, red: 2 },
      away: { goals: 0, shots: 1, shotsOnTarget: 0, corners: 0, fouls: 45, yellow: 9, red: 2 },
    },
    events: [
      { minute: 5, clock: "5'", type: 'red', teamId: home.id, playerId: `${home.id}p9`, player: `Jugador 9 ${home.id}` },
      { minute: 6, clock: "6'", type: 'red', teamId: away.id, playerId: `${away.id}p9`, player: `Jugador 9 ${away.id}` },
    ],
    referee: { id: ref.id, name: refName },
  });
  const other = TEAMS.find((x) => x.id !== target.home.id && x.id !== target.away.id)!;
  const extra: MatchRecord[] = [
    mk('P-SAME', t, target.home, other, target.round!), // a la misma hora
    mk('P-1H', t + 3_600_000, target.away, other, target.round!),
    mk('P-2D', t + 2 * DAY, target.home, target.away, 'Jornada 17', LALIGA.id, 'Otro Nombre'), // mismo id, otro nombre
    mk('P-5D', t + 5 * DAY, target.away, target.home, 'Jornada 18'),
    mk('P-CUP', t + DAY, target.away, target.home, 'Octavos de final · Ida', COPA.id), // otra competición
  ];
  for (const m of extra) (m.compId === COPA.id ? cup : league).push(m);
  // partido programado del árbitro ANTES del inicio, con estadísticas: no es pasado terminado
  const sched = mk('P-SCHED', t - 2 * DAY, other, target.away, 'Jornada 16');
  league.push({ ...sched, status: 'scheduled', score: undefined });
  // las jornadas 17-18 programadas pasan a «terminadas» (con el árbitro del objetivo) aunque son posteriores
  for (const m of league) {
    if (m.status === 'scheduled' && Date.parse(m.date) > t && /Jornada 1[78]/.test(m.round ?? '')) {
      Object.assign(m, { status: 'finished', score: { home: 0, away: 6 }, stats: { home: { goals: 0, yellow: 9, red: 2, fouls: 45 }, away: { goals: 6, yellow: 9, red: 2, fouls: 45 } }, events: [], referee: { id: ref.id, name: ref.name } });
    }
  }
  for (const m of extra) {
    for (const side of ['home', 'away'] as const) {
      for (let p = 0; p < 14; p++) lines.push(line(m, m[side].id, p, { red: p % 3 === 0 ? 1 : 0, goals: 3, shots: 9, shotsOnTarget: 6, minutes: p === 1 || p === 2 ? 90 : 10 }));
    }
  }
  return { league, cup, lines };
}

function fileFor(w: World, id: string, warm: string[] = []) {
  const ctx = createContext({ stores: stores(w), configs: CONFIGS, now: NOW });
  computeWalkForward(ctx);
  // cachés del contexto llenadas antes con partidos posteriores (otro corte, otro día)
  for (const wid of warm) buildMatchFile(ctx, ctx.matchById.get(wid)!);
  return buildMatchFile(ctx, ctx.matchById.get(id)!);
}

describe('factores del partido por el camino del build: sin fuga con veneno en la misma competición', () => {
  const w = world();
  const target = w.league.find((m) => m.season === 2026 && m.round === 'Jornada 16')!;
  const clean = fileFor(w, target.id);

  it('el bloque limpio no es trivial (árbitro usado, bajas con sancionado, tabla, forma, casa/fuera, jugadores en forma)', () => {
    const f = clean.factors!;
    expect(f.referee.status).toBe('conocido');
    expect(f.referee.usedInModel).toBe(true);
    const susp = [...f.absences!.home, ...f.absences!.away].filter((a) => a.kind === 'susp');
    expect(susp.length).toBeGreaterThan(0);
    for (const a of susp) expect(a.minutesFactor).toBe(0);
    // el sancionado no se publica en las props
    const published = new Set([...clean.players.home, ...clean.players.away].map((p) => p.player.id));
    for (const a of susp) expect(published.has(a.playerId)).toBe(false);
    expect(f.stakes).toBeDefined();
    expect(f.form).toBeDefined();
    expect(f.venue).toBeDefined();
    expect(clean.players.home.length + clean.players.away.length).toBeGreaterThan(10);
  });

  it('partido terminado: veneno posterior (misma competición, mismo árbitro) y cachés llenas no cambian ni factores ni props', () => {
    const p = poison(w, target);
    const later = ['P-2D', 'P-5D'];
    const pf = fileFor(p, target.id, later);
    expect(pf.factors).toEqual(clean.factors);
    // props: mismos jugadores con los mismos minutos esperados y probabilidades de tiros, tiros a puerta, tarjetas,
    // faltas (bajas probables y factores del rival) y también gol/asistencia, que dependen del λ walk-forward del
    // partido (hasta el 26-nov-2026 se excluían: en este mundo, con < 300 partidos antes del corte de pretemporada, el λ
    // usaba parámetros ajustados a la fecha del build y se movía ~0,2 %; ver tests/analytics/walkforward-leak.test.ts)
    expect(pf.players).toEqual(clean.players);
    expect(pf.model).toEqual(clean.model);
    // tarjetas y faltas proyectadas (multiplicador del árbitro) tampoco
    const pick = (f: typeof clean) => f.projections.filter((x) => x.key === 'cards' || x.key === 'fouls');
    expect(pick(clean)).toHaveLength(2);
    expect(pick(pf)).toEqual(pick(clean));
  });

  it('partido por jugar: el veneno posterior a su inicio no cambia el bloque', () => {
    const up = w.league.find((m) => m.season === 2026 && m.round === 'Jornada 17')!;
    const cleanUp = fileFor(w, up.id);
    expect(cleanUp.factors?.referee.status).toBe('conocido');
    // (lo «terminado» con fecha posterior a NOW lo neutraliza además coherentStatus: aquí se comprueba el extremo a extremo)
    const p = poison(w, up);
    // el objetivo sigue programado
    const pw: World = { ...p, league: p.league.map((m) => (m.id === up.id ? { ...w.league.find((x) => x.id === up.id)! } : m)) };
    expect(fileFor(pw, up.id).factors).toEqual(cleanUp.factors);
  });
});
