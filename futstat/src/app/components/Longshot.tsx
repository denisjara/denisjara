import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Hash, Layers, Scale, Shapes, Sparkles, TrendingDown, UserRound, Zap, type LucideIcon } from 'lucide-react';
import type { LongshotBet, LongshotKind, LongshotLeg } from '../../types/data';
import { LONGSHOT_KIND_LABEL, evState, impliedProb, legStarted, minOddsLabel } from '../lib/longshots';
import { isValidNumericId } from '../lib/data';
import { localizeDecimals } from '../lib/picks';
import { dayKey, ev as fmtEv, int, kickoff, odds as fmtOdds, pct, time } from '../lib/format';
import { cx } from './Card';
import { CompetitionBadge, matchHref } from './MatchStatus';
import { TeamCrest } from './TeamCrest';
import { DailyNum } from './Daily';
import { ResultMark } from './Confidence';

/**
 * Piezas compartidas de «Cuota alta 6+» (public/data/longshots.json): insignia de tipo, valor esperado con color
 * semántico (y siempre con signo e icono), aviso obligatorio y fila de una pata. Las usan la página /cuota-alta y la
 * tarjeta de Inicio. Regla: nunca se promete ganar; junto a cada cuota va su probabilidad («1 de cada N»).
 */

export const LONGSHOT_KIND_ICON: Record<LongshotKind, LucideIcon> = {
  combinada: Layers,
  sorpresa: Sparkles,
  marcador: Hash,
  goleador: UserRound,
  otro: Shapes,
};

/** Insignia neutra del tipo de apuesta (icono + texto; nunca un color por tipo). */
export function LongshotKindBadge({ kind, className }: { kind: LongshotKind; className?: string }) {
  const Icon = LONGSHOT_KIND_ICON[kind];
  return (
    <span className={cx('chip shrink-0 whitespace-nowrap', className)}>
      <Icon className="h-3 w-3 shrink-0 text-accent-text" aria-hidden="true" />
      {LONGSHOT_KIND_LABEL[kind]}
    </span>
  );
}

/** Texto del aviso obligatorio (cuota mínima del archivo; 6 por defecto). */
export function longshotWarningText(minOdds: number): string {
  const m = minOddsLabel(minOdds);
  return `Con cuota ${m} o más, la mayoría de estas apuestas pierden: aciertan 1 de cada ${m} o menos. Solo ganarías a la larga si la probabilidad real es mayor que la que paga la casa.`;
}

/** Aviso corto (Inicio y pies de tarjeta). */
export function longshotShortWarning(minOdds: number): string {
  const m = minOddsLabel(minOdds);
  return `La mayoría pierden: con cuota ${m} o más se acierta 1 de cada ${m} o menos.`;
}

/**
 * Valor esperado de una apuesta con su color semántico, signo e icono (nunca solo color):
 *  - positivo (⚡ +x %): la probabilidad del modelo supera la implícita en la cuota de la casa;
 *  - negativo (↘ −x %): a la larga pierde;
 *  - sin cuota de la casa: «compárala con tu casa: necesitas al menos <cuota justa>».
 * `detail` añade la frase que lo explica con las dos probabilidades.
 */
export function LongshotEv({ bet, detail = true, className }: { bet: Pick<LongshotBet, 'prob' | 'fairOdds' | 'marketOdds' | 'ev'>; detail?: boolean; className?: string }) {
  const s = evState(bet);
  const implied = impliedProb(bet.marketOdds);
  if (s === 'sin-cuota') {
    return (
      <span className={cx('block text-[12.5px] leading-snug text-ink-2', className)}>
        <span className="inline-flex items-center gap-1 font-semibold text-ink-1">
          <Scale className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          Sin cuota de la casa
        </span>
        <span className="block">
          Compárala con tu casa: necesitas al menos <strong className="num font-semibold text-ink-1">{fmtOdds(bet.fairOdds)}</strong>
          {detail ? ' para no perder a la larga (cuota justa = 1 / probabilidad).' : '.'}
        </span>
      </span>
    );
  }
  const pos = s === 'pos';
  const Icon = pos ? Zap : TrendingDown;
  return (
    <span className={cx('block text-[12.5px] leading-snug text-ink-2', className)}>
      <span
        className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-semibold', pos ? 'border-accent-text/70 text-pos' : 'border-neg/40 text-neg')}
        title="Valor esperado por unidad apostada a la cuota de la casa: probabilidad × cuota − 1"
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="num">{fmtEv(bet.ev)}</span>
        <span className="font-sans text-[11.5px] font-medium">valor esperado</span>
      </span>
      {detail && (
        <span className="mt-1 block">
          {pos ? (
            <>
              El modelo le da <strong className="num font-semibold text-ink-1">{pct(bet.prob, 1)}</strong> y la casa paga como si fuera <span className="num">{pct(implied, 1)}</span>. Aun así,
              lo normal es perderla: solo compensa repetida muchas veces.
            </>
          ) : (
            <>
              A la larga pierde: la casa paga como si fuera <span className="num">{pct(implied, 1)}</span> y el modelo solo le da{' '}
              <strong className="num font-semibold text-ink-1">{pct(bet.prob, 1)}</strong>.
            </>
          )}
        </span>
      )}
    </span>
  );
}

/** Aviso de los goleadores (y de cualquier pata con jugador). */
export const LONGSHOT_PLAYER_NOTE = 'Si no juega, la apuesta suele anularse: comprueba la alineación.';

/** Bloque de aviso (borde e icono `warn`, texto en tinta para que llegue a AA). No se puede cerrar. */
export function LongshotWarning({ minOdds, children, compact, className }: { minOdds: number; children?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div role="note" aria-label="Aviso sobre las apuestas de cuota alta" className={cx('flex items-start gap-2.5 rounded-lg border border-warn/60 bg-warn/[0.08] text-ink-2', compact ? 'px-3 py-2 text-[12.5px]' : 'px-3.5 py-3 text-[13.5px] sm:px-4', className)}>
      <AlertTriangle className={cx('shrink-0 text-warn', compact ? 'mt-0.5 h-4 w-4' : 'mt-0.5 h-5 w-5')} aria-hidden="true" />
      <div className="min-w-0 space-y-1.5 leading-snug">
        <p className={cx('text-ink-1', !compact && 'font-semibold')}>{compact ? longshotShortWarning(minOdds) : longshotWarningText(minOdds)}</p>
        {children}
      </div>
    </div>
  );
}

/** Ruta del análisis del partido de una pata (o de su competición si el id no es válido). */
export function legHref(leg: Pick<LongshotLeg, 'matchId' | 'compId'>): string {
  return matchHref({ id: leg.matchId, compId: leg.compId, hasDetail: isValidNumericId(leg.matchId) });
}

/** Hora local de la pata (con el día si no es el del listado) o «Empezado» si ya pasó la hora de inicio. */
export function LegKickoff({ leg, now, day, settled, className }: { leg: Pick<LongshotLeg, 'date'>; now: number; day?: string; settled?: boolean; className?: string }) {
  if (!leg.date) return null;
  if (settled || legStarted(leg, now)) {
    return <span className={cx('rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-ink-2', className)}>{settled ? 'Final' : 'Empezado'}</span>;
  }
  return <span className={cx('num shrink-0 text-[12px] font-medium text-ink-2', className)}>{day && dayKey(leg.date) !== day ? kickoff(leg.date, new Date(now)) : time(leg.date)}</span>;
}

const LEG_RESULT = { hit: 'acertada', miss: 'fallada', void: 'nula' } as const;

/**
 * Fila de una pata: partido (escudos, equipos, competición, hora local), mercado → selección y, a la derecha,
 * probabilidad de la pata, cuota justa y cuota de la casa («—» si la fuente no la publica). Enlaza al partido.
 */
export function LongshotLegRow({ leg, index, now, day, settled, showResult }: { leg: LongshotLeg; index?: number; now: number; day?: string; settled?: boolean; showResult?: boolean }) {
  const teams = `${leg.home.short || leg.home.name} – ${leg.away.short || leg.away.name}`;
  const nums = (
    <>
      <DailyNum label="Prob." value={pct(leg.prob, leg.prob < 0.2 ? 1 : 0)} strong title="Probabilidad del modelo para esta pata" />
      <DailyNum label="Justa" value={fmtOdds(leg.fairOdds)} title="Cuota justa (1 / probabilidad): por debajo de ella, a la larga se pierde" />
      <DailyNum label="Casa" value={leg.marketOdds ? fmtOdds(leg.marketOdds) : '—'} title={leg.marketOdds ? 'Cuota de la casa (DraftKings vía ESPN)' : 'La fuente no publica cuota de la casa para este mercado'} />
    </>
  );
  return (
    <Link
      to={legHref(leg)}
      className="group flex min-w-0 items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-surface-2 sm:px-4"
      aria-label={`${index !== undefined ? `Pata ${index + 1}: ` : ''}${leg.home.name} – ${leg.away.name}, ${localizeDecimals(leg.selection)}, ${pct(leg.prob, 1)}${showResult && leg.result ? `, ${LEG_RESULT[leg.result]}` : ''}`}
    >
      {index !== undefined && <span className="num mt-0.5 w-4 shrink-0 text-2xs font-semibold text-ink-3">{index + 1}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 -space-x-1.5">
            <TeamCrest team={leg.home} size={18} className="ring-2 ring-surface-1" />
            <TeamCrest team={leg.away} size={18} className="ring-2 ring-surface-1" />
          </span>
          <span className="truncate text-[13px] font-semibold text-ink-1" title={`${leg.home.name} – ${leg.away.name}`}>
            {teams}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-ink-3">
          {leg.compId ? <CompetitionBadge compId={leg.compId} name={leg.compName} link={false} className="min-w-0 text-2xs font-medium" /> : leg.compName ? <span className="truncate">{leg.compName}</span> : null}
          <LegKickoff leg={leg} now={now} day={day} settled={settled} className="text-2xs" />
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-snug">
          <span className="text-ink-3">{localizeDecimals(leg.market)}</span>
          <ArrowRight className="h-3 w-3 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="font-semibold text-ink-1">{localizeDecimals(leg.selection)}</span>
        </span>
        {leg.player && !leg.selection.includes(leg.player.name) && <span className="mt-0.5 block text-2xs text-ink-3">Jugador: {leg.player.name}</span>}
        <span className="mt-1.5 flex items-start gap-3 sm:hidden [&>span]:w-auto [&>span]:text-left">{nums}</span>
      </span>
      <span className="hidden shrink-0 items-start gap-1.5 sm:flex">{nums}</span>
      {showResult && leg.result && <ResultMark result={leg.result} className="mt-0.5 h-5 w-5" />}
    </Link>
  );
}

/** «1 de cada 7» con la probabilidad. */
export function OneIn({ bet, className }: { bet: Pick<LongshotBet, 'prob' | 'oneIn'>; className?: string }) {
  return (
    <span className={cx('text-[12.5px] text-ink-2', className)}>
      Acierta <strong className="font-semibold text-ink-1">1 de cada {int(bet.oneIn)}</strong> veces
    </span>
  );
}
