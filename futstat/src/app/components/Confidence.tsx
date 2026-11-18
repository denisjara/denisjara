import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Minus, ShieldCheck, X } from 'lucide-react';
import type { ConfidencePick, ConfidenceTier, MatchSummary } from '../../types/data';
import { localizeDecimals, pickMarketLabel } from '../lib/picks';
import { int, kickoff, odds as fmtOdds, pct, time } from '../lib/format';
import { cx } from './Card';
import { OOS_MIN_N, beyond90, groupByMatch, outOfSample, ownRate, wilson90 } from '../lib/confidence';

export { OOS_MIN_N, beyond90, groupByMatch, outOfSample, ownRate, wilson90 };
import { TeamCrest } from './TeamCrest';
import { CompetitionBadge, matchHref } from './MatchStatus';

/**
 * Piezas de los pronósticos de ALTA CONFIANZA (public/data/confidence.json): acierto con n e intervalo de Wilson
 * (RateCI), chip discreto para tarjetas de partido, nota de validación fuera de muestra, marca de resultado y fila de
 * lista. Solo se publica el nivel oro: la UI ya no muestra niveles (TierBadge queda por compatibilidad).
 * Regla de presentación: ningún acierto sin su n e intervalo; con n < 50, «muestra pequeña» y sin acierto propio.
 */

/** Solo existe el nivel oro en la UI; 'plata' (ficheros antiguos) nunca se muestra. */
export const TIER_LABEL: Record<ConfidenceTier, string> = { oro: 'Oro', plata: '' };
export const confidenceSelection = (p: Pick<ConfidencePick, 'selection'>) => localizeDecimals(p.selection);
/** Mercado neutro (en hándicaps el nombre del pipeline lleva el equipo local aunque la selección sea del visitante). */
export const confidenceMarket = (p: Pick<ConfidencePick, 'marketId' | 'market'>) => pickMarketLabel(p);

/** Insignia del nivel oro (compatibilidad; las vistas actuales no la usan). 'plata' no se muestra. */
export function TierBadge({ tier, className }: { tier: ConfidenceTier; className?: string }) {
  if (tier !== 'oro') return null;
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded-md border border-warn/40 bg-warn/15 px-1.5 py-[1px] text-[10.5px] font-bold uppercase tracking-[0.08em] text-warn', className)}
      title="Nivel oro: su franja acierta al menos el 85 % en el histórico de su regla"
    >
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      {TIER_LABEL.oro}
    </span>
  );
}

/** «86,7–92,6%» (intervalo de Wilson al 90 %). */
export const ciText = (lo: number | undefined, hi: number | undefined, digits = 1) =>
  lo !== undefined && hi !== undefined ? `${pct(lo, digits).replace('%', '')}–${pct(hi, digits)}` : '';

export interface RateCIProps {
  /** acierto (0..1) */
  rate: number | undefined;
  /** resueltas */
  n: number | undefined;
  hits?: number;
  /** intervalo de Wilson al 90 %; si falta y hay hits, se calcula */
  lo?: number;
  hi?: number;
  digits?: number;
  /** clase del número */
  valueClass?: string;
  className?: string;
  /** muestra «hits/n» en vez de «n = …» */
  showHits?: boolean;
  /** solo la cifra (referencias derivadas sin muestra propia, p. ej. una tasa esperada) */
  hideN?: boolean;
  /** cifra encima y muestra/intervalo debajo, alineados a la derecha */
  stacked?: boolean;
}

/**
 * Acierto con su muestra y su intervalo de Wilson al 90 %: «89,8% · n = 2.630 · 88,8–90,7%». Con n < 50 no se da
 * acierto propio: «Muestra pequeña (n = 21)».
 */
export function RateCI({ rate, n, hits, lo, hi, digits = 1, valueClass, className, showHits, hideN, stacked }: RateCIProps) {
  if (rate === undefined || !(n !== undefined && n > 0)) return <span className={cx('text-ink-3', className)}>—</span>;
  if (!ownRate(n)) {
    return (
      <span className={cx('inline-flex items-baseline gap-1 text-ink-3', className)} title={`Con menos de ${OOS_MIN_N} casos no se publica un acierto propio`}>
        <span className="font-medium">Muestra pequeña</span>
        <span className="text-2xs tabular-nums">(n = {int(n)})</span>
      </span>
    );
  }
  let l = lo;
  let h = hi;
  if ((l === undefined || h === undefined) && hits !== undefined) [l, h] = wilson90(hits, n);
  return (
    <span
      className={cx(stacked ? 'flex flex-col items-end text-right' : 'inline-flex flex-wrap items-baseline justify-end gap-x-1.5', className)}
      title="Acierto · muestra · intervalo de Wilson al 90 %"
    >
      <span className={cx('num font-semibold text-ink-1', valueClass)}>{pct(rate, digits)}</span>
      {!hideN && (
        <span className="whitespace-nowrap text-2xs tabular-nums text-ink-3">
          {showHits && hits !== undefined ? `${int(hits)}/${int(n)}` : `n = ${int(n)}`}
          {l !== undefined && h !== undefined ? ` · ${ciText(l, h, digits)}` : ''}
        </span>
      )}
    </span>
  );
}

/** Chip discreto para tarjetas de partido: «🛡 Más de 1,5 goles 91 %». */
export function SafePickChip({ pick, className }: { pick: ConfidencePick; className?: string }) {
  const sel = confidenceSelection(pick);
  const s = outOfSample(pick);
  return (
    <span
      className={cx('inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-2/70 px-2 py-1 text-2xs text-ink-2', className)}
      title={`Selección muy probable con cuota baja: ${sel} · ${pct(pick.prob)} (cuota justa ${fmtOdds(pick.fairOdds)}). No es una ventaja frente a la casa.${
        s === 'ok'
          ? ` Su regla acierta ${pct(pick.validationHitRate, 1)} fuera de muestra (n = ${int(pick.validationN)}).`
          : s === 'pequena'
            ? ` Validada fuera de muestra con muestra pequeña (n = ${int(pick.validationN)}).`
            : s === 'bajo'
              ? ` Fuera de muestra su regla acierta solo ${pct(pick.validationHitRate)}.`
              : ' Sin datos de validación fuera de muestra.'
      }`}
    >
      {s === 'ok' || s === 'pequena' ? (
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" aria-label="Sin validación fuera de muestra o por debajo del 80%" />
      )}
      <span className="sr-only">Alta confianza: </span>
      <span className="min-w-0 truncate">{sel}</span>
      <span className="num shrink-0 font-semibold text-ink-1">{pct(pick.prob)}</span>
    </span>
  );
}

/**
 * Validación FUERA DE MUESTRA de la regla del pick (walk-forward mensual): acierto con n e intervalo, «muestra
 * pequeña» si n < 50, o aviso si falta o queda por debajo del 80 %.
 */
export function OutOfSampleNote({ pick, className }: { pick: ConfidencePick; className?: string }) {
  const s = outOfSample(pick);
  if (s === 'ok') {
    return (
      <span className={cx('text-2xs text-ink-3', className)} title="Acierto de esta regla (mercado y fuente) fuera de muestra: walk-forward mensual · intervalo de Wilson al 90 %">
        Fuera de muestra <span className="num font-semibold text-ink-2">{pct(pick.validationHitRate, 0)}</span>{' '}
        <span className="tabular-nums">
          (n = {int(pick.validationN)}
          {pick.validationWilsonLow !== undefined ? ` · ${ciText(pick.validationWilsonLow, pick.validationWilsonHigh, 0)}` : ''})
        </span>
      </span>
    );
  }
  if (s === 'pequena') {
    return (
      <span className={cx('text-2xs text-ink-3', className)} title={`Validada fuera de muestra, pero con menos de ${OOS_MIN_N} casos: sin acierto propio`}>
        Fuera de muestra: muestra pequeña <span className="tabular-nums">(n = {int(pick.validationN)})</span>
      </span>
    );
  }
  return (
    <span className={cx('inline-flex items-center gap-1 text-2xs text-warn', className)}>
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      {s === 'bajo' ? (
        <span>
          Fuera de muestra solo <span className="num font-semibold">{pct(pick.validationHitRate, 0)}</span> (n = {int(pick.validationN)})
        </span>
      ) : (
        <span>Sin validación fuera de muestra</span>
      )}
    </span>
  );
}

/** ✓ acierto · ✗ fallo · = nulo (empate no apuesta con empate). */
export function ResultMark({ result, className }: { result: ConfidencePick['result']; className?: string }) {
  if (!result) return null;
  const cfg =
    result === 'hit'
      ? { cls: 'bg-win/15 text-win', label: 'Acierto', Icon: Check }
      : result === 'miss'
        ? { cls: 'bg-loss/15 text-loss', label: 'Fallo', Icon: X }
        : { cls: 'bg-draw/20 text-ink-2', label: 'Nulo (se devuelve)', Icon: Minus };
  return (
    <span className={cx('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full', cfg.cls, className)} role="img" aria-label={cfg.label} title={cfg.label}>
      <cfg.Icon className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
    </span>
  );
}

function Num({ label, value, title, strong, showLabel, className }: { label: string; value: string; title?: string; strong?: boolean; showLabel?: boolean; className?: string }) {
  return (
    <span className={cx('w-[44px] shrink-0 text-right', className)} title={title}>
      {showLabel && <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>}
      <span className={cx('num block text-[13px]', strong ? 'font-semibold text-ink-1' : 'text-ink-2')}>
        <span className="sr-only">{label}: </span>
        {value}
      </span>
    </span>
  );
}

const RESULT_WORD = { hit: 'acierto', miss: 'fallo', void: 'nulo' } as const;

export interface ConfidenceRowProps {
  match: MatchSummary;
  /** pronósticos del partido (1 o 2) */
  picks: ConfidencePick[];
  /** muestra la competición (oculta en listas ya agrupadas) */
  showComp?: boolean;
  /** formato de la hora: 'kickoff' ("Hoy · 21:00") o 'time' ("21:00", listas agrupadas por día) */
  when?: 'kickoff' | 'time';
  /** picks resueltos: marcador y ✓/✗ */
  settled?: boolean;
  /** columnas de cuota (justa y mercado) */
  showOdds?: boolean;
}

/**
 * Fila de lista con los pronósticos de alta confianza de UN partido: partido (escudos, equipos, competición, hora) y,
 * por cada pronóstico, selección, mercado, validación fuera de muestra de su regla (n e intervalo), probabilidad,
 * cuota justa y cuota de mercado (y ✓/✗ si está resuelto). Toda la fila enlaza a la ficha del partido.
 */
export function ConfidenceRow({ match: m, picks, showComp = true, when = 'kickoff', settled, showOdds = true }: ConfidenceRowProps) {
  const teams = `${m.home.short || m.home.name} – ${m.away.short || m.away.name}`;
  const et = settled ? beyond90(m) : undefined;
  const label = `${teams}${et ? ` (con ${et}, se resuelve a los 90 minutos)` : ''}: ${picks.map((p) => `${confidenceSelection(p)} ${pct(p.prob)}${settled && p.result ? `, ${RESULT_WORD[p.result]}` : ''}`).join('; ')}`;
  return (
    <Link
      to={matchHref(m)}
      className="group grid gap-x-6 gap-y-2.5 px-3 py-3 transition-colors hover:bg-surface-2 sm:px-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)] lg:items-center"
      aria-label={label}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex shrink-0 -space-x-1.5">
          <TeamCrest team={m.home} size={22} className="ring-2 ring-surface-1" />
          <TeamCrest team={m.away} size={22} className="ring-2 ring-surface-1" />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold text-ink-1" title={`${m.home.name} – ${m.away.name}`}>
              {teams}
            </span>
            {settled && m.score && (
              <span className="num shrink-0 font-display text-[16px] font-extrabold leading-none text-ink-1">
                {m.score.home}-{m.score.away}
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-2xs text-ink-3">
            {showComp && <CompetitionBadge compId={m.compId} name={m.compName} link={false} className="min-w-0 text-2xs font-medium" />}
            <span className="num shrink-0">{when === 'time' ? time(m.date) : kickoff(m.date)}</span>
            {et && (
              <span className="shrink-0" title={`Partido con ${et}: los pronósticos se resuelven con el marcador a los 90 minutos, como en las casas`}>
                · {et === 'penaltis' ? 'Penaltis' : 'Prórroga'}: a 90&apos;
              </span>
            )}
          </span>
        </span>
      </span>
      <span className="block min-w-0 space-y-2.5 border-l-2 border-line pl-3 sm:ml-[52px] lg:ml-0 lg:border-l-0 lg:pl-0">
        {picks.map((pick, i) => (
          <span key={`${pick.family}-${pick.selection}`} className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="block min-w-0 text-[13px] font-semibold leading-snug text-ink-1">{confidenceSelection(pick)}</span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-2xs text-ink-3">{localizeDecimals(confidenceMarket(pick))}</span>
                {!settled && <OutOfSampleNote pick={pick} />}
              </span>
            </span>
            <Num label="Prob." value={pct(pick.prob)} strong showLabel={i === 0} title="Probabilidad del modelo" />
            {showOdds && <Num label="Justa" value={fmtOdds(pick.fairOdds)} showLabel={i === 0} title="Cuota justa (1 / probabilidad)" />}
            {showOdds && (
              <Num
                label="Mercado"
                className="hidden w-[56px] sm:block"
                value={pick.marketOdds ? `${fmtOdds(pick.marketOdds)}${pick.oddsKind === 'sintetica' ? '*' : ''}` : '—'}
                showLabel={i === 0}
                title={pick.marketOdds ? (pick.oddsKind === 'sintetica' ? 'Cuota sintética calculada desde el 1X2 de la casa' : 'Cuota de la casa') : 'La fuente no publica cuota para este mercado'}
              />
            )}
            {settled && <ResultMark result={pick.result} />}
          </span>
        ))}
      </span>
    </Link>
  );
}
