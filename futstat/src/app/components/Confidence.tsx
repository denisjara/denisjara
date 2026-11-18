import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Minus, ShieldCheck, X } from 'lucide-react';
import type { ConfidencePick, ConfidenceTier, MatchSummary } from '../../types/data';
import { localizeDecimals, pickMarketLabel } from '../lib/picks';
import { int, kickoff, odds as fmtOdds, pct, time } from '../lib/format';
import { cx } from './Card';
import { OOS_MIN_N, groupByMatch, outOfSample } from '../lib/confidence';

export { OOS_MIN_N, groupByMatch, outOfSample };
import { TeamCrest } from './TeamCrest';
import { CompetitionBadge, matchHref } from './MatchStatus';

/**
 * Piezas de los pronósticos de ALTA CONFIANZA (public/data/confidence.json): insignia oro/plata, chip discreto para
 * tarjetas de partido, nota de acierto fuera de muestra, marca de resultado y fila de lista.
 * El nivel nunca se transmite solo por color: siempre lleva la palabra «Oro»/«Plata».
 */

export const TIER_LABEL: Record<ConfidenceTier, string> = { oro: 'Oro', plata: 'Plata' };
const TIER_CLASS: Record<ConfidenceTier, string> = {
  oro: 'border-warn/40 bg-warn/15 text-warn',
  plata: 'border-line-strong bg-surface-3 text-ink-2',
};
export const confidenceSelection = (p: Pick<ConfidencePick, 'selection'>) => localizeDecimals(p.selection);
/** Mercado neutro (en hándicaps el nombre del pipeline lleva el equipo local aunque la selección sea del visitante). */
export const confidenceMarket = (p: Pick<ConfidencePick, 'marketId' | 'market'>) => pickMarketLabel(p);

export function TierBadge({ tier, className }: { tier: ConfidenceTier; className?: string }) {
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-[1px] text-[10.5px] font-bold uppercase tracking-[0.08em]', TIER_CLASS[tier], className)}
      title={tier === 'oro' ? 'Nivel oro: su franja acierta al menos el 85 % en el histórico' : 'Nivel plata: su franja acierta al menos el 80 % en el histórico'}
    >
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      {TIER_LABEL[tier]}
    </span>
  );
}

/** Chip discreto para tarjetas de partido: «🛡 Oro · Más de 1,5 goles 91 %». */
export function SafePickChip({ pick, className }: { pick: ConfidencePick; className?: string }) {
  const sel = confidenceSelection(pick);
  return (
    <span
      className={cx('inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-2/70 px-2 py-1 text-2xs text-ink-2', className)}
      title={`Pronóstico de alta confianza (${TIER_LABEL[pick.tier].toLowerCase()}): ${sel} · ${pct(pick.prob)}. Cuota justa ${fmtOdds(pick.fairOdds)}: alto acierto no es beneficio.${
        outOfSample(pick) === 'bajo' ? ` Fuera de muestra este mercado acierta solo ${pct(pick.holdoutHitRate)}.` : outOfSample(pick) === 'sin-validar' ? ' Mercado aún sin validar fuera de muestra.' : ''
      }`}
    >
      {outOfSample(pick) === 'ok' ? (
        <ShieldCheck className={cx('h-3.5 w-3.5 shrink-0', pick.tier === 'oro' ? 'text-warn' : 'text-ink-3')} aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" aria-label="Mercado sin validar fuera de muestra o por debajo del 80%" />
      )}
      <span className="shrink-0 font-semibold text-ink-1">{TIER_LABEL[pick.tier]}</span>
      <span className="min-w-0 truncate">{sel}</span>
      <span className="num shrink-0 font-semibold text-ink-1">{pct(pick.prob)}</span>
    </span>
  );
}

/** Acierto FUERA DE MUESTRA de la familia del pick (o aviso si no está validada o queda por debajo del 80 %). */
export function OutOfSampleNote({ pick, className }: { pick: ConfidencePick; className?: string }) {
  const s = outOfSample(pick);
  if (s === 'ok') {
    return (
      <span className={cx('text-2xs text-ink-3', className)} title="Acierto de esta familia de mercados en partidos no usados para calibrar (holdout)">
        Fuera de muestra <span className="num font-semibold text-ink-2">{pct(pick.holdoutHitRate, 0)}</span> ({int(pick.holdoutN)})
      </span>
    );
  }
  return (
    <span className={cx('inline-flex items-center gap-1 text-2xs text-warn', className)}>
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      {s === 'bajo' ? (
        <span>
          Fuera de muestra solo <span className="num font-semibold">{pct(pick.holdoutHitRate, 0)}</span> ({int(pick.holdoutN)})
        </span>
      ) : (
        <span>Familia sin validar fuera de muestra{pick.holdoutN ? ` (${int(pick.holdoutN)})` : ''}</span>
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
 * por cada pronóstico, nivel, selección, mercado, acierto fuera de muestra, probabilidad, cuota justa y cuota de
 * mercado (y ✓/✗ si está resuelto). Toda la fila enlaza a la ficha del partido.
 */
export function ConfidenceRow({ match: m, picks, showComp = true, when = 'kickoff', settled, showOdds = true }: ConfidenceRowProps) {
  const teams = `${m.home.short || m.home.name} – ${m.away.short || m.away.name}`;
  const label = `${teams}: ${picks
    .map((p) => `${confidenceSelection(p)} ${pct(p.prob)}, nivel ${TIER_LABEL[p.tier]}${settled && p.result ? `, ${RESULT_WORD[p.result]}` : ''}`)
    .join('; ')}`;
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
          </span>
        </span>
      </span>
      <span className="block min-w-0 space-y-2.5 border-l-2 border-line pl-3 sm:ml-[52px] lg:ml-0 lg:border-l-0 lg:pl-0">
        {picks.map((pick, i) => (
          <span key={`${pick.family}-${pick.selection}`} className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <TierBadge tier={pick.tier} />
                <span className="min-w-0 text-[13px] font-semibold leading-snug text-ink-1">{confidenceSelection(pick)}</span>
              </span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-2xs text-ink-3">{localizeDecimals(confidenceMarket(pick))}</span>
                <OutOfSampleNote pick={pick} />
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
