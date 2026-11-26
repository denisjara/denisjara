/**
 * App: «Pronósticos del día» (daily.json y HomeFile.daily). La capa de datos debe aceptar el archivo, normalizarlo de
 * forma defensiva (categorías en lista blanca, números finitos, listas acotadas, combinadas con patas válidas) y no
 * inventar cifras; las utilidades de la página (filtros, top, orden de competiciones) deben ser coherentes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompetitionMeta, DailyFile, DailyPick, HomeFile } from '../../src/types/data';
import { normalizeDataFile, normDailyPick } from '../../src/app/lib/sanitize';
import {
  DAILY_CATEGORIES,
  categoryOrder,
  competitionPrestige,
  dailyTop,
  defaultDay,
  filterDailyMatches,
  groupDailyByCompetition,
  hasStarted,
  inferDailyCategory,
  isMarqueeCompetition,
  nextDayWithPicks,
  pickRecord,
  picksByCategory,
  upcomingFirst,
} from '../../src/app/lib/daily';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mock = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mock-data', rel), 'utf8'));

const PICK = {
  family: 'sot-over-6.5',
  marketId: 'sot-ou-6.5',
  market: 'Tiros a puerta: más/menos 6.5',
  selection: 'Más de 6.5 tiros a puerta',
  prob: 0.9,
  fairOdds: 1.111,
  tier: 'oro',
  historicalHitRate: 0.9,
  historicalN: 600,
  calibratedProb: 0.89,
  source: 'mercado',
  validationHitRate: 0.874,
  validationN: 349,
  validationWilsonLow: 0.842,
  validationWilsonHigh: 0.901,
  baseRate: 0.851,
  category: 'tiros',
  reason: 'Proyección de 12,7 tiros a puerta.',
  score: 86.2,
  lift: 0.023,
};
const team = (id: string, name: string) => ({ id, name });
const match = (id: string, extra: Record<string, unknown> = {}) => ({ id, compId: 'champions', compName: 'UEFA Champions League', date: '2026-11-24T20:00:00Z', status: 'scheduled', home: team('1', 'Local'), away: team('2', 'Visitante'), hasDetail: true, ...extra });
const leg = (matchId: string, pick: unknown = PICK) => ({ matchId, home: 'Local', away: 'Visitante', compName: 'Champions', pick });
const file = (days: unknown, extra: Record<string, unknown> = {}) => normalizeDataFile('daily.json', { generatedAt: '2026-11-24T12:00:00Z', days, ...extra }) as DailyFile;

describe('pronósticos del día: capa de datos', () => {
  it('daily.json está en la lista blanca de rutas de la capa de datos y tiene su hook', () => {
    // data.ts usa APIs del navegador (no se importa en Node): se comprueba la lista blanca sobre su código fuente
    const src = fs.readFileSync(path.join(ROOT, 'src/app/lib/data.ts'), 'utf8');
    const m = /const ALLOWED_PATH = \/(.+)\/;/.exec(src);
    expect(m).toBeTruthy();
    const allowed = new RegExp(m![1]);
    expect(allowed.test('daily.json')).toBe(true);
    expect(allowed.test('confidence.json')).toBe(true);
    expect(allowed.test('daily2.json')).toBe(false);
    expect(allowed.test('../daily.json')).toBe(false);
    expect(allowed.test('daily.json/../x')).toBe(false);
    expect(src).toMatch(/export const useDaily = \(\) => useJson<DailyFile>\('daily\.json'\)/);
  });

  it('el archivo de prueba se normaliza sin perder nada y es coherente con el contrato', () => {
    const raw = mock('daily.json');
    const out = normalizeDataFile('daily.json', raw) as DailyFile;
    expect(out.days.length).toBe(raw.days.length);
    expect(out.days.length).toBeGreaterThanOrEqual(2);
    expect(out.days.length).toBeLessThanOrEqual(4);
    expect(out.categories.map((c) => c.id)).toEqual([...DAILY_CATEGORIES]);
    const seenCats = new Set<string>();
    const seenComps = new Set<string>();
    out.days.forEach((d, i) => {
      const r = raw.days[i];
      expect(d.date).toBe(r.date);
      expect(d.matches.length).toBe(r.matches.length);
      expect(d.counts).toEqual(r.counts);
      expect(d.top.length).toBe(r.top.length);
      expect(d.top.length).toBeLessThanOrEqual(10);
      expect(d.combos.length).toBe(r.combos.length);
      expect(new Set(d.top.map((t) => t.matchId)).size).toBe(d.top.length); // uno por partido
      d.matches.forEach((m, k) => {
        expect(m.picks.length).toBe(r.matches[k].picks.length);
        expect(m.picks.length).toBeLessThanOrEqual(8);
        expect(m.analysis.length).toBeGreaterThanOrEqual(2);
        expect(m.expected.goals.total).toBeCloseTo(m.expected.goals.home + m.expected.goals.away, 1);
        seenComps.add(m.match.compId);
        const perCat = new Map<string, number>();
        for (const p of m.picks) {
          seenCats.add(p.category);
          perCat.set(p.category, (perCat.get(p.category) ?? 0) + 1);
          expect(p.fairOdds).toBeCloseTo(1 / p.prob, 2);
          if (p.category === 'jugadores') expect(p.player?.name).toBeTruthy();
          if (p.marketOdds) expect(p.marketOdds).toBeGreaterThan(1);
        }
        expect(Math.max(...perCat.values())).toBeLessThanOrEqual(2);
      });
      for (const c of d.combos) {
        expect(c.legs.length).toBeGreaterThanOrEqual(2);
        expect(new Set(c.legs.map((l) => l.matchId)).size).toBe(c.legs.length); // partidos distintos
        expect(c.prob).toBeCloseTo(c.legs.reduce((a, l) => a * (l.pick.calibratedProb ?? l.pick.prob), 1), 3);
        expect(c.fairOdds).toBeCloseTo(1 / c.prob, 2);
      }
    });
    expect([...seenCats].sort()).toEqual([...DAILY_CATEGORIES].sort()); // todas las categorías
    expect(seenComps.has('champions')).toBe(true);
    expect(seenComps.size).toBeGreaterThan(2); // Champions y ligas
    expect(out.days.some((d) => d.combos.some((c) => c.marketOdds !== undefined))).toBe(true);
    expect(out.days.some((d) => d.combos.some((c) => c.marketOdds === undefined))).toBe(true);
    // registro fuera de muestra: global, por categoría (con tasa base), combinadas y línea base
    const t = out.track;
    expect(t.overall.hitRate).toBeCloseTo(t.overall.hits / t.overall.n, 3);
    expect(t.overall.wilsonLow!).toBeLessThan(t.overall.hitRate);
    expect(t.byCategory.map((c) => c.category)).toEqual([...DAILY_CATEGORIES]);
    expect(t.byCategory.reduce((s, c) => s + c.n, 0)).toBe(t.overall.n);
    expect(t.byCategory.every((c) => c.baseRate !== undefined)).toBe(true);
    expect(t.byCategory.some((c) => c.n < 50)).toBe(true); // una categoría de muestra pequeña para probar la UI
    expect(t.combos!.map((c) => c.id)).toEqual(['segura', 'equilibrada', 'atrevida']);
    for (const c of t.combos!) expect(c.hitRate).toBeCloseTo(c.hits / c.days, 6);
    expect(t.baseline!.hitRate).toBeGreaterThan(0.8);
    expect(out.note.length).toBeGreaterThan(20);
  });

  it('portada: HomeFile.daily con el top (máx. 4 en el archivo de prueba) y coherente con daily.json', () => {
    const home = normalizeDataFile('home.json', mock('home.json')) as HomeFile;
    const daily = normalizeDataFile('daily.json', mock('daily.json')) as DailyFile;
    expect(home.daily).toBeDefined();
    expect(home.daily!.top.length).toBeGreaterThan(0);
    expect(home.daily!.top.length).toBeLessThanOrEqual(4);
    const day = daily.days.find((d) => d.date === home.daily!.date)!;
    expect(day).toBeDefined();
    expect(home.daily!.picks).toBe(day.counts.picks);
    expect(home.daily!.matches).toBe(day.counts.matches);
    expect(home.daily!.top[0].pick.selection).toBe(day.top[0].pick.selection);
    // sin dato o con dato roto, el bloque no se muestra
    expect((normalizeDataFile('home.json', { ...mock('home.json'), daily: undefined }) as HomeFile).daily).toBeUndefined();
    expect((normalizeDataFile('home.json', { ...mock('home.json'), daily: { date: 'hoy', matches: 3, picks: 9, top: [{ match: match('1'), pick: PICK }] } }) as HomeFile).daily).toBeUndefined();
    expect((normalizeDataFile('home.json', { ...mock('home.json'), daily: { date: '2026-11-24', matches: 3, picks: 9, top: [{ match: { id: 'x' }, pick: PICK }, 7, null] } }) as HomeFile).daily).toBeUndefined();
    const odd = normalizeDataFile('home.json', { ...mock('home.json'), daily: { date: '2026-11-24', matches: 'muchos', picks: -4, top: [{ match: match('1'), pick: PICK }, { match: match('1'), pick: PICK }] } }) as HomeFile;
    expect(odd.daily).toEqual({ date: '2026-11-24', matches: 1, picks: 1, top: [expect.objectContaining({ pick: expect.objectContaining({ category: 'tiros' }) })] });
  });

  it('picks anómalos: categorías en lista blanca, números finitos, textos acotados y nada de plata', () => {
    const ok = normDailyPick(PICK)!;
    expect(ok.category).toBe('tiros');
    expect(ok.lift).toBe(0.023);
    expect(ok.tier).toBe('oro');
    // descartados: sin objeto, probabilidad imposible, sin selección, nivel plata, categoría desconocida sin pista
    for (const bad of [null, 7, 'x', [], { ...PICK, prob: 1.4 }, { ...PICK, prob: 0 }, { ...PICK, prob: 'alta' }, { ...PICK, prob: NaN }, { ...PICK, selection: '   ' }, { ...PICK, tier: 'plata' }, { ...PICK, tier: '__proto__' }, { ...PICK, category: 'apuestas', family: 'misterio', marketId: 'x' }]) {
      expect(normDailyPick(bad)).toBeUndefined();
    }
    // categoría ausente o inventada → se deduce de la familia / el mercado (o del jugador)
    expect(normDailyPick({ ...PICK, category: undefined })!.category).toBe('tiros');
    expect(normDailyPick({ ...PICK, category: 'constructor', family: 'corners-over-6.5', marketId: 'corners-ou-6.5' })!.category).toBe('corners');
    expect(normDailyPick({ ...PICK, category: 7, family: 'x', marketId: 'y', player: { id: '9', name: 'Ana Gol' } })!.category).toBe('jugadores');
    // campos raros se neutralizan; lo que falta no se inventa
    const odd = normDailyPick({
      ...PICK,
      fairOdds: Infinity,
      marketOdds: 0.4,
      oddsKind: 'rara',
      historicalHitRate: undefined,
      historicalN: 900,
      calibratedProb: 3,
      source: 'x',
      validationN: 0,
      holdoutHitRate: 0.9,
      holdoutN: 120,
      holdoutWilsonLow: 0.95,
      holdoutWilsonHigh: 0.99,
      baseRate: -1,
      result: 'ganada',
      reason: `  dos\n líneas ${'x'.repeat(900)}`,
      player: { id: 12, name: `  ${'N'.repeat(300)}`, teamId: null, position: 'Z', expMinutes: 4000 },
      score: 250,
      lift: 0.3,
      extra: '<script>',
    })!;
    expect(odd.fairOdds).toBeCloseTo(1 / 0.9, 6);
    expect(odd.marketOdds).toBeUndefined();
    expect(odd.oddsKind).toBeUndefined();
    expect(odd.historicalHitRate).toBe(0);
    expect(odd.historicalN).toBe(0);
    expect(odd.calibratedProb).toBeUndefined();
    expect(odd.source).toBeUndefined();
    expect(odd.validationHitRate).toBeUndefined();
    expect(odd.validationN).toBeUndefined();
    expect(odd.holdoutHitRate).toBe(0.9);
    expect(odd.holdoutWilsonLow).toBeUndefined(); // el intervalo no contiene el acierto
    expect(odd.baseRate).toBeUndefined();
    expect(odd.result).toBeUndefined();
    expect(odd.reason!.length).toBeLessThanOrEqual(280);
    expect(odd.reason!.startsWith('dos líneas')).toBe(true);
    expect(odd.player).toEqual({ id: '12', name: 'N'.repeat(80), short: 'N'.repeat(40), teamId: '', position: undefined, expMinutes: undefined });
    expect(odd.score).toBe(100);
    expect(odd.lift).toBeUndefined(); // sin validación propia no hay mejora que enseñar
    expect('extra' in odd).toBe(false);
    for (const v of Object.values(odd)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('días y partidos anómalos: se descarta lo roto, se acotan las listas y los recuentos salen de lo que se muestra', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...PICK, family: `shots-over-${i}`, selection: `Más de ${i} tiros`, category: DAILY_CATEGORIES[i % 7] }));
    const out = file(
      [
        'basura',
        { date: '2026-13-40', matches: [{ match: match('1'), picks: [PICK] }] },
        { date: '24/11/2026', matches: [] },
        {
          date: '2026-11-25',
          matches: [
            { match: match('10'), picks: many, expected: { goals: { home: 1.5, away: 'x' }, shots: { home: 12, away: 10 }, corners: { home: -3, away: 4, total: 1 }, cards: null, fouls: { home: 11, away: 12, total: Infinity } }, analysis: ['a', 7, 'b'.repeat(900), 'c', 'd', 'e', 'f'] },
            { match: match('10'), picks: [PICK] }, // partido repetido
            { match: { id: '11' }, picks: [PICK] }, // partido sin equipos
            { match: match('12'), picks: [{ ...PICK, prob: 9 }, null] }, // sin picks válidos
            { match: match('13', { prediction: { p: { home: 0.5, draw: 0.3, away: 0.2 }, xgHome: 1.4, xgAway: 0.9 } }), picks: [PICK, PICK, { ...PICK, family: 'sot-over-7.5', selection: 'Más de 7.5 tiros a puerta' }, { ...PICK, family: 'sot-over-8.5', selection: 'Más de 8.5 tiros a puerta' }] },
          ],
          top: [{ matchId: '10', pick: many[0] }, { matchId: '10', pick: many[1] }, { matchId: '99', pick: PICK }, { matchId: '13', pick: { ...PICK, prob: -1 } }, 5],
          combos: 'ninguna',
          counts: { matches: 500, picks: 9000, matchesAnalyzed: 3 },
        },
        { date: '2026-11-24', matches: [], top: [], combos: [], counts: { matches: 0, picks: 0, matchesAnalyzed: 14 } },
        { date: '2026-11-24', matches: [{ match: match('1'), picks: [PICK] }] }, // día repetido
      ],
      { categories: [{ id: 'tiros', label: 'Remates' }, { id: 'tiros', label: 'Otra' }, { id: 'magia', label: 'Magia' }, 3], track: 'x', note: 7 },
    );
    expect(out.days.map((d) => d.date)).toEqual(['2026-11-24', '2026-11-25']); // cronológico, sin fechas inválidas ni repetidas
    expect(out.days[0].counts).toEqual({ matches: 0, picks: 0, matchesAnalyzed: 14 });
    const d = out.days[1];
    expect(d.matches.map((m) => m.match.id)).toEqual(['10', '13']);
    const m10 = d.matches[0];
    expect(m10.picks.length).toBe(8); // tope por partido
    expect(Math.max(...DAILY_CATEGORIES.map((c) => m10.picks.filter((p) => p.category === c).length))).toBeLessThanOrEqual(2);
    expect(m10.expected.goals).toBeUndefined(); // incompleto y sin predicción de respaldo: no se inventa
    expect(m10.expected.shots).toEqual({ home: 12, away: 10, total: 22 }); // total derivado
    expect(m10.expected.corners).toBeUndefined();
    expect(m10.expected.cards).toBeUndefined();
    expect(m10.expected.fouls).toEqual({ home: 11, away: 12, total: 23 });
    expect(m10.analysis.length).toBe(5);
    expect(m10.analysis.every((a) => a.length <= 320)).toBe(true);
    const m13 = d.matches[1];
    expect(m13.picks.map((p) => p.family)).toEqual(['sot-over-6.5', 'sot-over-7.5']); // sin repetidos y máx. 2 por categoría
    expect(m13.expected.goals).toEqual({ home: 1.4, away: 0.9, total: 2.3 }); // respaldo: xG de la predicción
    expect(d.top.map((t) => t.matchId)).toEqual(['10']); // uno por partido, solo partidos del día y picks válidos
    expect(d.combos).toEqual([]);
    expect(d.counts).toEqual({ matches: 2, picks: 10, matchesAnalyzed: 3 });
    // categorías: lista blanca sin repetir, con su etiqueta; registro ausente → vacío, nunca inventado
    expect(out.categories).toEqual([{ id: 'tiros', label: 'Remates' }]);
    expect(categoryOrder(out)).toEqual([{ id: 'tiros', label: 'Remates' }]);
    expect(out.track.overall.n).toBe(0);
    expect(out.track.byCategory).toEqual([]);
    expect(out.track.combos).toEqual([]);
    expect(out.track.baseline).toBeUndefined();
    expect(out.note).toBe('7');
    // archivo casi vacío: sin días, con las categorías por defecto
    const empty = file(undefined);
    expect(empty.days).toEqual([]);
    expect(empty.categories.map((c) => c.id)).toEqual([...DAILY_CATEGORIES]);
    expect(() => normalizeDataFile('daily.json', [])).toThrow();
    expect(() => normalizeDataFile('daily.json', { days: [] })).toThrow(); // sin generatedAt
    // como mucho 7 días
    expect(file(Array.from({ length: 12 }, (_, i) => ({ date: `2026-12-${String(i + 1).padStart(2, '0')}`, matches: [] }))).days.length).toBe(7);
  });

  it('combinadas: todas las patas válidas y de partidos distintos; la probabilidad no puede superar a la de una pata', () => {
    const p2 = { ...PICK, family: 'cards-over-1.5', selection: 'Más de 1.5 tarjetas', category: 'tarjetas', prob: 0.92, calibratedProb: 0.93, marketOdds: 1.05 };
    const base = { date: '2026-11-24', matches: [{ match: match('1'), picks: [PICK] }, { match: match('2'), picks: [p2] }] };
    const combos = (list: unknown[]) => file([{ ...base, combos: list }]).days[0].combos;
    const good = { id: 'segura', label: 'Combinada segura', legs: [leg('1'), leg('2', p2)], prob: 0.8277, fairOdds: 1.208 };
    expect(combos([good]).map((c) => c.id)).toEqual(['segura']);
    expect(combos([good])[0].marketOdds).toBeUndefined();
    // cuota de mercado solo si TODAS las patas tienen cuota
    expect(combos([{ ...good, marketOdds: 1.12 }])[0].marketOdds).toBeUndefined();
    expect(combos([{ ...good, legs: [leg('1', { ...PICK, marketOdds: 1.07 }), leg('2', p2)], marketOdds: 1.12 }])[0].marketOdds).toBe(1.12);
    // cuota justa ausente o imposible → 1 / probabilidad
    expect(combos([{ ...good, fairOdds: 'x' }])[0].fairOdds).toBeCloseTo(1 / 0.8277, 6);
    const rejected = [
      { ...good, legs: [leg('1')] }, // una sola pata
      { ...good, legs: [leg('1'), leg('1', p2)] }, // dos patas del mismo partido
      { ...good, legs: [leg('1'), leg('2', { ...p2, prob: 7 })] }, // una pata rota invalida la combinada
      { ...good, legs: [leg('1'), { ...leg('2', p2), home: '' }] },
      { ...good, legs: [leg('1'), null] },
      { ...good, legs: 'dos' },
      { ...good, prob: 0.99 }, // mayor que la de su pata menos probable
      { ...good, prob: 0 },
      { ...good, prob: NaN },
      { ...good, legs: Array.from({ length: 13 }, (_, i) => leg(String(i + 1))) },
    ];
    expect(combos(rejected)).toEqual([]);
    expect(combos([good, good, good, good, good]).length).toBe(3); // tope
    // histórico de combinadas: días > 0, aciertos ≤ días y acierto recalculado
    const t = file([], { track: { combos: [{ id: 'segura', label: 'S', days: 96, hits: 71, hitRate: 0.99, avgLegs: 3, avgFairOdds: 1.36 }, { id: 'x', days: 0, hits: 0 }, { id: 'y', days: 10, hits: 12 }, { days: 5, hits: 1 }, { id: 'z', days: 20, hits: 9, avgLegs: 'tres', avgFairOdds: 0.2 }] } }).track.combos!;
    expect(t.map((c) => c.id)).toEqual(['segura', 'z']);
    expect(t[0].hitRate).toBeCloseTo(71 / 96, 9);
    expect(t[1].avgLegs).toBeUndefined();
    expect(t[1].avgFairOdds).toBeUndefined();
  });

  it('registro fuera de muestra anómalo: no se muestra un acierto que no cuadra con sus cuentas', () => {
    const out = file([], {
      track: {
        overall: { picks: 10, n: 10, hits: 12, hitRate: 1.2, from: 'ayer', to: '2026-11-23T00:00:00Z' },
        byCategory: [
          { category: 'goles', label: 'Goles', picks: 100, n: 100, hits: 90, hitRate: 0.9, wilsonLow: 0.84, wilsonHigh: 0.94, baseRate: 0.86 },
          { category: 'goles', label: 'Repetida', n: 5, hits: 5, hitRate: 1 },
          { category: 'tiros', n: 10, hits: 30, hitRate: 0.5 },
          { category: 'quinielas', n: 10, hits: 5, hitRate: 0.5 },
          { category: 'faltas', n: 44, hits: 38, hitRate: 0.8636, baseRate: 7 },
        ],
        baseline: { label: 'siempre lo mismo', n: 0, hits: 0, hitRate: 0 },
      },
    });
    expect(out.track.overall).toEqual({ picks: 0, n: 0, hits: 0, hitRate: 0, from: '', to: '' });
    expect(out.track.byCategory.map((c) => [c.category, c.label, c.n, c.baseRate])).toEqual([
      ['goles', 'Goles', 100, 0.86],
      ['faltas', 'Faltas', 44, undefined],
    ]);
    expect(out.track.baseline).toBeUndefined();
  });
});

describe('pronósticos del día: utilidades de la página', () => {
  const daily = normalizeDataFile('daily.json', mock('daily.json')) as DailyFile;
  const day = daily.days[0];
  const meta = (id: string, tier: number, kind: CompetitionMeta['kind']) => ({ id, tier, kind, name: id }) as CompetitionMeta;
  const metas = [meta('champions', 10, 'continental'), meta('laliga', 10, 'league'), meta('brasileirao', 7, 'league'), meta('copadelrey', 6, 'cup'), meta('europa', 8, 'continental')];

  it('categoría deducida de la familia y récord fuera de muestra del pick', () => {
    expect(inferDailyCategory('dc')).toBe('resultado');
    expect(inferDailyCategory('ah+1.5', 'ah-home-1.5')).toBe('resultado');
    expect(inferDailyCategory('ou-1.5-over')).toBe('goles');
    expect(inferDailyCategory('team-score')).toBe('goles');
    expect(inferDailyCategory('sot-team-over-2.5')).toBe('tiros');
    expect(inferDailyCategory('shots-over-19.5')).toBe('tiros');
    expect(inferDailyCategory('corners-over-6.5')).toBe('corners');
    expect(inferDailyCategory('cards-over-1.5')).toBe('tarjetas');
    expect(inferDailyCategory('fouls-over-17.5')).toBe('faltas');
    expect(inferDailyCategory('player-sot-1', 'player-123-sot1')).toBe('jugadores');
    expect(inferDailyCategory('otro', 'otro')).toBeUndefined();
    const p = normDailyPick(PICK)!;
    expect(pickRecord(p)).toMatchObject({ rate: 0.874, n: 349, kind: 'walk-forward', state: 'ok' });
    expect(pickRecord({ validationHitRate: 0.86, validationN: 44 })).toMatchObject({ state: 'pequena' }); // n < 50: sin acierto propio
    expect(pickRecord({ validationHitRate: 0.74, validationN: 125 })).toMatchObject({ state: 'bajo' });
    expect(pickRecord({ holdoutHitRate: 0.9, holdoutN: 240 })).toMatchObject({ kind: 'holdout', state: 'ok' }); // sin walk-forward: holdout de la familia
    expect(pickRecord({})).toBeUndefined();
  });

  it('competiciones por prestigio: Champions primero, continentales de cartel y después el tier', () => {
    const order = ['copadelrey', 'brasileirao', 'laliga', 'europa', 'champions'].sort((a, b) => competitionPrestige(b, metas.find((m) => m.id === b)) - competitionPrestige(a, metas.find((m) => m.id === a)));
    expect(order).toEqual(['champions', 'europa', 'laliga', 'brasileirao', 'copadelrey']);
    expect(isMarqueeCompetition('champions')).toBe(true);
    expect(isMarqueeCompetition('laliga', metas[1])).toBe(false);
    expect(isMarqueeCompetition('otra', meta('otra', 3, 'continental'))).toBe(true);
    const groups = groupDailyByCompetition(day.matches, metas);
    expect(groups[0].compId).toBe('champions');
    expect(groups.reduce((s, g) => s + g.matches.length, 0)).toBe(day.matches.length);
    expect(groups.reduce((s, g) => s + g.picks, 0)).toBe(day.counts.picks);
    for (const g of groups) expect([...g.matches].sort((a, b) => a.match.date.localeCompare(b.match.date) || a.match.id.localeCompare(b.match.id))).toEqual(g.matches);
    // sin meta.json la Champions sigue primera y el resto conserva el orden del archivo
    expect(groupDailyByCompetition(day.matches, undefined)[0].compId).toBe('champions');
  });

  it('filtros por competición y categoría, y top del día', () => {
    expect(filterDailyMatches(day.matches, {})).toEqual(day.matches);
    const ucl = filterDailyMatches(day.matches, { comp: 'champions' });
    expect(ucl.length).toBeGreaterThan(0);
    expect(ucl.every((m) => m.match.compId === 'champions')).toBe(true);
    const shots = filterDailyMatches(day.matches, { comp: 'champions', cat: 'tiros' });
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((m) => m.picks.length > 0 && m.picks.every((p) => p.category === 'tiros'))).toBe(true);
    expect(filterDailyMatches(day.matches, { comp: 'no-existe' })).toEqual([]);
    // sin filtros: el top del pipeline tal cual; con filtros: el mejor pick de cada partido que los pasa, por score
    const top = dailyTop(day);
    expect(top.map((t) => t.pick.selection)).toEqual(day.top.map((t) => t.pick.selection));
    const topShots = dailyTop(day, { cat: 'tiros' });
    expect(topShots.length).toBeGreaterThan(0);
    expect(topShots.length).toBeLessThanOrEqual(10);
    expect(topShots.every((t) => t.pick.category === 'tiros')).toBe(true);
    expect(new Set(topShots.map((t) => t.match.id)).size).toBe(topShots.length);
    expect(topShots.map((t) => t.pick.score!)).toEqual([...topShots.map((t) => t.pick.score!)].sort((a, b) => b - a));
    expect(dailyTop(day, { comp: 'champions' }).every((t) => t.match.compId === 'champions')).toBe(true);
    expect(dailyTop({ ...day, top: [] }).length).toBeGreaterThan(0); // sin top publicado se deriva de los partidos
    expect(dailyTop(day, {}, 3).length).toBe(3);
    const grouped = picksByCategory(day.matches[0].picks, daily.categories.map((c) => c.id));
    expect(grouped.reduce((s, g) => s + g.picks.length, 0)).toBe(day.matches[0].picks.length);
    expect(grouped.map((g) => g.category)).toEqual(DAILY_CATEGORIES.filter((c) => day.matches[0].picks.some((p) => p.category === c)));
  });

  it('partidos empezados al final, día por defecto y siguiente día con pronósticos', () => {
    const now = Date.parse('2026-11-24T19:00:00Z');
    const sched = (date: string) => ({ status: 'scheduled' as const, date });
    expect(hasStarted(sched('2026-11-24T20:00:00Z'), now)).toBe(false);
    expect(hasStarted(sched('2026-11-24T18:45:00Z'), now)).toBe(true); // programado en los datos, pero ya en juego
    expect(hasStarted({ status: 'live', date: '2026-11-24T20:00:00Z' }, now)).toBe(true);
    expect(hasStarted({ status: 'finished', date: '2026-11-24T20:00:00Z' }, now)).toBe(true);
    const items = [{ id: 'a', match: sched('2026-11-24T18:45:00Z') }, { id: 'b', match: sched('2026-11-24T20:00:00Z') }, { id: 'c', match: sched('2026-11-24T21:00:00Z') }];
    expect(upcomingFirst(items, now).map((x) => x.id)).toEqual(['b', 'c', 'a']);
    const days = [
      { date: '2026-11-24', counts: { matches: 0, picks: 0, matchesAnalyzed: 9 } },
      { date: '2026-11-25', counts: { matches: 9, picks: 60, matchesAnalyzed: 9 } },
      { date: '2026-11-27', counts: { matches: 4, picks: 20, matchesAnalyzed: 12 } },
    ];
    expect(defaultDay(days, null, '2026-11-24')).toBe('2026-11-24');
    expect(defaultDay(days, '2026-11-27', '2026-11-24')).toBe('2026-11-27');
    expect(defaultDay(days, '2026-11-26', '2026-11-24')).toBe('2026-11-24'); // día pedido que no existe
    expect(defaultDay(days, null, '2026-11-26')).toBe('2026-11-27'); // datos de hace unos días: el primero de hoy en adelante
    expect(defaultDay(days, null, '2026-12-01')).toBe('2026-11-27'); // todo pasado: el último
    expect(defaultDay([], '2026-11-24', '2026-11-24')).toBeUndefined();
    expect(nextDayWithPicks(days, '2026-11-24')!.date).toBe('2026-11-25');
    expect(nextDayWithPicks(days, '2026-11-27')).toBeUndefined();
  });

  it('ningún pick normalizado del archivo de prueba contiene textos o números inválidos', () => {
    const bad = /undefined|NaN|null|\[object/;
    const check = (p: DailyPick) => {
      for (const s of [p.selection, p.market, p.reason ?? '', p.player?.name ?? '']) expect(bad.test(s)).toBe(false);
      for (const v of [p.prob, p.fairOdds, p.score ?? 0, p.lift ?? 0, p.marketOdds ?? 1.5]) expect(Number.isFinite(v)).toBe(true);
    };
    for (const d of daily.days) {
      for (const m of d.matches) {
        m.picks.forEach(check);
        for (const a of m.analysis) expect(bad.test(a)).toBe(false);
      }
      d.top.forEach((t) => check(t.pick));
      d.combos.forEach((c) => c.legs.forEach((l) => check(l.pick)));
    }
  });
});
