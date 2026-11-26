/**
 * Revisión adversarial (fugas) del factor FORMA DE JUGADORES, variante playerform-fac6x40
 * (pipeline/experiments/playerform/{make,model}.ts).
 *
 * Complementa tests/experiments/playerform.test.ts (que usa una HistoryView de juguete) con la HistoryView REAL
 * (pipeline/experiments/history.ts) y el gancho completo de la variante (players.adjust), y con vectores que la
 * comprobación de fuga del banco (copa ficticia al día siguiente) no cubre:
 *   1. veneno en la MISMA competición y temporada: mismo instante del inicio, minutos/horas después (mismo día), días
 *      después, temporada siguiente, con los dos equipos del partido y con otros;
 *   2. el propio partido (terminado, con tiros/tarjetas extremos) dentro de las listas de la fuente;
 *   3. partidos de los equipos en OTRA competición después del inicio (teamMatches) y líneas de jugador futuras;
 *   4. un partido de la misma competición del MISMO día (UTC) anterior al inicio: producción corta por día y no lo usa;
 *   5. control de sensibilidad: el mismo veneno con fecha del día anterior sí cambia los factores;
 *   6. SENSIBILIDAD documentada (contrato compartido con producción, statContext): un partido que empezó el día UTC
 *      anterior y aún está en juego al inicio (p. ej. 23:30 UTC para un partido a las 00:30 UTC) sí entra en el pool.
 */
import { describe, expect, it } from 'vitest';
import { Elo } from '../../src/lib/models';
import type { PlayerPropsInput } from '../../pipeline/analytics/players';
import type { MatchRecord, PlayerLine } from '../../pipeline/types';
import { historyView } from '../../pipeline/experiments/history';
import { preMatchView, type FeatureContext } from '../../pipeline/experiments/types';
import { statPool } from '../../pipeline/experiments/playerform/model';
import fac6x40 from '../../pipeline/experiments/playerform-fac6x40';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// inicio a las 18:00 UTC: deja sitio a partidos del mismo día anteriores y posteriores
const KO = Date.parse('2026-08-20T18:00:00Z');
let seq = 1;

const team = (id: string) => ({ id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() });

function mk(
  compId: string,
  t: number,
  home: string,
  away: string,
  s: { hs: number; as: number; hc?: number; ac?: number },
  season = 2026,
  id?: string,
): MatchRecord {
  const i = seq++;
  return {
    id: id ?? `m${i}`,
    compId,
    season,
    currentSeason: season === 2026,
    date: new Date(t).toISOString(),
    status: 'finished',
    home: team(home),
    away: team(away),
    score: { home: 1, away: 1 },
    stats: {
      home: { goals: 1, shots: s.hs, shotsOnTarget: Math.round(s.hs / 3), yellow: s.hc ?? 2, red: 0 },
      away: { goals: 1, shots: s.as, shotsOnTarget: Math.round(s.as / 3), yellow: s.ac ?? 2, red: 0 },
    },
  };
}

function source(ms: MatchRecord[], lines: PlayerLine[] = []) {
  const byComp = new Map<string, MatchRecord[]>();
  const byTeam = new Map<string, MatchRecord[]>();
  const linesByTeam = new Map<string, PlayerLine[]>();
  const push = <T>(m: Map<string, T[]>, k: string, x: T) => m.set(k, [...(m.get(k) ?? []), x]);
  for (const m of ms) {
    push(byComp, m.compId, m);
    push(byTeam, m.home.id, m);
    push(byTeam, m.away.id, m);
  }
  for (const l of lines) push(linesByTeam, l.teamId, l);
  return { matchesByTeam: byTeam, matchesByComp: byComp, linesByTeam, elo: new Elo({ k: 20, homeAdv: 65, init: 1500 }) };
}

/** Liga de 6 equipos (A tira mucho, F poco, tarjetas variadas) + copa con A y B; todo antes del día del partido. */
function past(): MatchRecord[] {
  const teams = ['A', 'B', 'C', 'D', 'E', 'F'];
  const shots: Record<string, number> = { A: 20, B: 13, C: 12, D: 11, E: 10, F: 7 };
  const cards: Record<string, number> = { A: 1, B: 3, C: 2, D: 2, E: 2, F: 4 };
  const out: MatchRecord[] = [];
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < teams.length; i++) {
      for (let j = 0; j < teams.length; j++) {
        if (i === j || (i + j + round) % 5 !== 0) continue;
        const h = teams[i];
        const a = teams[j];
        out.push(mk('liga', KO - (50 - round * 5) * DAY + i * HOUR, h, a, { hs: shots[h] + 1, as: shots[a] - 1, hc: cards[h], ac: cards[a] }));
      }
    }
  }
  for (let k = 0; k < 4; k++) out.push(mk('copa', KO - (30 - k * 6) * DAY, 'A', `X${k}`, { hs: 25, as: 5 }));
  for (let k = 0; k < 4; k++) out.push(mk('copa', KO - (29 - k * 6) * DAY, `Y${k}`, 'B', { hs: 9, as: 9 }));
  return out;
}

const target = mk('liga', KO, 'A', 'B', { hs: 60, as: 0, hc: 9, ac: 9 }, 2026, 'target');
const pre = preMatchView(target);
const ctx = {} as FeatureContext; // el gancho no lo lee

const baseOf = (teamId: string, opponentId: string): PlayerPropsInput => ({
  teamId,
  opponentId,
  lines: [],
  teamLambda: 1.5,
  teamAvgGoals: 1.4,
  oppShotsFactor: 0.9,
  oppSotFactor: 1.05,
  cardsFactor: 1.2,
  foulsFactor: 1.1,
});

/** Salida del gancho para los dos lados con la HistoryView real cortada en el inicio. */
function hook(ms: MatchRecord[], lines: PlayerLine[] = []) {
  const history = historyView(source(ms, lines), KO);
  return (['home', 'away'] as const).map((side) =>
    fac6x40.players!.adjust!({
      ctx,
      match: pre,
      teamId: side === 'home' ? 'A' : 'B',
      side,
      history,
      base: side === 'home' ? baseOf('A', 'B') : baseOf('B', 'A'),
    }),
  );
}

function futureLine(teamId: string, t: number): PlayerLine {
  return {
    matchId: `fl${seq++}`,
    compId: 'liga',
    date: new Date(t).toISOString(),
    teamId,
    opponentId: 'Z',
    isHome: true,
    playerId: `${teamId}9`,
    name: 'p',
    short: 'p',
    position: 'F',
    starter: true,
    minutes: 90,
    goals: 4,
    assists: 0,
    shots: 12,
    shotsOnTarget: 8,
    yellow: 1,
    red: 1,
    foulsCommitted: 6,
    foulsSuffered: 0,
    offsides: 0,
    ownGoals: 0,
  };
}

describe('revisión de fugas: forma de jugadores (playerform-fac6x40)', () => {
  it('la prueba es sensible: el gancho cambia los factores de producción en este escenario', () => {
    const [h, a] = hook(past());
    expect(h.oppShotsFactor).not.toBe(0.9);
    expect(h.cardsFactor).not.toBe(1.2);
    expect(a.oppShotsFactor).not.toBe(0.9);
    // y no toca nada más (sin líneas ni faltas)
    expect(h.lines).toBeUndefined();
    expect(h.foulsFactor).toBeUndefined();
  });

  it('veneno en la MISMA competición (mismo instante, minutos/horas después, días después, temporada siguiente): idéntico', () => {
    const ms = past();
    const clean = hook(ms);
    const poison: MatchRecord[] = [];
    poison.push(mk('liga', KO, 'A', 'B', { hs: 0, as: 60, hc: 9, ac: 9 })); // mismo instante (no es anterior)
    poison.push(mk('liga', KO, 'C', 'D', { hs: 60, as: 60, hc: 9, ac: 9 }));
    for (let i = 1; i <= 20; i++) {
      poison.push(mk('liga', KO + i * 60_000, 'A', `C`, { hs: 0, as: 60, hc: 9, ac: 0 }));
      poison.push(mk('liga', KO + (i % 5) * HOUR + 1, 'B', 'E', { hs: 60, as: 0, hc: 0, ac: 9 }));
      poison.push(mk('liga', KO + i * DAY, 'F', 'A', { hs: 60, as: 0, hc: 9, ac: 9 }));
      poison.push(mk('liga', KO + i * DAY + 7, 'B', 'D', { hs: 0, as: 60, hc: 9, ac: 9 }, 2027));
    }
    expect(hook([...ms, ...poison])).toEqual(clean);
  });

  it('el propio partido (terminado, extremo) en las listas de la fuente no cuenta y el PreMatch no lleva estadísticas', () => {
    const ms = past();
    expect(hook([...ms, target])).toEqual(hook(ms));
    expect((pre as Partial<MatchRecord>).stats).toBeUndefined();
    expect((pre as Partial<MatchRecord>).score).toBeUndefined();
  });

  it('veneno de los equipos en OTRA competición después del inicio y líneas de jugador futuras: idéntico', () => {
    const ms = past();
    const clean = hook(ms);
    const poison: MatchRecord[] = [];
    for (let i = 1; i <= 10; i++) {
      poison.push(mk('copa', KO + i * 30 * 60_000, 'A', 'X9', { hs: 0, as: 60, hc: 9, ac: 9 }));
      poison.push(mk('copa', KO + i * DAY, 'Y9', 'B', { hs: 60, as: 0, hc: 9, ac: 9 }));
    }
    const lines = [futureLine('A', KO + HOUR), futureLine('B', KO + 2 * DAY), futureLine('A', KO)];
    expect(hook([...ms, ...poison], lines)).toEqual(clean);
  });

  it('un partido de la misma competición del MISMO día UTC anterior al inicio no entra (corte por día, como producción)', () => {
    const ms = past();
    const sameDay = [
      mk('liga', KO - 3 * HOUR, 'A', 'C', { hs: 0, as: 60, hc: 9, ac: 9 }),
      mk('liga', KO - 17 * HOUR, 'D', 'B', { hs: 60, as: 0, hc: 9, ac: 9 }),
      mk('copa', KO - 5 * HOUR, 'A', 'X7', { hs: 0, as: 60, hc: 9, ac: 9 }),
    ];
    expect(hook([...ms, ...sameDay])).toEqual(hook(ms));
    const ids = new Set(statPool(pre, historyView(source([...ms, ...sameDay]), KO)).map((m) => m.id));
    for (const m of sameDay) expect(ids.has(m.id)).toBe(false);
  });

  it('control: el mismo veneno con fecha del día ANTERIOR sí cambia los factores', () => {
    const ms = past();
    const before = [mk('liga', KO - DAY, 'A', 'C', { hs: 0, as: 60, hc: 9, ac: 9 }), mk('liga', KO - DAY - HOUR, 'D', 'B', { hs: 60, as: 0, hc: 9, ac: 9 })];
    expect(hook([...ms, ...before])).not.toEqual(hook(ms));
  });

  it('determinista: el orden de la fuente no importa', () => {
    const ms = past();
    expect(hook([...ms].reverse())).toEqual(hook(ms));
  });

  it('SENSIBILIDAD (contrato compartido con statContext de producción): un partido del día UTC anterior aún en juego al inicio entra en el pool', () => {
    const ko = Date.parse('2026-08-21T00:30:00Z');
    const t = mk('liga', ko, 'A', 'B', { hs: 0, as: 0 }, 2026, 'late');
    const inPlay = mk('liga', ko - 60 * 60_000, 'C', 'D', { hs: 60, as: 60 }); // 23:30 UTC del día anterior
    const ids = new Set(statPool(preMatchView(t), historyView(source([...past(), inPlay]), ko)).map((m) => m.id));
    expect(ids.has(inPlay.id)).toBe(true);
  });
});
