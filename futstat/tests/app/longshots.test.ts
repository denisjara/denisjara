/**
 * App: «Cuota alta 6+» (longshots.json y HomeFile.longshot). La capa de datos debe aceptar el archivo, normalizarlo de
 * forma defensiva (tipos en lista blanca, números finitos, topes, textos acotados, patas válidas, cifras derivadas
 * coherentes) sin inventar nada, y las utilidades de la página (filtros, resumen del historial, calculadora) deben
 * dar cifras honestas.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HomeFile, LongshotFile, LongshotRecord } from '../../src/types/data';
import { normLongshotBet, normLongshotLeg, normLongshotRecord, normalizeDataFile } from '../../src/app/lib/sanitize';
import {
  LONGSHOT_FILTERS,
  LONGSHOT_KINDS,
  betStarted,
  calibrationDomain,
  clampStake,
  evState,
  filterLongshots,
  kindFromParam,
  longshotSummary,
  netWin,
  nextDayWithBets,
  oneIn,
  paramFromKind,
  playableFirst,
  settledOf,
} from '../../src/app/lib/longshots';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOCK = path.join(ROOT, 'public/mock-data');
const mock = (rel: string) => JSON.parse(fs.readFileSync(path.join(MOCK, rel), 'utf8'));

beforeAll(async () => {
  // datos de prueba generados antes de existir este apartado: se regeneran (el script escribe al importarse)
  if (!fs.existsSync(path.join(MOCK, 'longshots.json'))) await import('../../scripts/mock-data');
});

const team = (id: string, name: string) => ({ id, name, short: name, abbr: name.slice(0, 3).toUpperCase() });
const LEG = {
  matchId: '740500',
  compId: 'laliga',
  compName: 'LaLiga',
  date: '2026-11-27T20:00:00Z',
  home: team('1', 'Getafe'),
  away: team('2', 'Real Madrid'),
  market: 'Resultado final (1X2)',
  selection: 'Gana Getafe',
  prob: 0.14,
  fairOdds: 7.143,
  marketOdds: 8.5,
};
const leg = (matchId: string, extra: Record<string, unknown> = {}) => ({ ...LEG, matchId, ...extra });
const BET = {
  id: 'sorpresa-740500',
  kind: 'sorpresa',
  label: 'Sorpresa: gana Getafe',
  legs: [LEG],
  prob: 0.14,
  fairOdds: 7.143,
  marketOdds: 8.5,
  displayOdds: 8.5,
  ev: 0.19,
  oneIn: 7,
  score: 71.2,
  reason: 'El modelo da un 14% al Getafe.',
};
const COMBO = {
  id: 'combinada-a',
  kind: 'combinada',
  label: 'Combinada de 3 partidos',
  legs: [leg('1', { prob: 0.6, fairOdds: 1.667, marketOdds: 1.7, selection: 'Gana A' }), leg('2', { prob: 0.55, fairOdds: 1.818, marketOdds: 1.8, selection: 'Gana B' }), leg('3', { prob: 0.5, fairOdds: 2, marketOdds: 2.05, selection: 'Gana C' })],
  prob: 0.165,
  fairOdds: 6.061,
  marketOdds: 6.273,
  displayOdds: 6.273,
  ev: 0.035,
  oneIn: 6,
  score: 60,
  reason: 'Tres favoritos.',
};
const RECORD = { kind: 'combinada', label: 'Combinadas', bets: 412, hits: 47, hitRate: 0.1141, wilsonLow: 0.09, wilsonHigh: 0.14, expectedHitRate: 0.128, avgOdds: 8.6, roi: { bets: 288, staked: 288, profit: -61.4, roi: -0.213 }, longestLosingStreak: 37 };
const file = (days: unknown, extra: Record<string, unknown> = {}) => normalizeDataFile('longshots.json', { generatedAt: '2026-11-26T12:00:00Z', minOdds: 6, days, ...extra }) as LongshotFile;

describe('cuota alta: capa de datos', () => {
  it('longshots.json está en la lista blanca de rutas y tiene su hook', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/app/lib/data.ts'), 'utf8');
    const m = /const ALLOWED_PATH = \/(.+)\/;/.exec(src);
    expect(m).toBeTruthy();
    const allowed = new RegExp(m![1]);
    expect(allowed.test('longshots.json')).toBe(true);
    expect(allowed.test('longshots2.json')).toBe(false);
    expect(allowed.test('../longshots.json')).toBe(false);
    expect(src).toMatch(/export const useLongshots = \(\) => useJson<LongshotFile>\('longshots\.json'\)/);
  });

  it('el archivo de prueba se normaliza sin perder nada y cumple el contrato', () => {
    const raw = mock('longshots.json');
    const out = normalizeDataFile('longshots.json', raw) as LongshotFile;
    expect(out.minOdds).toBe(6);
    expect(out.days.length).toBe(raw.days.length);
    expect(out.days.length).toBeGreaterThanOrEqual(2);
    for (const [i, d] of out.days.entries()) {
      expect(d.bets.length).toBe(raw.days[i].bets.length);
      for (const b of d.bets) {
        expect(LONGSHOT_KINDS).toContain(b.kind);
        expect(b.displayOdds).toBeGreaterThanOrEqual(6);
        expect(b.displayOdds).toBeCloseTo(b.marketOdds ?? b.fairOdds, 5);
        expect(b.oneIn).toBe(Math.round(1 / b.prob));
        if (b.kind === 'combinada') expect(b.legs.length).toBeGreaterThanOrEqual(2);
        else expect(b.legs.length).toBe(1);
        if (b.marketOdds) expect(b.ev).toBeCloseTo(b.prob * b.marketOdds - 1, 2);
        else expect(b.ev).toBeUndefined();
      }
    }
    expect(out.track.byKind.map((r) => r.kind)).toEqual([...LONGSHOT_KINDS]);
    expect(out.track.calibration.length).toBeGreaterThan(0);
    // hay de todo para probar la interfaz: combinadas, sorpresas, marcadores, goleadores, otras; EV + y −; sin cuota
    const all = out.days.flatMap((d) => d.bets);
    // los tipos excluidos (sin validar) no publican apuestas; el resto, sí
    const excluded = new Set(out.track.byKind.filter((r) => r.excluded).map((r) => r.kind));
    expect(excluded.size).toBeGreaterThan(0);
    for (const k of LONGSHOT_KINDS) expect(all.some((b) => b.kind === k)).toBe(!excluded.has(k));
    // nulas: el acierto es aciertos / (apuestas − nulas)
    const gol = out.track.byKind.find((r) => r.kind === 'goleador')!;
    expect(gol.voids).toBeGreaterThan(0);
    expect(gol.hitRate).toBeCloseTo(gol.hits / (gol.bets - gol.voids!), 6);
    expect(settledOf(gol)).toBe(gol.bets - gol.voids!);
    expect(all.some((b) => evState(b) === 'pos')).toBe(true);
    expect(all.some((b) => evState(b) === 'neg')).toBe(true);
    expect(all.some((b) => evState(b) === 'sin-cuota')).toBe(true);
  });

  it('home.json lleva el avance con una apuesta válida', () => {
    const home = normalizeDataFile('home.json', mock('home.json')) as HomeFile;
    expect(home.longshot?.best).toBeTruthy();
    expect(home.longshot!.bets).toBeGreaterThanOrEqual(1);
    expect(home.longshot!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('cuota alta: normalización con datos anómalos', () => {
  it('tipos fuera de la lista blanca: se deducen del número de patas, nunca se inventan', () => {
    expect(normLongshotBet({ ...BET, kind: 'segura' })!.kind).toBe('otro');
    expect(normLongshotBet({ ...COMBO, kind: '__proto__' })!.kind).toBe('combinada');
    // una «combinada» de una pata o una simple con varias patas no describen lo que dicen ser
    expect(normLongshotBet({ ...BET, kind: 'combinada' })).toBeUndefined();
    expect(normLongshotBet({ ...COMBO, kind: 'sorpresa' })).toBeUndefined();
  });

  it('una pata inválida, repetida o de más descarta la apuesta entera', () => {
    expect(normLongshotBet({ ...COMBO, legs: [...COMBO.legs.slice(0, 2), { ...LEG, matchId: '3', prob: 'NaN' }] })).toBeUndefined();
    expect(normLongshotBet({ ...COMBO, legs: [...COMBO.legs.slice(0, 2), { ...LEG, matchId: '3', home: null }] })).toBeUndefined();
    expect(normLongshotBet({ ...COMBO, legs: [...COMBO.legs.slice(0, 2), { ...LEG, matchId: '3', selection: '   ' }] })).toBeUndefined();
    expect(normLongshotBet({ ...COMBO, legs: [COMBO.legs[0], COMBO.legs[0], COMBO.legs[1]] })).toBeUndefined();
    expect(normLongshotBet({ ...COMBO, legs: Array.from({ length: 9 }, (_, i) => leg(String(i))) })).toBeUndefined();
    expect(normLongshotBet({ ...BET, legs: [] })).toBeUndefined();
    expect(normLongshotBet({ ...BET, legs: 'x' })).toBeUndefined();
    expect(normLongshotLeg({ ...LEG, prob: 1 })).toBeUndefined();
    expect(normLongshotLeg({ ...LEG, prob: 0 })).toBeUndefined();
    expect(normLongshotLeg({ ...LEG, matchId: '' })).toBeUndefined();
  });

  it('probabilidades imposibles se descartan (la total no puede superar a su pata menos probable)', () => {
    expect(normLongshotBet({ ...COMBO, prob: 0.6 })).toBeUndefined();
    for (const prob of [0, 1, 1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.14', null]) expect(normLongshotBet({ ...BET, prob })).toBeUndefined();
  });

  it('cifras derivadas incoherentes se recalculan desde la probabilidad y la cuota de la casa', () => {
    const b = normLongshotBet({ ...BET, fairOdds: 2, displayOdds: 99, ev: 5, oneIn: 1, score: 1e9 })!;
    expect(b.fairOdds).toBeCloseTo(1 / 0.14, 6);
    expect(b.displayOdds).toBe(8.5);
    expect(b.ev).toBeCloseTo(0.14 * 8.5 - 1, 6);
    expect(b.oneIn).toBe(7);
    expect(b.score).toBe(100);
    // sin cuota de la casa: la cuota mostrada es la justa y no hay valor esperado
    const nb = normLongshotBet({ ...BET, marketOdds: undefined, legs: [{ ...LEG, marketOdds: undefined }], displayOdds: 8.5, ev: 0.19 })!;
    expect(nb.marketOdds).toBeUndefined();
    expect(nb.ev).toBeUndefined();
    expect(nb.displayOdds).toBe(nb.fairOdds);
    expect(nb.displayOdds).toBeCloseTo(1 / 0.14, 2);
    expect(evState(nb)).toBe('sin-cuota');
  });

  it('cuota de la casa de la apuesta solo si TODAS las patas la tienen; cuotas absurdas fuera', () => {
    const c = normLongshotBet({ ...COMBO, legs: [COMBO.legs[0], COMBO.legs[1], { ...COMBO.legs[2], marketOdds: undefined }] })!;
    expect(c.marketOdds).toBeUndefined();
    expect(c.ev).toBeUndefined();
    for (const marketOdds of [0, 1, -3, 1e9, Number.NaN, '8.5']) {
      const b = normLongshotBet({ ...BET, marketOdds, legs: [{ ...LEG, marketOdds }] })!;
      expect(b.marketOdds).toBeUndefined();
      expect(b.legs[0].marketOdds).toBeUndefined();
    }
  });

  it('textos acotados, ids de competición validados, jugador y resultado en lista blanca', () => {
    const long = 'x'.repeat(5000);
    const b = normLongshotBet({
      ...BET,
      kind: 'goleador',
      label: long,
      reason: `a\n\n${long}`,
      result: 'ganada',
      legs: [{ ...LEG, compId: '../../etc', market: long, selection: long, player: { id: 9, name: long, short: '', teamId: '2' }, category: 'magia' }],
    })!;
    expect(b.label.length).toBeLessThanOrEqual(90);
    expect(b.reason.length).toBeLessThanOrEqual(320);
    expect(b.reason).not.toMatch(/\n/);
    expect(b.result).toBeUndefined();
    expect(b.legs[0].compId).toBe('');
    expect(b.legs[0].market.length).toBeLessThanOrEqual(120);
    expect(b.legs[0].selection.length).toBeLessThanOrEqual(120);
    expect(b.legs[0].player!.name.length).toBeLessThanOrEqual(80);
    expect(b.legs[0].player!.short.length).toBeLessThanOrEqual(40);
    expect(b.legs[0].category).toBeUndefined();
    expect(normLongshotBet({ ...BET, result: 'hit' })!.result).toBe('hit');
    // resultado por pata (añadido opcional): lista blanca
    expect(normLongshotLeg({ ...LEG, result: 'miss' })!.result).toBe('miss');
    expect(normLongshotLeg({ ...LEG, result: 'perdida' })!.result).toBeUndefined();
  });

  it('días: fecha válida, sin repetidos, ordenados, apuestas por debajo de la cuota mínima fuera y topes', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...BET, id: `s-${i}`, legs: [leg(String(1000 + i))] }));
    const out = file([
      { date: '2026-11-28', bets: [BET] },
      { date: '2026-11-26', bets: [...many, { ...BET, id: 'baja', marketOdds: 3.2, displayOdds: 3.2, legs: [{ ...LEG, marketOdds: 3.2 }] }, { ...BET, id: 's-0' }] },
      { date: '2026-11-26', bets: [BET] },
      { date: '2026-13-01', bets: [BET] },
      { date: 'mañana', bets: [BET] },
      'x',
      null,
    ]);
    expect(out.days.map((d) => d.date)).toEqual(['2026-11-26', '2026-11-28']);
    const d0 = out.days[0];
    // como mucho 8 del mismo tipo y 24 por día, sin ids repetidos y nada por debajo de cuota 6
    expect(d0.bets.length).toBeLessThanOrEqual(8);
    expect(new Set(d0.bets.map((b) => b.id)).size).toBe(d0.bets.length);
    expect(d0.bets.some((b) => b.id === 'baja')).toBe(false);
    expect(d0.bets.every((b) => b.displayOdds >= 6)).toBe(true);
  });

  it('archivo casi vacío o con tipos equivocados: estructura completa, sin NaN ni undefined donde la UI suma', () => {
    const out = normalizeDataFile('longshots.json', { generatedAt: '2026-11-26T12:00:00Z', minOdds: 'seis', days: {}, track: 7, note: 42 }) as LongshotFile;
    expect(out.minOdds).toBe(6);
    expect(out.days).toEqual([]);
    expect(out.track.byKind).toEqual([]);
    expect(out.track.calibration).toEqual([]);
    expect(out.note).toBe('42');
    expect(() => normalizeDataFile('longshots.json', { days: [] })).toThrow();
    expect(() => normalizeDataFile('longshots.json', [])).toThrow();
    const s = longshotSummary(out.track.byKind);
    expect(s).toMatchObject({ bets: 0, settled: 0, hits: 0 });
    expect(s.hitRate).toBeUndefined();
    expect(s.roi).toBeUndefined();
  });

  it('historial: cuentas incoherentes fuera, acierto y ROI siempre cuadrados con sus cuentas', () => {
    expect(normLongshotRecord({ ...RECORD, hits: 500 })).toBeUndefined();
    expect(normLongshotRecord({ ...RECORD, bets: -1 })).toBeUndefined();
    expect(normLongshotRecord({ ...RECORD, kind: 'apuesta' })).toBeUndefined();
    expect(normLongshotRecord({ ...RECORD, hits: Number.NaN })).toBeUndefined();
    const r = normLongshotRecord({ ...RECORD, hitRate: 0.9, roi: { bets: 288, staked: 288, profit: -61.4, roi: 3 }, wilsonLow: 0.5, wilsonHigh: 0.6, longestLosingStreak: 9999, avgOdds: Number.POSITIVE_INFINITY, expectedHitRate: 'x' })!;
    // un acierto que no cuadra con aciertos/apuestas no se puede comprobar: se acepta si es ≥ aciertos/apuestas…
    expect(r.hitRate).toBe(0.9);
    // …pero el intervalo que no lo contiene se descarta y el ROI es SIEMPRE beneficio / apostado
    expect(r.wilsonLow).toBeUndefined();
    expect(r.roi!.roi).toBeCloseTo(-61.4 / 288, 6);
    expect(r.longestLosingStreak).toBeUndefined();
    expect(r.avgOdds).toBeUndefined();
    expect(r.expectedHitRate).toBeUndefined();
    expect(normLongshotRecord({ ...RECORD, hitRate: 0.05 })!.hitRate).toBeCloseTo(47 / 412, 6);
    // añadidos opcionales: nulas coherentes (resueltas ≥ aciertos) y motivo de exclusión acotado
    expect(normLongshotRecord({ ...RECORD, voids: 12 })!.hitRate).toBeCloseTo(47 / 400, 9);
    expect(normLongshotRecord({ ...RECORD, voids: 400 })!.voids).toBeUndefined();
    expect(normLongshotRecord({ ...RECORD, voids: -1 })!.voids).toBeUndefined();
    expect(normLongshotRecord({ ...RECORD, excluded: 'z'.repeat(2000) })!.excluded!.length).toBeLessThanOrEqual(240);
    expect(normLongshotRecord({ ...RECORD, excluded: 42 })!.excluded).toBe('42');
    expect(normLongshotRecord({ ...RECORD, excluded: '' })!.excluded).toBeUndefined();
    // no se puede perder más de lo apostado
    expect(normLongshotRecord({ ...RECORD, roi: { bets: 10, staked: 10, profit: -50 } })!.roi).toBeUndefined();
    expect(normLongshotRecord({ ...RECORD, roi: { bets: 0, staked: 0, profit: 0 } })!.roi).toBeUndefined();
    // duplicados por tipo y calibración inválida
    const out = file([], {
      track: {
        from: 'ayer',
        to: '2026-11-25T00:00:00Z',
        byKind: [RECORD, { ...RECORD, bets: 1, hits: 0, hitRate: 0 }, { ...RECORD, kind: 'marcador', label: '' }],
        calibration: [{ from: 0.1, to: 0.05, predicted: 0.07, observed: 0.06, n: 10 }, { from: 0.05, to: 0.1, predicted: 0.07, observed: 1.4, n: 10 }, { from: 0.05, to: 0.1, predicted: 0.07, observed: 0.06, n: 10 }],
      },
    });
    expect(out.track.byKind.map((x) => x.kind)).toEqual(['combinada', 'marcador']);
    expect(out.track.byKind[0].bets).toBe(412);
    expect(out.track.byKind[1].label).toBe('Marcador exacto');
    expect(out.track.calibration).toHaveLength(1);
    expect(out.track.from).toBe('');
  });

  it('avance de Inicio: sin fecha válida o sin apuesta válida no se muestra', () => {
    const base = { generatedAt: '2026-11-26T12:00:00Z', popular: [], today: [], tomorrow: [], recent: [], topValue: [], hotPlayers: [], highlights: [] };
    const h = (longshot: unknown) => (normalizeDataFile('home.json', { ...base, longshot }) as HomeFile).longshot;
    expect(h({ date: '2026-11-26', bets: 9, best: BET })).toMatchObject({ date: '2026-11-26', bets: 9 });
    expect(h({ date: '2026-11-26', bets: 'muchas', best: BET })!.bets).toBe(1);
    expect(h({ date: '2026-11-26', bets: 9 })).toBeUndefined();
    expect(h({ date: '26/11/2026', bets: 9, best: BET })).toBeUndefined();
    expect(h({ date: '2026-11-26', bets: 9, best: { ...BET, prob: 2 } })).toBeUndefined();
    expect(h('x')).toBeUndefined();
  });
});

describe('cuota alta: utilidades de la página', () => {
  const out = file([{ date: '2026-11-26', bets: [BET, COMBO, { ...BET, id: 'm', kind: 'marcador', label: 'Marcador exacto 1-1', legs: [leg('9', { date: '2026-11-26T10:00:00Z' })] }] }, { date: '2026-11-27', bets: [] }, { date: '2026-11-28', bets: [BET] }]);
  const bets = out.days[0].bets;

  it('filtros por tipo sincronizables con la URL (?tipo=)', () => {
    expect(LONGSHOT_FILTERS.map((f) => f.id)).toEqual(['combinadas', 'sorpresas', 'marcador', 'goleador', 'otras']);
    expect(kindFromParam('combinadas')).toBe('combinada');
    expect(kindFromParam('otras')).toBe('otro');
    expect(kindFromParam('combinada')).toBeUndefined();
    expect(kindFromParam(null)).toBeUndefined();
    expect(paramFromKind('sorpresa')).toBe('sorpresas');
    expect(filterLongshots(bets, 'combinada').map((b) => b.id)).toEqual(['combinada-a']);
    expect(filterLongshots(bets).length).toBe(3);
    expect(nextDayWithBets(out.days, '2026-11-26')?.date).toBe('2026-11-28');
  });

  it('las que ya han empezado van al final', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    expect(betStarted(bets.find((b) => b.id === 'm')!, now)).toBe(true);
    expect(playableFirst(bets, now).map((b) => b.id)).toEqual(['sorpresa-740500', 'combinada-a', 'm']);
  });

  it('calculadora: beneficio neto = importe · (cuota − 1), sin cifras con datos inválidos', () => {
    expect(netWin(10, 7.4)).toBeCloseTo(64, 9);
    expect(netWin(10, 1)).toBeUndefined();
    expect(netWin(Number.NaN, 7)).toBeUndefined();
    expect(netWin(10, undefined)).toBeUndefined();
    expect(clampStake('25')).toBe(25);
    expect(clampStake('2,5')).toBe(2.5);
    expect(clampStake('-3')).toBe(10);
    expect(clampStake('abc')).toBe(10);
    expect(clampStake('1e9')).toBe(10_000);
    expect(oneIn(0.14)).toBe(7);
    expect(oneIn(0.9)).toBe(1);
  });

  it('resumen del historial: sumas de cuentas (nunca medias de porcentajes) y resueltas sin las nulas', () => {
    const recs: LongshotRecord[] = [
      { kind: 'combinada', label: 'Combinadas', bets: 100, hits: 10, hitRate: 0.1, expectedHitRate: 0.12, avgOdds: 9, roi: { bets: 50, staked: 50, profit: -10, roi: -0.2 } },
      { kind: 'goleador', label: 'Goleador', bets: 110, hits: 10, hitRate: 0.1, expectedHitRate: 0.14, avgOdds: 7 },
    ];
    expect(settledOf(recs[1])).toBe(100);
    const s = longshotSummary(recs);
    expect(s.bets).toBe(210);
    expect(s.settled).toBe(200);
    expect(s.hits).toBe(20);
    expect(s.hitRate).toBeCloseTo(0.1, 9);
    expect(s.expectedHitRate).toBeCloseTo(0.13, 9);
    expect(s.avgOdds).toBeCloseTo((100 * 9 + 110 * 7) / 210, 9);
    expect(s.roi).toEqual({ bets: 50, staked: 50, profit: -10, roi: -0.2 });
    expect(s.oneIn).toBe(10);
  });

  it('eje de la calibración en la banda baja', () => {
    expect(calibrationDomain([{ to: 0.18, observed: 0.15, predicted: 0.16, n: 10 }])).toBe(0.2);
    expect(calibrationDomain([{ to: 0.18, observed: 0.31, predicted: 0.16, n: 10 }])).toBe(0.35);
    expect(calibrationDomain([{ to: 0.18, observed: 0.31, predicted: 0.16, n: 0 }])).toBe(1);
    expect(calibrationDomain([])).toBe(1);
    expect(calibrationDomain([{ to: 0.02, observed: 0.01, predicted: 0.015, n: 3 }])).toBe(0.1);
  });
});
