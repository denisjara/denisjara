import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, CalendarCheck, CalendarClock, Layers, ListOrdered, ShieldCheck, Target, Trophy } from 'lucide-react';
import type { DailyCategory, DailyDay, DailyFile } from '../../types/data';
import { isValidCompId, useDaily, useMeta } from '../lib/data';
import { useMediaQuery, useNow } from '../lib/hooks';
import {
  categoryOrder,
  dailyTop,
  defaultDay,
  filterDailyMatches,
  groupDailyByCompetition,
  isDailyCategory,
  isMarqueeCompetition,
  nextDayWithPicks,
  upcomingFirst,
  type DailyCompGroup,
} from '../lib/daily';
import { capitalize, dayKey, fromDayKey, int, longDate, pct, plural, relativeDay, shortDate } from '../lib/format';
import {
  CATEGORY_ICON,
  Card,
  CompetitionBadge,
  DailyTopRow,
  Disclaimer,
  EmptyState,
  ErrorState,
  KpiTile,
  PageHeader,
  Section,
  Skeleton,
  SkeletonCard,
  ciText,
  cx,
  ownRate,
} from '../components';
import { ComboCard, ComboWarning, DailyMatchCard, FeaturedCompetition, HowToRead } from './daily/parts';

/** «Hoy», «Mañana» o «jue 26 nov» para un día YYYY-MM-DD. */
const dayName = (date: string, now: Date) => relativeDay(fromDayKey(date), now);

// ---------------------------------------------------------------------------
// Chips (día, competición, categoría)
// ---------------------------------------------------------------------------
function Chip({ active, onClick, count, disabled, children, title }: { active: boolean; onClick: () => void; count?: number; disabled?: boolean; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cx(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        active ? 'border-accent-text bg-surface-3 text-ink-1' : 'border-line bg-surface-2 text-ink-2 hover:text-ink-1',
      )}
    >
      {children}
      {count !== undefined && <span className="num text-[11px] text-ink-3">{int(count)}</span>}
    </button>
  );
}

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="eyebrow w-[86px] shrink-0 max-sm:sr-only">{label}</span>
      <div className="-mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-1 scrollbar-none" role="group" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cabecera: selector de día y KPIs
// ---------------------------------------------------------------------------
function DayPicker({ days, current, onChange, now }: { days: DailyDay[]; current: string; onChange: (d: string) => void; now: Date }) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1 scrollbar-none" role="group" aria-label="Día">
      {days.map((d) => {
        const name = dayName(d.date, now);
        const rel = name === 'Hoy' || name === 'Mañana';
        return (
          <Chip key={d.date} active={d.date === current} onClick={() => onChange(d.date)} count={d.counts.picks} title={`${capitalize(longDate(fromDayKey(d.date)))}: ${plural(d.counts.picks, 'pronóstico')} en ${plural(d.counts.matches, 'partido')}`}>
            <span className="font-semibold">{capitalize(name)}</span>
            {rel && <span className="text-ink-3">{shortDate(fromDayKey(d.date))}</span>}
          </Chip>
        );
      })}
    </div>
  );
}

function Kpis({ file, day }: { file: DailyFile; day: DailyDay }) {
  const o = file.track.overall;
  const b = file.track.baseline;
  const cats = new Set(day.matches.flatMap((m) => m.picks.map((p) => p.category))).size;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        label="Partidos con pronóstico"
        value={int(day.counts.matches)}
        hint={day.counts.matchesAnalyzed > day.counts.matches ? `De ${int(day.counts.matchesAnalyzed)} analizados ese día` : `${plural(day.counts.matchesAnalyzed, 'partido analizado', 'partidos analizados')}`}
        icon={<CalendarClock />}
      />
      <KpiTile label="Pronósticos del día" value={int(day.counts.picks)} hint={cats ? `En ${plural(cats, 'categoría')} · máx. 8 por partido` : 'Ninguno supera los umbrales'} icon={<ListOrdered />} />
      <KpiTile
        accent
        label="Acierto fuera de muestra"
        value={ownRate(o.n) ? pct(o.hitRate, 1) : '—'}
        hint={o.n > 0 ? (ownRate(o.n) ? `n = ${int(o.n)}${ciText(o.wilsonLow, o.wilsonHigh) ? ` · ${ciText(o.wilsonLow, o.wilsonHigh)}` : ''} · walk-forward` : `Muestra pequeña (n = ${int(o.n)})`) : 'Sin histórico todavía'}
        icon={<Target />}
      />
      <KpiTile
        label="Sin modelo (línea base)"
        value={b && ownRate(b.n) ? pct(b.hitRate, 1) : '—'}
        hint={b ? `Apostando siempre: ${b.label}` : 'Sin línea base publicada'}
        icon={<ShieldCheck />}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Partidos de una competición
// ---------------------------------------------------------------------------
/** Tarjetas visibles por competición antes de «Ver todos» (con el filtro de esa competición se muestran todas). */
const COMP_PREVIEW = 4;

function CompetitionSection({
  group: g,
  categories,
  catLabel,
  now,
  day,
  showAll,
  wide,
}: {
  group: DailyCompGroup;
  categories: { id: DailyCategory; label: string }[];
  catLabel?: string;
  now: number;
  day: string;
  showAll: boolean;
  /** escritorio: tarjetas con el detalle desplegado */
  wide: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = showAll || all ? g.matches : g.matches.slice(0, COMP_PREVIEW);
  return (
    <Section
      id={`comp-${g.compId}`}
      eyebrow={`${plural(g.matches.length, 'partido')} · ${plural(g.picks, 'pronóstico')}${catLabel ? ` · ${catLabel}` : ''}`}
      title={g.compName}
      icon={
        <span aria-hidden="true" className="inline-block max-w-[1.6em] overflow-hidden whitespace-nowrap text-[18px] leading-none">
          {g.meta?.flag ?? '⚽'}
        </span>
      }
      moreTo={isValidCompId(g.compId) ? `/c/${g.compId}` : undefined}
      moreLabel="Competición"
    >
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {shown.map((m) => (
          <DailyMatchCard key={`${m.match.id}-${wide ? 'a' : 'p'}`} item={m} categories={categories} now={now} day={day} defaultOpen={wide} />
        ))}
      </div>
      {shown.length < g.matches.length && (
        <div className="mt-4 flex justify-center">
          <button type="button" className="btn" onClick={() => setAll(true)}>
            Ver los {int(g.matches.length)} partidos de {g.meta?.shortName ?? g.compName}
          </button>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------
function DailySkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Cargando los pronósticos del día…</span>
      <div className="card p-6">
        <Skeleton className="mb-3 h-3 w-40" />
        <Skeleton className="h-10 w-80 max-w-full" />
        <div className="mt-4 flex gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-28" />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[92px] w-full" />
          ))}
        </div>
      </div>
      <SkeletonCard lines={6} />
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonCard key={i} lines={5} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function DailyPage() {
  const { data, error, loading, reload } = useDaily();
  const { data: meta } = useMeta();
  const [params, setParams] = useSearchParams();
  const nowDate = useNow(60_000);
  const now = nowDate.getTime();
  // en pantallas anchas las tarjetas de partido se abren con todo el detalle; en móvil, plegadas (una línea por pick)
  const wide = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    const prev = document.title;
    document.title = 'Pronósticos del día · FutStat Lab';
    return () => {
      document.title = prev;
    };
  }, []);

  // Dos pulsaciones seguidas (día y filtro) pueden llegar antes de que el router haya aplicado la primera: los cambios
  // se acumulan sobre los últimos parámetros pedidos, no sobre los ya pintados.
  const pending = useRef<URLSearchParams | null>(null);
  useEffect(() => {
    pending.current = null;
  }, [params]);
  const setParam = useCallback(
    (changes: Record<string, string | undefined>) => {
      const next = new URLSearchParams(pending.current ?? params);
      for (const [k, v] of Object.entries(changes)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      pending.current = next;
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const days = data?.days ?? [];
  const todayKey = dayKey(nowDate);
  const firstDay = defaultDay(days, null, todayKey);
  const dayId = defaultDay(days, params.get('dia'), todayKey);
  const day = days.find((d) => d.date === dayId);
  const categories = useMemo(() => categoryOrder(data), [data]);

  const allGroups = useMemo(() => groupDailyByCompetition(day?.matches ?? [], meta?.competitions), [day, meta]);
  const rawComp = params.get('comp');
  const comp = rawComp && isValidCompId(rawComp) && allGroups.some((g) => g.compId === rawComp) ? rawComp : undefined;
  const rawCat = params.get('cat');
  const cat: DailyCategory | undefined = isDailyCategory(rawCat) && categories.some((c) => c.id === rawCat) ? rawCat : undefined;
  const filtered = !!comp || !!cat;

  const matches = useMemo(() => filterDailyMatches(day?.matches ?? [], { comp, cat }), [day, comp, cat]);
  const groups = useMemo(() => groupDailyByCompetition(matches, meta?.competitions), [matches, meta]);
  const top = useMemo(() => (day ? upcomingFirst(dailyTop(day, { comp, cat }), now) : []), [day, comp, cat, now]);
  const matchById = useMemo(() => new Map((day?.matches ?? []).map((m) => [m.match.id, m.match])), [day]);
  // recuentos de los chips: cada filtro se cuenta con el otro ya aplicado
  const compCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of filterDailyMatches(day?.matches ?? [], { cat })) out.set(m.match.compId, (out.get(m.match.compId) ?? 0) + 1);
    return out;
  }, [day, cat]);
  const catCounts = useMemo(() => {
    const out = new Map<DailyCategory, number>();
    for (const m of filterDailyMatches(day?.matches ?? [], { comp })) for (const p of m.picks) out.set(p.category, (out.get(p.category) ?? 0) + 1);
    return out;
  }, [day, comp]);

  if (loading && !data) return <DailySkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  const header = (children?: ReactNode, eyebrow?: string) => (
    <PageHeader
      eyebrow={eyebrow ?? 'Selecciones muy probables · cuota baja · medidas fuera de muestra'}
      title="Pronósticos del día"
      description="Lo que el modelo ve más claro en cada partido: resultado, goles, tiros, córners, tarjetas, faltas y jugadores. Solo mercados validados fuera de muestra, ordenados del mejor al peor. Aciertan mucho porque son fáciles, no porque ganen a la casa."
    >
      {children}
    </PageHeader>
  );

  if (!day) {
    return (
      <div className="space-y-6">
        {header()}
        <EmptyState
          icon={<CalendarCheck />}
          title="Sin pronósticos publicados"
          description="No hay partidos con pronósticos validados en los próximos días. Vuelve más tarde: los datos se actualizan varias veces al día."
          action={
            <Link to="/confianza" className="btn">
              Ver alta confianza
            </Link>
          }
        />
        <Disclaimer />
      </div>
    );
  }

  const name = dayName(day.date, nowDate);
  const isRel = name === 'Hoy' || name === 'Mañana';
  const dateLong = capitalize(longDate(fromDayKey(day.date)));
  const featured: DailyCompGroup | undefined = allGroups.find((g) => isMarqueeCompetition(g.compId, g.meta)) ?? undefined;
  const next = nextDayWithPicks(days, day.date);
  const totalMatches = day.matches.length;
  const totalPicks = day.counts.picks;
  const compLabel = comp ? (allGroups.find((g) => g.compId === comp)?.meta?.shortName ?? allGroups.find((g) => g.compId === comp)?.compName) : undefined;
  const catLabel = cat ? categories.find((c) => c.id === cat)?.label : undefined;
  const filterText = [compLabel, catLabel].filter(Boolean).join(' · ');
  const labelOf = Object.fromEntries(categories.map((c) => [c.id, c.label])) as Partial<Record<DailyCategory, string>>;

  return (
    <div className="space-y-8 sm:space-y-10">
      {header(
        <div className="space-y-4">
          <DayPicker days={days} current={day.date} now={nowDate} onChange={(d) => setParam({ dia: d === firstDay ? undefined : d, comp: undefined })} />
          <Kpis file={data} day={day} />
        </div>,
        `${isRel ? `${name} · ` : ''}${dateLong}`,
      )}

      {featured && (
        <FeaturedCompetition
          meta={featured.meta}
          compName={featured.compName}
          matches={featured.matches}
          picks={featured.picks}
          dayLabel={isRel ? name : `El ${name}`}
          now={now}
          active={comp === featured.compId}
          onFilter={() => setParam({ comp: comp === featured.compId ? undefined : featured.compId })}
        />
      )}

      {totalMatches === 0 ? (
        <EmptyState
          icon={<CalendarCheck />}
          title={`${isRel ? name : capitalize(name)} no hay pronósticos`}
          description={
            day.counts.matchesAnalyzed > 0
              ? `Se han analizado ${plural(day.counts.matchesAnalyzed, 'partido')}, pero ninguna selección supera los umbrales de un mercado validado fuera de muestra. Mejor ninguno que uno forzado.`
              : 'No hay partidos con pronósticos validados ese día.'
          }
          action={
            next ? (
              <button type="button" className="btn-accent" onClick={() => setParam({ dia: next.date === firstDay ? undefined : next.date, comp: undefined })}>
                Ver {dayName(next.date, nowDate).toLowerCase()} · {plural(next.counts.picks, 'pronóstico')}
              </button>
            ) : (
              <Link to="/partidos" className="btn">
                Abrir calendario
              </Link>
            )
          }
        />
      ) : (
        <>
          <Card pad="sm" className="space-y-1" aria-label="Filtros">
            <ChipRow label="Competición">
              <Chip active={!comp} onClick={() => setParam({ comp: undefined })} count={[...compCounts.values()].reduce((a, b) => a + b, 0)}>
                Todas
              </Chip>
              {allGroups.map((g) => (
                <Chip key={g.compId} active={comp === g.compId} onClick={() => setParam({ comp: comp === g.compId ? undefined : g.compId })} count={compCounts.get(g.compId) ?? 0} disabled={!compCounts.get(g.compId) && comp !== g.compId} title={g.compName}>
                  <CompetitionBadge compId={g.compId} name={g.compName} link={false} className="text-[12.5px] font-medium text-inherit" />
                </Chip>
              ))}
            </ChipRow>
            <ChipRow label="Mercado">
              <Chip active={!cat} onClick={() => setParam({ cat: undefined })} count={[...catCounts.values()].reduce((a, b) => a + b, 0)}>
                Todos
              </Chip>
              {categories.map((c) => {
                const Icon = CATEGORY_ICON[c.id];
                const n = catCounts.get(c.id) ?? 0;
                return (
                  <Chip key={c.id} active={cat === c.id} onClick={() => setParam({ cat: cat === c.id ? undefined : c.id })} count={n} disabled={!n && cat !== c.id}>
                    <Icon className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                    {c.label}
                  </Chip>
                );
              })}
            </ChipRow>
            <p className="px-0.5 pt-1 text-2xs text-ink-3" role="status" aria-live="polite">
              {filtered ? (
                <>
                  Mostrando {plural(matches.reduce((s, m) => s + m.picks.length, 0), 'pronóstico')} en {plural(matches.length, 'partido')} ({filterText}) de {int(totalPicks)} ·{' '}
                  <button type="button" className="link" onClick={() => setParam({ comp: undefined, cat: undefined })}>
                    quitar filtros
                  </button>
                </>
              ) : (
                <>
                  {plural(totalPicks, 'pronóstico')} en {plural(totalMatches, 'partido')}. Los filtros se aplican al top y a los partidos.
                </>
              )}
            </p>
          </Card>

          <Section
            id="top"
            eyebrow={filtered ? filterText : 'Los mejores, uno por partido'}
            title="Top del día"
            icon={<Trophy />}
            description="Ordenados por probabilidad recalibrada, récord fuera de muestra de su mercado y mejora sobre su tasa base. «Justa» es la cuota mínima a la que la apuesta no pierde a la larga; «Mercado», la de la casa cuando la fuente la publica."
          >
            {top.length ? (
              <Card pad="none" className="overflow-hidden">
                <ol className="divide-y divide-line/70">
                  {top.map((t, i) => (
                    <li key={`${t.match.id}-${t.pick.family}-${t.pick.selection}`}>
                      <DailyTopRow match={t.match} pick={t.pick} rank={i + 1} now={now} day={day.date} categoryLabel={labelOf[t.pick.category]} />
                    </li>
                  ))}
                </ol>
              </Card>
            ) : (
              <EmptyState compact icon={<Trophy />} title="Ningún pronóstico con estos filtros" action={<button type="button" className="btn" onClick={() => setParam({ comp: undefined, cat: undefined })}>Quitar filtros</button>} />
            )}
          </Section>

          {day.combos.length > 0 && (
            <Section
              id="combinadas"
              eyebrow="Patas de partidos distintos"
              title="Combinadas sugeridas"
              icon={<Layers />}
              description="Tres formas de juntar los mejores pronósticos del día. La probabilidad combinada es el producto de las de sus patas."
            >
              <div className="space-y-3">
                <ComboWarning combos={day.combos} />
                <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {day.combos.map((c) => (
                    <ComboCard key={c.id} combo={c} track={data.track.combos?.find((x) => x.id === c.id)} matches={matchById} now={now} />
                  ))}
                </div>
              </div>
            </Section>
          )}

          {groups.map((g) => (
            <CompetitionSection key={`${day.date}-${g.compId}`} group={g} categories={categories} catLabel={catLabel} now={now} day={day.date} showAll={comp === g.compId || groups.length === 1} wide={wide} />
          ))}
        </>
      )}

      <Section id="como-leer" eyebrow="Antes de apostar" title="Cómo leer esto" icon={<BookOpen />}>
        <HowToRead file={data} />
      </Section>

      <p className="text-[12px] text-ink-3">
        Datos generados el {longDate(data.generatedAt)}. Horas en tu zona horaria. * Cuota sintética de doble oportunidad o empate no apuesta, calculada desde el 1X2 de la casa.
      </p>
      <Disclaimer />
    </div>
  );
}
