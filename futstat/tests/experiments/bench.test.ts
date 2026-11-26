/**
 * Banco de pruebas de modelos (pipeline/experiments): la variante vacía («production», y una con TODOS los ganchos en
 * los valores de producción) da exactamente las predicciones de producción; «baseline» es la producción anterior al
 * 22-nov-2026 (mismo 1X2; sin contracción del total ni priorN 40); el combinador solo ve filas anteriores a cada
 * reajuste; la comprobación de fuga (partidos «del futuro» envenenados) aprueba a producción, a la línea base y a un
 * rasgo legítimo y detecta un gancho que mira el futuro; el holdout no se muestra sin --final.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitDixonColes, goalMultiplier, mulberry32, sampleNegBin, samplePoisson, type DCMatch } from '../../src/lib/models';
import { MODEL, type CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../../pipeline/types';
import { kMultiplierFor } from '../../pipeline/analytics/ratings';
import { predictMatch } from '../../pipeline/analytics/predict';
import { PRIOR_N } from '../../pipeline/analytics/projections';
import { productionTotalFactor } from '../../pipeline/analytics/totals';
import { refereeMultipliers } from '../../pipeline/analytics/referee';
import { productionPlayerAdjust } from '../../pipeline/analytics/playerFactors';
import { computeWalkForward, createContext, refitBoundaries, wfContext } from '../../pipeline/publish/context';
import {
  bootstrapByDay,
  busiestDay,
  compare,
  leakCheck,
  matchInfos,
  runVariant,
  type EvalData,
} from '../../pipeline/experiments/bench';
import { historyView } from '../../pipeline/experiments/history';
import { checkVariantSource, loadVariant, validateVariant } from '../../pipeline/experiments/load';
import { BASELINE_2211_VARIANT, BASELINE_VARIANT, PRODUCTION_VARIANT, isEmptyVariant, preMatchView, type ModelVariant, type StatPairs, type WalkForwardRow } from '../../pipeline/experiments/types';
import example from '../../pipeline/experiments/example';
import { HOLDOUT_LOG, main as evalMain } from '../../scripts/eval-model';

const DAY = 86_400_000;

const LIGA: CompetitionConfig = { id: 'liga-x', slug: 'synx.1', name: 'Liga X', shortName: 'Liga X', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 8 };
const COPA: CompetitionConfig = { id: 'copa-x', slug: 'synx.copa', name: 'Copa X', shortName: 'Copa X', country: 'Sintetia', flag: '🏳️', kind: 'cup', tier: 5 };
const CONFIGS = [LIGA, COPA];

/**
 * Liga de 12 equipos (una jornada el sábado desde 2025-01 hasta 2026-10, temporada actual desde 2026-06-01, cuotas
 * de cierre en la mitad de los partidos, 6 árbitros) y una copa entre equipos de la liga los miércoles de la
 * temporada actual. Líneas de jugador (13 por equipo: 11 titulares y 2 suplentes) desde 2026-03-01; el jugador 0 de
 * cada equipo se pierde un partido de cada 5 (habitual que falta). La copa va PRIMERO en los stores: el walk-forward
 * la procesa antes que la liga (orden no cronológico entre competiciones, el caso en que un estado global de una
 * variante filtraría el futuro).
 */
function benchWorld(seed = 5): CompetitionStore[] {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: `X${i}`, name: `Equipo ${i}`, short: `Eq${i}`, abbr: `E${i}`, att: 1.45 - 0.07 * i, def: 0.7 + 0.06 * i }));
  const ref = (t: (typeof teams)[number]) => ({ id: t.id, name: t.name, short: t.short, abbr: t.abbr });
  const lines: Record<string, PlayerLine[]> = { [LIGA.id]: [], [COPA.id]: [] };
  const games = new Map<string, number>();
  const linesOf = (m: MatchRecord, side: 'home' | 'away', goals: number) => {
    const team = m[side];
    const opp = side === 'home' ? m.away : m.home;
    const n = (games.get(team.id) ?? 0) + 1;
    games.set(team.id, n);
    for (let k = 0; k < 13; k++) {
      if (k === 0 && n % 5 === 0) continue; // el habitual falta
      const sub = k >= 11;
      const pos = k === 0 ? 'G' : k < 5 ? 'D' : k < 9 ? 'M' : 'F';
      const shots = pos === 'G' ? 0 : samplePoisson(pos === 'F' ? 2.2 : 0.8, rng);
      lines[m.compId].push({
        matchId: m.id,
        compId: m.compId,
        date: m.date,
        teamId: team.id,
        opponentId: opp.id,
        isHome: side === 'home',
        playerId: `${team.id}p${k}`,
        name: `Jugador ${k} ${team.id}`,
        short: `J${k}`,
        position: pos,
        starter: !sub,
        minutes: sub ? 30 : 90,
        goals: pos === 'F' && goals > 0 && k === 9 + (n % 2) ? goals : 0,
        assists: 0,
        shots,
        shotsOnTarget: Math.min(shots, samplePoisson(0.4, rng)),
        yellow: rng() < 0.12 ? 1 : 0,
        red: 0,
        foulsCommitted: samplePoisson(1, rng),
        foulsSuffered: samplePoisson(1, rng),
        offsides: 0,
        ownGoals: 0,
      });
    }
  };
  let id = 7000;
  const play = (compId: string, date: number, h: (typeof teams)[number], a: (typeof teams)[number], withOdds: boolean): MatchRecord => {
    const lh = 1.2 * h.att * a.def * 1.2;
    const la = 1.2 * a.att * h.def;
    const hg = samplePoisson(lh, rng);
    const ag = samplePoisson(la, rng);
    const m: MatchRecord = {
      id: String(id++),
      compId,
      season: new Date(date).getUTCFullYear(),
      currentSeason: date >= Date.UTC(2026, 5, 1),
      date: new Date(date).toISOString(),
      status: 'finished',
      home: ref(h),
      away: ref(a),
      score: { home: hg, away: ag },
      stats: {
        home: { goals: hg, corners: sampleNegBin(5.4, 12, rng), yellow: samplePoisson(1.9, rng) + 1, red: 0, shots: sampleNegBin(13, 20, rng), shotsOnTarget: 4, fouls: sampleNegBin(12, 20, rng) },
        away: { goals: ag, corners: sampleNegBin(4.4, 12, rng), yellow: samplePoisson(2.2, rng), red: 0, shots: sampleNegBin(11, 20, rng), shotsOnTarget: 3, fouls: sampleNegBin(12, 20, rng) },
      },
      referee: { id: `R${id % 6}`, name: `Árbitro ${id % 6}` },
    };
    if (date >= Date.UTC(2026, 2, 1)) {
      linesOf(m, 'home', hg);
      linesOf(m, 'away', ag);
    }
    if (withOdds) {
      // cuotas con margen ~5 % alrededor de una probabilidad aproximada
      const ph = Math.min(0.8, Math.max(0.1, 0.45 + 0.25 * (lh - la)));
      const pd = 0.26;
      const pa = Math.max(0.05, 1 - ph - pd);
      m.odds = { provider: 'Sintética', home: 1 / (ph * 1.05), draw: 1 / (pd * 1.05), away: 1 / (pa * 1.05), totalLine: 2.5, over: 1.9, under: 1.9 };
    }
    return m;
  };
  const league: MatchRecord[] = [];
  const cup: MatchRecord[] = [];
  const start = Date.UTC(2025, 0, 4, 15);
  const end = Date.UTC(2026, 9, 25);
  let w = 0;
  for (let t = start; t < end; t += 7 * DAY, w++) {
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let k = 0; k < 6; k++) league.push(play(LIGA.id, t + k * 3_600_000, order[2 * k], order[2 * k + 1], (w + k) % 2 === 0));
    if (t >= Date.UTC(2026, 5, 1) && w % 2 === 0) {
      for (let k = 0; k < 2; k++) cup.push(play(COPA.id, t + 4 * DAY + k * 3_600_000, order[4 * k + 1], order[4 * k + 2], false));
    }
  }
  return [
    { compId: COPA.id, slug: COPA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: cup, players: lines[COPA.id], standings: [] },
    { compId: LIGA.id, slug: LIGA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: league, players: lines[LIGA.id], standings: [] },
  ];
}

const stores = benchWorld();
const data: EvalData = { stores, configs: CONFIGS, now: new Date('2026-11-01T00:00:00Z'), fingerprint: 'test' };

/** Todos los ganchos activos con los valores de producción: debe dar EXACTAMENTE producción. */
const identity: ModelVariant = {
  name: 'identidad',
  description: 'todos los ganchos con los valores de producción',
  dc: { xi: MODEL.dcXi, windowDays: MODEL.dcWindowDays, priorWeight: 2, fitGoals: (m) => ({ hg: m.score!.home, ag: m.score!.away }), weight: () => 1 },
  elo: { k: MODEL.eloK, homeAdv: MODEL.eloHomeAdv, tierOffset: MODEL.eloTierOffset, kMultiplier: (_m, c) => kMultiplierFor(c?.kind), goalMultiplier },
  eloProbs: { homeAdv: MODEL.eloProbHomeAdv },
  features: (_c, m, before) => ({ prev: before.teamMatches(m.home.id).length }),
  lambdaAdjust: ({ lambdaHome, lambdaAway }) => ({ lambdaHome, lambdaAway }),
  combine: { prepare: () => {}, blend: (r) => r.production },
  // el factor de producción del total, reproducido con lo que recibe el gancho
  totals: {
    adjustTotal: ({ ctx, match, lambdaHome, lambdaAway }) =>
      productionTotalFactor({ hasMarketTotal: ctx.market?.over25 !== undefined, kind: ctx.comp.kind, compId: match.compId, before: ctx.history, lambdaHome, lambdaAway }),
  },
  // multiplicadores 1 en todas las estadísticas proyectadas salvo el árbitro de producción (tarjetas y faltas)
  stats: {
    priorN: PRIOR_N,
    halfLifeDays: 150,
    dispersion: 'pooled',
    leaguePriorN: 20,
    adjust: ({ base, match, history }) => ({
      ...(Object.fromEntries(Object.keys(base).map((k) => [k, { home: 1, away: 1 }])) as StatPairs),
      ...refereeMultipliers(match, history, base, MODEL.referee),
    }),
  },
  // los ajustes de producción de las props (bajas probables y factores del rival 6/40), reproducidos con el gancho
  players: { adjust: ({ match, teamId, side, history, base }) => ({ cardsFactor: base.cardsFactor, ...productionPlayerAdjust({ match, teamId, side, history, base }) }) },
};

describe('variante vacía = producción', () => {
  const prod = createContext({ stores, configs: CONFIGS, now: data.now });
  computeWalkForward(prod);
  const base = runVariant(PRODUCTION_VARIANT, data);

  it('el walk-forward del banco (variante vacía) es el del build; además predice las temporadas pasadas desde prev', () => {
    expect(prod.wf.size).toBeGreaterThan(120);
    for (const [id, wf] of prod.wf) {
      const r = base.rows.get(id)!;
      expect(r.p).toEqual([wf.p.home, wf.p.draw, wf.p.away]);
      expect([r.over25, r.btts, r.lh, r.la]).toEqual([wf.over25, wf.btts, wf.lambdaHome, wf.lambdaAway]);
    }
    // el build nunca predice temporadas pasadas; el banco sí (2026-01-01 → inicio de la actual), y solo esas de más
    const extra = [...base.rows.keys()].filter((id) => !prod.wf.has(id)).map((id) => prod.matchById.get(id)!);
    expect(extra.length).toBeGreaterThan(100);
    for (const m of extra) {
      expect(m.currentSeason).toBe(false);
      expect(m.date >= '2026-01-01').toBe(true);
    }
    expect(prod.allMatches.some((m) => !m.currentSeason && !prod.wf.has(m.id))).toBe(true);
  });

  it('ventana prev: solo partidos de temporadas pasadas, sin tocar las demás; faltas, tiros, líneas por equipo y props', () => {
    const infos = matchInfos(base.ctx!);
    const prev = compare(base, base, infos, 'prev', data);
    expect(prev.n).toBeGreaterThan(100);
    expect(prev.composition).toEqual({ [LIGA.id]: prev.n });
    const tuning = compare(base, base, infos, 'tuning', data);
    const pre = compare(base, base, infos, 'pre', data);
    expect(pre.n).toBe(0); // en este mundo no hay partidos de la temporada actual antes de junio
    for (const k of ['fouls', 'shots', 'sot', 'teamGoals', 'teamCards', 'teamCorners', 'pScorer', 'pCard', 'pSot1', 'pShots2'] as const) {
      expect(tuning.ci[k]?.diff).toBe(0);
    }
    expect(tuning.model.fouls!.n).toBe(tuning.n);
    expect(tuning.playerSets!.common).toBeGreaterThan(1000);
    expect(tuning.playerSets!.onlyBaseline + tuning.playerSets!.onlyVariant).toBe(0);
    const segs = Object.fromEntries(tuning.segments.map((x) => [x.id, x.n]));
    expect(segs['arbitro-conocido']).toBe(tuning.n);
    expect(segs['falta-habitual']).toBeGreaterThan(10);
    expect(segs['falta-habitual']).toBeLessThan(tuning.n);
    expect(segs['final-de-liga']).toBe(0); // la temporada actual de la liga sigue hasta el final de los datos
    expect(segs.vuelta).toBe(0);
  });

  it('una variante con TODOS los ganchos en los valores de producción da exactamente las mismas predicciones', () => {
    const run = runVariant(identity, data);
    expect(run.rows.size).toBe(base.rows.size);
    let withProps = 0;
    for (const [id, b] of base.rows) {
      expect(run.rows.get(id)).toEqual(b);
      if (b.pl?.length && b.fouls && b.cards?.home) withProps++;
    }
    expect(withProps).toBeGreaterThan(100);
    expect(isEmptyVariant({ name: 'x', description: 'y', players: {} })).toBe(false);
  });

  it('predictMatch con la variante vacía en el contexto es idéntico a producción', () => {
    const withVariant = createContext({ stores, configs: CONFIGS, now: data.now, variant: { name: 'vacia', description: 'sin ganchos' } });
    computeWalkForward(withVariant);
    const m = prod.allMatches.filter((x) => x.currentSeason && x.status === 'finished')[40];
    expect(predictMatch(m, wfContext(withVariant, m))).toEqual(predictMatch(m, wfContext(prod, m)));
  });

  it('compare() de la base consigo misma: diferencias e intervalos nulos', () => {
    const infos = matchInfos(base.ctx!);
    const r = compare(base, base, infos, 'tuning', data);
    expect(r.n).toBeGreaterThan(100);
    expect(r.model).toEqual(r.baseline);
    expect([r.ci.rps.diff, r.ci.rps.lo, r.ci.rps.hi]).toEqual([0, 0, 0]);
    const t1 = compare(base, base, infos, 'T1', data);
    const t2 = compare(base, base, infos, 'T2', data);
    expect(t1.n + t2.n).toBe(r.n);
  });

  it('baseline = producción anterior (26-nov-2026): mismo 1X2, goles, córners y tiros; tarjetas y faltas (árbitro) y props distintas', () => {
    const legacy = runVariant(BASELINE_VARIANT, data, { reuse: base });
    let cards = 0;
    let fouls = 0;
    let props = 0;
    let suspended = 0;
    for (const [id, p] of base.rows) {
      const l = legacy.rows.get(id)!;
      expect([p.p, p.ep, p.lh, p.la, p.over25, p.btts]).toEqual([l.p, l.ep, l.lh, l.la, l.over25, l.btts]);
      expect([p.corners, p.shots, p.sot]).toEqual([l.corners, l.shots, l.sot]);
      if (p.cards && l.cards && Math.abs(p.cards.exp - l.cards.exp) > 1e-6) cards++;
      if (p.fouls && l.fouls && Math.abs(p.fouls.exp - l.fouls.exp) > 1e-6) fouls++;
      if (p.pl && l.pl && JSON.stringify(p.pl) !== JSON.stringify(l.pl)) props++;
      // el habitual que falta (jugador 0) puede tener menos minutos, pero ningún publicado desaparece salvo sancionados
      if (l.pl && p.pl) suspended += l.pl.filter((x) => !p.pl!.some((y) => y.id === x.id && y.s === x.s)).length;
    }
    expect(cards).toBeGreaterThan(50);
    expect(fouls).toBeGreaterThan(50);
    expect(props).toBeGreaterThan(50);
    expect(suspended).toBe(0); // en este mundo nadie ve roja
  });

  it('la producción anterior al 22-nov-2026 (BASELINE_2211_VARIANT): mismo 1X2; total contraído solo sin línea de goles y fuera de copas', () => {
    const legacy = runVariant(BASELINE_2211_VARIANT, data, { reuse: base });
    const byId = new Map(prod.allMatches.map((m) => [m.id, m]));
    let shrunk = 0;
    let corners = 0;
    for (const [id, p] of base.rows) {
      const l = legacy.rows.get(id)!;
      const m = byId.get(id)!;
      for (let k = 0; k < 3; k++) expect(p.p[k]).toBeCloseTo(l.p[k], 12);
      expect(p.ep).toEqual(l.ep);
      if (m.odds?.totalLine !== undefined || m.compId === COPA.id) {
        expect([p.lh, p.la, p.over25]).toEqual([l.lh, l.la, l.over25]);
      } else if (Math.abs(p.lh + p.la - (l.lh + l.la)) > 1e-6) shrunk++;
      if (p.corners && l.corners && Math.abs(p.corners.exp - l.corners.exp) > 1e-6) corners++;
    }
    expect(shrunk).toBeGreaterThan(50);
    expect(corners).toBeGreaterThan(50);
  });

  it('producción (variante vacía) = factors-combo: mismas predicciones y mismas cifras del banco frente a la base', async () => {
    const combo = await loadVariant('factors-combo');
    const legacy = runVariant(BASELINE_VARIANT, data, { reuse: base });
    const run = runVariant(combo, data, { reuse: legacy });
    const prodRun = runVariant(PRODUCTION_VARIANT, data, { reuse: legacy });
    expect(run.rows.size).toBe(prodRun.rows.size);
    for (const [id, p] of prodRun.rows) expect(run.rows.get(id)).toEqual(p);
    const infos = matchInfos(base.ctx!);
    for (const w of ['tuning', 'prev'] as const) {
      const a = compare(legacy, prodRun, infos, w, data);
      const b = compare(legacy, run, infos, w, data);
      const strip = (r: typeof a) => ({ ...r, variant: '', description: '', generatedAt: '', seconds: undefined });
      expect(strip(b)).toEqual(strip(a));
      expect(a.n).toBeGreaterThan(100);
    }
    const t = compare(legacy, prodRun, infos, 'tuning', data);
    expect(t.ci.cards!.diff).not.toBe(0);
    expect(t.ci.pSot1!.diff).not.toBe(0);
  });
});

describe('ganchos', () => {
  it('lambdaAdjust y adjustTotal cambian las predicciones en el sentido esperado', () => {
    const base = runVariant(BASELINE_VARIANT, data);
    const more: ModelVariant = { name: 'mas-goles', description: '+20 % de goles', totals: { adjustTotal: () => 1.2 } };
    const run = runVariant(more, data, { reuse: base });
    let higher = 0;
    for (const [id, b] of base.rows) if (run.rows.get(id)!.over25 > b.over25) higher++;
    expect(higher).toBe(base.rows.size);
  });

  it('el combinador solo recibe filas estrictamente anteriores a cada reajuste y su ensamble es el publicado', () => {
    const calls: { asOf: string; n: number; maxDate: number }[] = [];
    const learned: ModelVariant = {
      name: 'combinador',
      description: 'media de las fuentes con el empate observado',
      combine: {
        prepare(rows: readonly WalkForwardRow[], asOf: string) {
          calls.push({ asOf, n: rows.length, maxDate: rows.reduce((t, r) => Math.max(t, Date.parse(r.date)), 0) });
        },
        blend: (r) => ({ home: (r.elo.home + r.goal.home) / 2, draw: (r.elo.draw + r.goal.draw) / 2, away: (r.elo.away + r.goal.away) / 2 }),
      },
    };
    const ctx = createContext({ stores, configs: CONFIGS, now: data.now, variant: learned });
    computeWalkForward(ctx);
    expect(calls.length).toBeGreaterThanOrEqual(6); // junio..octubre + final
    for (const c of calls) expect(c.maxDate).toBeLessThan(Date.parse(c.asOf));
    expect(calls[0].n).toBe(0);
    expect(calls[calls.length - 1].asOf).toBe(data.now.toISOString());
    // la ficha de un partido terminado usa el ensamble del walk-forward (no el del reajuste final)
    const m = ctx.allMatches.filter((x) => x.currentSeason && x.status === 'finished')[10];
    const wf = ctx.wf.get(m.id)!;
    expect(predictMatch(m, wfContext(ctx, m)).quick.p.home).toBeCloseTo(wf.p.home, 4);
  });

  it('stats.adjust: los multiplicadores cambian las proyecciones (nunca reutiliza las de la base) y llegan a las props de tarjeta', () => {
    // base: producción sin el árbitro (el gancho de la variante SUSTITUYE al de producción)
    const base = runVariant({ name: 'sin-arbitro', description: 'producción sin árbitro', stats: { adjust: () => ({}) } }, data);
    const cards: ModelVariant = { name: 'mas-tarjetas', description: '+30 % de tarjetas', stats: { adjust: () => ({ cards: { home: 1.3, away: 1.3 } }) } };
    const run = runVariant(cards, data, { reuse: base });
    let n = 0;
    let props = 0;
    for (const [id, b] of base.rows) {
      const v = run.rows.get(id)!;
      if (!b.cards) continue;
      n++;
      expect(v.cards!.exp).toBeGreaterThan(b.cards.exp * 1.25);
      expect(v.corners).toEqual(b.corners);
      for (const p of v.pl ?? []) {
        const q = b.pl!.find((x) => x.id === p.id)!;
        expect(p.g).toBe(q.g);
        if (p.c > q.c) props++;
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(props).toBeGreaterThan(100);
    const bad: ModelVariant = { name: 'mala', description: 'multiplicador 0', stats: { adjust: () => ({ cards: { home: 0, away: 1 } }) } };
    expect(() => runVariant(bad, data, { reuse: base })).toThrow(/stats.adjust/);
  });

  it('players: vida media de las tasas y factor de minutos (bajas) cambian las props publicadas', () => {
    const base = runVariant(PRODUCTION_VARIANT, data);
    const recency = runVariant({ name: 'recencia', description: 'vida media 30 días', players: { rateHalfLifeDays: 30 } }, data, { reuse: base });
    const out: ModelVariant = {
      name: 'bajas',
      description: 'el portero no juega',
      players: { adjust: ({ teamId }) => ({ minutesFactor: { [`${teamId}p0`]: 0 } }) },
    };
    const sinPortero = runVariant(out, data, { reuse: base });
    let changed = 0;
    let rows = 0;
    for (const [id, b] of base.rows) {
      if (!b.pl) continue;
      rows++;
      const r = recency.rows.get(id)!;
      if (r.pl!.some((p, k) => p.g !== b.pl![k]?.g || p.c !== b.pl![k]?.c)) changed++;
      expect(sinPortero.rows.get(id)!.pl!.some((p) => p.id.endsWith('p0'))).toBe(false);
      expect([r.lh, r.p]).toEqual([b.lh, b.p]);
    }
    expect(rows).toBeGreaterThan(100);
    expect(changed).toBeGreaterThan(rows / 2);
  });

  it('HistoryView: líneas de jugador y partidos del árbitro estrictamente anteriores al corte, cronológicos', () => {
    const ctx = createContext({ stores, configs: CONFIGS, now: data.now });
    const cut = Date.parse('2026-07-01T00:00:00Z');
    const v = historyView(ctx.history, cut);
    const ls = v.playerLines('X3');
    expect(ls.length).toBeGreaterThan(100);
    expect(ls.every((l) => Date.parse(l.date) < cut && l.teamId === 'X3')).toBe(true);
    for (let k = 1; k < ls.length; k++) expect(Date.parse(ls[k].date)).toBeGreaterThanOrEqual(Date.parse(ls[k - 1].date));
    const rm = v.refereeMatches('R1');
    expect(rm.length).toBeGreaterThan(20);
    expect(rm.every((m) => m.referee?.id === 'R1' && m.status === 'finished' && Date.parse(m.date) < cut)).toBe(true);
    expect(v.refereeMatches('nadie')).toEqual([]);
    // la vista pre-partido conserva el árbitro y quita la contabilidad de su descarga
    const pm = preMatchView({ ...rm[0], refereeChecks: 2, refereeRetryAt: '2026-01-01T00:00:00Z' });
    expect(pm.referee).toEqual(rm[0].referee);
    expect('refereeChecks' in pm || 'refereeRetryAt' in pm).toBe(false);
  });

  it('refitBoundaries: día 1 de cada mes o cada N días', () => {
    const b = refitBoundaries(Date.parse('2026-06-03T10:00:00Z'), Date.parse('2026-08-02T00:00:00Z'));
    expect(b.map((t) => new Date(t).toISOString().slice(0, 10))).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    expect(refitBoundaries(0, 20 * DAY, 7)).toEqual([0, 7 * DAY, 14 * DAY]);
  });

  it('preMatchView quita el resultado, las estadísticas, los eventos y la forma', () => {
    const m = stores[1].matches.at(-1)!;
    const p = preMatchView({ ...m, homeForm: 'WWW', events: [] });
    expect(p.status).toBe('scheduled');
    for (const k of ['score', 'stats', 'events', 'homeForm', 'awayForm']) expect(k in p).toBe(false);
    expect(p.odds).toEqual(m.odds);
  });

  it('Dixon-Coles con goles ajustados (no enteros) y marcador real para τ', () => {
    const ms: DCMatch[] = stores[1].matches.slice(0, 300).map((m) => ({ home: m.home.id, away: m.away.id, hg: m.score!.home, ag: m.score!.away, date: m.date }));
    const ref = '2025-12-01T00:00:00Z';
    const a = fitDixonColes(ms, { refDate: ref, xi: 0.002 });
    const same = fitDixonColes(ms.map((m) => ({ ...m, rawHg: m.hg, rawAg: m.ag })), { refDate: ref, xi: 0.002 });
    expect(same).toEqual(a);
    const adj = fitDixonColes(ms.map((m) => ({ ...m, hg: 0.5 * m.hg + 0.6, ag: 0.5 * m.ag + 0.5, rawHg: m.hg, rawAg: m.ag })), { refDate: ref, xi: 0.002 });
    expect(adj.nMatches).toBe(300);
    expect(Number.isFinite(adj.base) && Number.isFinite(adj.rho)).toBe(true);
    // sin marcador real, los goles no enteros se siguen descartando (comportamiento original)
    expect(fitDixonColes(ms.map((m) => ({ ...m, hg: m.hg + 0.5 })), { refDate: ref, xi: 0.002 }).nMatches).toBe(0);
  });
});

describe('comprobación de fuga (partidos «del futuro» envenenados)', () => {
  const base = runVariant(PRODUCTION_VARIANT, data);
  const infos = matchInfos(base.ctx!);
  const days = (['T1', 'T2'] as const).map((w) => busiestDay(infos, w, base.rows)!);

  it('producción (y la producción anterior) no miran el futuro', () => {
    const r = leakCheck(PRODUCTION_VARIANT, data, base, days);
    expect(r.days.length).toBe(2);
    expect(r.days.every((d) => d.matches > 0)).toBe(true);
    expect(r.ok).toBe(true);
    const legacy = runVariant(BASELINE_VARIANT, data);
    expect(leakCheck(BASELINE_VARIANT, data, legacy, days).ok).toBe(true);
  });

  it('un rasgo legítimo (días de descanso con la vista del pasado) tampoco', () => {
    const run = runVariant(example, data, { reuse: base });
    expect(leakCheck(example, data, run, days).ok).toBe(true);
  });

  it('ganchos legítimos de árbitro (stats.adjust) y de jugadores (players.adjust) pasan, también en un día de prev', () => {
    const referee: ModelVariant = {
      name: 'arbitro',
      description: 'tarjetas según el historial del árbitro',
      stats: {
        adjust: ({ match, history }) => {
          const ms = match.referee ? history.refereeMatches(match.referee.id) : [];
          const avg = ms.length ? ms.reduce((t, m) => t + (m.stats?.home.yellow ?? 0) + (m.stats?.away.yellow ?? 0), 0) / ms.length : 4;
          return { cards: { home: avg / 4, away: avg / 4 } };
        },
      },
      players: {
        rateHalfLifeDays: 60,
        adjust: ({ history, teamId }) => {
          const ls = history.playerLines(teamId);
          const last = ls[ls.length - 1]?.matchId;
          return { minutesFactor: Object.fromEntries(ls.filter((l) => l.matchId === last && l.yellow > 0).map((l) => [l.playerId, 0.9])) };
        },
      },
    };
    const run = runVariant(referee, data, { reuse: base });
    const prevDay = busiestDay(infos, 'prev', base.rows)!;
    const r = leakCheck(referee, data, run, [...days, prevDay]);
    expect(r.days.length).toBe(3);
    expect(r.ok).toBe(true);
  });

  it('un gancho de árbitro o de jugadores con estado global se detecta (el veneno lleva el árbitro y líneas de jugador)', () => {
    const maxSeen = new Map<string, number>();
    const leakyRef: ModelVariant = {
      name: 'tramposa-arbitro',
      description: 'recuerda el máximo de partidos vistos de cada árbitro en CUALQUIER llamada',
      stats: {
        adjust: ({ match, history }) => {
          if (!match.referee) return {};
          const id = match.referee.id;
          maxSeen.set(id, Math.max(maxSeen.get(id) ?? 0, history.refereeMatches(id).length));
          return { cards: { home: 1 + maxSeen.get(id)! / 1000, away: 1 } };
        },
      },
    };
    const run = runVariant(leakyRef, data, { reuse: base });
    maxSeen.clear();
    expect(leakCheck(leakyRef, data, run, days).ok).toBe(false);
    const seen = new Set<string>();
    const leakyPlayers: ModelVariant = {
      name: 'tramposa-jugadores',
      description: 'cuenta las líneas vistas de cada jugador en CUALQUIER llamada (también las de partidos posteriores)',
      players: {
        adjust: ({ history, teamId }) => {
          for (const l of history.playerLines(teamId)) seen.add(`${l.playerId}|${l.matchId}`);
          const count = (pid: string) => [...seen].filter((k) => k.startsWith(`${pid}|`)).length;
          return { minutesFactor: Object.fromEntries(Array.from({ length: 13 }, (_, k) => [`${teamId}p${k}`, 1 - count(`${teamId}p${k}`) / 1000])) };
        },
      },
    };
    const run2 = runVariant(leakyPlayers, data, { reuse: base });
    seen.clear();
    expect(leakCheck(leakyPlayers, data, run2, days).ok).toBe(false);
  });

  it('un gancho que acumula estado global (y así ve partidos posteriores) se detecta', () => {
    const seen = new Map<string, MatchRecord>();
    const leaky: ModelVariant = {
      name: 'tramposa',
      description: 'recuerda el último partido visto de cada equipo en CUALQUIER llamada',
      features(_c, match, before) {
        for (const id of [match.home.id, match.away.id]) {
          const ms = before.teamMatches(id);
          const last = ms[ms.length - 1];
          const prev = seen.get(id);
          if (last && (!prev || Date.parse(last.date) > Date.parse(prev.date))) seen.set(id, last);
        }
        const gd = (id: string) => {
          const m = seen.get(id);
          return m ? (m.home.id === id ? m.score!.home - m.score!.away : m.score!.away - m.score!.home) : 0;
        };
        return { gdHome: gd(match.home.id), gdAway: gd(match.away.id) };
      },
      lambdaAdjust: ({ lambdaHome, lambdaAway, features }) => ({ lambdaHome: lambdaHome * (1 + 0.02 * features.gdHome), lambdaAway: lambdaAway * (1 + 0.02 * features.gdAway) }),
    };
    const run = runVariant(leaky, data, { reuse: base });
    seen.clear();
    const r = leakCheck(leaky, data, run, days);
    expect(r.ok).toBe(false);
    expect(r.days.some((d) => d.maxDiff > 1e-6)).toBe(true);
  });

  it('una variante que lee el data-store o el disco por su cuenta se rechaza al cargarla', () => {
    expect(() => checkVariantSource("import { loadAllStores } from '../store';\nexport default {}", 'x.ts')).toThrow(/data-store/);
    expect(() => checkVariantSource("import fs from 'node:fs';", 'x.ts')).toThrow(/fs/);
    expect(() => checkVariantSource('// leer data-store está prohibido\nexport default {}', 'x.ts')).not.toThrow();
  });
});

describe('carga de variantes y protección del holdout', () => {
  it('carga baseline, production y example; valida la forma', async () => {
    expect((await loadVariant('baseline')).name).toBe('baseline');
    expect(await loadVariant('production')).toBe(PRODUCTION_VARIANT);
    expect((await loadVariant('example')).name).toBe('example');
    await expect(loadVariant('../store')).rejects.toThrow(/no válido/);
    await expect(loadVariant('no-existe-xyz')).rejects.toThrow(/No existe/);
    expect(() => validateVariant({ name: 'a', description: 'b', combine: {} }, 't')).toThrow(/blend/);
    expect(() => validateVariant({ name: 'a', description: 'b', stats: { dispersion: 'rara' } }, 't')).toThrow(/dispersion/);
    expect(() => validateVariant({ name: 'a', description: 'b', eloProbs: { homeAdv: { 'XX-league': 50 } } }, 't')).toThrow(/grupo/);
    expect(validateVariant({ name: 'a', description: 'b', eloProbs: { homeAdv: { 'EU-league': 50 } } }, 't').name).toBe('a');
    expect(() => validateVariant({ name: 'a', description: 'b', stats: { adjust: 3 } }, 't')).toThrow(/stats.adjust/);
    expect(() => validateVariant({ name: 'a', description: 'b', players: { rateHalfLifeDays: -5 } }, 't')).toThrow(/rateHalfLifeDays/);
    expect(() => validateVariant({ name: 'a', description: 'b', players: { adjust: 'x' } }, 't')).toThrow(/players.adjust/);
    expect(validateVariant({ name: 'a', description: 'b', players: { rateHalfLifeDays: 90, adjust: () => ({}) } }, 't').name).toBe('a');
  });

  it('sin --final el holdout se niega y no se registra ninguna mirada', async () => {
    const before = fs.existsSync(HOLDOUT_LOG) ? fs.readFileSync(HOLDOUT_LOG, 'utf8') : undefined;
    expect(await evalMain(['--variant=baseline', '--window=holdout'])).toBe(1);
    expect(await evalMain(['--variant=baseline', '--final', '--window=tuning'])).toBe(1);
    expect(await evalMain(['--variant=baseline', '--final', '--window=prev'])).toBe(1);
    const after = fs.existsSync(HOLDOUT_LOG) ? fs.readFileSync(HOLDOUT_LOG, 'utf8') : undefined;
    expect(after).toBe(before);
  });

  it('bootstrap por día: determinista y con el intervalo alrededor de la media', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ day: `d${i % 30}`, diff: ((i * 7919) % 13) / 100 - 0.05 }));
    const a = bootstrapByDay(items);
    expect(bootstrapByDay(items)).toEqual(a);
    expect(a.lo).toBeLessThanOrEqual(a.diff);
    expect(a.hi).toBeGreaterThanOrEqual(a.diff);
    expect(a.days).toBe(30);
  });
});
