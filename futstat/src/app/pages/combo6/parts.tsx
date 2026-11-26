import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ClipboardCopy, Info, Layers, TrendingDown, Zap } from 'lucide-react';
import type { Combo6Category, Combo6Combo, Combo6File, Combo6History } from '../../../types/data';
import {
  COMBO6_CATEGORY_LABEL,
  COMBO6_DEFAULT_RULE,
  combo6CopyText,
  combo6Cumulative,
  combo6LegsByKickoff,
  combo6Started,
  combo6Totals,
} from '../../lib/combo6';
import { copyText } from '../../lib/clipboard';
import { wilson90 } from '../../lib/confidence';
import { ev as fmtEv, fromDayKey, int, num, odds as fmtOdds, pct, plural, shortDate, time } from '../../lib/format';
import { COMBO6_CATEGORY_ICON, Card, Combo6LegRow, Meter, ResultMark, ciText, cx } from '../../components';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------------
// Aviso fijo
// ---------------------------------------------------------------------------
/** Aviso honesto fijo (no se puede cerrar): la mayoría de días se pierde; cada pata paga el margen; +18. */
export function Combo6Warning({ history, compact, className }: { history?: Combo6History; compact?: boolean; className?: string }) {
  const oneIn = history && history.settled > 0 && history.hits > 0 ? Math.round(history.settled / history.hits) : undefined;
  return (
    <div
      role="note"
      aria-label="Aviso sobre la combinada"
      className={cx('flex items-start gap-2.5 rounded-lg border border-warn/60 bg-warn/[0.08] text-ink-2', compact ? 'px-3 py-2 text-[12.5px]' : 'px-3.5 py-3 text-[13.5px] sm:px-4', className)}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
      <p className="min-w-0 leading-snug">
        <strong className="font-semibold text-ink-1">La mayoría de los días se pierde.</strong>
        {oneIn ? ` En el historial acertó 1 de cada ${int(oneIn)} combinadas.` : ''} Cada pata paga el margen de la casa y el margen se multiplica: a la larga, pierde
        dinero. Solo mayores de 18 años (+18).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copiar selecciones
// ---------------------------------------------------------------------------
type CopyState = 'idle' | 'ok' | 'manual';

/**
 * Botón «Copiar selecciones»: copia la lista en texto plano. Funciona sin red (también en la versión de un solo archivo
 * abierta con file://); si el navegador no deja copiar, muestra el texto seleccionado para copiarlo a mano.
 */
export function CopyLegsButton({ combo, title, className }: { combo: Combo6Combo; title?: string; className?: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number>();
  const text = combo6CopyText(combo, { timeOf: (iso) => time(iso), title });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (state === 'manual') {
      areaRef.current?.focus();
      areaRef.current?.select();
    }
  }, [state]);
  const onCopy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'ok' : 'manual');
    window.clearTimeout(timer.current);
    if (ok) timer.current = window.setTimeout(() => setState('idle'), 2500);
  };
  return (
    <div className={cx('space-y-2', className)}>
      <button type="button" onClick={onCopy} className="btn w-full justify-center">
        {state === 'ok' ? <Check className="h-4 w-4 text-win" aria-hidden="true" /> : <ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
        {state === 'ok' ? 'Copiadas' : 'Copiar selecciones'}
      </button>
      <p className="sr-only" role="status" aria-live="polite">
        {state === 'ok' ? 'Selecciones copiadas al portapapeles.' : state === 'manual' ? 'No se pudo copiar automáticamente: el texto está seleccionado para copiarlo a mano.' : ''}
      </p>
      {state === 'manual' && (
        <div className="space-y-1">
          <label className="block text-2xs text-ink-2" htmlFor={`copiar-${combo.id}`}>
            Tu navegador no deja copiar automáticamente. Selecciona el texto y cópialo (Ctrl+C o mantén pulsado):
          </label>
          <textarea
            id={`copiar-${combo.id}`}
            ref={areaRef}
            readOnly
            value={text}
            rows={Math.min(12, combo.legs.length + 4)}
            className="input w-full resize-y px-2 py-1.5 font-mono text-[11.5px] leading-snug"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Escalera de probabilidad
// ---------------------------------------------------------------------------
/** Probabilidad acumulada pata a pata: cada pata, por probable que sea, baja la de la combinada. */
function CumulativeLadder({ combo }: { combo: Combo6Combo }) {
  const legs = combo6LegsByKickoff(combo.legs);
  const cum = combo6Cumulative(legs);
  if (legs.length < 2) return null;
  return (
    <figure className="min-w-0">
      <figcaption className="eyebrow mb-1.5">Así baja la probabilidad</figcaption>
      <ol className="space-y-[3px]" aria-label="Probabilidad acumulada tras cada pata">
        {cum.map((p, i) => {
          const last = i === cum.length - 1;
          return (
            <li key={i} className="grid grid-cols-[22px_minmax(0,1fr)_44px] items-center gap-2">
              <span className="sr-only">{`Tras ${plural(i + 1, 'pata')}: ${pct(p, 1)}`}</span>
              <span className="num text-[10.5px] text-ink-3" aria-hidden="true">
                {i + 1}
              </span>
              <span className="h-[7px] overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                <span className={cx('block h-full rounded-full', last ? 'bg-accent' : 'bg-ink-3/55')} style={{ width: `${Math.max(1.5, p * 100)}%` }} />
              </span>
              <span className={cx('num text-right text-[11.5px]', last ? 'font-semibold text-ink-1' : 'text-ink-3')} aria-hidden="true">
                {pct(p, p < 0.2 ? 1 : 0)}
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Boleto de una combinada
// ---------------------------------------------------------------------------
export interface ComboTicketProps {
  combo: Combo6Combo;
  now: number;
  /** día del listado (YYYY-MM-DD) */
  day: string;
  /** «Hoy · jue 26 nov» */
  dayLabel?: string;
  /** combinada principal (tipografía más grande) */
  main?: boolean;
}

/**
 * Boleto de una combinada: patas por hora de inicio (a la izquierda) y la matriz del boleto con la cuota total en la
 * casa (≈ si alguna es estimada), la probabilidad real («1 de cada N»), la cuota justa, el valor esperado, la escalera
 * de probabilidad y «Copiar selecciones». Las cifras se recalculan con las patas publicadas.
 */
export function ComboTicket({ combo, now, day, dayLabel, main }: ComboTicketProps) {
  const legs = combo6LegsByKickoff(combo.legs);
  const t = combo6Totals(legs);
  const started = combo6Started(combo, now);
  const settled = !!combo.result;
  const comps = new Set(legs.map((l) => l.compId || l.compName)).size;
  const estimated = t.estimatedLegs > 0;
  const titleId = `boleto-${combo.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const span = t.firstKickoff && t.lastKickoff ? (time(t.firstKickoff) === time(t.lastKickoff) ? time(t.firstKickoff) : `${time(t.firstKickoff)}–${time(t.lastKickoff)}`) : '';
  const evPos = t.ev > 0;
  const EvIcon = evPos ? Zap : TrendingDown;
  return (
    <Card as="article" pad="none" aria-labelledby={titleId} className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" aria-hidden="true" />
      <header className="flex items-start justify-between gap-3 border-b border-line bg-surface-2/50 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          {dayLabel && <span className="eyebrow block text-accent-text">{dayLabel}</span>}
          <h3 id={titleId} className={cx('mt-0.5 font-display font-extrabold uppercase leading-tight text-ink-1 [overflow-wrap:anywhere]', main ? 'text-[22px] sm:text-[26px]' : 'text-[19px]')}>
            {combo.label || 'Combinada 6'}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-2">
            <span>{plural(legs.length, 'pata')}</span>
            <span aria-hidden="true">·</span>
            <span>{plural(t.categories, 'mercado')} distintos</span>
            <span aria-hidden="true">·</span>
            <span>{plural(comps, 'competición', 'competiciones')}</span>
            {span && (
              <>
                <span aria-hidden="true">·</span>
                <span className="num">{span}</span>
              </>
            )}
          </p>
        </div>
        {/* resumen en móvil: la matriz del boleto queda debajo de las patas */}
        <div className="shrink-0 text-right lg:hidden">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">Cuota</span>
          <span className="block font-display text-[30px] font-extrabold leading-none text-ink-1">
            {estimated && <span className="mr-0.5 text-[20px] text-ink-3">≈</span>}
            {fmtOdds(t.bookOdds)}
          </span>
          <span className="num mt-0.5 block text-[11.5px] text-ink-2">{pct(t.prob, 1)}</span>
        </div>
      </header>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_330px]">
        <ol className="min-w-0 divide-y divide-line/70" aria-label="Patas de la combinada, por hora de inicio">
          {legs.map((l, i) => (
            <li key={`${l.matchId}-${l.marketId}-${l.selection}`}>
              <Combo6LegRow leg={l} index={i} now={now} day={day} settled={settled || !!l.result} hideReason={!main} />
            </li>
          ))}
        </ol>

        <aside aria-label="Total de la combinada" className="relative border-t border-dashed border-line-strong bg-surface-2/40 px-4 py-4 lg:border-l lg:border-t-0">
          {/* muescas de boleto en la línea de corte */}
          <span className="pointer-events-none absolute -left-2.5 -top-2.5 h-5 w-5 rounded-full border border-line bg-bg" aria-hidden="true" />
          <span className="pointer-events-none absolute -right-2.5 -top-2.5 h-5 w-5 rounded-full border border-line bg-bg lg:-bottom-2.5 lg:-left-2.5 lg:right-auto lg:top-auto" aria-hidden="true" />

          <div className="space-y-4">
            <div>
              <span className="eyebrow block">Cuota en la casa</span>
              <span className={cx('mt-1 block font-display font-black leading-[0.9] text-ink-1', main ? 'text-[56px] sm:text-[64px]' : 'text-[48px]')}>
                {estimated && <span className="mr-1 align-top text-[0.5em] font-extrabold text-ink-3">≈</span>}
                {fmtOdds(t.bookOdds)}
              </span>
              <span className="mt-1.5 flex items-start gap-1 text-2xs leading-snug text-ink-2">
                <Info className="mt-px h-3 w-3 shrink-0 text-ink-3" aria-hidden="true" />
                {estimated
                  ? t.estimatedLegs === legs.length
                    ? 'Todas las cuotas son estimadas (la justa menos el margen típico): compruébalas en tu casa.'
                    : `${int(t.estimatedLegs)} de ${int(legs.length)} cuotas son estimadas: compruébalas en tu casa.`
                  : 'Todas son cuotas de la casa (DraftKings vía ESPN). Pueden haber cambiado.'}
              </span>
            </div>

            <div>
              <span className="eyebrow block">Probabilidad real</span>
              <span className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="num text-[24px] font-semibold leading-none text-ink-1">{pct(t.prob, 1)}</span>
                <span className="text-[13px] text-ink-2">
                  · <strong className="font-semibold text-ink-1">1 de cada {int(t.oneIn)}</strong>
                </span>
              </span>
              <Meter value={t.prob} height={5} className="mt-2" label={`Probabilidad de la combinada ${pct(t.prob, 1)}`} />
            </div>

            <dl className="grid grid-cols-2 gap-3 text-[12.5px]">
              <div className="min-w-0">
                <dt className="eyebrow">Cuota justa</dt>
                <dd className="num mt-0.5 text-[16px] font-semibold text-ink-1" title="1 / probabilidad: lo que debería pagar sin margen">
                  {fmtOdds(t.fairOdds)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="eyebrow">Valor esperado</dt>
                <dd className="mt-0.5">
                  <span
                    className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-semibold', evPos ? 'border-accent-text/70 text-pos' : 'border-neg/40 text-neg')}
                    title="Probabilidad × cuota − 1, por unidad apostada"
                  >
                    <EvIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="num">{fmtEv(t.ev)}</span>
                  </span>
                </dd>
              </div>
            </dl>
            <p className="-mt-1 text-2xs leading-snug text-ink-3">
              {evPos
                ? 'Positivo con estas cuotas, pero lo normal es perderla igualmente.'
                : `De cada 10 € apostados, a la larga se pierden unos ${num(Math.abs(t.ev) * 10, 1)} €: es el margen de la casa multiplicado por ${int(legs.length)} patas.`}
            </p>

            <CumulativeLadder combo={combo} />

            {settled ? (
              <p className="flex items-center gap-2 text-[12.5px] text-ink-2">
                <ResultMark result={combo.result} className="h-5 w-5" />
                {combo.result === 'hit' ? 'Acertada' : combo.result === 'miss' ? 'Fallada' : 'Nula'} (a los 90 minutos).
              </p>
            ) : (
              <>
                {started && (
                  <p className="flex items-start gap-1.5 text-2xs leading-snug text-ink-2">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
                    Algún partido ya ha empezado: ya no se puede hacer entera antes del inicio. Se recalcula en cada actualización con los que faltan.
                  </p>
                )}
                <CopyLegsButton combo={combo} title={dayLabel ? `${combo.label} · ${dayLabel}` : combo.label} />
              </>
            )}
          </div>
        </aside>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
const dayText = (key: string | undefined) => (key && /^\d{4}-\d{2}-\d{2}$/.test(key) ? shortDate(fromDayKey(key)) : '—');
/** con menos patas, la diferencia real − previsto no se califica (puede ser azar) */
const SMALL_N = 50;
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x * 100), 1)} pp`;

/** Acierto real con su intervalo de Wilson al 90 % frente al esperado, en una escala común. */
function RateVsExpected({ h }: { h: Combo6History }) {
  if (!h.settled || !finite(h.hitRate)) return null;
  const [lo, hi] = finite(h.wilsonLow) && finite(h.wilsonHigh) ? [h.wilsonLow, h.wilsonHigh] : wilson90(h.hits, h.settled);
  const exp = finite(h.expectedHitRate) ? h.expectedHitRate : undefined;
  const max = Math.min(1, Math.max(0.1, Math.ceil(Math.max(hi, exp ?? 0, h.hitRate) * 20 + 0.25) / 20));
  const x = (v: number) => `${(Math.max(0, Math.min(max, v)) / max) * 100}%`;
  const ticks = Array.from({ length: Math.round(max * 20) + 1 }, (_, i) => i * 0.05).filter((v) => v <= max + 1e-9);
  return (
    <figure className="min-w-0" aria-label={`Acierto real ${pct(h.hitRate, 1)} (intervalo al 90 % ${ciText(lo, hi)}) frente al ${exp !== undefined ? pct(exp, 1) : '—'} esperado`}>
      <div className="relative mx-1 h-10" aria-hidden="true">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-strong" />
        <span className="absolute top-1/2 h-3 -translate-y-1/2 rounded-full bg-ink-3/35" style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})` }} />
        {exp !== undefined && (
          <span className="absolute top-1 h-8 w-0 border-l-2 border-dashed border-ink-2" style={{ left: x(exp) }}>
            <span className="absolute -top-0.5 left-1 whitespace-nowrap text-[10px] font-semibold text-ink-2">esperado</span>
          </span>
        )}
        <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-1 bg-accent" style={{ left: x(h.hitRate) }} />
      </div>
      <div className="relative mx-1 h-4 text-[10px] text-ink-3" aria-hidden="true">
        {ticks.map((v) => (
          <span key={v} className="num absolute -translate-x-1/2" style={{ left: x(v) }}>
            {pct(v)}
          </span>
        ))}
      </div>
      <figcaption className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-3">
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden="true" /> Real {pct(h.hitRate, 1)}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-4 rounded-full bg-ink-3/35" aria-hidden="true" /> Intervalo al 90 % {ciText(lo, hi)}
        </span>
        {exp !== undefined && (
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-0 border-l-2 border-dashed border-ink-2" aria-hidden="true" /> Esperado por el modelo {pct(exp, 1)}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
      <span className="eyebrow block leading-tight">{label}</span>
      <span className="mt-1 block font-display text-[26px] font-extrabold leading-none text-ink-1">{value}</span>
      {hint && <span className="mt-1 block text-2xs leading-snug text-ink-3">{hint}</span>}
    </div>
  );
}

/** Acierto de las patas por categoría (real frente a previsto), con barra y marca del previsto. */
function CategoryRecords({ rows }: { rows: Combo6History['byCategory'] }) {
  if (!rows.length) return <p className="text-[13px] text-ink-3">Todavía no hay patas resueltas.</p>;
  return (
    <ul className="grid gap-x-6 gap-y-0 sm:grid-cols-2" aria-label="Acierto de las patas por categoría">
      {rows.map((r) => {
        const Icon = COMBO6_CATEGORY_ICON[r.category as Combo6Category] ?? Layers;
        const diff = finite(r.hitRate) && finite(r.expectedHitRate) ? r.hitRate - r.expectedHitRate : undefined;
        const [lo, hi] = r.legs > 0 ? wilson90(r.hits, r.legs) : [0, 1];
        return (
          <li key={r.category} className="min-w-0 border-b border-line/70 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-ink-1">
                <Icon className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
                <span className="truncate">{r.label || COMBO6_CATEGORY_LABEL[r.category as Combo6Category] || r.category}</span>
                <span className="num shrink-0 text-2xs font-normal text-ink-3">n = {int(r.legs)}</span>
              </span>
              <span className="shrink-0 text-right text-[12.5px] text-ink-2">
                <strong className="num font-semibold text-ink-1">{pct(r.hitRate, 1)}</strong> real · <span className="num">{pct(r.expectedHitRate, 1)}</span> previsto
              </span>
            </div>
            <div className="relative mt-1.5 h-2 rounded-full bg-surface-3" aria-hidden="true">
              <span className="absolute inset-y-0 left-0 rounded-full bg-ink-3/60" style={{ width: `${Math.max(0, Math.min(1, r.hitRate)) * 100}%` }} />
              {finite(r.expectedHitRate) && <span className="absolute -inset-y-1 w-0.5 rounded bg-ink-1" style={{ left: `${Math.max(0, Math.min(1, r.expectedHitRate)) * 100}%` }} />}
            </div>
            <p className="mt-1 flex flex-wrap justify-between gap-x-3 text-2xs text-ink-3">
              <span>
                {int(r.hits)} de {int(r.legs)}
                {r.voids ? ` · ${plural(r.voids, 'nula')}` : ''} · IC 90 % {ciText(lo, hi)}
              </span>
              {diff !== undefined &&
                (r.legs < SMALL_N ? (
                  <span className="num text-ink-3" title={`Con menos de ${SMALL_N} patas la diferencia puede ser azar`}>
                    {pp(diff)} (muestra pequeña)
                  </span>
                ) : (
                  <span className={cx('num', Math.abs(diff) < 0.02 ? 'text-ink-3' : diff < 0 ? 'text-neg' : 'text-pos')}>
                    {pp(diff)} {Math.abs(diff) < 0.02 ? '(bien calibrado)' : diff < 0 ? '(el modelo era optimista)' : '(el modelo era prudente)'}
                  </span>
                ))}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** Últimas combinadas resueltas: fecha, resultado, cuota, probabilidad y ✓/✗ de cada pata (desplegable con el detalle). */
function RecentCombos({ items, now }: { items: Combo6Combo[]; now: number }) {
  if (!items.length) return <p className="text-[13px] text-ink-3">Todavía no hay combinadas resueltas.</p>;
  return (
    <Card pad="none" className="overflow-hidden">
      <ul className="divide-y divide-line/70" aria-label="Últimas combinadas resueltas, la más reciente primero">
        {items.map((c) => {
          const legs = combo6LegsByKickoff(c.legs);
          const t = combo6Totals(legs);
          const misses = legs.filter((l) => l.result === 'miss').length;
          return (
            <li key={c.id}>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2 sm:px-4 [&::-webkit-details-marker]:hidden">
                  <ResultMark result={c.result} className="h-6 w-6" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                      <span className="font-semibold capitalize text-ink-1">{dayText(c.date)}</span>
                      <span className="text-ink-3">
                        {plural(legs.length, 'pata')} · <span className="num">{t.estimatedLegs ? '≈ ' : ''}{fmtOdds(t.bookOdds)}</span> · <span className="num">{pct(t.prob, 1)}</span>
                      </span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1" role="img" aria-label={`${plural(legs.length - misses, 'pata')} sin fallar, ${plural(misses, 'fallada')}`}>
                      {legs.map((l, i) => (
                        <span
                          key={i}
                          title={`${l.home.short || l.home.name} – ${l.away.short || l.away.name}: ${l.selection}`}
                          aria-hidden="true"
                          className={cx(
                            'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded px-0.5 text-[10px] font-bold leading-none',
                            l.result === 'hit' ? 'bg-win/15 text-win' : l.result === 'miss' ? 'bg-loss/15 text-loss' : 'bg-draw/20 text-ink-2',
                          )}
                        >
                          {l.result === 'hit' ? '✓' : l.result === 'miss' ? '✗' : '='}
                        </span>
                      ))}
                    </span>
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden="true" />
                  <span className="sr-only">Ver las patas</span>
                </summary>
                <ol className="divide-y divide-line/60 border-t border-line bg-surface-2/30" aria-label="Patas">
                  {legs.map((l, i) => (
                    <li key={`${l.matchId}-${l.selection}`}>
                      <Combo6LegRow leg={l} index={i} now={now} day={c.date} settled hideReason />
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Bloque de historial fuera de muestra: acierto frente a lo esperado con Wilson, días, categorías y últimas combinadas. */
export function HistoryBlock({ history: h, now }: { history: Combo6History; now: number }) {
  const has = h.combos > 0;
  return (
    <div className="space-y-5">
      {h.warning && (
        <div role="note" className="flex items-start gap-2.5 rounded-lg border border-warn/60 bg-warn/[0.08] px-3.5 py-3 text-[13px] text-ink-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <p className="min-w-0 leading-snug [overflow-wrap:anywhere]">
            <strong className="font-semibold text-ink-1">Aviso automático: </strong>
            {h.warning}
          </p>
        </div>
      )}
      {!has ? (
        <p className="text-[13px] text-ink-2">Todavía no hay combinadas en el historial: la regla necesita reglas validadas y al menos 4 partidos con patas.</p>
      ) : (
        <Card className="space-y-4">
          <p className="text-[13.5px] leading-snug text-ink-2">
            Del <span className="font-semibold text-ink-1">{dayText(h.from)}</span> al <span className="font-semibold text-ink-1">{dayText(h.to)}</span>, la misma regla habría
            armado {plural(h.combos, 'combinada')} en {plural(h.days, 'día')} con partidos. Acertó{' '}
<strong className="font-semibold text-ink-1">{int(h.hits)}</strong> de <strong className="font-semibold text-ink-1">{int(h.settled)}</strong>
            {finite(h.hitRate) && h.settled > 0 && (
              <>
                {' '}
                (<span className="num">{pct(h.hitRate, 1)}</span>)
              </>
            )}
            ; el modelo esperaba un <span className="num">{pct(h.expectedHitRate, 1)}</span>.
          </p>
          <RateVsExpected h={h} />
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <Stat label="Acierto real" value={h.settled ? pct(h.hitRate, 1) : '—'} hint={h.settled ? `${int(h.hits)} de ${int(h.settled)}${h.voids ? ` · ${plural(h.voids, 'nula')}` : ''}` : undefined} />
            <Stat label="Esperado" value={pct(h.expectedHitRate, 1)} hint="Media de la probabilidad de cada combinada" />
            <Stat label="Peor racha" value={int(h.longestLosingStreak)} hint="Combinadas seguidas falladas" />
            <Stat label="Cuota media" value={`≈ ${fmtOdds(h.avgBookOdds)}`} hint={`Justa ${fmtOdds(h.avgFairOdds)} · ${num(h.avgLegs, 1)} patas de media`} />
          </div>
        </Card>
      )}

      {h.byCategory.length > 0 && (
        <div>
          <h3 className="mb-1 font-display text-[17px] font-bold uppercase text-ink-1">Acierto de las patas por mercado</h3>
          <p className="mb-2 text-[12.5px] text-ink-3">Barra: acierto real. Marca: lo que preveía el modelo. Si la barra no llega a la marca, el modelo era optimista en ese mercado.</p>
          <CategoryRecords rows={h.byCategory} />
        </div>
      )}

      {h.recent.length > 0 && (
        <div>
          <h3 className="mb-2 font-display text-[17px] font-bold uppercase text-ink-1">Últimas {int(h.recent.length)} combinadas</h3>
          <RecentCombos items={h.recent} now={now} />
        </div>
      )}

      <p className="flex items-start gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 text-[12.5px] leading-snug text-ink-2">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        <span>
          <strong className="font-semibold text-ink-1">La mayoría de los días se pierde.</strong> Cada pata paga el margen de la casa, así que el valor esperado es negativo
          aunque cada selección sea muy probable. Historial fuera de muestra: cada día se predijo solo con datos anteriores y se resolvió a los 90 minutos; una pata nula se
          quita de la combinada. No se calcula rentabilidad: la mayoría de las patas no tienen precio real. Solo mayores de 18 años (+18).
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cómo se arma
// ---------------------------------------------------------------------------
const whole = (x: number) => num(x, Number.isInteger(x) ? 0 : 1);
const MARGIN_ORDER: Combo6Category[] = ['ganador', 'goles', 'corners', 'tiros-puerta', 'tiros', 'tarjetas', 'faltas', 'jugadores'];

/** La regla en castellano llano, con las constantes del archivo (o las del motor si faltan). */
export function HowItsBuilt({ file }: { file: Combo6File }) {
  const r = { ...COMBO6_DEFAULT_RULE, ...file.rule };
  const margins = MARGIN_ORDER.filter((c) => finite(r.margins?.[c]));
  // agrupa categorías con el mismo margen: «5 %: ganador y goles; 7 %: córners, tiros…»
  const byMargin = new Map<number, string[]>();
  for (const c of margins) {
    const m = r.margins![c]!;
    byMargin.set(m, [...(byMargin.get(m) ?? []), COMBO6_CATEGORY_LABEL[c].toLowerCase()]);
  }
  const marginText = [...byMargin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, cs]) => `${pct(m)} en ${cs.length > 1 ? `${cs.slice(0, -1).join(', ')} y ${cs[cs.length - 1]}` : cs[0]}`)
    .join('; ');
  const steps = [
    <>
      <strong className="font-semibold text-ink-1">Solo mercados validados.</strong> Se parte de los mismos candidatos que «Pronósticos del día» y solo cuentan los mercados cuya regla ha
      acertado fuera de muestra lo que decía. La probabilidad de cada pata es la calibrada con los meses anteriores.
    </>,
    <>
      <strong className="font-semibold text-ink-1">Patas probables, pero no «seguras».</strong> Cada pata tiene entre un {pct(r.legMinProb)} y un {pct(r.legMaxProb)}. Las
      selecciones de 90 % pagan tan poco que harían falta 20 o más para llegar a 6, y cada una paga el margen de la casa: con menos patas, algo menos seguras, la
      combinada acierta más.
    </>,
    <>
      <strong className="font-semibold text-ink-1">Una pata por partido y mercados distintos.</strong> Entre {int(r.minLegs)} y {int(r.maxLegs)} partidos, con al menos{' '}
      {int(r.minCategories)} mercados distintos (ganador, goles, córners, tiros, tiros a puerta, tarjetas, faltas) y como mucho {int(r.maxPerCategory)} patas del mismo. Los
      jugadores no entran: dependen de la alineación y su acierto no supera a su tasa base.
    </>,
    <>
      <strong className="font-semibold text-ink-1">Cuota total entre {whole(r.targetMin)} y {whole(r.targetMax)}.</strong> Se usa la cuota de la casa cuando existe
      (DraftKings vía ESPN: 1X2 y línea principal de goles). Doble oportunidad y empate no apuesta se calculan desde el 1X2 de la casa. Para el resto, la cuota se estima: la justa
      menos un margen típico{marginText ? ` (${marginText})` : ''}. Por eso la cuota total lleva «≈»: compruébala en tu casa.
    </>,
    <>
      <strong className="font-semibold text-ink-1">La de mayor probabilidad.</strong> De todas las combinaciones que cumplen lo anterior, se publica la que tiene la probabilidad
      conjunta más alta (las patas son de partidos distintos: se multiplican).
    </>,
    <>
      <strong className="font-semibold text-ink-1">Cada 3 horas.</strong> Se recalcula en cada actualización de datos con los partidos que aún no han empezado. Además, para
      Champions, Europa League, Conference, Libertadores y Sudamericana se arma una con solo esa competición cuando tiene al menos 5 partidos con patas.
    </>,
  ];
  return (
    <details className="card group p-4 text-[13.5px] text-ink-2 sm:p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-display text-[17px] font-bold uppercase text-ink-1 [&::-webkit-details-marker]:hidden">
        Las {int(steps.length)} reglas, en castellano llano
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <ol className="mt-3 space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3 leading-snug">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong font-display text-[13px] font-extrabold text-ink-2" aria-hidden="true">
              {i + 1}
            </span>
            <span className="min-w-0">{s}</span>
          </li>
        ))}
      </ol>
      {file.note && <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-snug text-ink-3 [overflow-wrap:anywhere]">{file.note}</p>}
    </details>
  );
}
