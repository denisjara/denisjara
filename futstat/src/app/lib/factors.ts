/**
 * «Factores del partido» (MatchFile.factors): utilidades puras de presentación. Todo lo que llega aquí ya pasó por
 * `normMatchFactors` (sanitize.ts), pero se vuelve a comprobar lo mínimo para no pintar nunca NaN ni etiquetas raras.
 */
import type { FactorAbsence, FactorReferee, FactorStake, FactorTeamForm, FactorTie, MatchFactors, TeamRef } from '../../types/data';
import { lookup } from './lookup';
import { signedPct } from './format';

const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------------
// Árbitro
// ---------------------------------------------------------------------------

export type RefereeTone = 'estricto' | 'permisivo' | 'normal';

/**
 * Banda de «normal»: ±5 % de tarjetas frente a la media (el ratio ya viene contraído hacia 1 con 30 partidos ficticios;
 * en datos reales p5–p95 ≈ 0,89–1,10, así que ±5 % separa aproximadamente el tercio central).
 */
export const REFEREE_BAND = 0.05;

export function refereeTone(ratio: number | undefined): RefereeTone {
  if (!ok(ratio)) return 'normal';
  if (ratio >= 1 + REFEREE_BAND) return 'estricto';
  if (ratio <= 1 - REFEREE_BAND) return 'permisivo';
  return 'normal';
}

/** "+7%" / "−7%" / "0%" frente a la media (ratio 1,07 → +7 %). */
export function ratioDelta(ratio: number | undefined): string {
  return ok(ratio) ? signedPct(ratio - 1, 0) : '—';
}

/** Frase accesible del árbitro: "7 % menos tarjetas que la media de la liga". */
export function refereeSentence(ref: FactorReferee): string {
  if (ref.status !== 'conocido') return 'Árbitro aún no publicado';
  if (ref.matches === 0) return `${ref.name}: sin partidos previos registrados, se toma la media de la liga`;
  const d = Math.round((ref.cardsRatio - 1) * 100);
  const how = d === 0 ? 'las mismas tarjetas que la media' : `${Math.abs(d)} % ${d > 0 ? 'más' : 'menos'} tarjetas que la media`;
  return `${ref.name}: ${how} de la liga (${ref.matches} partidos previos)`;
}

/** Posición del marcador en el medidor de severidad (0..1) en el rango [1 − span, 1 + span]. */
export function refereeGaugePos(ratio: number | undefined, span = 0.2): number {
  if (!ok(ratio)) return 0.5;
  return Math.max(0, Math.min(1, (ratio - (1 - span)) / (2 * span)));
}

// ---------------------------------------------------------------------------
// Eliminatoria
// ---------------------------------------------------------------------------

/** ¿Jugó la ida en casa el visitante de este partido? (lo normal). Si el marcador no lo deja claro, se asume que sí. */
export function firstLegHostIsAway(tie: Pick<FactorTie, 'firstLeg' | 'aggregate'>): boolean {
  const { firstLeg: f, aggregate: a } = tie;
  if (f.home === a.away && f.away === a.home) return true;
  return !(f.home === a.home && f.away === a.away);
}

/**
 * Qué necesita un equipo en la vuelta según su diferencia en el global (goles propios − rivales), sin valor doble de
 * los goles fuera. «Iguala la eliminatoria» = global empatado tras 90 minutos (prórroga o penaltis según la competición).
 */
export function tieNeed(diff: number): string {
  if (!ok(diff)) return '';
  const d = Math.round(diff);
  if (d === 0) return 'Si gana, pasa; con empate el global sigue igualado';
  if (d > 0) {
    const margin = d === 1 ? 'Le vale el empate' : `Le vale empatar o perder por ${d === 2 ? '1 gol' : `hasta ${d - 1} goles`}`;
    return `${margin}; perder por ${d} ${d === 1 ? 'gol' : 'goles'} iguala la eliminatoria`;
  }
  const k = -d;
  return `Necesita ganar por ${k + 1} goles para pasar; por ${k} ${k === 1 ? 'gol' : 'goles'}, iguala la eliminatoria`;
}

export function tieNeeds(tie: Pick<FactorTie, 'aggregate'>): { home: string; away: string } {
  const diff = tie.aggregate.home - tie.aggregate.away;
  return { home: tieNeed(diff), away: tieNeed(-diff) };
}

// ---------------------------------------------------------------------------
// Lo que se juega
// ---------------------------------------------------------------------------

const STAKE_TEXT: Record<string, string> = {
  título: 'Se juega el título',
  'plazas continentales': 'Se juega plaza continental',
  ascenso: 'Se juega el ascenso',
  descenso: 'Se juega el descenso',
  'sin nada en juego': 'Sin nada en juego',
};
export function stakeText(status: FactorStake['status']): string {
  return lookup(STAKE_TEXT, status) ?? 'Sin nada en juego';
}

/** "3º" */
export const ordinal = (n: number) => (ok(n) ? `${Math.round(n)}º` : '—');

// ---------------------------------------------------------------------------
// Forma, bajas
// ---------------------------------------------------------------------------

export type FormTrend = 'up' | 'down' | 'flat';
export function formTrend(f: Pick<FactorTeamForm, 'label'>): FormTrend {
  return f.label === 'rinde por encima de lo esperado' ? 'up' : f.label === 'rinde por debajo de lo esperado' ? 'down' : 'flat';
}

const ABSENCE_KIND: Record<string, string> = {
  susp: 'Sancionado',
  miss2: 'Ausente',
  miss1s: 'Duda',
  miss1o: 'Duda',
};
export function absenceKindLabel(kind: FactorAbsence['kind']): string {
  return lookup(ABSENCE_KIND, kind) ?? 'Duda';
}

const ABSENCE_DETAIL: Record<string, string> = {
  susp: 'expulsado en el último partido',
  miss2: 'no jugó los 2 últimos partidos',
  miss1s: 'no jugó el último partido',
  miss1o: 'no jugó el último partido (otra competición)',
};
/** Motivo sin repetir la etiqueta («Sancionado · expulsado en el último partido»). */
export function absenceDetail(kind: FactorAbsence['kind']): string {
  return lookup(ABSENCE_DETAIL, kind) ?? 'no jugó los últimos partidos';
}

/** Qué hace el modelo con la baja: "Fuera de las props" (factor 0), "Minutos ×0,60" o "Sin ajuste". */
export function absenceEffect(a: Pick<FactorAbsence, 'minutesFactor'>): string {
  const f = a.minutesFactor;
  if (!ok(f) || f === 1) return 'Sin ajuste';
  if (f === 0) return 'Fuera de las props';
  return `Minutos ×${f.toFixed(2).replace('.', ',')}`;
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------

export interface FactorHighlight {
  key: string;
  label: string;
  /** icono sugerido (la página decide cuál) */
  kind: 'referee' | 'tie' | 'absences' | 'stakes';
  /** true si el factor entra en el modelo */
  used: boolean;
}

/**
 * Hasta 4 frases cortas para la cabecera del panel (y para futuros chips de tarjeta): árbitro no neutral, eliminatoria,
 * bajas y equipos con algo (o nada) en juego. Nunca inventa nada que no esté en el bloque.
 */
export function factorHighlights(f: MatchFactors | undefined, home: Pick<TeamRef, 'name' | 'short'>, away: Pick<TeamRef, 'name' | 'short'>): FactorHighlight[] {
  if (!f) return [];
  const out: FactorHighlight[] = [];
  const nm = (t: Pick<TeamRef, 'name' | 'short'>) => t.short || t.name;
  const ref = f.referee;
  if (ref?.status === 'conocido' && ref.matches > 0) {
    const tone = refereeTone(ref.cardsRatio);
    if (tone !== 'normal') out.push({ key: 'ref', label: `Árbitro ${tone}`, kind: 'referee', used: ref.usedInModel });
  }
  if (f.tie) {
    const diff = f.tie.aggregate.home - f.tie.aggregate.away;
    const label = diff === 0 ? 'Vuelta: global igualado' : `Vuelta: ${nm(diff < 0 ? home : away)} necesita remontar`;
    out.push({ key: 'tie', label, kind: 'tie', used: false });
  }
  const abs = f.absences;
  if (abs) {
    const all = [...abs.home, ...abs.away];
    const susp = all.filter((a) => a.kind === 'susp').length;
    if (all.length) {
      const label = `${all.length} ${all.length === 1 ? 'baja probable' : 'bajas probables'}${susp ? ` (${susp} ${susp === 1 ? 'sancionado' : 'sancionados'})` : ''}`;
      out.push({ key: 'abs', label, kind: 'absences', used: all.some((a) => a.usedInModel) });
    }
  }
  if (f.stakes) {
    for (const [side, t] of [['home', home], ['away', away]] as const) {
      const s = f.stakes[side];
      out.push({ key: `stake-${side}`, label: `${nm(t)}: ${stakeText(s.status).toLowerCase()}`, kind: 'stakes', used: false });
    }
  }
  return out.slice(0, 5);
}

/** Cuántos apartados presentes entran en el modelo y cuántos son informativos. */
export function factorUsage(f: MatchFactors | undefined): { used: number; info: number } {
  if (!f) return { used: 0, info: 0 };
  const parts: boolean[] = [f.referee?.usedInModel === true];
  if (f.tie) parts.push(false);
  if (f.stakes) parts.push(false);
  if (f.form) parts.push(false);
  if (f.venue) parts.push(true);
  if (f.absences) parts.push([...f.absences.home, ...f.absences.away].some((a) => a.usedInModel));
  if (f.inForm) parts.push(false);
  const used = parts.filter(Boolean).length;
  return { used, info: parts.length - used };
}
