/**
 * Variantes «referee-*» (pipeline/experiments/referee/model.ts): multiplicador walk-forward de la severidad del árbitro.
 * Comprueba la fórmula (observado/esperado contraído hacia 1), las reglas de datos (prórroga y 0 tarjetas = ausente),
 * que sin árbitro no cambia nada y, sobre todo, una prueba ADVERSARIAL propia: la comprobación de fuga del banco nunca
 * mete partidos envenenados en la competición del partido predicho, y este factor usa `compMatches` (medias esperadas)
 * además de `refereeMatches`; aquí se añaden partidos futuros extremos EN LA MISMA competición, con el mismo árbitro y
 * con otros, y el multiplicador debe ser idéntico. También se cargan las variantes con el cargador oficial.
 */
import { describe, expect, it } from 'vitest';
import { Elo } from '../../src/lib/models';
import type { MatchRecord } from '../../pipeline/types';
import { historyView } from '../../pipeline/experiments/history';
import { listVariants, loadVariant } from '../../pipeline/experiments/load';
import { preMatchView } from '../../pipeline/experiments/types';
import { MIN_COMP_N, observed, refereeMultipliers, refereeRatio } from '../../pipeline/experiments/referee/model';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-03T15:00:00Z');
let seq = 1;

function match(compId: string, t: number, cards: [number, number], refId: string | undefined, opts: { fouls?: [number, number]; season?: number; et?: boolean } = {}): MatchRecord {
  return {
    id: String(seq++),
    compId,
    season: opts.season ?? 2025,
    currentSeason: true,
    date: new Date(t).toISOString(),
    status: 'finished',
    ...(opts.et ? { statusDetail: 'Final (prórroga)' } : {}),
    home: { id: `H${seq % 7}`, name: 'h', short: 'h', abbr: 'h' },
    away: { id: `A${seq % 5}`, name: 'a', short: 'a', abbr: 'a' },
    score: { home: 1, away: 1 },
    stats: {
      home: { goals: 1, yellow: cards[0], red: 0, ...(opts.fouls ? { fouls: opts.fouls[0] } : {}) },
      away: { goals: 1, yellow: cards[1], red: 0, ...(opts.fouls ? { fouls: opts.fouls[1] } : {}) },
    },
    ...(refId ? { referee: { id: refId, name: `Árbitro ${refId}` } } : {}),
  };
}

function source(ms: MatchRecord[]) {
  const byComp = new Map<string, MatchRecord[]>();
  const byRef = new Map<string, MatchRecord[]>();
  const byTeam = new Map<string, MatchRecord[]>();
  for (const m of ms) {
    byComp.set(m.compId, [...(byComp.get(m.compId) ?? []), m]);
    if (m.referee) byRef.set(m.referee.id, [...(byRef.get(m.referee.id) ?? []), m]);
    for (const t of [m.home.id, m.away.id]) byTeam.set(t, [...(byTeam.get(t) ?? []), m]);
  }
  return { matchesByTeam: byTeam, matchesByComp: byComp, matchesByReferee: byRef, elo: new Elo({ k: 20, homeAdv: 65, init: 1500 }) };
}

/** Liga con media 4 tarjetas (2+2) y 22 faltas; el árbitro R1 saca 6 por partido (1,5 veces la media) en 10 partidos. */
function past(): MatchRecord[] {
  const out: MatchRecord[] = [];
  for (let i = 0; i < 40; i++) out.push(match('liga', T0 + i * DAY, [2, 2], `X${i % 8}`, { fouls: [11, 11] }));
  for (let i = 0; i < 10; i++) out.push(match('liga', T0 + (40 + i) * DAY, [3, 3], 'R1', { fouls: [14, 14] }));
  return out;
}

const target = (t: number, refId: string | null = 'R1') => preMatchView(match('liga', t, [0, 0], refId ?? undefined));

describe('árbitro: multiplicador walk-forward', () => {
  it('ratio = (ΣO + k·ē)/(ΣE + k·ē) con la media de la competición/temporada como esperado', () => {
    const ms = past();
    const cutoff = T0 + 60 * DAY;
    const h = historyView(source(ms), cutoff);
    // media de la liga: (40·4 + 10·6)/50 = 4,4 tarjetas; R1: 10 partidos, O = 60, E = 44
    const r = refereeRatio(target(cutoff), h, 'cards', 30);
    expect(r.n).toBe(10);
    expect(r.observed).toBe(60);
    expect(r.expected).toBeCloseTo(44, 9);
    expect(r.ratio).toBeCloseTo((60 + 30 * 4.4) / (44 + 30 * 4.4), 12);
    // más k ⇒ más cerca de 1
    expect(refereeRatio(target(cutoff), h, 'cards', 60).ratio).toBeLessThan(r.ratio);
    expect(refereeRatio(target(cutoff), h, 'cards', 60).ratio).toBeGreaterThan(1);
    // faltas con su propio ratio: liga (40·22 + 10·28)/50 = 23,2; R1 O = 280, E = 232
    const f = refereeRatio(target(cutoff), h, 'fouls', 30);
    expect(f.ratio).toBeCloseTo((280 + 30 * 23.2) / (232 + 30 * 23.2), 12);
  });

  it('sin árbitro, árbitro sin partidos previos o sin tarjetas en la proyección: ningún multiplicador (producción)', () => {
    const cutoff = T0 + 60 * DAY;
    const h = historyView(source(past()), cutoff);
    const base = { cards: { home: 2, away: 2 }, fouls: { home: 11, away: 11 } };
    expect(refereeMultipliers(target(cutoff, null), h, base, { kCards: 30, kFouls: 30 })).toEqual({});
    expect(refereeMultipliers(target(cutoff, 'NUEVO'), h, base, { kCards: 30, kFouls: 30 })).toEqual({});
    expect(refereeMultipliers(target(cutoff), h, {}, { kCards: 30, kFouls: 30 })).toEqual({});
    const m = refereeMultipliers(target(cutoff), h, base, { kCards: 30 });
    expect(Object.keys(m)).toEqual(['cards']);
    expect(m.cards!.home).toBe(m.cards!.away);
  });

  it('prórroga y 0 tarjetas cuentan como dato ausente (como el banco)', () => {
    expect(observed(match('liga', T0, [0, 0], 'R1'), 'cards')).toBeUndefined();
    expect(observed(match('liga', T0, [3, 2], 'R1', { et: true }), 'cards')).toBeUndefined();
    expect(observed(match('liga', T0, [3, 2], 'R1'), 'cards')).toBe(5);
    expect(observed(match('liga', T0, [3, 2], 'R1'), 'fouls')).toBeUndefined();
    expect(observed(match('liga', T0, [3, 2], 'R1', { fouls: [10, 12] }), 'fouls')).toBe(22);
  });

  it('ADVERSARIAL: partidos futuros extremos en la MISMA competición (con el mismo árbitro y con otros) no cambian nada', () => {
    const ms = past();
    const cutoff = T0 + 60 * DAY;
    const future: MatchRecord[] = [];
    // el mismo instante del corte (no es anterior) y después; mismo árbitro, otros árbitros, sin árbitro, otra temporada
    future.push(match('liga', cutoff, [9, 9], 'R1', { fouls: [40, 40] }));
    for (let i = 1; i <= 30; i++) {
      future.push(match('liga', cutoff + i * 3_600_000, [9, 9], 'R1', { fouls: [40, 40] }));
      future.push(match('liga', cutoff + i * DAY, [0 + 9, 9], `X${i % 8}`, { fouls: [40, 40] }));
      future.push(match('liga', cutoff + i * DAY + 1, [1, 1], undefined, { fouls: [2, 2] }));
      future.push(match('liga', cutoff + i * DAY + 2, [9, 9], 'R1', { season: 2026 }));
    }
    const a = historyView(source(ms), cutoff);
    const b = historyView(source([...ms, ...future]), cutoff);
    const base = { cards: { home: 2, away: 2 }, fouls: { home: 11, away: 11 } };
    const ma = refereeMultipliers(target(cutoff), a, base, { kCards: 15, kFouls: 15 });
    const mb = refereeMultipliers(target(cutoff), b, base, { kCards: 15, kFouls: 15 });
    expect(ma.cards).toBeDefined();
    expect(ma.fouls).toBeDefined();
    expect(mb).toEqual(ma);
    // control: los mismos partidos ANTES del corte sí lo cambian (la prueba es sensible)
    const shifted = future.map((m) => ({ ...m, date: new Date(Date.parse(m.date) - 45 * DAY).toISOString() }));
    const c = historyView(source([...ms, ...shifted]), cutoff);
    expect(refereeMultipliers(target(cutoff), c, base, { kCards: 15, kFouls: 15 })).not.toEqual(ma);
  });

  it('esperado: temporada de la competición con >= MIN_COMP_N partidos; si no, todas las temporadas', () => {
    const ms: MatchRecord[] = [];
    // temporada 2024: 30 partidos con 6 tarjetas; 2025: solo MIN_COMP_N − 1 con dato (no basta: se usan todas)
    for (let i = 0; i < 30; i++) ms.push(match('liga', T0 - 200 * DAY + i * DAY, [3, 3], `X${i % 4}`, { season: 2024 }));
    for (let i = 0; i < MIN_COMP_N - 2; i++) ms.push(match('liga', T0 + i * DAY, [1, 1], `X${i % 4}`));
    ms.push(match('liga', T0 + 30 * DAY, [2, 2], 'R2'));
    const h = historyView(source(ms), T0 + 40 * DAY);
    const all = (30 * 6 + (MIN_COMP_N - 2) * 2 + 4) / (30 + MIN_COMP_N - 1);
    expect(refereeRatio(target(T0 + 40 * DAY, 'R2'), h, 'cards', 0).ratio).toBeCloseTo(4 / all, 12);
  });

  it('las cuatro variantes se cargan con el cargador oficial', async () => {
    const names = listVariants().filter((n) => n.startsWith('referee-'));
    expect(names.sort()).toEqual(['referee-fouls-k30', 'referee-k15', 'referee-k30', 'referee-k60']);
    for (const n of names) {
      const v = await loadVariant(n);
      expect(v.name).toBe(n);
      expect(typeof v.stats?.adjust).toBe('function');
    }
  });
});
