/**
 * «Combinada 6» en la app: normalización defensiva de combo6.json y de HomeFile.combo6 (src/app/lib/sanitize.ts) y
 * utilidades puras (src/app/lib/combo6.ts). Las cifras de una combinada se recalculan siempre con sus patas.
 */
import { describe, expect, it } from 'vitest';
import type { Combo6File, HomeFile } from '../../src/types/data';
import { normalizeDataFile } from '../../src/app/lib/sanitize';
import { afterEach, vi } from 'vitest';
import { COMBO6_CATEGORY_LABEL, combo6CopyText, combo6Cumulative, combo6LegOddsText, combo6LegsByKickoff, combo6Result, combo6Started, combo6Totals } from '../../src/app/lib/combo6';
import { copyText } from '../../src/app/lib/clipboard';

const team = (id: string) => ({ id, name: `Equipo ${id}`, short: `E${id}`, abbr: `E${id}` });
const leg = (id: string, category: string, prob: number, bookOdds: number, extra: Record<string, unknown> = {}) => ({
  matchId: id,
  compId: 'europa',
  compName: 'UEFA Europa League',
  kickoff: `2026-11-27T${String(10 + Number(id)).padStart(2, '0')}:00:00Z`,
  home: team(`${id}1`),
  away: team(`${id}2`),
  category,
  marketId: 'ou-4.5',
  market: 'Más/Menos 4.5 goles',
  selection: 'Menos de 4.5 goles',
  prob,
  fairOdds: 1 / prob,
  bookOdds,
  bookOddsEstimated: true,
  oddsSource: 'estimada',
  ...extra,
});
const combo = (legs: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'c6-todas-2026-11-27-1-2-3-4',
  date: '2026-11-27',
  scope: 'todas',
  label: 'Combinada 6 del día',
  legs,
  prob: 0.9, // mal: se recalcula
  fairOdds: 1.1,
  bookOdds: 99,
  estimatedLegs: 0,
  oneIn: 1,
  ev: 3,
  categories: 1,
  firstKickoff: 'x',
  lastKickoff: 'y',
  ...extra,
});

describe('combo6.json en la app', () => {
  const legs = [leg('1', 'goles', 0.75, 1.27), leg('2', 'corners', 0.72, 1.3), leg('3', 'ganador', 0.8, 1.2, { oddsSource: 'casa', bookOddsEstimated: false }), leg('4', 'tiros', 0.74, 1.3, { oddsSource: 'raro' })];
  const raw = {
    generatedAt: '2026-11-26T17:40:00Z',
    rule: { targetMin: 6, targetMax: 8, legMinProb: 0.7, legMaxProb: 0.88, minLegs: 4, maxLegs: 9, minCategories: 4, maxPerCategory: 2, margins: { goles: 0.05, raro: 0.3 } },
    days: [
      { date: '2026-11-27', main: combo(legs), byCompetition: [combo(legs, { scope: 'europa', id: 'b' }), combo([legs[0], legs[0], legs[1]], { scope: 'conference', id: 'c' })], counts: { matches: 12, eligibleMatches: 10, candidateLegs: 40 } },
      { date: '2026-11-28', byCompetition: [], counts: { matches: 3, eligibleMatches: 2, candidateLegs: 5 } },
      { date: 'mal' },
    ],
    history: { settled: 10, hits: 30, hitRate: 0.5, longestLosingStreak: 99, recent: [combo(legs.map((l) => ({ ...l, result: 'miss' })), { date: '2026-11-20' }), combo(legs)], byCategory: [{ category: 'goles', legs: 4, hits: 9, expectedHitRate: 0.72 }, { category: 'x' }] },
    note: 'Nota +18.',
  };
  const f = normalizeDataFile('combo6.json', raw) as Combo6File;

  it('recalcula las cifras de la combinada con sus patas y marca como estimada toda cuota que no es de la casa', () => {
    const c = f.days[0].main!;
    const p = 0.75 * 0.72 * 0.8 * 0.74;
    expect(c.prob).toBeCloseTo(p, 12);
    expect(c.fairOdds).toBeCloseTo(1 / p, 9);
    expect(c.bookOdds).toBeCloseTo(1.27 * 1.3 * 1.2 * 1.3, 9);
    expect(c.ev).toBeCloseTo(p * c.bookOdds - 1, 12);
    expect(c.oneIn).toBe(Math.round(1 / p));
    expect(c.categories).toBe(4);
    expect(c.estimatedLegs).toBe(3);
    expect(c.legs[3].oddsSource).toBe('estimada'); // origen desconocido ⇒ estimada
    expect(c.legs[2].bookOddsEstimated).toBe(false);
    expect(c.firstKickoff).toBe('2026-11-27T11:00:00Z');
    expect(c.lastKickoff).toBe('2026-11-27T14:00:00Z');
    expect(c.result).toBeUndefined();
  });

  it('descarta combinadas con partidos repetidos, días inválidos y da un motivo a los días sin combinada', () => {
    expect(f.days.map((d) => d.date)).toEqual(['2026-11-27', '2026-11-28']);
    expect(f.days[0].byCompetition.map((c) => c.scope)).toEqual(['europa']);
    expect(f.days[1].main).toBeUndefined();
    expect(f.days[1].reason).toMatch(/No hay ninguna combinada/);
    expect(f.rule.margins).toEqual({ goles: 0.05 });
  });

  it('historial: aciertos acotados, acierto = aciertos / resueltas, racha acotada y solo combinadas resueltas', () => {
    expect(f.history.hits).toBe(10);
    expect(f.history.hitRate).toBe(1);
    expect(f.history.longestLosingStreak).toBe(10);
    expect(f.history.recent.length).toBe(1);
    expect(f.history.recent[0].result).toBe('miss');
    expect(f.history.byCategory).toEqual([{ category: 'goles', label: COMBO6_CATEGORY_LABEL.goles, legs: 4, hits: 4, voids: undefined, hitRate: 1, expectedHitRate: 0.72 }]);
  });

  it('portada: solo una combinada válida del mismo día', () => {
    const base = { generatedAt: '2026-11-26T17:40:00Z' };
    const ok = normalizeDataFile('home.json', { ...base, combo6: { date: '2026-11-27', combo: combo(legs) } }) as HomeFile;
    expect(ok.combo6?.combo.legs.length).toBe(4);
    const bad = normalizeDataFile('home.json', { ...base, combo6: { date: '2026-11-28', combo: combo(legs) } }) as HomeFile;
    expect(bad.combo6).toBeUndefined();
  });

  it('archivo hostil: descarta combinadas con cifras absurdas (cuota total > 1000 o probabilidad < 1/10 000)', () => {
    const big = Array.from({ length: 12 }, (_, i) => leg(String(i + 1), 'goles', 0.5, 9999));
    const tiny = Array.from({ length: 12 }, (_, i) => leg(String(i + 1), 'goles', 0.0002, 1.01));
    const g = normalizeDataFile('combo6.json', {
      generatedAt: 'x',
      days: [
        { date: '2026-11-27', main: combo(big), byCompetition: [combo(tiny, { scope: 'europa', id: 'e' })] },
        { date: '2026-11-28', main: combo(legs) },
      ],
      history: { settled: 1, hits: 0, recent: [combo(big.map((l) => ({ ...l, result: 'miss' })))] },
    }) as Combo6File;
    expect(g.days[0].main).toBeUndefined();
    expect(g.days[0].byCompetition).toEqual([]);
    expect(g.days[0].reason).toBeTruthy();
    expect(g.days[1].main?.legs.length).toBe(4);
    expect(g.history.recent).toEqual([]);
    const home = normalizeDataFile('home.json', { generatedAt: 'x', combo6: { date: '2026-11-27', combo: combo(big) } }) as HomeFile;
    expect(home.combo6).toBeUndefined();
  });

  it('archivo hostil: ids de boleto únicos en el día y válidos como id del DOM', () => {
    const g = normalizeDataFile('combo6.json', {
      generatedAt: 'x',
      days: [
        {
          date: '2026-11-27',
          main: combo(legs, { id: 'mismo "<id>"' }),
          byCompetition: [combo(legs, { scope: 'europa', id: 'mismo "<id>"' }), combo(legs, { scope: 'champions', id: 'mismo "<id>"' })],
        },
      ],
    }) as Combo6File;
    const d = g.days[0];
    const ids = [d.main!.id, ...d.byCompetition.map((c) => c.id)];
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('utilidades: resultado (nulas fuera), totales y si ya ha empezado', () => {
    expect(combo6Result([{ result: 'hit' }, { result: 'void' }])).toBe('hit');
    expect(combo6Result([{ result: 'void' }])).toBe('void');
    expect(combo6Result([{ result: 'hit' }, { result: undefined }])).toBeUndefined();
    expect(combo6Result([{ result: 'miss' }, { result: undefined }])).toBe('miss');
    expect(combo6Totals([]).prob).toBe(1);
    const c = f.days[0].main!;
    expect(combo6Started(c, Date.parse('2026-11-27T10:00:00Z'))).toBe(false);
    expect(combo6Started(c, Date.parse('2026-11-27T11:30:00Z'))).toBe(true);
  });
});

describe('combinada 6: presentación', () => {
  const l1 = leg('3', 'goles', 0.75, 1.27);
  const l2 = leg('1', 'corners', 0.8, 1.2, { oddsSource: 'casa', bookOddsEstimated: false, selection: 'Más de 7.5 córners' });
  const l3 = { ...leg('2', 'ganador', 0.7, 1.35), kickoff: 'no-es-fecha' };

  it('ordena por hora de inicio (las de hora inválida al final) y acumula la probabilidad', () => {
    const sorted = combo6LegsByKickoff([l1, l3, l2] as never[]) as typeof l1[];
    expect(sorted.map((l) => l.matchId)).toEqual(['1', '3', '2']);
    const cum = combo6Cumulative([{ prob: 0.8 }, { prob: 0.5 }, { prob: 0.5 }]);
    expect(cum).toEqual([0.8, 0.4, 0.2]);
    expect(combo6Cumulative([])).toEqual([]);
  });

  it('marca siempre la cuota estimada con «≈»', () => {
    const fmt = (x: number) => x.toFixed(2);
    expect(combo6LegOddsText({ bookOdds: 1.2, bookOddsEstimated: false, oddsSource: 'casa' }, fmt)).toBe('1.20');
    expect(combo6LegOddsText({ bookOdds: 1.2, bookOddsEstimated: true, oddsSource: 'derivada' }, fmt)).toBe('≈ 1.20');
    // incoherente: dice «casa» pero está marcada como estimada ⇒ se trata como estimada
    expect(combo6LegOddsText({ bookOdds: 1.2, bookOddsEstimated: true, oddsSource: 'casa' }, fmt)).toBe('≈ 1.20');
  });

  it('texto para copiar: una línea por pata en orden, estimadas marcadas, total recalculado y aviso +18', () => {
    const text = combo6CopyText({ label: 'Combinada 6 del día', legs: [l1, l2] as never[] }, { timeOf: (iso) => iso.slice(11, 16) });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Combinada 6 del día');
    expect(lines[1]).toMatch(/^1\. 11:00 · Equipo 11 – Equipo 12 \(UEFA Europa League\) · Córners: Más de 7,5 córners · 80 % · cuota 1,20$/);
    expect(lines[2]).toMatch(/^2\. 13:00 · .* · Goles: Menos de 4,5 goles · 75 % · cuota ≈ 1,27 \(estimada\)$/);
    expect(text).toContain('Cuota total en la casa ≈ 1,52 (1 de 2 cuotas estimadas');
    expect(text).toContain('Probabilidad según el modelo: 60,0 % (1 de cada 2)');
    expect(lines[lines.length - 1]).toContain('+18');
  });
});

describe('copiar al portapapeles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('usa navigator.clipboard si existe', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyText('hola')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hola');
  });

  it('si el portapapeles lo rechaza y no hay documento, devuelve false sin lanzar', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowed')) } });
    expect(await copyText('hola')).toBe(false);
    expect(await copyText('')).toBe(false);
  });

  it('recurre a execCommand("copy") con un textarea temporal', async () => {
    vi.stubGlobal('navigator', {});
    const removed: unknown[] = [];
    const ta = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: () => removed.push(ta) };
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal('document', { body: { appendChild: vi.fn() }, activeElement: null, createElement: () => ta, execCommand });
    expect(await copyText('texto')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(ta.value).toBe('texto');
    expect(removed).toHaveLength(1);
  });
});
