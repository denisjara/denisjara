import { useMemo, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, Loader2, Radio, Search, X, Zap } from 'lucide-react';
import type { CompetitionMeta, MatchSummary } from '../../types/data';
import { useCompetitions, useHome, useMeta } from '../lib/data';
import { LIVE_ENABLED, useLiveScores, withLive } from '../lib/live';
import { byTier, groupCompetitions, groupMatchesByCompetition } from '../lib/competitions';
import { addDays, capitalize, dayKey, fromDayKey, longDate, normalizeText, plural } from '../lib/format';
import { Disclaimer, EmptyState, ErrorState, MatchGroup, MatchRow, PageHeader, SegmentedControl, Skeleton, cx } from '../components';

const PAST_DAYS = 3;
const FUTURE_DAYS = 14;

type SortMode = 'comp' | 'hora';

function useCalendarParams() {
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  return { params, set };
}

/** Tira de fechas: hoy-3 … hoy+14. */
function DateStrip({ days, selected, todayKey, counts, onSelect }: { days: string[]; selected: string; todayKey: string; counts: Record<string, number | undefined>; onSelect: (d: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="date"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [selected]);
  return (
    <div ref={ref} className="scrollbar-none mask-fade-x -mx-1 flex gap-1.5 overflow-x-auto px-1 py-1" role="group" aria-label="Elegir día">
      {days.map((d) => {
        const date = fromDayKey(d);
        const active = d === selected;
        const isToday = d === todayKey;
        const past = d < todayKey;
        const wd = new Intl.DateTimeFormat('es-ES', { weekday: 'short' }).format(date).replace('.', '');
        const mon = new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(date).replace('.', '');
        const n = counts[d];
        return (
          <button
            key={d}
            type="button"
            onClick={() => onSelect(d)}
            aria-current={active ? 'date' : undefined}
            aria-label={`${capitalize(longDate(date))}${isToday ? ' (hoy)' : ''}${n !== undefined ? `, ${plural(n, 'partido')}` : ''}`}
            className={cx(
              'relative flex w-[58px] shrink-0 flex-col items-center rounded-xl border px-1 pb-1.5 pt-2 transition-colors',
              active ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-surface-1/80 hover:border-line-strong hover:bg-surface-2',
              past && !active && 'opacity-75',
            )}
          >
            <span className={cx('text-[10px] font-semibold uppercase tracking-[0.1em]', active ? 'text-accent-ink' : isToday ? 'text-accent-text' : 'text-ink-3')}>
              {isToday ? 'Hoy' : wd}
            </span>
            <span className={cx('font-display text-[24px] font-extrabold leading-none', active ? 'text-accent-ink' : 'text-ink-1')}>{date.getDate()}</span>
            <span className={cx('text-[10px] uppercase', active ? 'text-accent-ink/80' : 'text-ink-3')}>{mon}</span>
            <span className={cx('num mt-1 h-3.5 text-[10px] font-medium leading-none', active ? 'text-accent-ink' : 'text-ink-2')}>{n === undefined ? '·' : n}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function CalendarPage() {
  const { data: meta, error: metaError, reload: reloadMeta } = useMeta();
  const { data: home } = useHome();
  const { params, set } = useCalendarParams();

  const now = new Date();
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(addDays(now, 1));
  const days = useMemo(() => Array.from({ length: PAST_DAYS + FUTURE_DAYS + 1 }, (_, i) => dayKey(addDays(fromDayKey(todayKey), i - PAST_DAYS))), [todayKey]);

  const rawDay = params.get('d') ?? '';
  const selected = days.includes(rawDay) ? rawDay : todayKey;
  const comp = params.get('c') ?? '';
  const q = params.get('q') ?? '';
  const onlyValue = params.get('valor') === '1';
  const sort = (params.get('orden') === 'hora' ? 'hora' : 'comp') as SortMode;

  const compsById = useMemo(() => new Map((meta?.competitions ?? []).map((c) => [c.id, c])), [meta]);
  const groups = useMemo(() => (meta ? groupCompetitions(meta.competitions) : null), [meta]);

  // ¿Sirve home.json para el día elegido? (solo hoy/mañana y si home es del día actual)
  const homeFresh = !!home && dayKey(home.generatedAt) === todayKey;
  const fromHome = homeFresh && (selected === todayKey || selected === tomorrowKey);

  // Competiciones a cargar cuando home.json no basta
  const compIds = useMemo(() => {
    if (!meta || fromHome) return [];
    if (comp && compsById.has(comp)) return [comp];
    const future = selected >= todayKey;
    return [...meta.competitions]
      .filter((c) => (future ? c.upcomingCount > 0 || selected === todayKey : c.finishedCount > 0))
      .sort(byTier)
      .map((c) => c.id);
  }, [meta, fromHome, comp, compsById, selected, todayKey]);
  const multi = useCompetitions(compIds);

  // Partidos del día elegido
  const dayMatches = useMemo<MatchSummary[]>(() => {
    if (fromHome && home) {
      const list = selected === todayKey ? home.today : home.tomorrow;
      return comp ? list.filter((m) => m.compId === comp) : list;
    }
    const seen = new Map<string, MatchSummary>();
    for (const f of Object.values(multi.data)) {
      for (const m of [...f.results, ...f.upcoming, ...f.live]) {
        if (dayKey(m.date) === selected) seen.set(m.id, m);
      }
    }
    return [...seen.values()];
  }, [fromHome, home, selected, todayKey, comp, multi.data]);

  // Recuento por día (solo los conocidos)
  const counts = useMemo(() => {
    const out: Record<string, number | undefined> = {};
    const filt = (m: MatchSummary) => !comp || m.compId === comp;
    if (homeFresh && home) {
      out[todayKey] = home.today.filter(filt).length;
      out[tomorrowKey] = home.tomorrow.filter(filt).length;
    }
    const loaded = Object.values(multi.data);
    if (loaded.length && !multi.loading) {
      const tmp: Record<string, Set<string>> = {};
      for (const f of loaded) {
        for (const m of [...f.results, ...f.upcoming, ...f.live]) {
          if (!filt(m)) continue;
          const k = dayKey(m.date);
          (tmp[k] ??= new Set()).add(m.id);
        }
      }
      // El conjunto cargado solo es completo para los días del mismo lado que el elegido (futuro: competiciones con
      // partidos próximos; pasado: con resultados), salvo con una competición filtrada o con "hoy" (se cargan todas).
      const all = (!!comp && compsById.has(comp)) || selected === todayKey;
      const future = selected >= todayKey;
      for (const d of days) {
        if (out[d] !== undefined || (homeFresh && (d === todayKey || d === tomorrowKey))) continue;
        if (all || d >= todayKey === future) out[d] = tmp[d]?.size ?? 0;
      }
    }
    return out;
  }, [homeFresh, home, todayKey, tomorrowKey, multi.data, multi.loading, days, comp, compsById, selected]);

  const live = useLiveScores(selected === todayKey ? dayMatches : undefined);

  const filtered = useMemo(() => {
    const nq = normalizeText(q);
    return withLive(dayMatches, live).filter((m) => {
      if (onlyValue && !m.prediction?.pick) return false;
      if (nq && !normalizeText(`${m.home.name} ${m.away.name} ${m.home.abbr} ${m.away.abbr}`).includes(nq)) return false;
      return true;
    });
  }, [dayMatches, live, q, onlyValue]);

  const grouped = useMemo(() => groupMatchesByCompetition(filtered, meta?.competitions), [filtered, meta]);
  const byTime = useMemo(() => [...filtered].sort((a, b) => a.date.localeCompare(b.date) || a.compName.localeCompare(b.compName)), [filtered]);
  const liveCount = filtered.filter((m) => m.status === 'live').length;
  const valueCount = dayMatches.filter((m) => m.prediction?.pick).length;

  const loading = !meta || (!fromHome && multi.loading && Object.keys(multi.data).length === 0);
  const partial = !fromHome && multi.loading && Object.keys(multi.data).length > 0;

  if (metaError) return <ErrorState error={metaError} onRetry={reloadMeta} />;

  const selDate = fromDayKey(selected);
  const selLabel = selected === todayKey ? 'Hoy' : selected === tomorrowKey ? 'Mañana' : capitalize(longDate(selDate));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Calendario"
        title="Partidos"
        description="Todos los partidos de las competiciones cubiertas, del pasado reciente a las próximas dos semanas, con la predicción del modelo para cada uno."
      >
        <DateStrip days={days} selected={selected} todayKey={todayKey} counts={counts} onSelect={(d) => set({ d: d === todayKey ? null : d })} />
      </PageHeader>

      {/* Filtros: una fila sobre todo lo que filtran */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <label htmlFor="cal-q" className="sr-only">
            Buscar equipo
          </label>
          <input id="cal-q" type="search" value={q} onChange={(e) => set({ q: e.target.value })} placeholder="Buscar equipo…" className="input h-9 pl-9" />
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <label htmlFor="cal-comp" className="sr-only">
            Competición
          </label>
          <select id="cal-comp" value={comp} onChange={(e) => set({ c: e.target.value })} className="input h-9 min-w-0 flex-1 cursor-pointer pr-8 sm:w-auto sm:min-w-[240px] sm:flex-none">
            <option value="">Todas las competiciones</option>
            {groups?.leagues.map((g) => (
              <optgroup key={g.region} label={`Ligas · ${g.region}`}>
                {g.items.map((c: CompetitionMeta) => (
                  <option key={c.id} value={c.id}>
                    {c.flag} {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
            {groups?.competitions.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.flag} {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button
            type="button"
            onClick={() => set({ valor: onlyValue ? null : '1' })}
            aria-pressed={onlyValue}
            className={cx('btn h-9 py-0', onlyValue && 'border-accent-text/60 bg-accent/15 text-ink-1')}
          >
            <Zap className={cx('h-4 w-4', onlyValue ? 'text-accent-text' : 'text-ink-3')} aria-hidden="true" />
            Solo con valor
            {valueCount > 0 && <span className="num rounded bg-surface-3 px-1 text-2xs text-ink-2">{valueCount}</span>}
          </button>
          {(comp || q || onlyValue) && (
            <button type="button" className="btn-ghost h-9" onClick={() => set({ c: null, q: null, valor: null })}>
              <X className="h-4 w-4" aria-hidden="true" /> Limpiar
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="display text-[26px] text-ink-1">
            {selLabel}
            {!loading && <span className="ml-3 font-sans text-[14px] font-medium normal-case tracking-normal text-ink-3">{plural(filtered.length, 'partido')}</span>}
          </h2>
          <SegmentedControl
            ariaLabel="Ordenar"
            size="sm"
            value={sort}
            onChange={(v) => set({ orden: v === 'comp' ? null : v })}
            options={[
              { value: 'comp', label: 'Por competición' },
              { value: 'hora', label: 'Por hora' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-3 empty:hidden">
          {liveCount > 0 && (
            <span className="inline-flex items-center gap-1.5 font-semibold text-live">
              <Radio className="h-3.5 w-3.5" aria-hidden="true" /> {liveCount} en vivo{LIVE_ENABLED ? ' · se actualiza cada minuto' : ''}
            </span>
          )}
          {partial && (
            <span className="inline-flex items-center gap-1.5" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Cargando competiciones {multi.loaded}/{multi.total}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 xl:grid-cols-2" role="status" aria-live="polite">
          <span className="sr-only">Cargando partidos…</span>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="card space-y-3 p-4" aria-hidden="true">
              <Skeleton className="h-4 w-40" />
              {Array.from({ length: 4 }, (_, j) => (
                <Skeleton key={j} className="h-10 w-full" />
              ))}
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<CalendarDays />}
          title={dayMatches.length ? 'Ningún partido coincide con los filtros' : 'No hay partidos este día'}
          description={dayMatches.length ? 'Prueba a quitar filtros o buscar otro equipo.' : 'Elige otro día en la tira de fechas.'}
        />
      ) : sort === 'comp' ? (
        <div className="space-y-4">
          {grouped.map((g) => (
            <MatchGroup key={g.compId} compId={g.compId} compName={g.compName} meta={g.meta} matches={g.matches} live={live} showHit />
          ))}
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <ul className="divide-y divide-line/70">
            {byTime.map((m) => (
              <li key={m.id}>
                <MatchRow match={m} live={live[m.id]} showComp showHit />
              </li>
            ))}
          </ul>
        </div>
      )}

      {Object.keys(multi.errors).length > 0 && (
        <p className="text-[12px] text-ink-3">
          No se pudieron cargar {Object.keys(multi.errors).length} competiciones: {Object.keys(multi.errors).map((id) => compsById.get(id)?.shortName ?? id).join(', ')}.
        </p>
      )}

      <Disclaimer compact />
    </div>
  );
}
