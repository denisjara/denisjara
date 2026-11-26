import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, BadgePercent, CalendarCheck, CalendarClock, Check, Flame, History, Radio, ShieldCheck, Target, TrendingUp, Users, X, Zap } from 'lucide-react';
import type { ConfidencePick, HomeFile, MatchSummary, PlayerSeasonRow, ValuePick } from '../../types/data';
import { useHome, useMeta } from '../lib/data';
import { pickMarketLabel, pickSelection } from '../lib/picks';
import { lookup } from '../lib/lookup';
import { useLiveScores, withLive } from '../lib/live';
import { useNow } from '../lib/hooks';
import { upcomingFirst } from '../lib/daily';
import { groupMatchesByCompetition } from '../lib/competitions';
import { ev as fmtEv, fromDayKey, int, kickoff, longDate, num, odds as fmtOdds, pct, plural, capitalize, relativeDay, shortDate, sumFinite } from '../lib/format';
import {
  Card,
  CompetitionBadge,
  ConfidenceRow,
  DailyTopRow,
  Disclaimer,
  EmptyState,
  ErrorState,
  KpiTile,
  MatchCard,
  MatchGroup,
  MatchRow,
  Meter,
  PageSkeleton,
  ProbBar1X2,
  SafeBlock,
  Section,
  SegmentedControl,
  Sparkline,
  TeamCrest,
  ValuePickChip,
  ciText,
  cx,
  matchHref,
} from '../components';

const POSITION: Record<string, string> = { G: 'POR', D: 'DEF', M: 'MED', F: 'DEL', '?': '—' };

/** Partidos que realmente se juegan (excluye aplazados y cancelados), igual que los titulares del pipeline. */
const isPlayable = (m: MatchSummary) => m.status !== 'postponed' && m.status !== 'cancelled';

// ---------------------------------------------------------------------------
// Cabecera del día: titulares + KPIs
// ---------------------------------------------------------------------------
function FocusMatch({ match: m }: { match: MatchSummary }) {
  const pr = m.prediction;
  return (
    <Link to={matchHref(m)} className="card card-hover group relative block overflow-hidden p-4">
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-accent/10 blur-2xl" aria-hidden="true" />
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="eyebrow text-accent-text">Foco del día</span>
        <span className="flex min-w-0 items-center gap-2 text-2xs text-ink-3">
          <CompetitionBadge compId={m.compId} name={m.compName} className="text-2xs" />
          <span className="num shrink-0">{kickoff(m.date)}</span>
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <TeamCrest team={m.home} size={36} />
          <span className="truncate font-display text-[22px] font-extrabold uppercase leading-none text-ink-1">{m.home.short || m.home.name}</span>
        </span>
        <span className="font-display text-[15px] font-bold uppercase text-ink-3">vs</span>
        <span className="flex min-w-0 items-center justify-end gap-2.5 text-right">
          <span className="truncate font-display text-[22px] font-extrabold uppercase leading-none text-ink-1">{m.away.short || m.away.name}</span>
          <TeamCrest team={m.away} size={36} />
        </span>
      </div>
      {pr && (
        <>
          <ProbBar1X2 p={pr.p} market={pr.market} size="lg" className="mt-4" />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-2">
            <span>
              Marcador probable <strong className="num font-semibold text-ink-1">{pr.likelyScore}</strong>
              <span className="text-ink-3"> · xG </span>
              <span className="num text-ink-1">
                {num(pr.xgHome, 2)}–{num(pr.xgAway, 2)}
              </span>
            </span>
            {pr.pick && <ValuePickChip pick={pr.pick} />}
          </div>
        </>
      )}
    </Link>
  );
}

function DayHero({ home, liveCount }: { home: HomeFile; liveCount: number }) {
  const { data: meta } = useMeta();
  const mh = home.modelHeadline;
  const ch = home.confidenceHeadline;
  const counts = meta?.counts;
  const focus = home.popular.find((m) => m.status === 'scheduled' && m.prediction) ?? home.popular[0];
  return (
    <header className="relative overflow-hidden rounded-card border border-line bg-surface-1/75">
      <div className="pitch-lines pointer-events-none absolute inset-0 opacity-[0.045]" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" aria-hidden="true" />
      <div className="relative grid gap-6 p-4 sm:p-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="eyebrow flex flex-wrap items-center gap-2 text-accent-text">
            <span>{capitalize(longDate(new Date()))}</span>
            {liveCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded bg-live/15 px-1.5 py-0.5 text-live">
                <span className="h-1.5 w-1.5 animate-live-pulse rounded-full bg-live" aria-hidden="true" />
                {liveCount} en vivo
              </span>
            )}
          </div>
          <h1 className="display mt-2 text-[40px] text-ink-1 sm:text-[56px]">
            La jornada <span className="text-accent-text">en datos</span>
          </h1>
          <p className="mt-2 max-w-xl text-[14px] text-ink-2">
            {plural(home.today.filter(isPlayable).length, 'partido')} hoy y {plural(home.tomorrow.filter(isPlayable).length, 'partido')} mañana, analizados con un ensamble Dixon-Coles + Elo + mercado.
          </p>
          {home.highlights.length > 0 && (
            <div className="mt-5">
              <h2 className="eyebrow mb-2">Titulares del día</h2>
              <ol className="grid gap-2 sm:grid-cols-2">
                {home.highlights.slice(0, 6).map((h, i) => (
                  <li key={i} className={cx('gap-3 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 text-[13px] leading-snug text-ink-1', i >= 3 ? 'hidden sm:flex' : 'flex')}>
                    <span className="num mt-px shrink-0 text-[11px] font-semibold text-accent-text">{String(i + 1).padStart(2, '0')}</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <KpiTile label="Partidos analizados" value={int(counts?.matchesAnalyzed)} hint="Base del modelo esta temporada" icon={<Activity />} />
            <KpiTile label="Próximos 14 días" value={int(counts?.upcomingMatches)} hint={`En ${plural(meta?.competitions.length ?? 0, 'competición', 'competiciones')}`} icon={<CalendarClock />} />
            <KpiTile label="Picks de valor" value={int(counts?.valueBets ?? home.topValue.length)} hint="EV ≥ +5% frente a la cuota" icon={<BadgePercent />} />
            <KpiTile
              label="Picks alta confianza"
              value={ch?.upcoming !== undefined ? int(ch.upcoming) : '—'}
              hint="Próximos 14 días · cuotas bajas"
              icon={<ShieldCheck />}
            />
            <KpiTile
              label="Acierto 1X2"
              value={mh ? pct(mh.accuracy) : '—'}
              hint={mh ? `RPS ${num(mh.rps, 3)}${mh.marketRps ? ` · mercado ${num(mh.marketRps, 3)}` : ''}` : 'Backtest pendiente'}
              icon={<Target />}
            />
            <KpiTile
              label="Alta confianza"
              value={ch ? pct(ch.hitRate, 1) : '—'}
              hint={
                ch
                  ? `Fuera de muestra · n = ${int(ch.picks)}${ch.wilsonLow !== undefined ? ` · ${ciText(ch.wilsonLow, ch.wilsonHigh)}` : ''}${ch.baselineRate !== undefined ? ` · sin modelo ${pct(ch.baselineRate, 1)}` : ''}`
                  : 'Sin datos todavía'
              }
              icon={<ShieldCheck />}
            />
          </div>
          {focus && <FocusMatch match={focus} />}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Picks de valor
// ---------------------------------------------------------------------------
function ValueList({ items }: { items: { match: MatchSummary; pick: ValuePick }[] }) {
  if (!items.length) {
    return <EmptyState compact icon={<BadgePercent />} title="Sin picks hoy" description="Ninguna cuota supera el umbral de valor esperado del modelo." />;
  }
  return (
    <Card pad="none" className="overflow-hidden">
      <ul className="divide-y divide-line/70">
        {items.map(({ match: m, pick }, i) => (
          <li key={`${m.id}-${pick.marketId}-${pick.selection}`}>
            <Link to={matchHref(m)} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3 py-3 transition-colors hover:bg-surface-2 sm:px-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
              <span className="flex min-w-0 items-center gap-3">
                <span className="num w-5 shrink-0 text-[11px] font-semibold text-ink-3">{i + 1}</span>
                <span className="flex shrink-0 -space-x-1.5">
                  <TeamCrest team={m.home} size={22} className="ring-2 ring-surface-1" />
                  <TeamCrest team={m.away} size={22} className="ring-2 ring-surface-1" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-semibold text-ink-1">
                    {m.home.short || m.home.name} – {m.away.short || m.away.name}
                  </span>
                  <span className="flex items-center gap-2 text-2xs text-ink-3">
                    <CompetitionBadge compId={m.compId} name={m.compName} className="hidden text-2xs font-medium sm:inline-flex" />
                    <span className="truncate">{kickoff(m.date)}</span>
                  </span>
                </span>
              </span>
              <span className="col-span-2 flex min-w-0 items-center gap-2 pl-8 md:col-span-1 md:pl-0">
                <Zap className="h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-ink-1">{pickSelection(pick)}</span>
                  <span className="block truncate text-2xs text-ink-3">{pickMarketLabel(pick)}</span>
                </span>
              </span>
              <span className="col-start-2 row-start-1 flex items-center gap-3 text-right md:col-start-3">
                <span className="hidden sm:block">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">Prob.</span>
                  <span className="num text-[13px] text-ink-1">{pct(pick.prob)}</span>
                </span>
                <span>
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">Cuota</span>
                  <span className="num text-[13px] font-semibold text-ink-1">{fmtOdds(pick.odds)}</span>
                </span>
                <span className="min-w-[56px]">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">EV</span>
                  <span className="num text-[13px] font-bold text-pos">{fmtEv(pick.ev)}</span>
                </span>
                <span className="hidden min-w-[56px] lg:block" title="Stake recomendado (Kelly fraccional) sobre la banca">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">Stake</span>
                  <span className="num text-[13px] text-ink-2">{pct(pick.kelly, 1)}</span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pronósticos de alta confianza
// ---------------------------------------------------------------------------
function ConfidenceList({ items, headline }: { items: { match: MatchSummary; pick: ConfidencePick }[]; headline: HomeFile['confidenceHeadline'] }) {
  if (!items.length) {
    return (
      <EmptyState
        compact
        icon={<ShieldCheck />}
        title="Sin pronósticos de alta confianza en 72 horas"
        description="Ningún partido próximo supera los umbrales de un mercado validado fuera de muestra."
        action={<Link to="/confianza" className="btn">Ver todos</Link>}
      />
    );
  }
  return (
    <Card pad="none" className="overflow-hidden">
      {headline && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface-2/70 px-3 py-2.5 text-[13px] text-ink-2 sm:px-4">
          <span>
            <strong className="num font-display text-[20px] font-extrabold leading-none text-ink-1">{pct(headline.hitRate, 1)}</strong> de acierto en{' '}
            <strong className="font-semibold text-ink-1">{int(headline.picks)}</strong> selecciones muy probables de partidos no usados para calibrar
            {headline.wilsonLow !== undefined && <span className="num text-2xs text-ink-3"> (Wilson 90%: {ciText(headline.wilsonLow, headline.wilsonHigh)})</span>}
          </span>
          <span className="text-2xs text-ink-3">
            {headline.baselineRate !== undefined ? `Sin modelo, una estrategia fija acierta ${pct(headline.baselineRate, 1)}. ` : ''}
            {headline.avgFairOdds !== undefined ? `Cuota justa media ${num(headline.avgFairOdds, 2)}: ` : 'Cuotas bajas: '}no es una ventaja frente a la casa.
          </span>
        </div>
      )}
      <ul className="divide-y divide-line/70">
        {items.map(({ match, pick }) => (
          <li key={`${match.id}-${pick.family}`}>
            <ConfidenceRow match={match} picks={[pick]} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pronósticos del día (avance de /hoy)
// ---------------------------------------------------------------------------
function DailyTeaser({ daily }: { daily: NonNullable<HomeFile['daily']> }) {
  const nowDate = useNow(60_000);
  const now = nowDate.getTime();
  const items = upcomingFirst(daily.top, now).slice(0, 4);
  const day = fromDayKey(daily.date);
  const name = relativeDay(day, nowDate);
  const rel = name === 'Hoy' || name === 'Mañana';
  return (
    <Section
      id="pronosticos-del-dia"
      eyebrow={rel ? `${name} · ${shortDate(day)}` : capitalize(name)}
      title="Pronósticos del día"
      icon={<CalendarCheck />}
      moreTo="/hoy"
      moreLabel="Ver todos"
      description={`Lo mejor de ${plural(daily.picks, 'pronóstico')} validados en ${plural(daily.matches, 'partido')}: resultado, goles, tiros, córners, tarjetas y jugadores. Muy probables y de cuota baja; no son una ventaja frente a la casa.`}
    >
      <Card pad="none" className="overflow-hidden">
        <ol className="divide-y divide-line/70">
          {items.map((t, i) => (
            <li key={`${t.match.id}-${t.pick.family}-${t.pick.selection}`}>
              <DailyTopRow match={t.match} pick={t.pick} rank={i + 1} now={now} day={daily.date} />
            </li>
          ))}
        </ol>
        <div className="border-t border-line px-3 py-2 sm:px-4">
          <Link to="/hoy" className="btn-ghost -mx-2.5">
            Ver los {int(daily.picks)} pronósticos y las combinadas del día
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Link>
        </div>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Jugadores en racha
// ---------------------------------------------------------------------------
function HotPlayers({ players }: { players: PlayerSeasonRow[] }) {
  if (!players.length) return <EmptyState compact icon={<Users />} title="Sin datos de jugadores" />;
  return (
    <Card pad="none" className="overflow-hidden">
      <ul className="divide-y divide-line/70">
        {players.slice(0, 8).map((p, i) => {
          const l5 = p.last5 ?? [];
          const g5 = sumFinite(l5, (x) => x.goals);
          const a5 = sumFinite(l5, (x) => x.assists);
          return (
            <li key={`${p.player.id}-${p.compId}`}>
              <Link to={`/t/${p.team.id}`} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2 sm:px-4">
                <span className="num text-[11px] font-semibold text-ink-3">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <TeamCrest team={p.team} size={22} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-semibold text-ink-1">{p.player.name}</span>
                    <span className="flex items-center gap-1.5 text-2xs text-ink-3">
                      <span className="rounded bg-surface-3 px-1 font-mono text-[10px] text-ink-2">{lookup(POSITION, p.player.position) ?? '—'}</span>
                      <span className="truncate">{p.team.short || p.team.name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="num shrink-0" title="Goles y asistencias en los últimos 5 partidos">
                        {int(g5)}G {int(a5)}A
                      </span>
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <Sparkline values={p.formTrend} width={56} height={22} domain={[4, 10]} ariaLabel={`Notas recientes de ${p.player.name}`} className="hidden sm:block" />
                  <span className="w-[54px]">
                    <span className="num block text-right text-[14px] font-bold text-ink-1">{int(p.formIndex)}</span>
                    <Meter value={p.formIndex / 100} height={4} label={`Índice de forma ${int(p.formIndex)} de 100`} />
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Resultados recientes
// ---------------------------------------------------------------------------
function RecentResults({ matches }: { matches: MatchSummary[] }) {
  const judged = matches.filter((m) => typeof m.predictionHit === 'boolean');
  const hits = judged.filter((m) => m.predictionHit).length;
  if (!matches.length) return <EmptyState compact icon={<History />} title="Sin resultados recientes" />;
  return (
    <Card pad="none" className="overflow-hidden">
      {judged.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface-2/70 px-3 py-2.5 sm:px-4">
          <span className="text-[13px] text-ink-2">
            El modelo acertó <strong className="font-semibold text-ink-1">{hits}</strong> de <strong className="font-semibold text-ink-1">{judged.length}</strong> pronósticos 1X2
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="num font-display text-[22px] font-extrabold leading-none text-ink-1">{pct(hits / judged.length)}</span>
            <span className="flex gap-[2px]" aria-hidden="true">
              {judged.slice(0, 16).map((m) => (
                <span key={m.id} className={cx('flex h-4 w-4 items-center justify-center rounded-[3px]', m.predictionHit ? 'bg-win text-win-ink' : 'bg-loss text-loss-ink')}>
                  {m.predictionHit ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
                </span>
              ))}
            </span>
          </span>
        </div>
      )}
      <ul className="divide-y divide-line/70">
        {matches.slice(0, 10).map((m) => (
          <li key={m.id}>
            <MatchRow match={m} showComp showDate showHit />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function HomePage() {
  const { data: home, error, loading, reload } = useHome();
  const { data: meta } = useMeta();
  const [day, setDay] = useState<'hoy' | 'manana'>('hoy');
  const [showAllPopular, setShowAllPopular] = useState(false);

  const allToday = useMemo(() => [...(home?.today ?? []), ...(home?.popular ?? [])], [home]);
  const liveScores = useLiveScores(allToday);
  const today = useMemo(() => withLive(home?.today ?? [], liveScores), [home, liveScores]);
  const liveCount = today.filter((m) => m.status === 'live').length;

  const dayMatches = day === 'hoy' ? today : home?.tomorrow ?? [];
  const groups = useMemo(() => groupMatchesByCompetition(dayMatches, meta?.competitions), [dayMatches, meta]);

  if (loading && !home) return <PageSkeleton />;
  if (error || !home) return <ErrorState error={error} onRetry={reload} />;

  const popular = home.popular.slice(0, showAllPopular ? 12 : 6);

  return (
    <div className="space-y-10">
      <SafeBlock label="Resumen del día">
        <DayHero home={home} liveCount={liveCount} />
      </SafeBlock>

      {home.daily && home.daily.top.length > 0 && <DailyTeaser daily={home.daily} />}

      <Section
        id="populares"
        eyebrow="Próximas 72 horas"
        title="Partidos populares"
        icon={<Flame />}
        description="Los encuentros con más interés según prestigio de la competición, nivel de los equipos e igualdad."
        moreTo="/partidos"
        moreLabel="Calendario"
      >
        {popular.length ? (
          <>
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {popular.map((m, i) => (
                <MatchCard key={m.id} match={m} live={liveScores[m.id]} delay={Math.min(i, 8) * 40} />
              ))}
            </div>
            {home.popular.length > 6 && (
              <div className="mt-4 flex justify-center">
                <button type="button" className="btn" onClick={() => setShowAllPopular((v) => !v)} aria-expanded={showAllPopular}>
                  {showAllPopular ? 'Ver menos' : `Ver ${Math.min(12, home.popular.length) - 6} más`}
                </button>
              </div>
            )}
          </>
        ) : (
          <EmptyState icon={<Flame />} title="Sin partidos destacados" description="No hay partidos programados en las próximas 72 horas." />
        )}
      </Section>

      <Section
        id="agenda"
        eyebrow="Agenda"
        title={day === 'hoy' ? 'Hoy' : 'Mañana'}
        icon={<Radio />}
        description="Todos los partidos agrupados por competición, con la predicción del modelo."
        action={
          <SegmentedControl
            ariaLabel="Día"
            value={day}
            onChange={setDay}
            options={[
              { value: 'hoy', label: 'Hoy', count: home.today.length },
              { value: 'manana', label: 'Mañana', count: home.tomorrow.length },
            ]}
          />
        }
      >
        {groups.length ? (
          <div className="space-y-4">
            {groups.map((g) => (
              <MatchGroup key={g.compId} compId={g.compId} compName={g.compName} meta={g.meta} matches={g.matches} live={day === 'hoy' ? liveScores : undefined} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CalendarClock />} title={day === 'hoy' ? 'Hoy no hay partidos' : 'Mañana no hay partidos'} description="Consulta el calendario para ver los próximos días." action={<Link to="/partidos" className="btn">Abrir calendario</Link>} />
        )}
      </Section>

      <Section
        id="alta-confianza"
        eyebrow="Próximas 72 horas"
        title="Pronósticos de alta confianza"
        icon={<ShieldCheck />}
        moreTo="/confianza"
        description="Selecciones muy probables y de cuota baja, de mercados validados fuera de muestra (≥ 80% de acierto). Uno por partido. Aciertan mucho porque son fáciles, no porque ganen a la casa."
      >
        <ConfidenceList items={(home.topConfidence ?? []).filter((x) => x.match.status === 'scheduled' && !(Date.parse(x.match.date) <= Date.now()))} headline={home.confidenceHeadline} />
      </Section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:gap-6">
        <Section id="valor" eyebrow="Valor esperado" title="Picks de valor" icon={<Zap />} moreTo="/valor" description="Selecciones con probabilidad del modelo superior a la implícita en la cuota.">
          <ValueList items={home.topValue.slice(0, 8)} />
        </Section>
        <Section id="racha" eyebrow="Estado de forma" title="Jugadores en racha" icon={<TrendingUp />} moreTo="/jugadores">
          <HotPlayers players={home.hotPlayers} />
        </Section>
      </div>

      <Section id="resultados" eyebrow="Últimas 48 horas" title="Resultados recientes" icon={<History />} description="Marcadores finales y si el pronóstico 1X2 del modelo (resultado más probable) acertó.">
        <RecentResults matches={home.recent} />
      </Section>

      <Disclaimer />
    </div>
  );
}
