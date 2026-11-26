/**
 * Variantes «availability-*» (pipeline/experiments/availability/model.ts): bajas probables y sanciones.
 * Comprueba las clases de baja (sanción por eventos o por línea, habitual que faltó 1 o 2 partidos, misma u otra
 * competición), los multiplicadores de equipo y, sobre todo, una prueba ADVERSARIAL propia: la comprobación de fuga
 * del banco nunca mete partidos envenenados en la competición del partido predicho, y la sanción depende del ÚLTIMO
 * partido del equipo EN ESA competición; aquí se añaden partidos y líneas futuros en la MISMA competición (con rojas,
 * con los habituales jugando o faltando) y todo debe ser idéntico. También se cargan las variantes con el cargador.
 */
import { describe, expect, it } from 'vitest';
import { Elo } from '../../src/lib/models';
import type { MatchRecord, PlayerLine } from '../../pipeline/types';
import { historyView } from '../../pipeline/experiments/history';
import { listVariants, loadVariant } from '../../pipeline/experiments/load';
import { preMatchView } from '../../pipeline/experiments/types';
import { MINUTES_FACTOR, minutesFactors, P_OUT, statMultipliers, TEAM_FLOOR, TEAM_K, teamAbsences, teamMultipliers, teamShares } from '../../pipeline/experiments/availability/model';

const DAY = 86_400_000;
const T0 = Date.parse('2026-06-01T18:00:00Z');
let seq = 1;

interface Spec {
  compId: string;
  t: number;
  /** jugadores de T con minutos (los demás no juegan) */
  players: string[];
  red?: string[];
  redEvents?: string[];
}

function team(id: string) {
  return { id, name: id, short: id, abbr: id };
}

function build(specs: Spec[]): { ms: MatchRecord[]; ls: PlayerLine[] } {
  const ms: MatchRecord[] = [];
  const ls: PlayerLine[] = [];
  for (const s of specs) {
    const id = `m${seq++}`;
    ms.push({
      id,
      compId: s.compId,
      season: 2026,
      currentSeason: true,
      date: new Date(s.t).toISOString(),
      status: 'finished',
      home: team('T'),
      away: team(`O${seq % 4}`),
      score: { home: 1, away: 1 },
      events: (s.redEvents ?? []).map((p) => ({ minute: 50, clock: "50'", type: 'red' as const, teamId: 'T', playerId: p })),
    });
    for (const p of s.players) {
      const striker = p === 'P9';
      ls.push({
        matchId: id,
        compId: s.compId,
        date: new Date(s.t).toISOString(),
        teamId: 'T',
        opponentId: 'O',
        isHome: true,
        playerId: p,
        name: p,
        short: p,
        position: striker ? 'F' : 'M',
        starter: true,
        minutes: 90,
        goals: striker ? 1 : 0,
        assists: 0,
        shots: striker ? 4 : 1,
        shotsOnTarget: striker ? 2 : 0,
        yellow: 0,
        red: s.red?.includes(p) ? 1 : 0,
        foulsCommitted: 1,
        foulsSuffered: 1,
        offsides: 0,
        ownGoals: 0,
      });
    }
  }
  return { ms, ls };
}

function view(ms: MatchRecord[], ls: PlayerLine[], cutoff: number) {
  const byTeam = new Map<string, MatchRecord[]>();
  const byComp = new Map<string, MatchRecord[]>();
  for (const m of ms) {
    for (const t of [m.home.id, m.away.id]) byTeam.set(t, [...(byTeam.get(t) ?? []), m]);
    byComp.set(m.compId, [...(byComp.get(m.compId) ?? []), m]);
  }
  const linesByTeam = new Map<string, PlayerLine[]>([['T', [...ls].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))]]);
  return historyView({ matchesByTeam: byTeam, matchesByComp: byComp, linesByTeam, elo: new Elo({ k: 20, homeAdv: 65, init: 1500 }) }, cutoff);
}

const ALL = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'];
const without = (...xs: string[]) => ALL.filter((p) => !xs.includes(p));

/**
 * Pasado de T: 5 de liga con los 11 (el 4.º con roja de P5 en la línea y la de P6 solo en los eventos), 1 de copa sin
 * P2 ni P3, y el último de liga sin P3 ni P4 y con roja (evento) de P7 ⇒ para un partido de LIGA: P7 sancionado,
 * P3 faltó los 2 últimos, P4 faltó el último (de liga), P2 jugó el último; P5/P6 ya cumplieron (no fue el último de liga).
 */
function past() {
  return build([
    { compId: 'liga', t: T0 - 40 * DAY, players: ALL },
    { compId: 'liga', t: T0 - 33 * DAY, players: ALL },
    { compId: 'liga', t: T0 - 26 * DAY, players: ALL },
    { compId: 'liga', t: T0 - 19 * DAY, players: ALL, red: ['P5'], redEvents: ['P6'] },
    { compId: 'liga', t: T0 - 12 * DAY, players: ALL },
    { compId: 'copa', t: T0 - 8 * DAY, players: without('P2', 'P3') },
    { compId: 'liga', t: T0 - 4 * DAY, players: without('P3', 'P4'), redEvents: ['P7'] },
  ]);
}

const target = (compId: string, t = T0) =>
  preMatchView({ id: 'X', compId, season: 2026, currentSeason: true, date: new Date(t).toISOString(), status: 'scheduled', home: team('T'), away: team('O1') });

describe('disponibilidad: clases de baja', () => {
  it('liga: P7 sancionado (evento), P3 faltó los 2 últimos, P4 faltó el último de la misma competición', () => {
    const { ms, ls } = past();
    const h = view(ms, ls, T0);
    const abs = teamAbsences(target('liga'), 'T', h.playerLines('T'), h);
    expect(abs).toEqual([
      { playerId: 'P3', kind: 'miss2', pOut: P_OUT.miss2 },
      { playerId: 'P4', kind: 'miss1s', pOut: P_OUT.miss1s },
      { playerId: 'P7', kind: 'susp', pOut: P_OUT.susp },
    ]);
    expect(minutesFactors(abs, true)).toEqual({ P7: MINUTES_FACTOR.susp });
    expect(minutesFactors(abs, false)).toEqual({ P3: MINUTES_FACTOR.miss2, P4: MINUTES_FACTOR.miss1s, P7: MINUTES_FACTOR.susp });
  });

  it('copa: nadie sancionado (la roja fue en liga); P4 faltó el último de OTRA competición', () => {
    const { ms, ls } = past();
    const h = view(ms, ls, T0);
    const abs = teamAbsences(target('copa'), 'T', h.playerLines('T'), h);
    expect(abs.map((a) => `${a.playerId}:${a.kind}`)).toEqual(['P3:miss2', 'P4:miss1o']);
  });

  it('roja en la línea (sin evento) también cuenta, y una sanción ya cumplida no', () => {
    const { ms, ls } = build([
      { compId: 'liga', t: T0 - 30 * DAY, players: ALL },
      { compId: 'liga', t: T0 - 20 * DAY, players: ALL, red: ['P5'] },
    ]);
    const h = view(ms, ls, T0);
    expect(teamAbsences(target('liga'), 'T', ls, h)).toEqual([{ playerId: 'P5', kind: 'susp', pOut: 1 }]);
    const served = build([{ compId: 'liga', t: T0 - 10 * DAY, players: without('P5') }]);
    const h2 = view([...ms, ...served.ms], [...ls, ...served.ls], T0);
    expect(teamAbsences(target('liga'), 'T', [...ls, ...served.ls], h2)).toEqual([]);
  });

  it('multiplicadores de equipo: 1 − K·Σ P(baja)·participación (con suelo) y 1 sin bajas', () => {
    const { ms, ls } = past();
    const h = view(ms, ls, T0);
    const sh = teamShares('T', ls, T0);
    const m = teamMultipliers(target('liga'), 'T', h);
    const lost = (x: Map<string, number>) => P_OUT.miss2 * (x.get('P3') ?? 0) + P_OUT.miss1s * (x.get('P4') ?? 0) + P_OUT.susp * (x.get('P7') ?? 0);
    expect(m.goals).toBeCloseTo(Math.max(TEAM_FLOOR, 1 - TEAM_K * lost(sh.attack)), 12);
    expect(m.shots).toBeCloseTo(Math.max(TEAM_FLOOR, 1 - TEAM_K * lost(sh.shots)), 12);
    expect(m.shots).toBeLessThan(1);
    // sin líneas: producción
    const empty = view(ms, [], T0);
    expect(teamMultipliers(target('copa'), 'T', empty)).toMatchObject({ goals: 1, shots: 1, sot: 1 });
    // stats.adjust: solo las estadísticas presentes en `base`
    const st = statMultipliers(target('liga'), h, { corners: { home: 5, away: 5 } });
    expect(st).toEqual({});
  });

  it('ADVERSARIAL: partidos y líneas futuros en la MISMA competición (rojas, habituales que juegan o faltan) no cambian nada', () => {
    const { ms, ls } = past();
    const fut = build([
      // en el mismo instante del corte (no es anterior) y después; misma competición y otra
      { compId: 'liga', t: T0, players: without('P1', 'P9'), red: ['P2'], redEvents: ['P8'] },
      { compId: 'liga', t: T0 + 3_600_000, players: ALL, redEvents: ['P9'] },
      { compId: 'liga', t: T0 + 2 * DAY, players: without('P9', 'P10', 'P11'), red: ['P10'] },
      { compId: 'copa', t: T0 + 3 * DAY, players: ['P1'] },
      { compId: 'liga', t: T0 + 5 * DAY, players: ['P3', 'P4', 'P7'] },
    ]);
    const a = view(ms, ls, T0);
    const b = view([...ms, ...fut.ms], [...ls, ...fut.ls], T0);
    for (const c of ['liga', 'copa']) {
      // la lista de líneas que se pasa puede traer el futuro (p. ej. una lista sin cortar): se corta igual
      expect(teamAbsences(target(c), 'T', [...ls, ...fut.ls], b)).toEqual(teamAbsences(target(c), 'T', ls, a));
      expect(teamMultipliers(target(c), 'T', b)).toEqual(teamMultipliers(target(c), 'T', a));
    }
    const base = { shots: { home: 12, away: 10 }, shotsOnTarget: { home: 4, away: 3 } };
    expect(statMultipliers(target('liga'), b, base)).toEqual(statMultipliers(target('liga'), a, base));
    // las bajas (P3, P4, P7) tiran pero nunca a puerta: solo cambian los tiros
    expect(Object.keys(statMultipliers(target('liga'), a, base))).toEqual(['shots']);
    // control: los mismos partidos ANTES del corte sí lo cambian (la prueba es sensible)
    const shift = (t: string) => new Date(Date.parse(t) - 2 * DAY + 60_000).toISOString();
    const ms2 = fut.ms.map((m) => ({ ...m, date: shift(m.date) })).filter((m) => Date.parse(m.date) < T0);
    const ids = new Set(ms2.map((m) => m.id));
    const ls2 = fut.ls.map((l) => ({ ...l, date: shift(l.date) })).filter((l) => ids.has(l.matchId));
    const c = view([...ms, ...ms2], [...ls, ...ls2], T0);
    expect(teamAbsences(target('liga'), 'T', [...ls, ...ls2], c)).not.toEqual(teamAbsences(target('liga'), 'T', ls, a));
  });

  it('las cuatro variantes se cargan con el cargador oficial', async () => {
    const names = listVariants().filter((n) => n.startsWith('availability-'));
    expect(names).toEqual(['availability-full', 'availability-props', 'availability-susp', 'availability-team']);
    for (const n of names) expect((await loadVariant(n)).name).toBe(n);
  });
});
