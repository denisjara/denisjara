/**
 * Regresión (26-nov-2026): las predicciones walk-forward de un partido TERMINADO (λ/xG publicados, 1X2, mercados y el
 * mapa ctx.wf del backtest) no pueden depender de partidos posteriores a su inicio, en NINGUNA competición.
 *
 * La revisión adversarial de la integración de factores encontró que, en un mundo sintético, añadir cualquier partido
 * terminado después del inicio movía ~0,2 % el λ walk-forward de partidos anteriores (y con él las props de gol y
 * asistencia), también con BASELINE_VARIANT. Causa: si antes del inicio de la temporada de la competición había menos de
 * PRESEASON_MIN_SAMPLES partidos, wfContext caía en los parámetros de empate del Elo, el modelo Elo→goles y las medias de
 * goles AJUSTADOS A LA FECHA DEL BUILD (con todos los partidos, también los posteriores). Lo mismo pasaba con los
 * partidos terminados de temporadas pasadas (sin parámetros de pretemporada). La comprobación de fuga del banco no lo
 * veía: con los datos reales todas las competiciones tienen >= 300 partidos previos.
 *
 * Mundo: el sintético de dos ligas + continental + copa, con la segunda vuelta de cada liga como temporada actual (la
 * liga A tiene < 300 partidos antes de su corte; la continental, >= 300). El camino es el del build: createContext →
 * computeWalkForward → buildMatchFile.
 *
 * Fuera de esta prueba: las proyecciones de córners/tarjetas/tiros/faltas de un partido de COPA sí cambian si un
 * partido posterior mete un equipo nuevo en la copa (statContext reúne el historial de competitionTeams, que incluye
 * los equipos de partidos posteriores). Es otro canal (no toca λ) y queda anotado en el informe de la revisión.
 */
import { describe, expect, it } from 'vitest';
import type { CompetitionStore, MatchRecord } from '../../pipeline/types';
import type { MatchFile } from '../../src/types/data';
import { PRESEASON_MIN_SAMPLES, baseContext, computeWalkForward, createContext, type BuildContext } from '../../pipeline/publish/context';
import { buildMatchFile } from '../../pipeline/publish/matches';
import { SYN_CONFIG_MAP, SYN_CONFIGS, TEAMS_A, TEAMS_B, TEAMS_LOW, scheduled, syntheticWorld } from './synthetic';

const DAY = 86_400_000;

/** Mundo sintético visto el día después de su último partido; temporada actual = tras el mayor hueco de la liga A. */
function world(): { stores: CompetitionStore[]; now: Date } {
  const w = syntheticWorld(11);
  const ta = w.stores
    .find((s) => s.compId === 'liga-a')!
    .matches.map((m) => Date.parse(m.date))
    .sort((a, b) => a - b);
  let gap = 0;
  let split = 0;
  for (let i = 1; i < ta.length; i++) if (ta[i] - ta[i - 1] > gap) [gap, split] = [ta[i] - ta[i - 1], ta[i]];
  for (const s of w.stores) {
    for (const m of s.matches) {
      m.currentSeason = Date.parse(m.date) >= split;
      m.season = m.currentSeason ? 2026 : 2025;
    }
  }
  const now = new Date(w.refDate);
  // partidos por jugar (usan todos los datos terminados: modelos a la fecha del build)
  const A = TEAMS_A.map((t) => t.ref);
  const la = w.stores.find((s) => s.compId === 'liga-a')!;
  la.matches.push(scheduled('liga-a', new Date(now.getTime() + DAY).toISOString(), A[0], A[1], { id: 'up-a01' }));
  return { stores: w.stores, now };
}

/** Partidos terminados POSTERIORES a `t` (a partir de t + 1 h) en todas las competiciones, con marcadores extremos. */
function poison(stores: CompetitionStore[], t: number): CompetitionStore[] {
  const A = TEAMS_A.map((x) => x.ref);
  const B = TEAMS_B.map((x) => x.ref);
  const L = TEAMS_LOW.map((x) => x.ref);
  const mk = (compId: string, k: number, home: MatchRecord['home'], away: MatchRecord['away'], hg: number, ag: number): MatchRecord => ({
    id: `V${compId}${k}`,
    compId,
    season: 2026,
    currentSeason: true,
    date: new Date(t + 3_600_000 + k * 6 * 3_600_000).toISOString(),
    status: 'finished',
    home,
    away,
    score: { home: hg, away: ag },
    stats: { home: { goals: hg, shots: 30, corners: 15, yellow: 6 }, away: { goals: ag, shots: 2, corners: 0, yellow: 6 } },
  });
  const extra: MatchRecord[] = [
    mk('liga-a', 0, A[9], A[0], 6, 0),
    mk('liga-a', 1, A[8], A[1], 0, 0),
    mk('liga-b', 2, B[7], B[0], 5, 0),
    mk('euro', 3, B[7], A[0], 7, 0),
    mk('copa', 4, L[0], A[2], 4, 4),
    mk('liga-a', 5, A[0], A[9], 0, 8),
    mk('liga-b', 6, B[0], B[1], 0, 0),
  ];
  return stores.map((s) => ({ ...s, matches: [...s.matches, ...extra.filter((m) => m.compId === s.compId)] }));
}

function build(stores: CompetitionStore[], now: Date): BuildContext {
  const ctx = createContext({ stores, configs: SYN_CONFIGS, now, fast: true });
  computeWalkForward(ctx);
  return ctx;
}

/** Mercados de estadísticas (proyecciones de córners, tarjetas...): no dependen de λ (ver la nota de cabecera). */
const STAT_MARKET = /^(corners|cards|shots|sot|fouls|offsides)-/;

/** Lo que publica la ficha de un partido terminado y depende del modelo de goles (λ, 1X2, mercados de goles, xG). */
function goalPart(f: MatchFile) {
  const { explanation, ...model } = f.model;
  const { expCorners: _c, expCards: _k, ...quick } = f.match.prediction ?? ({} as NonNullable<MatchFile['match']['prediction']>);
  return {
    model,
    explanation: explanation.filter((x) => !x.startsWith('Estadísticas proyectadas')),
    markets: f.markets.filter((m) => !STAT_MARKET.test(m.id)),
    quick,
  };
}

const { stores, now } = world();
const clean = build(stores, now);
const finished = clean.allMatches.filter((m) => m.status === 'finished' && m.score);
const current = finished.filter((m) => m.currentSeason);
const curOf = (compId: string) => current.filter((m) => m.compId === compId);
/**
 * Cortes del veneno (el veneno empieza 1 h después): a 2/3 de la temporada actual de la liga A (ligas a mitad de
 * temporada) y a mitad de la continental (que empieza cuando las ligas ya han terminado).
 */
const CUTS: [string, number, string[]][] = [
  ['liga A a 2/3', Date.parse(curOf('liga-a')[Math.floor((curOf('liga-a').length * 2) / 3)].date), ['liga-a', 'liga-b', 'copa']],
  ['continental a mitad', Date.parse(curOf('euro')[Math.floor(curOf('euro').length / 2)].date), ['liga-a', 'liga-b', 'copa', 'euro']],
];

it('el mundo ejercita los dos caminos: corte con menos y con más de PRESEASON_MIN_SAMPLES partidos previos', () => {
  expect(clean.preSeason.get('liga-a')?.samples ?? 0).toBeLessThan(PRESEASON_MIN_SAMPLES);
  expect(clean.preSeason.get('euro')?.samples ?? 0).toBeGreaterThanOrEqual(PRESEASON_MIN_SAMPLES);
});

describe.each(CUTS)('walk-forward de partidos terminados: nada posterior a su inicio (veneno tras %s)', (_name, cut, comps) => {
  const poisoned = build(poison(stores, cut), now);
  // objetivos con ficha: el último partido terminado de cada competición antes del corte (temporada actual) y el último
  // de la temporada pasada de la liga A (sin parámetros de pretemporada)
  const upTo = (xs: MatchRecord[]) => xs.filter((m) => Date.parse(m.date) <= cut);
  const lastOf = (xs: MatchRecord[]) => xs[xs.length - 1];
  const targets = [
    ...comps.map((c) => lastOf(upTo(curOf(c)))),
    lastOf(upTo(finished.filter((m) => !m.currentSeason && m.compId === 'liga-a'))),
  ];

  it('el veneno cambia los modelos a la fecha del build (si no, la prueba no demostraría nada)', () => {
    for (const m of targets) expect(m, comps.join(',')).toBeDefined();
    expect(poisoned.suite.eloBuild.drawParams).not.toEqual(clean.suite.eloBuild.drawParams);
    expect(poisoned.suite.eloGoal.a).not.toBe(clean.suite.eloGoal.a);
  });

  it('las predicciones walk-forward (backtest y xG) de todos los partidos anteriores al veneno no cambian', () => {
    let n = 0;
    for (const m of current) {
      if (!(Date.parse(m.date) <= cut)) continue;
      const a = clean.wf.get(m.id);
      expect(a, m.id).toBeDefined();
      expect(poisoned.wf.get(m.id), `${m.compId} ${m.id}`).toEqual(a);
      expect(poisoned.xg.get(m.id), `${m.compId} ${m.id}`).toEqual(clean.xg.get(m.id));
      n++;
    }
    expect(n).toBeGreaterThan(30);
  });

  it('ficha de un partido terminado (λ, 1X2, mercados, xG): igual con partidos posteriores en cualquier competición', () => {
    for (const m of targets) {
      const a = goalPart(buildMatchFile(clean, clean.matchById.get(m.id)!));
      const b = goalPart(buildMatchFile(poisoned, poisoned.matchById.get(m.id)!));
      expect(b, `${m.compId} ${m.id} (${m.currentSeason ? 'actual' : 'pasada'})`).toEqual(a);
    }
  });

  it('partido por jugar: sigue usando los modelos a la fecha del build (todos los partidos terminados)', () => {
    const comp = SYN_CONFIG_MAP.get('liga-a')!;
    const b = baseContext(poisoned, comp);
    expect(b.drawParams).toBe(poisoned.suite.eloBuild.drawParams);
    expect(b.eloGoal).toBe(poisoned.suite.eloGoal);
    expect(b.leagueAvgGoals).toBe(poisoned.suite.leagueAvgGoals);
    // y por tanto el veneno (pasado para él) sí cambia su predicción
    const up = (ctx: BuildContext) => buildMatchFile(ctx, ctx.matchById.get('up-a01')!).model;
    expect(up(poisoned).lambdaHome).not.toBeCloseTo(up(clean).lambdaHome, 6);
  });
});
