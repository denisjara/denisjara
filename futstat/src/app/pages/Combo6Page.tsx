import { useCallback, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, CalendarCheck, Dices, History, ListChecks, Ticket, Trophy } from 'lucide-react';
import type { Combo6Day } from '../../types/data';
import { useCombo6 } from '../lib/data';
import { useNow } from '../lib/hooks';
import { defaultDay } from '../lib/daily';
import { combo6Totals } from '../lib/combo6';
import { capitalize, dayKey, fromDayKey, int, longDate, odds as fmtOdds, pct, plural, relativeDay, shortDate } from '../lib/format';
import { Disclaimer, EmptyState, ErrorState, FilterChip, PageHeader, Section, Skeleton, SkeletonCard } from '../components';
import { ComboTicket, Combo6Warning, HistoryBlock, HowItsBuilt } from './combo6/parts';

/** «Hoy», «Mañana» o «jue 26 nov» para un día YYYY-MM-DD. */
const dayName = (date: string, now: Date) => relativeDay(fromDayKey(date), now);

function DayPicker({ days, current, onChange, now }: { days: Combo6Day[]; current: string; onChange: (d: string) => void; now: Date }) {
  const ref = useRef<HTMLDivElement>(null);
  // en móvil la tira hace scroll propio: el día elegido (p. ej. por ?dia=) tiene que quedar a la vista
  useEffect(() => {
    const box = ref.current;
    const btn = box?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!box || !btn) return;
    const left = btn.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft || left + btn.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = Math.max(0, left - 8);
  }, [current]);
  return (
    <div ref={ref} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-1 scrollbar-none" role="group" aria-label="Día">
      {days.map((d) => {
        const name = dayName(d.date, now);
        const rel = name === 'Hoy' || name === 'Mañana';
        const odds = d.main ? combo6Totals(d.main.legs).bookOdds : undefined;
        return (
          <FilterChip
            key={d.date}
            active={d.date === current}
            onClick={() => onChange(d.date)}
            title={`${capitalize(longDate(fromDayKey(d.date)))}: ${d.main ? `combinada de ${plural(d.main.legs.length, 'pata')}` : 'sin combinada'}`}
          >
            <span className="font-semibold">{capitalize(name)}</span>
            {rel && <span className="text-ink-3">{shortDate(fromDayKey(d.date))}</span>}
            <span className="num text-[11px] text-ink-3">{odds ? `≈ ${fmtOdds(odds)}` : '—'}</span>
          </FilterChip>
        );
      })}
    </div>
  );
}

function Combo6Skeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Cargando la combinada…</span>
      <div className="card p-6">
        <Skeleton className="mb-3 h-3 w-40" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="mt-4 h-16 w-full" />
        <div className="mt-4 flex gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-24" />
          ))}
        </div>
      </div>
      <SkeletonCard lines={9} />
    </div>
  );
}

/** Enlaces a las otras secciones de apuestas. */
function OtherSections() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Link to="/hoy" className="card card-hover group flex items-start gap-3 p-4">
        <CalendarCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-text" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block font-display text-[17px] font-bold uppercase text-ink-1">Pronósticos del día</span>
          <span className="block text-[12.5px] text-ink-2">Todas las selecciones probables de cada partido, de donde salen las patas.</span>
        </span>
        <ArrowRight className="ml-auto mt-1 h-4 w-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>
      <Link to="/cuota-alta" className="card card-hover group flex items-start gap-3 p-4">
        <Dices className="mt-0.5 h-5 w-5 shrink-0 text-accent-text" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block font-display text-[17px] font-bold uppercase text-ink-1">Cuota alta 6+</span>
          <span className="block text-[12.5px] text-ink-2">Sorpresas, marcadores exactos y combinadas de pocas patas con cuota 6 o más.</span>
        </span>
        <ArrowRight className="ml-auto mt-1 h-4 w-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function Combo6Page() {
  const { data, error, loading, reload } = useCombo6();
  const [params, setParams] = useSearchParams();
  const nowDate = useNow(60_000);
  const now = nowDate.getTime();

  useEffect(() => {
    const prev = document.title;
    document.title = 'Combinada cuota 6 · FutStat Lab';
    return () => {
      document.title = prev;
    };
  }, []);

  // los cambios se acumulan sobre los últimos parámetros pedidos (dos pulsaciones seguidas no se pisan)
  const pending = useRef<URLSearchParams | null>(null);
  useEffect(() => {
    pending.current = null;
  }, [params]);
  const setDay = useCallback(
    (d: string | undefined) => {
      const next = new URLSearchParams(pending.current ?? params);
      if (d) next.set('dia', d);
      else next.delete('dia');
      pending.current = next;
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  if (loading && !data) return <Combo6Skeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  const days = data.days ?? [];
  const todayKey = dayKey(nowDate);
  const firstDay = defaultDay(days, null, todayKey);
  const dayId = defaultDay(days, params.get('dia'), todayKey);
  const day = days.find((d) => d.date === dayId);

  const header = (eyebrow?: string) => (
    <PageHeader
      eyebrow={eyebrow ?? 'Una pata por partido · mercados distintos'}
      title="Combinada cuota 6"
      description="Una pata por partido, cada una de un mercado distinto (ganador, goles, córners, tiros, tarjetas…): las selecciones más probables que, juntas, pagan unas 6 veces lo apostado en la casa."
    >
      <div className="space-y-4">
        <Combo6Warning history={data.history} />
        {day && days.length > 0 && <DayPicker days={days} current={day.date} now={nowDate} onChange={(d) => setDay(d === firstDay ? undefined : d)} />}
      </div>
    </PageHeader>
  );

  const tail = (
    <>
      <Section
        id="historial"
        eyebrow="Fuera de muestra"
        title="Cómo le habría ido"
        icon={<History />}
        description="La misma regla aplicada en días pasados, con solo los datos anteriores a cada partido y resuelta a los 90 minutos."
      >
        <HistoryBlock history={data.history} now={now} />
      </Section>
      <Section id="como-se-arma" eyebrow="La regla" title="Cómo se arma" icon={<BookOpen />}>
        <HowItsBuilt file={data} />
      </Section>
      <Section id="otras" eyebrow="Más apuestas" title="Otras secciones" icon={<ListChecks />}>
        <OtherSections />
      </Section>
      <p className="text-[12px] text-ink-3">Datos generados el {longDate(data.generatedAt)}. Se actualizan cada 3 horas. Horas en tu zona horaria.</p>
      <Disclaimer />
    </>
  );

  if (!day) {
    return (
      <div className="space-y-8 sm:space-y-10">
        {header()}
        <EmptyState
          icon={<Ticket />}
          title="Sin combinada publicada"
          description="No hay partidos con selecciones validadas en los próximos días. Vuelve más tarde: los datos se actualizan cada 3 horas."
          action={
            <Link to="/hoy" className="btn">
              Ver los pronósticos del día
            </Link>
          }
        />
        {tail}
      </div>
    );
  }

  const name = dayName(day.date, nowDate);
  const isRel = name === 'Hoy' || name === 'Mañana';
  const dateLong = capitalize(longDate(fromDayKey(day.date)));
  const dayLabel = `${isRel ? `${name} · ` : ''}${dateLong}`;
  const nextWith = days.find((d) => d.date > day.date && d.main);
  const comps = day.byCompetition ?? [];

  return (
    <div className="space-y-8 sm:space-y-10">
      {header(dayLabel)}

      <Section
        id="combinada"
        eyebrow={`${plural(day.counts.eligibleMatches, 'partido')} con patas de ${int(day.counts.matches)} analizados`}
        title={isRel ? `La combinada de ${name.toLowerCase()}` : 'La combinada'}
        icon={<Ticket />}
        description="Patas por hora de inicio. Toca una para ver el análisis del partido."
      >
        {day.main ? (
          <ComboTicket combo={day.main} now={now} day={day.date} dayLabel={dayLabel} main />
        ) : (
          <EmptyState
            icon={<Ticket />}
            title={`${isRel ? name : capitalize(name)} no hay combinada`}
            description={
              <>
                <span className="[overflow-wrap:anywhere]">{day.reason || 'Ninguna combinación cumple la regla ese día.'}</span> Mejor ninguna que una forzada.
                <span className="mt-1 block text-2xs text-ink-3">
                  {plural(day.counts.matches, 'partido')} analizados · {plural(day.counts.eligibleMatches, 'partido')} con alguna pata · {plural(day.counts.candidateLegs, 'pata candidata', 'patas candidatas')}
                </span>
              </>
            }
            action={
              nextWith ? (
                <button type="button" className="btn-accent" onClick={() => setDay(nextWith.date === firstDay ? undefined : nextWith.date)}>
                  Ver la de {dayName(nextWith.date, nowDate).toLowerCase()} · ≈ {fmtOdds(combo6Totals(nextWith.main!.legs).bookOdds)}
                </button>
              ) : (
                <Link to="/hoy" className="btn">
                  Ver los pronósticos del día
                </Link>
              )
            }
          />
        )}
      </Section>

      {comps.length > 0 && (
        <Section
          id="por-competicion"
          eyebrow="Misma regla, una sola competición"
          title="Por competición"
          icon={<Trophy />}
          description="Si solo quieres partidos de una competición. Suelen tener algo menos de probabilidad que la general, que elige entre todos los partidos."
        >
          <div className="grid items-start gap-4 2xl:grid-cols-2">
            {comps.map((c) => {
              const t = combo6Totals(c.legs);
              return (
                <div key={c.id} className="min-w-0 space-y-1.5">
                  <p className="px-1 text-2xs text-ink-3">
                    {pct(t.prob, 1)} frente al {day.main ? pct(combo6Totals(day.main.legs).prob, 1) : '—'} de la general
                  </p>
                  <ComboTicket combo={c} now={now} day={day.date} dayLabel={dayLabel} />
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {tail}
    </div>
  );
}

