/**
 * Rasgos de FORMA DEL EQUIPO (variantes «form-*»), calculados SOLO con la vista del pasado (`HistoryView`: partidos
 * terminados con inicio anterior al del partido) y el Elo justo antes del corte (`eloBefore`). Sin estado: todo se
 * recalcula en cada llamada.
 *
 * (a) Forma de goles (sufijos H = local, A = visitante), sobre los últimos FORM_N partidos del equipo (todas las
 *     competiciones) jugados en los FORM_MAX_DAYS días anteriores; con menos de FORM_MIN partidos, 0:
 *  - gfRes / gaRes    goles a favor / en contra MENOS los esperados antes de cada partido pasado
 *  - xgfRes / xgaRes  xG aproximado por tiros (k·(a puerta + 0,2·fuera), constantes fijadas con 2025 en shots/xg.ts)
 *                     a favor / en contra MENOS los mismos goles esperados (solo partidos con tiros de los dos)
 *  - nForm            partidos de la ventana
 *  Goles esperados de un partido pasado m del equipo T contra O:
 *      s = clamp((Elo_T − Elo_O ± 65·localía) / 250, ±2,5)            (supremacía esperada, goles)
 *      t = total medio de los partidos de T en 365 días (contraído hacia 2,6 con 5 partidos ficticios)
 *      eGF = max(0,15, t/2 + s/2),  eGA = max(0,15, t/2 − s/2)
 *  Elo_T y Elo_O son los ratings JUSTO ANTES DEL CORTE (no los de la fecha de m): `HistoryView` no ofrece el Elo
 *  histórico. Todo es anterior al partido predicho (sin fuga), pero el Elo ya absorbió parte de esos resultados, lo
 *  que atenúa los residuos (sesgo conservador, documentado). Cada media se contrae con n/(n + 2) y se recorta a ±2.
 *
 * (b) Forma estadística (córners, tiros, a puerta, faltas…): cociente entre la media de los últimos partidos y la tasa
 *     de largo plazo del propio equipo (365 días), por lado (a favor / en contra) y normalizado por localía (cada
 *     partido reciente se divide por la media de largo plazo del equipo en esa condición, contraída hacia su media
 *     general con 5 partidos ficticios). Ver `statForm`.
 */
import type { MatchRecord, TeamMatchStats } from '../../types';
import type { StatKey } from '../../analytics/projections';
import { STAT_DEF_BY_KEY } from '../../analytics/projections';
import type { FeatureContext, Features, HistoryView, PreMatch } from '../types';

const DAY_MS = 86_400_000;

export const FORM_N = 6;
export const FORM_MIN = 3;
export const FORM_MAX_DAYS = 75;
const LONG_DAYS = 365;
const ELO_HA = 65;
const ELO_PER_GOAL = 250;
/** xG aproximado por tiros (mismas constantes que shots/xg.ts con r = 0,2, fijadas con datos de 2025). */
const XG_K = 0.2272;
const XG_R = 0.2;

export function xgOf(s: TeamMatchStats | undefined): number | undefined {
  if (!s) return undefined;
  const sh = s.shots;
  const sot = s.shotsOnTarget;
  if (typeof sh !== 'number' || typeof sot !== 'number' || !Number.isFinite(sh) || !Number.isFinite(sot)) return undefined;
  if (sot < 0 || sh < sot || sh > 60) return undefined;
  return XG_K * (sot + XG_R * (sh - sot));
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Perspectiva del equipo en un partido pasado. */
function side(m: MatchRecord, teamId: string) {
  const home = m.home.id === teamId;
  return {
    home,
    oppId: home ? m.away.id : m.home.id,
    gf: home ? m.score!.home : m.score!.away,
    ga: home ? m.score!.away : m.score!.home,
    sFor: home ? m.stats?.home : m.stats?.away,
    sAg: home ? m.stats?.away : m.stats?.home,
    venue: m.neutral ? 0 : home ? 1 : -1,
  };
}

export interface GoalForm {
  n: number;
  gfRes: number;
  gaRes: number;
  xgfRes: number;
  xgaRes: number;
}

const ZERO_FORM: GoalForm = { n: 0, gfRes: 0, gaRes: 0, xgfRes: 0, xgaRes: 0 };

/** Forma de goles de un equipo (residuos frente a lo esperado antes de cada partido reciente). */
export function goalForm(before: HistoryView, teamId: string): GoalForm {
  const all = before.teamMatches(teamId);
  const cutoff = before.cutoff;
  const recent: MatchRecord[] = [];
  for (let i = all.length - 1; i >= 0 && recent.length < FORM_N; i--) {
    if (cutoff - Date.parse(all[i].date) > FORM_MAX_DAYS * DAY_MS) break;
    recent.push(all[i]);
  }
  if (recent.length < FORM_MIN) return ZERO_FORM;
  const eloT = before.eloBefore(teamId);
  if (eloT === undefined) return ZERO_FORM;
  // total medio de largo plazo del equipo
  let tot = 0;
  let nL = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (cutoff - Date.parse(all[i].date) > LONG_DAYS * DAY_MS) break;
    tot += all[i].score!.home + all[i].score!.away;
    nL++;
  }
  const t = (tot + 5 * 2.6) / (nL + 5);
  let gf = 0;
  let ga = 0;
  let xf = 0;
  let xa = 0;
  let n = 0;
  let nx = 0;
  for (const m of recent) {
    const s = side(m, teamId);
    const eloO = before.eloBefore(s.oppId);
    const d = eloO === undefined ? 0 : eloT - eloO + ELO_HA * s.venue;
    const sup = clamp(d / ELO_PER_GOAL, -2.5, 2.5);
    const eGF = Math.max(0.15, t / 2 + sup / 2);
    const eGA = Math.max(0.15, t / 2 - sup / 2);
    gf += s.gf - eGF;
    ga += s.ga - eGA;
    n++;
    const xF = xgOf(s.sFor);
    const xA = xgOf(s.sAg);
    if (xF !== undefined && xA !== undefined) {
      xf += xF - eGF;
      xa += xA - eGA;
      nx++;
    }
  }
  const sh = (sum: number, k: number) => (k > 0 ? clamp((sum / k) * (k / (k + 2)), -2, 2) : 0);
  return { n, gfRes: sh(gf, n), gaRes: sh(ga, n), xgfRes: sh(xf, nx), xgaRes: sh(xa, nx) };
}

/** Rasgos de forma de goles del partido (gancho `features`). */
export function formFeatures(_ctx: FeatureContext, match: PreMatch, before: HistoryView): Features {
  const h = goalForm(before, match.home.id);
  const a = goalForm(before, match.away.id);
  return {
    nFormH: h.n,
    nFormA: a.n,
    gfResH: h.gfRes,
    gaResH: h.gaRes,
    xgfResH: h.xgfRes,
    xgaResH: h.xgaRes,
    gfResA: a.gfRes,
    gaResA: a.gaRes,
    xgfResA: a.xgfRes,
    xgaResA: a.xgaRes,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// (b) forma estadística

export const STAT_FORM_N = 5;
export const STAT_FORM_MAX_DAYS = 60;
const STAT_LONG_MIN = 8;

export interface StatFormOptions {
  /** partidos ficticios de la contracción del cociente reciente/largo plazo: peso = n/(n + K) */
  K: number;
  /** recorte del multiplicador final de cada media */
  maxMult: number;
}

/** Forma a favor / en contra de un equipo en una estadística: multiplicadores contraídos (1 = sin señal). */
export function statForm(before: HistoryView, teamId: string, key: StatKey, opts: StatFormOptions): { forM: number; agM: number } {
  const def = STAT_DEF_BY_KEY.get(key);
  if (!def) return { forM: 1, agM: 1 };
  const all = before.teamMatches(teamId);
  const cutoff = before.cutoff;
  // largo plazo: medias a favor / en contra, general y por condición (local / visitante; neutral = general)
  const acc = { f: [0, 0, 0], a: [0, 0, 0], n: [0, 0, 0] }; // [general, local, visitante]
  const rec: { venue: number; f: number; a: number }[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    const age = cutoff - Date.parse(m.date);
    if (age > LONG_DAYS * DAY_MS) break;
    const s = side(m, teamId);
    const f = s.sFor ? def.read(s.sFor) : undefined;
    const a = s.sAg ? def.read(s.sAg) : undefined;
    if (f === undefined || a === undefined) continue;
    acc.f[0] += f;
    acc.a[0] += a;
    acc.n[0]++;
    if (s.venue !== 0) {
      const j = s.venue === 1 ? 1 : 2;
      acc.f[j] += f;
      acc.a[j] += a;
      acc.n[j]++;
    }
    if (rec.length < STAT_FORM_N && age <= STAT_FORM_MAX_DAYS * DAY_MS) rec.push({ venue: s.venue, f, a });
  }
  if (acc.n[0] < STAT_LONG_MIN || rec.length === 0) return { forM: 1, agM: 1 };
  const meanF = acc.f[0] / acc.n[0];
  const meanA = acc.a[0] / acc.n[0];
  if (!(meanF > 0 && meanA > 0)) return { forM: 1, agM: 1 };
  const venueMean = (tot: number[], mean: number, venue: number) => {
    if (venue === 0) return mean;
    const j = venue === 1 ? 1 : 2;
    return (tot[j] + 5 * mean) / (acc.n[j] + 5);
  };
  let rf = 0;
  let ra = 0;
  for (const r of rec) {
    rf += r.f / venueMean(acc.f, meanF, r.venue);
    ra += r.a / venueMean(acc.a, meanA, r.venue);
  }
  const n = rec.length;
  const w = n / (n + opts.K);
  const lim = (x: number) => clamp(x, 1 / opts.maxMult, opts.maxMult);
  return { forM: lim(1 + w * (clamp(rf / n, 0.5, 2) - 1)), agM: lim(1 + w * (clamp(ra / n, 0.5, 2) - 1)) };
}
