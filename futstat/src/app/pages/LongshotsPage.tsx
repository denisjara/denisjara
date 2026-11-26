import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BookOpen, CalendarClock, Dices, History, Percent, Target, Zap } from 'lucide-react';
import type { LongshotDay, LongshotFile } from '../../types/data';
import { useLongshots } from '../lib/data';
import { useNow } from '../lib/hooks';
import { defaultDay } from '../lib/daily';
import {
  LONGSHOT_FILTERS,
  STAKE_DEFAULT,
  clampStake,
  evState,
  excludedKinds,
  filterLongshots,
  kindCounts,
  kindFromParam,
  longshotSummary,
  minOddsLabel,
  nextDayWithBets,
  paramFromKind,
  playableFirst,
} from '../lib/longshots';
import { capitalize, dayKey, fromDayKey, int, longDate, pct, plural, relativeDay, shortDate } from '../lib/format';
import {
  Card,
  ChipRow,
  Combo6Callout,
  Disclaimer,
  EmptyState,
  ErrorState,
  FilterChip,
  KpiTile,
  LONGSHOT_KIND_ICON,
  LongshotWarning,
  PageHeader,
  Section,
  Skeleton,
  SkeletonCard,
} from '../components';
import { BeforeBetting, LongshotCard, TrackBlock, TrackSentence, money } from './longshots/parts';

/** «Hoy», «Mañana» o «jue 26 nov» para un día YYYY-MM-DD. */
const dayName = (date: string, now: Date) => relativeDay(fromDayKey(date), now);

function DayPicker({ days, current, onChange, now }: { days: LongshotDay[]; current: string; onChange: (d: string) => void; now: Date }) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1 scrollbar-none" role="group" aria-label="Día">
      {days.map((d) => {
        const name = dayName(d.date, now);
        const rel = name === 'Hoy' || name === 'Mañana';
        return (
          <FilterChip key={d.date} active={d.date === current} onClick={() => onChange(d.date)} count={d.bets.length} title={`${capitalize(longDate(fromDayKey(d.date)))}: ${plural(d.bets.length, 'apuesta')}`}>
            <span className="font-semibold">{capitalize(name)}</span>
            {rel && <span className="text-ink-3">{shortDate(fromDayKey(d.date))}</span>}
          </FilterChip>
        );
      })}
    </div>
  );
}

function Kpis({ file, day }: { file: LongshotFile; day: LongshotDay }) {
  const s = longshotSummary(file.track.byKind);
  const bets = day.bets;
  const meanProb = bets.length ? bets.reduce((a, b) => a + b.prob, 0) / bets.length : undefined;
  const priced = bets.filter((b) => evState(b) !== 'sin-cuota');
  const positive = priced.filter((b) => evState(b) === 'pos').length;
  const combos = bets.filter((b) => b.kind === 'combinada').length;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        label="Apuestas del día"
        value={int(bets.length)}
        hint={bets.length ? `${plural(combos, 'combinada')} · ${plural(bets.length - combos, 'simple')}` : 'Ninguna llega a la cuota mínima'}
        icon={<CalendarClock />}
      />
      <KpiTile
        label="Probabilidad media"
        value={meanProb !== undefined ? pct(meanProb, 1) : '—'}
        hint={meanProb ? `De media, 1 de cada ${int(Math.round(1 / meanProb))}` : 'Sin apuestas ese día'}
        icon={<Percent />}
      />
      <KpiTile
        label="Valor esperado +"
        value={priced.length ? `${int(positive)}/${int(priced.length)}` : '—'}
        hint={priced.length ? 'Con cuota de la casa; aun así, la mayoría pierden' : 'Ninguna tiene cuota de la casa'}
        icon={<Zap />}
      />
      <KpiTile
        accent
        label="Acierto histórico"
        value={s.hitRate !== undefined ? pct(s.hitRate, 1) : '—'}
        hint={s.settled ? `${int(s.hits)} de ${int(s.settled)}${s.expectedHitRate !== undefined ? ` · esperado ${pct(s.expectedHitRate, 1)}` : ''}` : 'Sin historial todavía'}
        icon={<Target />}
      />
    </div>
  );
}

function LongshotsSkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Cargando las apuestas de cuota alta…</span>
      <div className="card p-6">
        <Skeleton className="mb-3 h-3 w-40" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="mt-4 h-20 w-full" />
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[92px] w-full" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonCard key={i} lines={6} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function LongshotsPage() {
  const { data, error, loading, reload } = useLongshots();
  const [params, setParams] = useSearchParams();
  const nowDate = useNow(60_000);
  const now = nowDate.getTime();
  const [stakeText, setStakeText] = useState(String(STAKE_DEFAULT));
  const stake = clampStake(stakeText);

  useEffect(() => {
    const prev = document.title;
    document.title = 'Cuota alta 6+ · FutStat Lab';
    return () => {
      document.title = prev;
    };
  }, []);

  // los cambios de filtro se acumulan sobre los últimos parámetros pedidos (dos pulsaciones seguidas no se pisan)
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
  const kind = kindFromParam(params.get('tipo'));
  const counts = useMemo(() => kindCounts(day?.bets ?? []), [day]);
  const bets = useMemo(() => playableFirst(filterLongshots(day?.bets ?? [], kind), now), [day, kind, now]);

  if (loading && !data) return <LongshotsSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  const minOdds = data.minOdds;
  const header = (children?: ReactNode, eyebrow?: string) => (
    <PageHeader
      eyebrow={eyebrow ?? `Apuestas de cuota ${minOddsLabel(minOdds)} o más`}
      title={`Cuota alta ${minOddsLabel(minOdds)}+`}
      description="Combinadas, sorpresas, marcadores exactos y goleadores con cuota alta, con su probabilidad real según el modelo, la cuota justa, la de la casa cuando existe, el valor esperado y cómo les fue a apuestas iguales en el pasado."
    >
      <div className="space-y-4">
        <LongshotWarning minOdds={minOdds}>
          <TrackSentence file={data} />
        </LongshotWarning>
        {children}
      </div>
    </PageHeader>
  );

  const track = (
    <>
      <Combo6Callout text="¿Prefieres más probabilidad a la misma cuota? Una pata por partido, mercados distintos y las selecciones más probables hasta llegar a cuota ≈ 6." />
      <Section
        id="historial"
        eyebrow="Fuera de muestra"
        title="Historial fuera de muestra"
        icon={<History />}
        description="Cómo les fue a las apuestas que habría publicado esta misma regla en días pasados, predichas solo con datos anteriores a cada partido."
      >
        <TrackBlock file={data} />
      </Section>
      <Section id="antes-de-apostar" eyebrow="Antes de apostar" title="Cómo leer esto" icon={<BookOpen />}>
        <BeforeBetting file={data} />
      </Section>
      <p className="text-[12px] text-ink-3">Datos generados el {longDate(data.generatedAt)}. Horas en tu zona horaria.</p>
      <Disclaimer />
    </>
  );

  if (!day) {
    return (
      <div className="space-y-8 sm:space-y-10">
        {header()}
        <EmptyState
          icon={<Dices />}
          title="Sin apuestas de cuota alta publicadas"
          description="No hay partidos con apuestas de cuota alta en los próximos días. Vuelve más tarde: los datos se actualizan varias veces al día."
          action={
            <Link to="/hoy" className="btn">
              Ver los pronósticos del día
            </Link>
          }
        />
        {track}
      </div>
    );
  }

  const name = dayName(day.date, nowDate);
  const isRel = name === 'Hoy' || name === 'Mañana';
  const dateLong = capitalize(longDate(fromDayKey(day.date)));
  const next = nextDayWithBets(days, day.date);
  const kindLabel = kind ? LONGSHOT_FILTERS.find((f) => f.kind === kind)?.label : undefined;
  const excluded = excludedKinds(data.track.byKind);
  const noneValidated = data.track.byKind.length === 0 || data.track.byKind.every((r) => r.excluded);
  const emptyWhy = noneValidated
    ? data.track.byKind.length === 0
      ? 'Todavía no hay historial fuera de muestra para medir estas apuestas: no se publica ninguna recomendación hasta tenerlo.'
      : 'Ningún tipo de apuesta pasa ahora la validación fuera de muestra (muestra suficiente y probabilidades que se cumplen): no se publica ninguna. Los motivos, en el historial.'
    : `Ninguna combinación o selección llega a cuota ${minOddsLabel(minOdds)} con datos fiables ese día. Mejor ninguna que una forzada.${
        excluded.length ? ` Además, ahora no se publican: ${excluded.map((e) => e.label.toLowerCase()).join(', ')}.` : ''
      }`;

  return (
    <div className="space-y-8 sm:space-y-10">
      {header(
        <div className="space-y-4">
          <DayPicker days={days} current={day.date} now={nowDate} onChange={(d) => setParam({ dia: d === firstDay ? undefined : d })} />
          <Kpis file={data} day={day} />
        </div>,
        `${isRel ? `${name} · ` : ''}${dateLong}`,
      )}

      {day.bets.length === 0 ? (
        <EmptyState
          icon={<Dices />}
          title={`${isRel ? name : capitalize(name)} no hay apuestas de cuota alta`}
          description={emptyWhy}
          action={
            next ? (
              <button type="button" className="btn" onClick={() => setParam({ dia: next.date === firstDay ? undefined : next.date })}>
                Ver {dayName(next.date, nowDate).toLowerCase()} · {plural(next.bets.length, 'apuesta')}
              </button>
            ) : (
              <Link to="/hoy" className="btn">
                Ver los pronósticos del día
              </Link>
            )
          }
        />
      ) : (
        <>
          <Card pad="sm" className="space-y-1">
            <ChipRow label="Tipo">
              <FilterChip active={!kind} onClick={() => setParam({ tipo: undefined })} count={day.bets.length}>
                Todas
              </FilterChip>
              {LONGSHOT_FILTERS.map((f) => {
                const Icon = LONGSHOT_KIND_ICON[f.kind];
                const n = counts.get(f.kind) ?? 0;
                const why = excluded.find((e) => e.kind === f.kind)?.reason;
                return (
                  <FilterChip
                    key={f.id}
                    active={kind === f.kind}
                    onClick={() => setParam({ tipo: kind === f.kind ? undefined : paramFromKind(f.kind) })}
                    count={n}
                    disabled={!n && kind !== f.kind}
                    title={why ? `No se publica ahora: ${why}` : undefined}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                    {f.label}
                  </FilterChip>
                );
              })}
            </ChipRow>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 pt-1">
              <label htmlFor="importe" className="eyebrow w-[86px] shrink-0">
                Calculadora
              </label>
              <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                Si apuestas
                <input
                  id="importe"
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={10000}
                  step={1}
                  value={stakeText}
                  onChange={(e) => setStakeText(e.target.value)}
                  onBlur={() => setStakeText(String(stake))}
                  className="input h-8 w-[84px] px-2 py-1 text-right font-mono text-[13px]"
                  aria-describedby="importe-ayuda"
                />
                €
              </span>
              <span id="importe-ayuda" className="text-2xs text-ink-3">
                Importe de ejemplo para la calculadora de cada apuesta. No es una recomendación de cuánto apostar.
              </span>
            </div>
            <p className="px-0.5 pt-1 text-2xs text-ink-3" role="status" aria-live="polite">
              {kind ? (
                <>
                  Mostrando {int(bets.length)} de {plural(day.bets.length, 'apuesta')} ({kindLabel}) ·{' '}
                  <button type="button" className="link" onClick={() => setParam({ tipo: undefined })}>
                    ver todas
                  </button>
                </>
              ) : (
                <>
                  {plural(day.bets.length, 'apuesta')} de cuota {minOddsLabel(minOdds)} o más, de la más a la menos recomendable según el modelo. Las que ya han empezado van al final.
                </>
              )}
            </p>
          </Card>

          <Section
            id="apuestas"
            eyebrow={kindLabel ?? 'Ordenadas por el modelo'}
            title="Apuestas del día"
            icon={<Dices />}
            description={`Cuota grande: la de la casa si la fuente la publica; si no, la justa (1 / probabilidad). Con ${money(stake)} de ejemplo.`}
          >
            {bets.length ? (
              <div className="grid items-start gap-4 xl:grid-cols-2">
                {bets.map((b) => (
                  <LongshotCard key={b.id} bet={b} now={now} day={day.date} stake={stake} />
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                icon={<Dices />}
                title="Ninguna apuesta de este tipo ese día"
                action={
                  <button type="button" className="btn" onClick={() => setParam({ tipo: undefined })}>
                    Ver todas
                  </button>
                }
              />
            )}
          </Section>
        </>
      )}

      {track}
    </div>
  );
}
