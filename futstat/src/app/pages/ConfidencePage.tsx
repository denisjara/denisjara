import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BookOpen, Check, CircleSlash, Coins, History, ListChecks, Percent, ShieldCheck, Target, X } from 'lucide-react';
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
  Section,
  SegmentedControl,
  TierBadge,
  cx,
  groupByMatch,
  outOfSample,
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

/** "16 sept 2026" (día UTC de los cortes del pipeline). */
function day(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('.', '') : '—';
}

// ---------------------------------------------------------------------------
// Cabecera: cifra real del holdout
// ---------------------------------------------------------------------------
function Headline({ data, upcoming }: { data: ConfidenceFile; upcoming: Item[] }) {
  const h = data.track.holdout;
  const roi = data.track.roi;
  const matches = new Set(upcoming.map((x) => x.match.id)).size;
  if (!(h.n > 0)) {
    return <p className="text-[14px] text-ink-2">Todavía no hay suficientes partidos terminados para medir el acierto fuera de muestra.</p>;
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <span className="font-display text-[64px] font-extrabold leading-[0.85] text-accent-text sm:text-[84px]">{pct(h.hitRate, 1)}</span>
        <p className="max-w-xl pb-1 text-[15px] leading-snug text-ink-1 sm:text-[16px]">
          de acierto en <strong className="num font-semibold">{int(h.n)}</strong> pronósticos de partidos <strong className="font-semibold">no usados para calibrar</strong>
          <span className="mt-1 block text-[12.5px] text-ink-3">
            {day(h.from)} – {day(h.to)} · {int(h.matches)} partidos · intervalo de Wilson al 90%: {pct(h.wilsonLow, 1)}–{pct(h.wilsonHigh, 1)}
            {h.voids ? ` · ${plural(h.voids, 'nulo')}` : ''}
          </span>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Aciertos" value={`${int(h.hits)}/${int(h.n)}`} hint={data.track.virgin?.n ? `Tramo final ${pct(data.track.virgin.hitRate, 1)} (${int(data.track.virgin.n)})` : undefined} icon={<Target />} />
        <KpiTile label="Cuota justa media" value={num(data.track.avgFairOdds, 2)} hint={`Prob. media del modelo ${pct(data.track.avgProb)}`} icon={<Coins />} />
        <KpiTile
          label="ROI con cuotas de cierre"
          value={roi ? `${roi.roi >= 0 ? '+' : '−'}${pct(Math.abs(roi.roi), 1)}` : '—'}
          hint={roi ? `Solo ${int(roi.bets)} de ${int(h.picks)} picks tienen precio` : 'Sin cuotas para medirlo'}
          icon={<Percent />}
        />
        <KpiTile label="Próximos 14 días" value={int(upcoming.length)} hint={`En ${plural(matches, 'partido')}`} icon={<ShieldCheck />} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Qué es / qué no es
// ---------------------------------------------------------------------------
function WhatItIs({ data, accuracy1x2 }: { data: ConfidenceFile; accuracy1x2?: number }) {
  const t = data.track;
  const plata = t.byTier.find((x) => x.tier === 'plata');
  const cov = t.coverage.matches ? (t.coverage.matchesWithPick ?? 0) / t.coverage.matches : undefined;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="space-y-3">
        <h3 className="flex items-center gap-2 font-display text-[17px] font-bold uppercase text-ink-1">
          <Check className="h-4 w-4 text-win" aria-hidden="true" /> Qué es
        </h3>
        <ul className="space-y-2 text-[13.5px] leading-snug text-ink-2">
          <li>
            Entre más de 20 mercados de cada partido (doble oportunidad, hándicap +1,5, más/menos goles, goles por equipo, córners, tarjetas…), las
            selecciones en las que el modelo ha acertado <strong className="text-ink-1">al menos 4 de cada 5 veces</strong> cuando su probabilidad supera el umbral de esa familia.
          </li>
          <li>
            La cifra de arriba es <strong className="text-ink-1">fuera de muestra</strong>: las reglas se ajustaron con partidos anteriores y se midieron en partidos que no se usaron
            para elegir nada. Cada partido se predijo solo con datos previos a su inicio.
          </li>
          <li>
            Nivel <TierBadge tier="oro" className="mx-0.5 align-middle" /> si su franja acierta ≥ 85% en el histórico y <TierBadge tier="plata" className="mx-0.5 align-middle" /> si
            acierta ≥ 80%. Como mucho {data.rules.maxPerMatch || 2} pronósticos por partido, de temas distintos.
          </li>
        </ul>
      </Card>
      <Card className="space-y-3 border-warn/40">
        <h3 className="flex items-center gap-2 font-display text-[17px] font-bold uppercase text-ink-1">
          <CircleSlash className="h-4 w-4 text-warn" aria-hidden="true" /> Qué NO es
        </h3>
        <ul className="space-y-2 text-[13.5px] leading-snug text-ink-2">
          <li>
            <strong className="text-ink-1">No es una forma de ganar dinero.</strong> Son selecciones de cuota baja (cuota justa media {num(t.avgFairOdds, 2)}) y las casas cobran
            margen{t.roi ? `: donde hay precio de cierre (${int(t.roi.bets)} picks), apostar 1 unidad a cada uno habría dado un ROI de ${t.roi.roi >= 0 ? '+' : '−'}${pct(Math.abs(t.roi.roi), 1)}` : ''}. Para la mayoría
            (goles por equipo, hándicap, córners, tarjetas) la fuente no publica cuota y la rentabilidad no se puede medir.
          </li>
          <li>
            <strong className="text-ink-1">No es una lista de «apuestas seguras».</strong> Alrededor de 1 de cada {t.holdout.hitRate < 1 ? Math.round(1 / Math.max(0.01, 1 - t.holdout.hitRate)) : '—'} falla, y la cobertura
            es casi total{cov !== undefined ? ` (${pct(cov)} de los partidos tienen pronóstico)` : ''}.
          </li>
          <li>
            <strong className="text-ink-1">No mejora el 1X2</strong>
            {accuracy1x2 !== undefined ? `, que sigue acertando el ${pct(accuracy1x2, 1)} de los partidos (lo normal en fútbol, como el mercado).` : ' (resultado del partido), que sigue acertando poco más de la mitad de las veces, como el mercado.'}
            {plata && plata.n > 0 && plata.hitRate < 0.8 ? ` El nivel plata acierta ${pct(plata.hitRate, 1)} fuera de muestra (${int(plata.hits)}/${int(plata.n)}), por debajo de su etiqueta.` : ''}
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
  const oro = items.filter((x) => x.pick.tier === 'oro').length;
  return (
    <Card pad="none" className="overflow-hidden" aria-labelledby={`dia-${dayId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line bg-surface-2/70 px-3 py-2.5 sm:px-4">
        <h3 id={`dia-${dayId}`} className="font-display text-[17px] font-bold uppercase text-ink-1">
          {first ? `${relativeDay(first, now)}${['Hoy', 'Mañana', 'Ayer'].includes(relativeDay(first, now)) ? ` · ${shortDate(first)}` : ''}` : dayId}
        </h3>
        <span className="text-2xs text-ink-3">
          {plural(items.length, 'pronóstico')} en {plural(groups.length, 'partido')} · {int(oro)} oro · {int(items.length - oro)} plata
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
  const [tier, setTier] = useState<'all' | 'oro' | 'plata'>('all');
  const [onlyValidated, setOnlyValidated] = useState(false);
  const [dayId, setDayId] = useState<string>('all');
  const [daysShown, setDaysShown] = useState(DAYS_PAGE);
  const filtered = useMemo(
    () => items.filter((x) => (tier === 'all' || x.pick.tier === tier) && (!onlyValidated || outOfSample(x.pick) === 'ok')),
    [items, tier, onlyValidated],
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
          <SegmentedControl
            ariaLabel="Nivel"
            size="sm"
            value={tier}
            onChange={setTier}
            options={[
              { value: 'all', label: 'Todos', count: items.length },
              { value: 'oro', label: 'Oro', count: items.filter((x) => x.pick.tier === 'oro').length },
              { value: 'plata', label: 'Plata', count: items.filter((x) => x.pick.tier === 'plata').length },
            ]}
          />
          <ToggleSwitch checked={onlyValidated} onChange={setOnlyValidated} label="Solo mercados validados fuera de muestra" />
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
            {!r.active && ' · no se publica'}
            {r.thresholds.length === 1 && t.bySource && t.bySource.length > 1 ? ` · solo ${SOURCE_LABEL[r.thresholds[0].source].toLowerCase()}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'th', header: 'Umbral', title: 'Probabilidad mínima del modelo (reglas actuales, por fuente: con cuotas / sin cuotas)', sortValue: (r) => r.threshold, firstDir: 'asc', cell: (r) => <Thresholds f={r} /> },
    { key: 'n', header: 'Picks', title: 'Pronósticos resueltos fuera de muestra (holdout)', numeric: true, sortValue: (r) => r.n, cell: (r) => int(r.n) },
    {
      key: 'rate',
      header: 'Acierto',
      title: 'Acierto fuera de muestra (holdout)',
      numeric: true,
      sortValue: (r) => r.hitRate,
      cell: (r) =>
        r.hitRate === undefined ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className={cx('inline-flex items-center justify-end gap-1.5 font-semibold', r.n >= 20 && r.hitRate < 0.8 ? 'text-warn' : 'text-ink-1')}>
            {r.n >= 20 && r.hitRate < 0.8 && <AlertTriangle className="h-3.5 w-3.5" aria-label="Por debajo del 80%" />}
            {pct(r.hitRate, 1)}
          </span>
        ),
    },
    {
      key: 'note',
      header: 'Nota',
      hideBelow: 'md',
      className: 'min-w-[220px] max-w-[360px] text-[12px] text-ink-3',
      cell: (r) => r.note ?? (r.n >= 20 ? `${int(r.hits)} de ${int(r.n)}` : ''),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {t.byTier.map((x) => (
          <Card key={x.tier} pad="sm" className={cx('flex items-center justify-between gap-3', x.n > 0 && x.hitRate < 0.8 && 'border-warn/40')}>
            <span className="space-y-1">
              <TierBadge tier={x.tier} />
              <span className="block text-2xs text-ink-3">
                {int(x.hits)}/{int(x.n)} fuera de muestra
              </span>
            </span>
            <span className={cx('font-display text-[30px] font-extrabold leading-none', x.n > 0 && x.hitRate < 0.8 ? 'text-warn' : 'text-ink-1')}>{pct(x.hitRate, 1)}</span>
          </Card>
        ))}
        {(t.bySource ?? []).map((x) => (
          <Card key={x.source} pad="sm" className="flex items-center justify-between gap-3">
            <span className="space-y-1">
              <span className="eyebrow block">{SOURCE_LABEL[x.source]}</span>
              <span className="block text-2xs text-ink-3">
                {int(x.hits)}/{int(x.n)} fuera de muestra
              </span>
            </span>
            <span className="font-display text-[30px] font-extrabold leading-none text-ink-1">{pct(x.hitRate, 1)}</span>
          </Card>
        ))}
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.family} caption="Acierto fuera de muestra por familia de mercado" initialSort={{ key: 'n', dir: 'desc' }} />
      {discarded.length > 0 && (
        <details className="card group p-4 text-[13px] text-ink-2">
          <summary className="cursor-pointer select-none font-semibold text-ink-1">Mercados descartados ({discarded.length})</summary>
          <p className="mt-2 text-[12.5px] text-ink-3">No alcanzan el acierto exigido con muestra suficiente en el histórico, así que nunca se publican.</p>
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
        <span className="num font-display text-[22px] font-extrabold leading-none text-ink-1">{pct(settled.length ? hits / settled.length : undefined, 1)}</span>
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
  const steps = [
    'Cada partido terminado de la temporada se vuelve a predecir solo con datos anteriores a su inicio (Elo previo, Dixon-Coles re-ajustado, proyecciones de córners y tarjetas con partidos anteriores y cuotas de cierre). Sin cuotas, se exigen al menos 10 partidos previos de cada equipo.',
    `Calibración: con el 60% más antiguo${cal ? ` (${day(cal.from)} – ${day(cal.to)}, ${int(cal.matches)} partidos)` : ''} se recalibran las probabilidades de cada familia de mercado y se fija su umbral: la cola debe acertar ≥ ${pct(data.rules.targetRate || 0.82)} con al menos 80 casos y un límite inferior de Wilson ≥ 78%.`,
    `Holdout: esas reglas se aplican, sin tocar nada, a los partidos posteriores (${day(h.from)} – ${day(h.to)}). Esa es la cifra de la cabecera.`,
    `Producción: el mismo procedimiento con todo el histórico (${int(data.rules.matches)} partidos, ${plural(data.rules.active, 'regla activa', 'reglas activas')}) elige los pronósticos de los próximos partidos. Lo validado fuera de muestra es el procedimiento; cada pronóstico indica el acierto fuera de muestra de su mercado.`,
    'Resultados recientes: reconstrucción con la misma regla sin fuga (reglas ajustadas sin esos partidos y cuotas de cierre), no un registro de lo que se publicó en su momento.',
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
        eyebrow="Pronósticos de alta confianza · medidos fuera de muestra"
        title="Alta confianza"
        description="El 1X2 no puede acertar 4 de cada 5 partidos. Esto es otra cosa: entre muchos mercados de cada partido, solo los que han acertado al menos el 80% de las veces en partidos que no se usaron para calibrar el método."
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
        description={`Umbral de las reglas actuales y acierto en el holdout (${day(data.track.holdout.from)} – ${day(data.track.holdout.to)}), con reglas ajustadas sin esos partidos.`}
      >
        <ByMarket data={data} />
      </Section>

      <Section id="recientes" eyebrow="Últimos 14 días" title="Resultados recientes" icon={<History />} description="Pronósticos ya resueltos, del más reciente al más antiguo: ✓ acierto, ✗ fallo.">
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
