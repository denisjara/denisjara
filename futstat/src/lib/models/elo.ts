/**
 * Rating Elo estilo World Football Elo (eloratings.net) y conversión a probabilidades 1X2.
 */
import type { Prob1X2 } from '../../types/data';

export interface EloOptions {
  k: number;
  homeAdv: number;
  init: number;
}

export interface EloMatch {
  id: string;
  date: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  neutral?: boolean;
  /** rating inicial si el equipo aún no existe */
  initHome?: number;
  initAway?: number;
  /** multiplicador de K (p. ej. finales, competiciones europeas) */
  kMultiplier?: number;
}

/** Multiplicador por diferencia de goles: 1 (0-1), 1.5 (2), (11+gd)/8 (>=3). */
export function goalMultiplier(goalDiff: number): number {
  const gd = Math.abs(goalDiff);
  if (!Number.isFinite(gd) || gd <= 1) return 1;
  if (gd === 2) return 1.5;
  return (11 + gd) / 8;
}

/** Expectativa Elo del local: 1/(1+10^(−diff/400)). */
export function eloExpectation(diff: number): number {
  return 1 / (1 + Math.pow(10, -diff / 400));
}

export class Elo {
  private readonly opts: EloOptions;
  private readonly r = new Map<string, number>();
  private readonly hist = new Map<string, { date: string; elo: number }[]>();

  constructor(opts: EloOptions) {
    this.opts = { ...opts };
  }

  get(team: string): number {
    return this.r.get(team) ?? this.opts.init;
  }

  has(team: string): boolean {
    return this.r.has(team);
  }

  set(team: string, rating: number): void {
    this.r.set(team, rating);
  }

  /** r_local + ventaja local (si no es neutral) − r_visitante. */
  diff(home: string, away: string, neutral = false): number {
    return this.get(home) + (neutral ? 0 : this.opts.homeAdv) - this.get(away);
  }

  update(m: EloMatch): { preHome: number; preAway: number; postHome: number; postAway: number } {
    if (!this.has(m.home) && m.initHome !== undefined && Number.isFinite(m.initHome)) this.set(m.home, m.initHome);
    if (!this.has(m.away) && m.initAway !== undefined && Number.isFinite(m.initAway)) this.set(m.away, m.initAway);
    const preHome = this.get(m.home);
    const preAway = this.get(m.away);
    if (!Number.isFinite(m.hg) || !Number.isFinite(m.ag) || m.home === m.away) {
      return { preHome, preAway, postHome: preHome, postAway: preAway };
    }
    const we = eloExpectation(this.diff(m.home, m.away, m.neutral));
    const w = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    const k = this.opts.k * (m.kMultiplier ?? 1);
    const delta = k * goalMultiplier(m.hg - m.ag) * (w - we);
    const postHome = preHome + delta;
    const postAway = preAway - delta;
    this.r.set(m.home, postHome);
    this.r.set(m.away, postAway);
    this.push(m.home, m.date, postHome);
    this.push(m.away, m.date, postAway);
    return { preHome, preAway, postHome, postAway };
  }

  private push(team: string, date: string, elo: number): void {
    let h = this.hist.get(team);
    if (!h) {
      h = [];
      this.hist.set(team, h);
    }
    h.push({ date, elo });
  }

  /** Evolución del rating tras cada partido (orden de procesado). */
  history(team: string): { date: string; elo: number }[] {
    return [...(this.hist.get(team) ?? [])];
  }

  ratings(): Record<string, number> {
    return Object.fromEntries(this.r);
  }

  teams(): string[] {
    return [...this.r.keys()];
  }
}

export const DEFAULT_DRAW_BASE = 0.27;
export const DEFAULT_DRAW_SCALE = 400;

function probsFrom(we: number, pDraw: number): [number, number, number] {
  let h = we - pDraw / 2;
  let a = 1 - h - pDraw;
  let d = pDraw;
  if (h < 0.01) h = 0.01;
  if (a < 0.01) a = 0.01;
  if (d < 0.01) d = 0.01;
  const s = h + d + a;
  return [h / s, d / s, a / s];
}

/**
 * Probabilidades 1X2 desde la diferencia Elo (incluida la ventaja local):
 * We = 1/(1+10^(−diff/400)); pDraw = drawBase·exp(−(diff/drawScale)²); pHome = We − pDraw/2;
 * pAway = 1 − pHome − pDraw; cada una recortada a >= 0.01 y renormalizada.
 */
export function eloProbs(diff: number, params?: { drawBase?: number; drawScale?: number }): Prob1X2 {
  const drawBase = params?.drawBase ?? DEFAULT_DRAW_BASE;
  const drawScale = params?.drawScale ?? DEFAULT_DRAW_SCALE;
  const d = Number.isFinite(diff) ? diff : 0;
  const pDraw = drawBase * Math.exp(-((d / drawScale) ** 2));
  const [home, draw, away] = probsFrom(eloExpectation(d), pDraw);
  return { home, draw, away };
}

/**
 * Ajusta drawBase/drawScale por máxima verosimilitud en rejilla (gruesa + refinada).
 * outcome: 0 = local, 1 = empate, 2 = visitante.
 */
export function fitEloDrawParams(samples: { diff: number; outcome: 0 | 1 | 2 }[]): { drawBase: number; drawScale: number } {
  const data = samples.filter((s) => Number.isFinite(s.diff) && (s.outcome === 0 || s.outcome === 1 || s.outcome === 2));
  if (data.length === 0) return { drawBase: DEFAULT_DRAW_BASE, drawScale: DEFAULT_DRAW_SCALE };
  // Agrupa por diferencia redondeada a 0.5 puntos (error despreciable): coste ∝ nº de bins, no de muestras.
  const binMap = new Map<number, [number, number, number]>();
  for (const s of data) {
    const key = Math.round(s.diff * 2) / 2;
    let c = binMap.get(key);
    if (!c) {
      c = [0, 0, 0];
      binMap.set(key, c);
    }
    c[s.outcome]++;
  }
  const n = binMap.size;
  const we = new Float64Array(n);
  const d2 = new Float64Array(n);
  const c0 = new Float64Array(n);
  const c1 = new Float64Array(n);
  const c2 = new Float64Array(n);
  let idx = 0;
  for (const [diff, c] of binMap) {
    we[idx] = eloExpectation(diff);
    d2[idx] = diff * diff;
    c0[idx] = c[0];
    c1[idx] = c[1];
    c2[idx] = c[2];
    idx++;
  }
  const e = new Float64Array(n);
  const evalGrid = (bases: number[], scales: number[]) => {
    let best = { drawBase: DEFAULT_DRAW_BASE, drawScale: DEFAULT_DRAW_SCALE, ll: -Infinity };
    for (const s of scales) {
      const inv = 1 / (s * s);
      for (let i = 0; i < n; i++) e[i] = Math.exp(-d2[i] * inv);
      for (const b of bases) {
        let ll = 0;
        for (let i = 0; i < n; i++) {
          // mismo cálculo que probsFrom (inline, sin asignaciones)
          const pd0 = b * e[i];
          let h = we[i] - pd0 / 2;
          let a = 1 - h - pd0;
          let d = pd0;
          if (h < 0.01) h = 0.01;
          if (a < 0.01) a = 0.01;
          if (d < 0.01) d = 0.01;
          const lt = Math.log(h + d + a);
          if (c0[i] > 0) ll += c0[i] * (Math.log(h) - lt);
          if (c1[i] > 0) ll += c1[i] * (Math.log(d) - lt);
          if (c2[i] > 0) ll += c2[i] * (Math.log(a) - lt);
        }
        if (ll > best.ll) best = { drawBase: b, drawScale: s, ll };
      }
    }
    return best;
  };
  const range = (lo: number, hi: number, step: number) => {
    const r: number[] = [];
    for (let x = lo; x <= hi + step / 2; x += step) r.push(Math.round(x * 1e6) / 1e6);
    return r;
  };
  // rejilla gruesa y dos refinamientos sucesivos alrededor del mejor punto
  let best = evalGrid(range(0.1, 0.46, 0.02), range(150, 1500, 50));
  for (const [db, ds, sb, ss] of [
    [0.02, 50, 0.004, 10],
    [0.004, 10, 0.001, 2],
  ]) {
    const cand = evalGrid(
      range(Math.max(0.05, best.drawBase - db), Math.min(0.5, best.drawBase + db), sb),
      range(Math.max(100, best.drawScale - ds), Math.min(2000, best.drawScale + ds), ss),
    );
    if (cand.ll >= best.ll) best = cand;
  }
  return { drawBase: best.drawBase, drawScale: best.drawScale };
}
