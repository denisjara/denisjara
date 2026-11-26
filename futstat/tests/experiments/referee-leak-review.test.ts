/**
 * Revisión adversarial (fugas) del factor ÁRBITRO (pipeline/experiments/referee/model.ts, variante referee-fouls-k30).
 *
 * Complementa tests/experiments/referee.test.ts con vectores que la comprobación de fuga del banco (copa ficticia al
 * día siguiente) no cubre:
 *   1. veneno en la MISMA competición y temporada, en el MISMO instante del inicio, minutos después (mismo día), con el
 *      mismo árbitro, con otros y sin árbitro, y en la temporada siguiente;
 *   2. veneno en las competiciones de los partidos ANTERIORES del árbitro (su «esperado» se calcula con compMatches de
 *      otras competiciones), después del inicio;
 *   3. el propio partido (terminado, con tarjetas/faltas extremas) dentro de las listas de la fuente;
 *   4. sensibilidad documentada (no es del gancho sino del contrato de HistoryView): un partido de la misma competición
 *      iniciado poco antes del corte (aún en juego al inicio) sí entra en la media esperada.
 */
import { describe, expect, it } from 'vitest';
import { Elo } from '../../src/lib/models';
import type { MatchRecord } from '../../pipeline/types';
import { historyView } from '../../pipeline/experiments/history';
import { preMatchView } from '../../pipeline/experiments/types';
import { refereeMultipliers } from '../../pipeline/experiments/referee/model';
import refereeFouls from '../../pipeline/experiments/referee-fouls-k30';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-02-01T15:00:00Z');
let seq = 1;

function mk(compId: string, t: number, cards: [number, number], refId: string | undefined, fouls: [number, number], season = 2025): MatchRecord {
  const i = seq++;
  return {
    id: `m${i}`,
    compId,
    season,
    currentSeason: true,
    date: new Date(t).toISOString(),
    status: 'finished',
    home: { id: `H${i % 9}`, name: 'h', short: 'h', abbr: 'h' },
    away: { id: `A${i % 7}`, name: 'a', short: 'a', abbr: 'a' },
    score: { home: 1, away: 0 },
    stats: {
      home: { goals: 1, yellow: cards[0], red: 0, fouls: fouls[0] },
      away: { goals: 0, yellow: cards[1], red: 0, fouls: fouls[1] },
    },
    ...(refId ? { referee: { id: refId, name: `Árbitro ${refId}` } } : {}),
  };
}

function source(ms: MatchRecord[]) {
  const byComp = new Map<string, MatchRecord[]>();
  const byRef = new Map<string, MatchRecord[]>();
  const byTeam = new Map<string, MatchRecord[]>();
  const push = (m: Map<string, MatchRecord[]>, k: string, x: MatchRecord) => m.set(k, [...(m.get(k) ?? []), x]);
  for (const m of ms) {
    push(byComp, m.compId, m);
    if (m.referee) push(byRef, m.referee.id, m);
    push(byTeam, m.home.id, m);
    push(byTeam, m.away.id, m);
  }
  return { matchesByTeam: byTeam, matchesByComp: byComp, matchesByReferee: byRef, elo: new Elo({ k: 20, homeAdv: 65, init: 1500 }) };
}

/** Pasado: liga (media 4 tarjetas, 22 faltas) y copa (media 6, 26); el árbitro R arbitra en las dos y es severo. */
function past(): MatchRecord[] {
  const out: MatchRecord[] = [];
  for (let i = 0; i < 40; i++) out.push(mk('liga', T0 - (60 - i) * DAY, [2, 2], `X${i % 6}`, [11, 11]));
  for (let i = 0; i < 30; i++) out.push(mk('copa', T0 - (60 - i) * DAY + 2 * HOUR, [3, 3], `Y${i % 5}`, [13, 13]));
  for (let i = 0; i < 8; i++) out.push(mk('liga', T0 - (15 - i) * DAY, [3, 4], 'R', [14, 14]));
  for (let i = 0; i < 4; i++) out.push(mk('copa', T0 - (6 - i) * DAY + 5 * HOUR, [4, 4], 'R', [15, 15]));
  return out;
}

const base = { cards: { home: 2, away: 2 }, fouls: { home: 11, away: 11 } };
const hook = (target: MatchRecord, ms: MatchRecord[]) =>
  refereeFouls.stats!.adjust!({
    ctx: {} as never,
    match: preMatchView(target),
    history: historyView(source(ms), Date.parse(target.date)),
    base,
  });

describe('revisión de fugas: árbitro (referee-fouls-k30)', () => {
  const target = mk('liga', T0, [9, 9], 'R', [40, 40]);

  it('el gancho da un multiplicador ≠ 1 en el escenario (la prueba es sensible)', () => {
    const m = hook(target, past());
    expect(m.cards!.home).toBeGreaterThan(1);
    expect(m.fouls!.home).toBeGreaterThan(1);
  });

  it('veneno en la MISMA competición (mismo instante, minutos/horas/días después, mismo árbitro, otros, sin árbitro, otra temporada): idéntico', () => {
    const ms = past();
    const a = hook(target, ms);
    const poison: MatchRecord[] = [];
    poison.push(mk('liga', T0, [9, 9], 'R', [40, 40])); // mismo instante (no es anterior)
    for (let i = 1; i <= 25; i++) {
      poison.push(mk('liga', T0 + i * 60_000, [9, 9], 'R', [40, 40]));
      poison.push(mk('liga', T0 + i * HOUR, [0 + 9, 9], `X${i % 6}`, [40, 40]));
      poison.push(mk('liga', T0 + i * HOUR + 1, [1, 0], undefined, [1, 1]));
      poison.push(mk('liga', T0 + i * DAY, [9, 9], 'R', [40, 40], 2026));
    }
    expect(hook(target, [...ms, ...poison])).toEqual(a);
  });

  it('veneno FUTURO en las competiciones de los partidos anteriores del árbitro (cambiaría su «esperado»): idéntico', () => {
    const ms = past();
    const a = hook(target, ms);
    const poison: MatchRecord[] = [];
    for (let i = 1; i <= 40; i++) {
      poison.push(mk('copa', T0 + i * 30 * 60_000, [0 + 1, 0], `Y${i % 5}`, [1, 1]));
      poison.push(mk('liga', T0 + i * DAY, [1, 0], `X${i % 6}`, [1, 1]));
    }
    expect(hook(target, [...ms, ...poison])).toEqual(a);
  });

  it('el propio partido (terminado, extremo, con el mismo árbitro) en las listas de la fuente no cuenta', () => {
    const ms = past();
    expect(hook(target, [...ms, target])).toEqual(hook(target, ms));
    // y el PreMatch no lleva estadísticas que el gancho pudiera leer
    expect((preMatchView(target) as Partial<MatchRecord>).stats).toBeUndefined();
    expect((preMatchView(target) as Partial<MatchRecord>).score).toBeUndefined();
  });

  it('control: el mismo veneno con fecha ANTERIOR al corte sí cambia el multiplicador', () => {
    const ms = past();
    const before = [mk('liga', T0 - 3 * DAY, [9, 9], 'R', [40, 40]), mk('copa', T0 - 2 * DAY, [1, 0], `Y1`, [1, 1])];
    expect(hook(target, [...ms, ...before])).not.toEqual(hook(target, ms));
  });

  it('SENSIBILIDAD (contrato de HistoryView, no del gancho): un partido de la misma competición iniciado 30 min antes (aún en juego) entra en el «esperado»', () => {
    const ms = past();
    const a = refereeMultipliers(preMatchView(target), historyView(source(ms), T0), base, { kCards: 30, kFouls: 30 });
    const inPlay = mk('liga', T0 - 30 * 60_000, [9, 9], 'X1', [40, 40]);
    const b = refereeMultipliers(preMatchView(target), historyView(source([...ms, inPlay]), T0), base, { kCards: 30, kFouls: 30 });
    // cambia solo a través de la media de la competición (efecto pequeño: un partido entre >= 20)
    expect(b.cards!.home).not.toBe(a.cards!.home);
    expect(Math.abs(b.cards!.home - a.cards!.home)).toBeLessThan(0.02);
  });
});
