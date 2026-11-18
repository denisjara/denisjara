import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Check, CircleSlash, History, ListChecks, Percent, ShieldCheck, Target, X } from 'lucide-react';
import type { ConfidenceFile, ConfidencePick, MatchSummary } from '../../types/data';
import { useConfidence, useHome } from '../lib/data';
import { useNow } from '../lib/hooks';
import { capitalize, dayKey, int, longDate, num, pct, plural, relativeDay, shortDate } from '../lib/format';
import { localizeDecimals } from '../lib/picks';
import {
  Card,
  ConfidenceRow,
  DataTable,
  Disclaimer,
  EmptyState,
  ErrorState,
  KpiTile,
  PageHeader,
  PageSkeleton,
  OOS_MIN_N,
  RateCI,
  Section,
  ciText,
  cx,
  groupByMatch,
  outOfSample,
  ownRate,
  type Column,
} from '../components';
import { ToggleSwitch } from './extra/ui';

type Item = { match: MatchSummary; pick: ConfidencePick };
type Recent = Item & { hit: boolean };
type FamilyRow = ConfidenceFile['track']['byFamily'][number];

/** partidos visibles por día en la vista «Todos los días» y partidos por página en resultados recientes */
const DAY_PREVIEW = 6;
/** días visibles (y de cada «ver más») en la vista «Todos los días» */
const DAYS_PAGE = 4;
const RECENT_PAGE = 12;
const THEME_LABEL: Record<FamilyRow['theme'], string> = { resultado: 'Resultado', goles: 'Goles', corners: 'Córners', tarjetas: 'Tarjetas' };
const SOURCE_LABEL = { mercado: 'Con cuotas', estadistico: 'Sin cuotas' } as const;

/** "26 oct" (día UTC, sin año). */
function dayShort(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '') : '—';
}

/** "16 sept 2026" (día UTC de los cortes del pipeline). */
function day(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('.', '') : '—';
}

// ---------------------------------------------------------------------------
// Cabecera: cifra real del holdout y su contexto (línea base sin modelo, tasa base, lift)
// ---------------------------------------------------------------------------
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x * 100), 1)} pp`;

/** Barra horizontal en escala 0–100 % (la escala completa muestra lo poco que separa a las tres cifras). */
function CompareBar({ label, sub, rate, n, hits, lo, hi, strong, hideN }: { label: string; sub?: string; rate: number; n: number; hits?: number; lo?: number; hi?: number; strong?: boolean; hideN?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 flex-1">
          <span className={cx('block text-[13px]', strong ? 'font-semibold text-ink-1' : 'text-ink-2')}>{label}</span>
          {sub && <span className="block text-2xs leading-snug text-ink-3">{sub}</span>}
        </span>
        <RateCI rate={rate} n={n} hits={hits} lo={lo} hi={hi} hideN={hideN} stacked className="shrink-0" valueClass={cx('text-[15px]', !strong && 'text-ink-2')} />
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
        <div className={cx('absolute inset-y-0 left-0 rounded-full', strong ? 'bg-accent' : 'bg-ink-3/60')} style={{ width: `${Math.max(0, Math.min(100, rate * 100))}%` }} />
        {lo !== undefined && hi !== undefined && (
          <div className="absolute inset-y-0 bg-ink-1/25" style={{ left: `${lo * 100}%`, width: `${Math.max(0.4, (hi - lo) * 100)}%` }} />
        )}
      </div>
    </div>
  );
}

function Context({ data }: { data: ConfidenceFile }) {
  const t = data.track;
  const h = t.holdout;
  const b = t.baseline;
  return (
    <Card className="space-y-4">
      <div className="space-y-1">
        <h2 className="eyebrow text-accent-text">Para ponerlo en contexto</h2>
        <p className="text-[13px] leading-snug text-ink-2">
          Mismos partidos del holdout, escala completa de 0 a 100%. El acierto alto es <strong className="text-ink-1">casi todo estructural</strong>: lo que aporta el modelo
          es poco.
        </p>
      </div>
      <CompareBar label="Estos pronósticos" sub={`Cuota justa media ${num(t.avgFairOdds, 2)}`} rate={h.hitRate} n={h.n} hits={h.hits} lo={h.wilsonLow} hi={h.wilsonHigh} strong />
      {t.expectedBaseRate !== undefined && (
        <CompareBar
          label="Tasa base de sus mercados"
          sub={`Cada pronóstico acertando como su mercado sin filtrar${t.lift !== undefined ? ` · el modelo añade ${pp(t.lift)}` : ''}`}
          rate={t.expectedBaseRate}
          n={h.n}
          hideN
        />
      )}
      {b && <CompareBar label="Estrategia fija sin modelo" sub={capitalize(b.label)} rate={b.hitRate} n={b.n} hits={b.hits} lo={b.wilsonLow} hi={b.wilsonHigh} />}
      <p className="text-2xs text-ink-3">Cifra · n = selecciones resueltas · intervalo de Wilson al 90% (la franja oscura de cada barra).</p>
    </Card>
  );
}

function Headline({ data, upcoming }: { data: ConfidenceFile; upcoming: Item[] }) {
  const t = data.track;
  const h = t.holdout;
  const wf = t.walkForward;
  const roi = t.roi ?? wf?.roi;
  const roiSrc = t.roi ? 'holdout' : 'walk-forward';
  const roiPicks = t.roi ? h.picks : (wf?.picks ?? 0);
  const matches = new Set(upcoming.map((x) => x.match.id)).size;
  if (!(h.n > 0)) {
    return <p className="text-[14px] text-ink-2">Todavía no hay suficientes partidos terminados para medir el acierto fuera de muestra.</p>;
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <span className="font-display text-[64px] font-extrabold leading-[0.85] text-accent-text sm:text-[84px]">{pct(h.hitRate, 1)}</span>
        <p className="max-w-xl pb-1 text-[15px] leading-snug text-ink-1 sm:text-[16px]">
          de acierto en <strong className="num font-semibold">{int(h.n)}</strong> selecciones muy probables y de cuota baja, en partidos{' '}
          <strong className="font-semibold">no usados para calibrar</strong>
          <span className="mt-1 block text-[12.5px] text-ink-3">
            {day(h.from)} – {day(h.to)} · {int(h.matches)} partidos · n = {int(h.n)} · Wilson 90%: {ciText(h.wilsonLow, h.wilsonHigh)}
            {h.voids ? ` · ${plural(h.voids, 'nulo')}` : ''}
          </span>
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Context data={data} />
        <div className="grid grid-cols-2 gap-3">
          <KpiTile
            label="Walk-forward mensual"
            value={wf && ownRate(wf.n) ? pct(wf.hitRate, 1) : '—'}
            hint={wf ? `n = ${int(wf.n)} · ${ciText(wf.wilsonLow, wf.wilsonHigh)}` : 'Sin datos'}
            icon={<History />}
          />
          <KpiTile
            label="Tramo final"
            value={t.virgin && ownRate(t.virgin.n) ? pct(t.virgin.hitRate, 1) : '—'}
            hint={t.virgin ? `Desde ${dayShort(t.virgin.from)} · n = ${int(t.virgin.n)} · ${ciText(t.virgin.wilsonLow, t.virgin.wilsonHigh)}` : 'Sin datos'}
            icon={<Target />}
          />
          <KpiTile
            label="ROI con cuotas de cierre"
            value={roi ? `${roi.roi >= 0 ? '+' : '−'}${pct(Math.abs(roi.roi), 1)}` : '—'}
            hint={roi ? `${roiSrc === 'holdout' ? 'Holdout' : 'Walk-forward'} · ${int(roi.bets)} de ${int(roiPicks)} con precio` : 'Sin cuotas para medirlo'}
            icon={<Percent />}
          />
          <KpiTile label="Próximos 14 días" value={int(upcoming.length)} hint={`En ${plural(matches, 'partido')} · prob. media ${pct(t.avgProb)}`} icon={<ShieldCheck />} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Qué es / qué no es
// ---------------------------------------------------------------------------
function WhatItIs({ data, accuracy1x2 }: { data: ConfidenceFile; accuracy1x2?: number }) {
  const t = data.track;
  const b = t.baseline;
  const cov = t.coverage.matches ? (t.coverage.matchesWithPick ?? 0) / t.coverage.matches : undefined;
  const negative = t.byFamily.filter((f) => ownRate(f.n) && f.lift !== undefined && f.lift < 0);
  const roi = t.roi ?? t.walkForward?.roi;
  const v = data.rules.validation ?? { minN: 30, minRate: 0.8 };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="space-y-3">
        <h3 className="flex items-center gap-2 font-display text-[17px] font-bold uppercase text-ink-1">
          <Check className="h-4 w-4 text-win" aria-hidden="true" /> Qué es
        </h3>
        <ul className="space-y-2 text-[13.5px] leading-snug text-ink-2">
          <li>
            Entre más de 20 mercados de cada partido (doble oportunidad, hándicap +1,5, más/menos goles, goles por equipo, córners, tarjetas…),{' '}
            <strong className="text-ink-1">selecciones muy probables con cuota baja</strong>: probabilidad media {pct(t.avgProb)}, cuota justa media {num(t.avgFairOdds, 2)}.
          </li>
          <li>
            Solo se publican mercados <strong className="text-ink-1">validados fuera de muestra</strong>: al menos {int(v.minN)} casos y un {pct(v.minRate)} de acierto en un
            walk-forward mensual, y solo la franja de probabilidad que acierta ≥ {pct(data.rules.minHitRate || 0.85)} en su histórico. Como mucho {data.rules.maxPerMatch || 2}{' '}
            por partido, de temas distintos.
          </li>
          <li>
            La cifra de arriba es <strong className="text-ink-1">fuera de muestra</strong>: las reglas se ajustaron con partidos anteriores y se midieron en partidos que no se
            usaron para ajustarlas. Cada partido se predijo solo con datos previos a su inicio y se resuelve a 90 minutos, como en las casas.
          </li>
        </ul>
      </Card>
      <Card className="space-y-3 border-warn/40">
        <h3 className="flex items-center gap-2 font-display text-[17px] font-bold uppercase text-ink-1">
          <CircleSlash className="h-4 w-4 text-warn" aria-hidden="true" /> Qué NO es
        </h3>
        <ul className="space-y-2 text-[13.5px] leading-snug text-ink-2">
          <li>
            <strong className="text-ink-1">No es una ventaja frente a la casa.</strong>
            {b ? ` Apostar siempre lo mismo sin ningún modelo (${b.label}) acierta un ${pct(b.hitRate, 1)} en esos partidos.` : ''}
            {t.lift !== undefined ? ` Frente a la tasa base de sus mercados, el modelo añade ${pp(t.lift)}.` : ''}
            {negative.length ? ` En ${negative.map((f) => localizeDecimals(f.label).toLowerCase()).join(', ')} filtrar con el modelo acierta menos que publicar siempre.` : ''}
          </li>
          <li>
            <strong className="text-ink-1">No es una forma de ganar dinero.</strong> Las casas cobran margen sobre cuotas así de bajas
            {roi ? `: donde hay precio de cierre (${int(roi.bets)} picks), apostar 1 unidad a cada uno habría dado un ROI de ${roi.roi >= 0 ? '+' : '−'}${pct(Math.abs(roi.roi), 1)}` : ''}. Para la
            mayoría (goles por equipo, hándicap, córners, tarjetas) la fuente no publica cuota y la rentabilidad no se puede medir.
          </li>
          <li>
            <strong className="text-ink-1">No es una lista de «apuestas seguras».</strong> Alrededor de 1 de cada {t.holdout.hitRate < 1 ? Math.round(1 / Math.max(0.01, 1 - t.holdout.hitRate)) : '—'} falla, y la
            cobertura es casi total{cov !== undefined ? ` (${pct(cov)} de los partidos tienen pronóstico)` : ''}.
          </li>
          <li>
            <strong className="text-ink-1">No mejora el 1X2</strong>
            {accuracy1x2 !== undefined ? `, que sigue acertando el ${pct(accuracy1x2, 1)} de los partidos (lo normal en fútbol, como el mercado).` : ' (resultado del partido), que sigue acertando poco más de la mitad de las veces, como el mercado.'}
          </li>
          <li className="flex items-start gap-2 rounded-lg border border-line bg-surface-2/70 px-3 py-2 text-[12.5px]">
            <span className="mt-px shrink-0 font-display text-[13px] font-extrabold text-ink-1">+18</span>
            <span>Información estadística, no consejos de apuesta. Si apuestas, solo con dinero que puedas permitirte perder y con límites.</span>
          </li>
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Próximos pronósticos, agrupados por día
// ---------------------------------------------------------------------------
function DayGroup({ dayId, items, limit, onShowAll, now }: { dayId: string; items: Item[]; limit?: number; onShowAll?: () => void; now: Date }) {
  const groups = groupByMatch(items);
  const shown = limit ? groups.slice(0, limit) : groups;
  const first = items[0]?.match.date;
  return (
    <Card pad="none" className="overflow-hidden" aria-labelledby={`dia-${dayId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line bg-surface-2/70 px-3 py-2.5 sm:px-4">
        <h3 id={`dia-${dayId}`} className="font-display text-[17px] font-bold uppercase text-ink-1">
          {first ? `${relativeDay(first, now)}${['Hoy', 'Mañana', 'Ayer'].includes(relativeDay(first, now)) ? ` · ${shortDate(first)}` : ''}` : dayId}
        </h3>
        <span className="text-2xs text-ink-3">
          {plural(items.length, 'pronóstico')} en {plural(groups.length, 'partido')}
        </span>
      </div>
      <ul className="divide-y divide-line/70">
        {shown.map((g) => (
          <li key={g.match.id}>
            <ConfidenceRow match={g.match} picks={g.picks} when="time" />
          </li>
        ))}
      </ul>
      {limit && groups.length > limit && onShowAll && (
        <div className="border-t border-line px-3 py-2.5 text-center sm:px-4">
          <button type="button" className="btn-ghost" onClick={onShowAll}>
            Ver los {int(groups.length)} partidos del día
          </button>
        </div>
      )}
    </Card>
  );
}

function Upcoming({ items, now }: { items: Item[]; now: Date }) {
  const [onlyValidated, setOnlyValidated] = useState(false);
  const [dayId, setDayId] = useState<string>('all');
  const [daysShown, setDaysShown] = useState(DAYS_PAGE);
  const filtered = useMemo(
    () => items.filter((x) => !onlyValidated || outOfSample(x.pick) === 'ok'),
    [items, onlyValidated],
  );
  const days = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of filtered) {
      const k = dayKey(it.match.date);
      const arr = m.get(k) ?? [];
      arr.push(it);
      m.set(k, arr);
    }
    return [...m.entries()];
  }, [filtered]);
  const current = dayId !== 'all' && days.some(([k]) => k === dayId) ? dayId : 'all';
  const hiddenUnvalidated = items.filter((x) => outOfSample(x.pick) !== 'ok').length;

  if (!items.length) {
    return <EmptyState icon={<ShieldCheck />} title="Sin pronósticos de alta confianza" description="Ningún partido de los próximos 14 días supera los umbrales de su mercado." />;
  }
  return (
    <div className="space-y-4">
      <Card pad="sm" className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3" role="group" aria-label="Filtros de pronósticos">
          <ToggleSwitch checked={onlyValidated} onChange={setOnlyValidated} label={`Solo con validación amplia (≥ ${OOS_MIN_N} casos fuera de muestra)`} />
          {onlyValidated && hiddenUnvalidated > 0 && <span className="text-2xs text-ink-3">{plural(hiddenUnvalidated, 'pronóstico oculto', 'pronósticos ocultos')}</span>}
        </div>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none" role="group" aria-label="Día">
          {[['all', filtered] as [string, Item[]], ...days].map(([k, arr]) => {
            const active = current === k;
            const label = k === 'all' ? 'Todos los días' : capitalize(relativeDay(arr[0].match.date, now));
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => setDayId(k)}
                className={cx(
                  'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors',
                  active ? 'border-accent-text bg-surface-3 text-ink-1' : 'border-line bg-surface-2 text-ink-2 hover:text-ink-1',
                )}
              >
                {label}
                <span className="num text-[11px] text-ink-3">{int(arr.length)}</span>
              </button>
            );
          })}
        </div>
      </Card>
      {filtered.length === 0 ? (
        <EmptyState compact icon={<ShieldCheck />} title="Ningún pronóstico con estos filtros" />
      ) : current === 'all' ? (
        <div className="space-y-4">
          {days.slice(0, daysShown).map(([k, arr]) => (
            <DayGroup key={k} dayId={k} items={arr} limit={DAY_PREVIEW} onShowAll={() => setDayId(k)} now={now} />
          ))}
          {days.length > daysShown && (
            <div className="flex justify-center">
              <button type="button" className="btn" onClick={() => setDaysShown((n) => n + DAYS_PAGE)}>
                Ver {plural(Math.min(DAYS_PAGE, days.length - daysShown), 'día')} más
              </button>
            </div>
          )}
        </div>
      ) : (
        <DayGroup dayId={current} items={days.find(([k]) => k === current)?.[1] ?? []} now={now} />
      )}
      <p className="text-2xs text-ink-3">
        «Mercado» = cuota de la casa cuando la fuente la publica (casi nunca en estos mercados). * Cuota sintética de doble oportunidad o empate no
        apuesta, calculada desde el 1X2 de la casa (realizable repartiendo la apuesta).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Acierto por mercado
// ---------------------------------------------------------------------------
function Thresholds({ f }: { f: FamilyRow }) {
  if (!f.thresholds.length) return <span className="text-ink-3">—</span>;
  return (
    <span className="block space-y-0.5">
      {f.thresholds.map((t) => (
        <span key={t.source} className="block whitespace-nowrap">
          <span className="num text-ink-1">≥ {num(t.threshold, 2)}</span>
          {f.thresholds.length > 1 && <span className="ml-1.5 text-2xs text-ink-3">{SOURCE_LABEL[t.source].toLowerCase()}</span>}
        </span>
      ))}
    </span>
  );
}

/** Validación walk-forward de las reglas publicadas de una familia y avisos. */
function FamilyNote({ f }: { f: FamilyRow }) {
  const parts: string[] = [];
  for (const t of f.thresholds) {
    if (t.validationN === undefined) continue;
    const src = f.thresholds.length > 1 ? ` ${SOURCE_LABEL[t.source].toLowerCase()}` : '';
    parts.push(
      ownRate(t.validationN)
        ? `Validación${src}: ${pct(t.validationHitRate, 1)} (n = ${int(t.validationN)})`
        : `Validación${src}: muestra pequeña (n = ${int(t.validationN)})`,
    );
  }
  const text = [parts.join(' · '), f.note].filter(Boolean).join('. ');
  return <span>{text || '—'}</span>;
}

function SourceCard({ label, rec, hint }: { label: string; rec: { n: number; hits: number; hitRate: number; wilsonLow?: number; wilsonHigh?: number }; hint: string }) {
  return (
    <Card pad="sm" className="flex items-center justify-between gap-3">
      <span className="min-w-0 space-y-1">
        <span className="eyebrow block">{label}</span>
        <span className="block text-2xs text-ink-3">{hint}</span>
      </span>
      {ownRate(rec.n) ? (
        <span className="shrink-0 text-right">
          <span className="block font-display text-[30px] font-extrabold leading-none text-ink-1">{pct(rec.hitRate, 1)}</span>
          <span className="num block text-2xs text-ink-3">
            n = {int(rec.n)} · {ciText(rec.wilsonLow, rec.wilsonHigh)}
          </span>
        </span>
      ) : (
        <span className="shrink-0 text-right text-[13px] text-ink-3">
          Muestra pequeña
          <span className="num block text-2xs">n = {int(rec.n)}</span>
        </span>
      )}
    </Card>
  );
}

function ByMarket({ data }: { data: ConfidenceFile }) {
  const t = data.track;
  const rows = t.byFamily.filter((f) => f.active || f.n > 0);
  const discarded = t.byFamily.filter((f) => !f.active && f.n === 0);
  const columns: Column<FamilyRow>[] = [
    {
      key: 'family',
      header: 'Mercado',
      sticky: true,
      sortValue: (r) => r.label,
      firstDir: 'asc',
      className: 'min-w-[170px]',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block font-semibold text-ink-1">{localizeDecimals(r.label)}</span>
          <span className="block text-2xs text-ink-3">
            {THEME_LABEL[r.theme]}
            {!r.active && ' · ya no se publica'}
            {r.thresholds.length === 1 && t.bySource && t.bySource.length > 1 ? ` · solo ${SOURCE_LABEL[r.thresholds[0].source].toLowerCase()}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'th', header: 'Umbral', title: 'Probabilidad mínima del modelo de las reglas publicadas (por fuente: con cuotas / sin cuotas)', sortValue: (r) => r.threshold, firstDir: 'asc', cell: (r) => <Thresholds f={r} /> },
    {
      key: 'rate',
      header: 'Acierto (holdout)',
      title: 'Acierto fuera de muestra (holdout) · n · intervalo de Wilson al 90 %. Con menos de 50 casos no se da acierto propio.',
      numeric: true,
      sortValue: (r) => (ownRate(r.n) ? r.hitRate : r.n ? -1 + r.n / 1000 : undefined),
      cell: (r) => <RateCI rate={r.hitRate} n={r.n} hits={r.hits} lo={r.wilsonLow} hi={r.wilsonHigh} className="min-w-[96px]" />,
    },
    {
      key: 'base',
      header: 'Tasa base',
      title: 'Acierto del mercado sin filtrar: su selección natural en todos los partidos del holdout con dato',
      numeric: true,
      sortValue: (r) => r.baseRate,
      cell: (r) =>
        r.baseRate === undefined ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
            <span className="num text-ink-2">{pct(r.baseRate, 1)}</span>
            {r.baseN !== undefined && <span className="whitespace-nowrap text-2xs tabular-nums text-ink-3">n = {int(r.baseN)}</span>}
          </span>
        ),
    },
    {
      key: 'lift',
      header: 'Lift',
      title: 'Acierto − tasa base, en puntos porcentuales (solo con al menos 50 casos)',
      numeric: true,
      sortValue: (r) => (ownRate(r.n) ? r.lift : undefined),
      cell: (r) =>
        ownRate(r.n) && r.lift !== undefined ? (
          <span className={cx('num font-semibold', r.lift < 0 ? 'text-warn' : 'text-ink-1')}>{pp(r.lift)}</span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      key: 'fair',
      header: 'Cuota justa',
      title: 'Cuota justa media (1 / probabilidad) de sus pronósticos en el holdout',
      numeric: true,
      hideBelow: 'sm',
      sortValue: (r) => r.avgFairOdds,
      cell: (r) => (r.avgFairOdds ? <span className="num text-ink-2">{num(r.avgFairOdds, 2)}</span> : <span className="text-ink-3">—</span>),
    },
    {
      key: 'note',
      header: 'Validación y notas',
      hideBelow: 'md',
      className: 'min-w-[220px] max-w-[360px] text-[12px] text-ink-3',
      cell: (r) => <FamilyNote f={r} />,
    },
  ];
  const wf = t.walkForward;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(t.bySource ?? []).map((x) => (
          <SourceCard key={x.source} label={`${SOURCE_LABEL[x.source]} · holdout`} rec={x} hint={`${int(x.hits)}/${int(x.n)} aciertos`} />
        ))}
        {wf && <SourceCard label="Walk-forward mensual" rec={wf} hint={`${day(wf.from)} – ${day(wf.to)} · reglas reajustadas cada mes`} />}
        {t.baseline && <SourceCard label="Sin modelo · holdout" rec={t.baseline} hint="Visitante < 3 goles + más de 1,5 tarjetas, siempre" />}
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.family} caption="Acierto fuera de muestra por familia de mercado" initialSort={{ key: 'rate', dir: 'desc' }} />
      <p className="text-2xs text-ink-3">
        Lift negativo (en naranja): publicar ese mercado en todos los partidos habría acertado más que filtrarlo con el modelo. «Validación»: acierto de las reglas
        publicadas en el walk-forward mensual, el que decide si se publican (≥ {int(data.rules.validation?.minN ?? 30)} casos y ≥ {pct(data.rules.validation?.minRate ?? 0.8)}).
      </p>
      {discarded.length > 0 && (
        <details className="card group p-4 text-[13px] text-ink-2">
          <summary className="cursor-pointer select-none font-semibold text-ink-1">Mercados que no se publican ({discarded.length})</summary>
          <p className="mt-2 text-[12.5px] text-ink-3">
            No alcanzan el acierto exigido con muestra suficiente, no tienen validación fuera de muestra suficiente o se excluyeron por fallar fuera de muestra.
          </p>
          <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {discarded.map((f) => (
              <li key={f.family} className="flex items-start gap-2">
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                <span>
                  <span className="text-ink-1">{localizeDecimals(f.label)}</span>
                  {f.note && <span className="block text-2xs text-ink-3">{f.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resultados recientes
// ---------------------------------------------------------------------------
function RecentResults({ items }: { items: Recent[] }) {
  const [limit, setLimit] = useState(RECENT_PAGE);
  const groups = useMemo(() => groupByMatch(items), [items]);
  const settled = items.filter((x) => x.pick.result === 'hit' || x.pick.result === 'miss');
  const hits = settled.filter((x) => x.pick.result === 'hit').length;
  const voids = items.length - settled.length;
  if (!items.length) return <EmptyState compact icon={<History />} title="Sin resultados recientes" description="No hay pronósticos resueltos en los últimos 14 días." />;
  return (
    <Card pad="none" className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface-2/70 px-3 py-2.5 sm:px-4">
        <span className="text-[13px] text-ink-2">
          <strong className="font-semibold text-ink-1">{int(hits)}</strong> aciertos de <strong className="font-semibold text-ink-1">{int(settled.length)}</strong> en 14 días
          {voids > 0 && <span className="text-ink-3"> · {plural(voids, 'nulo')}</span>}
        </span>
        <RateCI rate={settled.length ? hits / settled.length : undefined} n={settled.length} hits={hits} valueClass="font-display text-[22px] font-extrabold leading-none" />
        <span className="flex gap-[2px]" aria-hidden="true">
          {settled.slice(0, 24).map((x) => (
            <span key={`${x.match.id}-${x.pick.family}`} className={cx('flex h-4 w-4 items-center justify-center rounded-[3px]', x.pick.result === 'hit' ? 'bg-win text-win-ink' : 'bg-loss text-loss-ink')}>
              {x.pick.result === 'hit' ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
            </span>
          ))}
        </span>
      </div>
      <ul className="divide-y divide-line/70">
        {groups.slice(0, limit).map((g) => (
          <li key={g.match.id}>
            <ConfidenceRow match={g.match} picks={g.picks} settled showOdds={false} />
          </li>
        ))}
      </ul>
      {groups.length > limit && (
        <div className="border-t border-line px-3 py-2.5 text-center sm:px-4">
          <button type="button" className="btn-ghost" onClick={() => setLimit((l) => l + RECENT_PAGE * 2)}>
            Mostrar {plural(Math.min(RECENT_PAGE * 2, groups.length - limit), 'partido')} más
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Método
// ---------------------------------------------------------------------------
function Method({ data }: { data: ConfidenceFile }) {
  const cal = data.track.calibration;
  const h = data.track.holdout;
  const v = data.rules.validation ?? { minN: 30, minRate: 0.8 };
  const excluded = data.track.excluded ?? [];
  const steps = [
    'Cada partido terminado de la temporada se vuelve a predecir solo con datos anteriores a su inicio (Elo previo, Dixon-Coles re-ajustado, proyecciones de córners y tarjetas con partidos anteriores y cuotas de cierre). Sin cuotas, se exigen al menos 10 partidos previos de cada equipo. Se resuelve a 90 minutos: con prórroga o penaltis, goles con los eventos hasta el 90 y sin córners ni tarjetas; 0 tarjetas cuenta como dato ausente.',
    `Calibración: con el 60% más antiguo${cal ? ` (${day(cal.from)} – ${day(cal.to)}, ${int(cal.matches)} partidos)` : ''} se recalibran las probabilidades de cada familia de mercado y se fija su umbral: la cola debe acertar ≥ ${pct(data.rules.targetRate || 0.82)} con al menos 80 casos y un límite inferior de Wilson ≥ 78%. Solo se publica la franja que acierta ≥ ${pct(data.rules.minHitRate || 0.85)}.`,
    `Validación por regla: un walk-forward mensual repite todo el procedimiento cada mes con los partidos anteriores; una regla (mercado y fuente) solo se publica con ≥ ${int(v.minN)} casos y ≥ ${pct(v.minRate)} de acierto fuera de muestra en los meses anteriores.${excluded.length ? ` Excluida de antemano por fallar en ese walk-forward: ${excluded.map((e) => localizeDecimals(e.label).toLowerCase()).join(', ')}.` : ''}`,
    `Holdout: esas reglas se aplican, sin tocar nada, a los partidos posteriores (${day(h.from)} – ${day(h.to)}). Esa es la cifra de la cabecera, junto a la línea base sin modelo y la tasa base de cada mercado en los mismos partidos.`,
    `Producción: el mismo procedimiento con todo el histórico (${int(data.rules.matches)} partidos) y la validación de todo el walk-forward: ${plural(data.rules.active, 'regla publicada', 'reglas publicadas')}${data.rules.unvalidated ? ` y ${plural(data.rules.unvalidated, 'sin validar', 'sin validar')} (no se publican)` : ''}. Cada pronóstico indica el acierto fuera de muestra de su regla con n e intervalo; con menos de ${OOS_MIN_N} casos, «muestra pequeña».`,
    'Resultados recientes: los que habría publicado el walk-forward mensual (reglas ajustadas sin esos partidos y cuotas de cierre), no un registro de lo que se publicó en su momento.',
    'Transparencia: las correcciones de la revisión del 18 nov 2026 (solo franja oro, sin «más de 2,5 tarjetas», validación por regla, resolución a 90 minutos) se decidieron después de ver el holdout y el walk-forward, así que el holdout ya no es del todo virgen para ellas. Antes, con datos hasta el 14 nov, acertaba 88,8% (n = 2.841; Wilson 87,8–89,7%).',
  ];
  return (
    <Card className="space-y-3">
      <ol className="space-y-2.5 text-[13.5px] leading-snug text-ink-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="num mt-px w-5 shrink-0 text-[12px] font-semibold text-accent-text">{String(i + 1).padStart(2, '0')}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      {data.note && <p className="rounded-lg border border-warn/40 bg-warn/[0.06] px-3 py-2 text-[12.5px] text-ink-2">{data.note}</p>}
      <p className="text-[12.5px] text-ink-3">
        Detalles y limitaciones en{' '}
        <Link to="/modelo" className="link">
          Modelo y backtest
        </Link>
        .
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function ConfidencePage() {
  const { data, error, loading, reload } = useConfidence();
  const { data: home } = useHome();
  const nowDate = useNow(60_000);
  const now = nowDate.getTime();
  // los partidos ya empezados (el pipeline los publica unas horas como «programados») no se ofrecen como próximos
  const upcoming = useMemo(() => (data?.picks ?? []).filter((x) => x.match.status === 'scheduled' && Date.parse(x.match.date) > now), [data, now]);

  if (loading && !data) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Selecciones muy probables con cuota baja · medidas fuera de muestra"
        title="Alta confianza"
        description="El 1X2 no puede acertar 4 de cada 5 partidos. Esto es otra cosa: entre muchos mercados de cada partido, selecciones muy probables y de cuota baja cuyo mercado ha acertado al menos el 80% fuera de muestra. Aciertan mucho porque son fáciles, no porque ganen a la casa."
      >
        <Headline data={data} upcoming={upcoming} />
      </PageHeader>

      <Section id="que-es" eyebrow="Antes de nada" title="Qué es y qué no es" icon={<BookOpen />}>
        <WhatItIs data={data} accuracy1x2={home?.modelHeadline?.accuracy} />
      </Section>

      <Section
        id="proximos"
        eyebrow="Próximos 14 días"
        title="Pronósticos"
        icon={<ShieldCheck />}
        description="Probabilidad del modelo, cuota justa (1 / probabilidad) y cuota de la casa cuando la fuente la publica. Pulsa un pronóstico para ver el análisis del partido."
      >
        <Upcoming items={upcoming} now={nowDate} />
      </Section>

      <Section
        id="mercados"
        eyebrow="Fuera de muestra"
        title="Acierto por mercado"
        icon={<ListChecks />}
        description={`Acierto en el holdout (${day(data.track.holdout.from)} – ${day(data.track.holdout.to)}) con reglas ajustadas sin esos partidos, frente a la tasa base de cada mercado en los mismos partidos.`}
      >
        <ByMarket data={data} />
      </Section>

      <Section
        id="recientes"
        eyebrow="Últimos 14 días"
        title="Resultados recientes"
        icon={<History />}
        description="Lo que habría publicado el walk-forward mensual, ya resuelto, del más reciente al más antiguo: ✓ acierto, ✗ fallo."
      >
        <RecentResults items={data.recent} />
      </Section>

      <Section id="metodo" eyebrow="Metodología" title="Cómo se calcula" icon={<BookOpen />}>
        <Method data={data} />
      </Section>

      <p className="text-[12px] text-ink-3">Datos generados el {longDate(data.generatedAt)}.</p>
      <Disclaimer />
    </div>
  );
}
