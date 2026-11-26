/**
 * Variantes «totals*» (pipeline/experiments/totals/model.ts y totals-*.ts): contracción del total de goles hacia la
 * media de la competición en partidos sin línea de goles del mercado y más contracción de las tasas de córners y
 * tarjetas. Comprueba la fórmula, que la media de la competición solo ve el pasado, que el 1X2 no cambia nunca, que
 * con línea de goles del mercado (y en copas, con «nocup») todo queda como en producción, que no hay fuga (futuro
 * envenenado) y que las variantes se cargan con el cargador oficial.
 */
import { describe, expect, it } from 'vitest';
import { Elo, mulberry32, sampleNegBin, samplePoisson } from '../../src/lib/models';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord } from '../../pipeline/types';
import { busiestDay, leakCheck, matchInfos, runVariant, type EvalData } from '../../pipeline/experiments/bench';
import { historyView } from '../../pipeline/experiments/history';
import { listVariants, loadVariant } from '../../pipeline/experiments/load';
import { BASELINE_2211_VARIANT as BASELINE_VARIANT, PRODUCTION_VARIANT, type ModelVariant } from '../../pipeline/experiments/types';
import { GLOBAL_TOTAL, LEAGUE_TOTAL_DEFAULTS, leagueTotal, shrinkFactor } from '../../pipeline/experiments/totals/model';
import totalsBest from '../../pipeline/experiments/totals-best';
import totalsShrink from '../../pipeline/experiments/totals-shrink';
import totalsStats from '../../pipeline/experiments/totals-stats';

const DAY = 86_400_000;
const LIGA: CompetitionConfig = { id: 'liga-t', slug: 'synt.1', name: 'Liga T', shortName: 'Liga T', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 6 };
const COPA: CompetitionConfig = { id: 'copa-t', slug: 'synt.copa', name: 'Copa T', shortName: 'Copa T', country: 'Sintetia', flag: '🏳️', kind: 'cup', tier: 4 };
const CONFIGS = [LIGA, COPA];

/**
 * Liga de 10 equipos (2024-01 → 2026-10) con un tercio de partidos sin cuotas, un tercio con 1X2 y línea de goles y un
 * tercio con 1X2 sin línea de goles; copa sin cuotas los miércoles desde 2026-06. Córners y tarjetas en casi todos.
 * Empieza en 2024 para que haya >= PRESEASON_MIN_SAMPLES (300) partidos antes de la temporada 2026: con menos, el
 * núcleo usa los parámetros de empate del Elo ajustados con todos los datos (también los futuros) y la comprobación de
 * fuga falla incluso con producción.
 */
function world(seed = 21): CompetitionStore[] {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, name: `Equipo ${i}`, short: `T${i}`, abbr: `T${i}`, att: 1.5 - 0.09 * i, def: 0.7 + 0.07 * i }));
  const ref = (t: (typeof teams)[number]) => ({ id: t.id, name: t.name, short: t.short, abbr: t.abbr });
  let id = 7000;
  const play = (compId: string, date: number, h: (typeof teams)[number], a: (typeof teams)[number], odds: 0 | 1 | 2): MatchRecord => {
    const hg = samplePoisson(1.25 * h.att * a.def * 1.15, rng);
    const ag = samplePoisson(1.25 * a.att * h.def, rng);
    const m: MatchRecord = {
      id: String(id++),
      compId,
      season: new Date(date).getUTCFullYear(),
      currentSeason: date >= Date.UTC(2026, 0, 1),
      date: new Date(date).toISOString(),
      status: 'finished',
      home: ref(h),
      away: ref(a),
      score: { home: hg, away: ag },
      ...(rng() < 0.1
        ? {}
        : {
            stats: {
              home: { goals: hg, corners: sampleNegBin(5 * h.att, 12, rng), yellow: samplePoisson(2, rng) + 1, red: 0 },
              away: { goals: ag, corners: sampleNegBin(4.4 * a.att, 12, rng), yellow: samplePoisson(2.2, rng) + 1, red: 0 },
            },
          }),
    };
    if (odds === 1) m.odds = { provider: 'Sintética', home: 2.2, draw: 3.4, away: 3.6, totalLine: 2.5, over: 1.95, under: 1.9 };
    if (odds === 2) m.odds = { provider: 'Sintética', home: 2.1, draw: 3.4, away: 3.8 };
    return m;
  };
  const league: MatchRecord[] = [];
  const cup: MatchRecord[] = [];
  let w = 0;
  for (let t = Date.UTC(2024, 0, 6, 15); t < Date.UTC(2026, 9, 25); t += 7 * DAY, w++) {
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let k = 0; k < 5; k++) league.push(play(LIGA.id, t + k * 3_600_000, order[2 * k], order[2 * k + 1], ((w + k) % 3) as 0 | 1 | 2));
    if (t >= Date.UTC(2026, 5, 1) && w % 2 === 0) cup.push(play(COPA.id, t + 4 * DAY, order[1], order[8], 0));
  }
  return [
    { compId: COPA.id, slug: COPA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: cup, players: [], standings: [] },
    { compId: LIGA.id, slug: LIGA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: league, players: [], standings: [] },
  ];
}

const stores = world();
const data: EvalData = { stores, configs: CONFIGS, now: new Date('2026-11-01T00:00:00Z'), fingerprint: 'test-totals' };
const byId = new Map(stores.flatMap((s) => s.matches).map((m) => [m.id, m]));

function match(hg: number, ag: number, date: string): MatchRecord {
  return {
    id: `m-${date}`,
    compId: LIGA.id,
    season: 2026,
    currentSeason: true,
    date,
    status: 'finished',
    home: { id: 'A', name: 'A', short: 'A', abbr: 'A' },
    away: { id: 'B', name: 'B', short: 'B', abbr: 'B' },
    score: { home: hg, away: ag },
  };
}

describe('contracción del total de goles', () => {
  it('shrinkFactor: s = 1 no cambia, s = 0 lleva a la media, s = 0,5 a mitad de camino; entradas no válidas ⇒ 1', () => {
    expect(shrinkFactor(3.2, 2.6, 1)).toBeCloseTo(1, 12);
    expect(shrinkFactor(3.2, 2.6, 0) * 3.2).toBeCloseTo(2.6, 12);
    expect(shrinkFactor(2.0, 2.6, 0.5) * 2.0).toBeCloseTo(2.3, 12);
    expect(shrinkFactor(0, 2.6, 0.5)).toBe(1);
    expect(shrinkFactor(Number.NaN, 2.6, 0.5)).toBe(1);
    expect(shrinkFactor(2.5, 0, 0.5)).toBe(1);
    // recorte del factor a [0,5; 2]
    expect(shrinkFactor(0.2, 2.6, 0)).toBe(2);
    expect(shrinkFactor(9, 2.6, 0)).toBe(0.5);
  });

  it('la media de la competición solo ve partidos anteriores al corte y se contrae hacia 2,6', () => {
    const past = [match(1, 0, '2026-02-01T15:00:00Z'), match(3, 2, '2026-02-08T15:00:00Z'), match(0, 0, '2025-01-01T15:00:00Z')];
    const future = [match(9, 9, '2026-03-10T15:00:00Z')];
    const src = (ms: MatchRecord[]) => ({ matchesByTeam: new Map([['A', ms], ['B', ms]]), matchesByComp: new Map([[LIGA.id, ms]]), elo: new Elo({ k: 20, homeAdv: 65, init: 1500 }) });
    const cutoff = Date.parse('2026-03-01T15:00:00Z');
    const a = leagueTotal(historyView(src(past), cutoff), LIGA.id);
    const b = leagueTotal(historyView(src([...past, ...future]), cutoff), LIGA.id);
    expect(b).toEqual(a);
    // el partido de 2025-01 queda fuera de la ventana de 365 días
    expect(a.n).toBe(2);
    const { halfLifeDays, priorN } = LEAGUE_TOTAL_DEFAULTS;
    const w = (d: string) => Math.pow(0.5, (cutoff - Date.parse(d)) / DAY / halfLifeDays);
    const w1 = w('2026-02-01T15:00:00Z');
    const w2 = w('2026-02-08T15:00:00Z');
    expect(a.mean).toBeCloseTo((w1 * 1 + w2 * 5 + priorN * GLOBAL_TOTAL) / (w1 + w2 + priorN), 12);
    // sin historial: la media global
    expect(leagueTotal(historyView(src([]), cutoff), LIGA.id)).toEqual({ mean: GLOBAL_TOTAL, n: 0 });
  });
});

describe('variantes totals en el banco', () => {
  const base = runVariant(BASELINE_VARIANT, data);
  const infos = matchInfos(base.ctx!);
  const days = (['T1', 'T2'] as const).map((w) => busiestDay(infos, w, base.rows)!);

  it('totals-best: el 1X2 no cambia; con línea de goles del mercado y en copas todo queda igual; sin ella cambian los totales', () => {
    const run = runVariant(totalsBest, data, { reuse: base, infos });
    expect(run.rows.size).toBe(base.rows.size);
    let changed = 0;
    let shrunkHigh = 0;
    let high = 0;
    for (const [id, b] of base.rows) {
      const v = run.rows.get(id)!;
      const m = byId.get(id)!;
      for (let k = 0; k < 3; k++) expect(v.p[k]).toBeCloseTo(b.p[k], 12);
      if (m.odds?.totalLine !== undefined || m.compId === COPA.id) {
        expect(v.over25).toBe(b.over25);
        expect(v.btts).toBe(b.btts);
        expect(v.lh).toBe(b.lh);
        expect(v.la).toBe(b.la);
      } else if (Math.abs(v.lh + v.la - (b.lh + b.la)) > 1e-6) {
        changed++;
        if (b.lh + b.la > 3.2) {
          high++;
          if (v.lh + v.la < b.lh + b.la) shrunkHigh++;
        }
      }
      // córners y tarjetas con otra contracción ⇒ cambian (cuando hay dato)
      if (b.corners && v.corners) expect(Number.isFinite(v.corners.exp)).toBe(true);
    }
    expect(changed).toBeGreaterThan(50);
    // los totales altos bajan hacia la media
    expect(high).toBeGreaterThan(0);
    expect(shrunkHigh).toBe(high);
  });

  it('totals-best es exactamente producción (integrada el 22-nov-2026)', () => {
    const prod = runVariant(PRODUCTION_VARIANT, data, { reuse: base, infos });
    const run = runVariant(totalsBest, data, { reuse: base, infos });
    expect(run.rows.size).toBe(prod.rows.size);
    for (const [id, p] of prod.rows) expect(run.rows.get(id)).toEqual(p);
  });

  it('priorN 40 (totals-stats, ahora en producción) solo cambia córners y tarjetas frente a la línea base', () => {
    expect(totalsStats.stats).toEqual({ priorN: 40 });
    const legacy40: ModelVariant = { ...BASELINE_VARIANT, name: 'baseline-prior40', stats: totalsStats.stats };
    const run = runVariant(legacy40, data, { reuse: base, infos });
    let changedCorners = 0;
    for (const [id, b] of base.rows) {
      const v = run.rows.get(id)!;
      expect(v.p).toEqual(b.p);
      expect(v.over25).toBe(b.over25);
      expect(v.lh).toBe(b.lh);
      if (b.corners && v.corners && Math.abs(b.corners.exp - v.corners.exp) > 1e-6) changedCorners++;
    }
    expect(changedCorners).toBeGreaterThan(50);
  });

  it('sin fuga: predicciones idénticas con partidos del futuro envenenados', () => {
    for (const v of [totalsBest, totalsShrink]) {
      const run = runVariant(v, data, { reuse: base, infos });
      const r = leakCheck(v, data, run, days);
      expect(r.days.length).toBeGreaterThan(0);
      expect(r.ok).toBe(true);
    }
  });

  it('todas las variantes totals-* del directorio se cargan con el cargador oficial', async () => {
    const names = listVariants().filter((n) => n.startsWith('totals'));
    expect(names).toEqual(expect.arrayContaining(['totals-best', 'totals-shrink', 'totals-shrink-nocup', 'totals-stats']));
    for (const n of names) {
      const v = await loadVariant(n);
      expect(v.name).toBe(n);
    }
  });
});
