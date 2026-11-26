/**
 * «Factores del partido»: contexto previo al pitido inicial (MatchFile.factors) en piezas pequeñas y escaneables.
 * Cada pieza dice si el modelo la usa («Usado en el modelo») o si es solo contexto («Informativo»).
 * Los datos llegan normalizados por `normMatchFactors`; aun así, cada pieza va en su propio SafeBlock.
 */
import { useId, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  CircleSlash,
  Cpu,
  Flame,
  Globe,
  House,
  Info,
  ListChecks,
  Minus,
  Plane,
  RectangleVertical,
  Split,
  Swords,
  Trophy,
  TrendingDown,
  TrendingUp,
  UserRoundX,
  UserX,
} from 'lucide-react';
import type {
  FactorAbsence,
  FactorInFormPlayer,
  FactorReferee,
  FactorStake,
  FactorStakes,
  FactorTeamForm,
  FactorTie,
  FactorVenueSide,
  MatchFactors,
  MatchSummary,
  TeamRef,
} from '../../../types/data';
import { Meter, SafeBlock, TeamCrest, cx } from '../../components';
import { dateTime, int, num, pct, shortDate, signed, xg } from '../../lib/format';
import {
  absenceEffect,
  absenceDetail,
  absenceKindLabel,
  factorHighlights,
  factorUsage,
  firstLegHostIsAway,
  formTrend,
  ordinal,
  ratioDelta,
  refereeGaugePos,
  refereeSentence,
  refereeTone,
  stakeText,
  tieNeeds,
  type FactorHighlight,
} from '../../lib/factors';
import { Panel, TeamTag } from './parts';

type Side = 'home' | 'away';
const SIDES: readonly Side[] = ['home', 'away'];

// ---------------------------------------------------------------------------
// Piezas comunes
// ---------------------------------------------------------------------------

/** Insignia «Usado en el modelo» / «Informativo» (texto + icono: nunca solo color). */
export function UsageBadge({ used, className }: { used: boolean; className?: string }) {
  return used ? (
    <span className={cx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-accent-text/45 bg-accent/10 px-1.5 py-0.5 text-2xs font-semibold text-ink-1', className)}>
      <Cpu className="h-3 w-3 text-accent-text" aria-hidden="true" />
      Usado en el modelo
    </span>
  ) : (
    <span className={cx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-line-strong px-1.5 py-0.5 text-2xs font-medium text-ink-2', className)}>
      <Info className="h-3 w-3 text-ink-3" aria-hidden="true" />
      Informativo
    </span>
  );
}

/** Pieza del panel: cabecera tipo rótulo de retransmisión con raíl de color (modelo = acento, informativo = línea). */
function Tile({ title, icon, used, className, children }: { title: string; icon: ReactNode; used: boolean; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <article aria-labelledby={id} className={cx('relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface-2/50', className)}>
      <span className={cx('absolute inset-y-0 left-0 w-[3px]', used ? 'bg-accent-text' : 'bg-line-strong')} aria-hidden="true" />
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-line/70 py-2 pl-4 pr-3">
        <h3 id={id} className="flex min-w-0 items-center gap-1.5 font-display text-[15px] font-bold uppercase leading-tight tracking-[0.04em] text-ink-1">
          <span className="text-ink-3 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h3>
        <UsageBadge used={used} />
      </header>
      {/* overflow-wrap:anywhere: un texto largo sin espacios (nota, «en juego»…) se parte en vez de quedar recortado */}
      <div className="min-w-0 flex-1 py-3 pl-4 pr-3 text-[13px] text-ink-2 [overflow-wrap:anywhere]">
        <SafeBlock>{children}</SafeBlock>
      </div>
    </article>
  );
}

/** Bloque por equipo dentro de una pieza (local arriba, visitante abajo). */
function TeamRows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line/70 [&>*]:py-2.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">{children}</div>;
}

function MiniStat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-2xs text-ink-3">{label}</div>
      <div className="num text-[13px] font-semibold text-ink-1">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Árbitro
// ---------------------------------------------------------------------------

const TONE_LABEL = { estricto: 'Estricto', permisivo: 'Permisivo', normal: 'Normal' } as const;

function RefereeTile({ referee, finished }: { referee: FactorReferee; finished: boolean }) {
  if (referee.status !== 'conocido') {
    return (
      <Tile title="Árbitro" icon={<RectangleVertical />} used={false}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-3" aria-hidden="true">
            <UserRoundX className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-ink-1">{finished ? 'Árbitro no publicado antes del partido' : 'Árbitro aún no publicado'}</p>
            <p className="mt-1 text-[12.5px] leading-snug text-ink-3">
              {finished
                ? 'Sin designación conocida, el modelo usó la media de la liga en tarjetas y faltas.'
                : 'Lo consultamos en cada actualización durante las 72 h previas. Cuando se conozca, el modelo ajustará tarjetas y faltas.'}
            </p>
          </div>
        </div>
      </Tile>
    );
  }
  const noHistory = referee.matches === 0;
  const tone = noHistory ? 'normal' : refereeTone(referee.cardsRatio);
  const pos = refereeGaugePos(referee.cardsRatio);
  return (
    <Tile title="Árbitro" icon={<RectangleVertical />} used={referee.usedInModel}>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-[15px] font-semibold text-ink-1" title={referee.name}>
          {referee.name}
        </p>
        <span className="shrink-0 text-2xs text-ink-3">
          {noHistory ? 'sin partidos previos' : `${int(referee.matches)} ${referee.matches === 1 ? 'partido previo' : 'partidos previos'}`}
        </span>
      </div>
      {noHistory ? (
        <p className="mt-2 text-[12.5px] leading-snug text-ink-3">Sin historial de tarjetas: el modelo toma la media de la liga.</p>
      ) : (
        <>
          <div className="mt-2.5 flex items-end justify-between gap-3">
            <div>
              <div className="font-display text-[24px] font-extrabold uppercase leading-none tracking-[0.02em] text-ink-1">{TONE_LABEL[tone]}</div>
              <div className="mt-1 text-[12px] text-ink-2">
                <span className="num font-semibold text-ink-1">{ratioDelta(referee.cardsRatio)}</span> tarjetas vs media de la liga
              </div>
            </div>
            {referee.cardsPerMatch !== undefined && (
              <div className="text-right">
                <div className="num text-[18px] font-semibold leading-none text-ink-1">{num(referee.cardsPerMatch, 2)}</div>
                <div className="mt-1 text-2xs text-ink-3">tarjetas/partido</div>
              </div>
            )}
          </div>
          {/* medidor de severidad: centro = media de la liga, ±20 % en los extremos */}
          <div className="mt-3" role="img" aria-label={`Severidad: ${refereeSentence(referee)}. Valoración: ${TONE_LABEL[tone].toLowerCase()}.`}>
            <div className="relative h-2 rounded-full bg-surface-3">
              <span className="absolute inset-y-0 left-[37.5%] right-[37.5%] bg-line-strong/60" />
              <span className="absolute inset-y-[-3px] left-1/2 w-px bg-ink-3" />
              <span
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-1 bg-warn shadow-card"
                style={{ left: `${pos * 100}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[10.5px] uppercase tracking-[0.08em] text-ink-3" aria-hidden="true">
              <span>Permisivo</span>
              <span>Media</span>
              <span>Estricto</span>
            </div>
          </div>
          {referee.foulsRatio !== undefined && (
            <p className="mt-2 text-[12px] text-ink-3">
              Faltas: <span className="num font-semibold text-ink-2">{ratioDelta(referee.foulsRatio)}</span> vs media
            </p>
          )}
        </>
      )}
      {!referee.usedInModel && !noHistory && <p className="mt-2 text-[12px] text-ink-3">Esta versión del modelo no aplica el ajuste de árbitro.</p>}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Eliminatoria
// ---------------------------------------------------------------------------

function ScoreLine({ label, sub, left, right, lg, rg, emphasize }: { label: string; sub?: string; left: TeamRef; right: TeamRef; lg: number; rg: number; emphasize?: Side | 'none' }) {
  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 py-1.5">
      <div className="min-w-0">
        <div className="text-2xs font-semibold uppercase tracking-[0.1em] text-ink-3">{label}</div>
        {sub && <div className="truncate text-[10.5px] text-ink-3">{sub}</div>}
      </div>
      <span className="flex min-w-0 items-center justify-end gap-1.5">
        <span className={cx('truncate', emphasize === 'home' ? 'font-semibold text-ink-1' : 'text-ink-2')} title={left.name}>
          {left.short || left.name}
        </span>
        <span className="hidden shrink-0 sm:inline-flex">
          <TeamCrest team={left} size={16} />
        </span>
      </span>
      <span className="num rounded-md bg-surface-3 px-2 py-0.5 text-center text-[15px] font-semibold text-ink-1">
        {int(lg)}–{int(rg)}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="hidden shrink-0 sm:inline-flex">
          <TeamCrest team={right} size={16} />
        </span>
        <span className={cx('truncate', emphasize === 'away' ? 'font-semibold text-ink-1' : 'text-ink-2')} title={right.name}>
          {right.short || right.name}
        </span>
      </span>
    </div>
  );
}

function TieTile({ tie, match }: { tie: FactorTie; match: MatchSummary }) {
  const hostAway = firstLegHostIsAway(tie);
  const idaHome = hostAway ? match.away : match.home;
  const idaAway = hostAway ? match.home : match.away;
  const needs = tieNeeds(tie);
  return (
    <Tile title="Eliminatoria" icon={<Split />} used={false}>
      <div role="group" aria-label={tie.summary} className="divide-y divide-line/70 rounded-lg border border-line bg-surface-1/60 px-2.5">
        <ScoreLine label="Ida" sub={tie.firstLegDate ? shortDate(tie.firstLegDate) : undefined} left={idaHome} right={idaAway} lg={tie.firstLeg.home} rg={tie.firstLeg.away} />
        <ScoreLine label="Global" left={match.home} right={match.away} lg={tie.aggregate.home} rg={tie.aggregate.away} emphasize={tie.leader} />
      </div>
      <dl className="mt-2.5 space-y-1.5">
        {SIDES.map((s) => (
          <div key={s} className="flex min-w-0 flex-col gap-0.5">
            <dt>
              <TeamTag team={match[s]} side={s} size={14} className="text-[12.5px]" />
            </dt>
            <dd className="pl-3.5 text-[12.5px] leading-snug text-ink-2">{needs[s]}</dd>
          </div>
        ))}
      </dl>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Lo que se juega
// ---------------------------------------------------------------------------

const STAKE_ICON: Record<FactorStake['status'], ReactNode> = {
  título: <Trophy className="h-3.5 w-3.5 text-warn" aria-hidden="true" />,
  'plazas continentales': <Globe className="h-3.5 w-3.5 text-home" aria-hidden="true" />,
  ascenso: <ArrowUp className="h-3.5 w-3.5 text-pos" aria-hidden="true" />,
  descenso: <ArrowDown className="h-3.5 w-3.5 text-neg" aria-hidden="true" />,
  'sin nada en juego': <CircleSlash className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />,
};

/** Rango matemático de posición final (mejor–peor) sobre la tabla, con la posición actual marcada. */
function RangeBar({ stake, teams }: { stake: FactorStake; teams: number }) {
  const n = Math.max(2, teams);
  const at = (p: number) => ((Math.min(n, Math.max(1, p)) - 1) / (n - 1)) * 100;
  const left = at(stake.best);
  const right = at(stake.worst);
  return (
    <div role="img" aria-label={`Ahora ${ordinal(stake.position)}; puede acabar entre ${ordinal(stake.best)} y ${ordinal(stake.worst)} de ${n}`} className="mt-1.5">
      <div className="relative h-1.5 rounded-full bg-surface-3">
        <span className="absolute inset-y-0 rounded-full bg-ink-3/60" style={{ left: `${left}%`, width: `${Math.max(1.5, right - left)}%` }} />
        <span className="absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-1" style={{ left: `${at(stake.position)}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[10.5px] text-ink-3" aria-hidden="true">
        <span>1º</span>
        <span>{ordinal(n)}</span>
      </div>
    </div>
  );
}

function StakesTile({ stakes, match }: { stakes: FactorStakes; match: MatchSummary }) {
  return (
    <Tile title="Lo que se juega" icon={<Trophy />} used={false}>
      <TeamRows>
        {SIDES.map((s) => {
          const st = stakes[s];
          return (
            <div key={s} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <TeamTag team={match[s]} side={s} size={16} />
                <span className="chip">
                  {STAKE_ICON[st.status] ?? STAKE_ICON['sin nada en juego']}
                  {stakeText(st.status)}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-ink-3">
                <span className="num text-ink-2">{ordinal(st.position)}</span> · <span className="num text-ink-2">{int(st.points)}</span> pts · quedan{' '}
                <span className="num text-ink-2">{int(st.remaining)}</span> · puede acabar {ordinal(st.best)}–{ordinal(st.worst)}
              </p>
              <RangeBar stake={st} teams={stakes.teams} />
              {st.inPlay.length > 0 && <p className="mt-1 text-[12px] text-ink-3">En juego: {st.inPlay.join(' · ')}</p>}
            </div>
          );
        })}
      </TeamRows>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Forma reciente
// ---------------------------------------------------------------------------

const TREND_ICON = {
  up: <TrendingUp className="h-3.5 w-3.5 text-pos" aria-hidden="true" />,
  down: <TrendingDown className="h-3.5 w-3.5 text-neg" aria-hidden="true" />,
  flat: <Minus className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />,
};

function FormBlock({ team, side, form }: { team: TeamRef; side: Side; form: FactorTeamForm }) {
  const hasXg = form.xgFor !== undefined && form.xgAgainst !== undefined;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <TeamTag team={team} side={side} size={16} />
        <span className="chip">
          {TREND_ICON[formTrend(form)]}
          {form.label}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {hasXg ? (
          <>
            <MiniStat label="xG a favor" value={xg(form.xgFor)} title="xG aproximado por tiros, por partido" />
            <MiniStat label="xG en contra" value={xg(form.xgAgainst)} title="xG aproximado por tiros, por partido" />
          </>
        ) : (
          <>
            <MiniStat label="Goles a favor" value={num(form.goalsFor, 2)} />
            <MiniStat label="Goles en contra" value={num(form.goalsAgainst, 2)} />
          </>
        )}
        <MiniStat label="vs esperado" value={signed(form.netRes, 2)} title="xG neto por partido frente a lo esperado por el Elo de los rivales" />
      </div>
      <p className="mt-1 text-2xs text-ink-3">
        Últimos {int(form.last)} · goles {num(form.goalsFor, 2)}–{num(form.goalsAgainst, 2)} por partido
      </p>
    </div>
  );
}

function FormTile({ form, match }: { form: NonNullable<MatchFactors['form']>; match: MatchSummary }) {
  return (
    <Tile title="Forma reciente" icon={<TrendingUp />} used={false}>
      <TeamRows>
        {SIDES.map((s) => {
          const f = form[s];
          return f ? (
            <FormBlock key={s} team={match[s]} side={s} form={f} />
          ) : (
            <div key={s} className="flex items-center justify-between gap-2">
              <TeamTag team={match[s]} side={s} size={16} />
              <span className="text-[12px] text-ink-3">Pocos partidos recientes</span>
            </div>
          );
        })}
      </TeamRows>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Local / visita
// ---------------------------------------------------------------------------

function RecordBar({ v }: { v: FactorVenueSide }) {
  const parts = [
    { k: 'V', n: v.w, cls: 'bg-win' },
    { k: 'E', n: v.d, cls: 'bg-draw' },
    { k: 'D', n: v.l, cls: 'bg-loss' },
  ];
  return (
    <div className="mt-1.5 flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
      {parts.map((p) => (p.n > 0 ? <span key={p.k} className={cx('h-full', p.cls)} style={{ flexGrow: p.n, flexBasis: 0 }} /> : null))}
    </div>
  );
}

function VenueBlock({ team, side, v }: { team: TeamRef; side: Side; v?: FactorVenueSide }) {
  const where = side === 'home' ? 'En casa' : 'Fuera';
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <TeamTag team={team} side={side} size={16} />
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">
          {side === 'home' ? <House className="h-3 w-3" aria-hidden="true" /> : <Plane className="h-3 w-3" aria-hidden="true" />}
          {where}
        </span>
      </div>
      {v ? (
        <>
          <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            {/* aria-label en un <span> genérico no se anuncia: texto oculto para lectores de pantalla en su lugar */}
            <span className="num text-[13px] text-ink-1">
              <span aria-hidden="true">
                <b className="font-semibold">{v.w}</b>V · <b className="font-semibold">{v.d}</b>E · <b className="font-semibold">{v.l}</b>D
              </span>
              <span className="sr-only">{`${v.w} victorias, ${v.d} empates y ${v.l} derrotas en ${v.played} partidos`}</span>
            </span>
            <span className="num text-[12px] text-ink-2">
              {num(v.gfPerMatch, 2)} – {num(v.gaPerMatch, 2)} <span className="font-sans text-ink-3">goles/partido</span>
            </span>
          </div>
          <RecordBar v={v} />
          <p className="mt-1 text-2xs text-ink-3">
            {int(v.played)} {v.played === 1 ? 'partido' : 'partidos'} · {v.scope === 'competición' ? 'esta competición' : 'todas las competiciones, último año'}
          </p>
        </>
      ) : (
        <p className="mt-1 text-[12px] text-ink-3">Sin partidos suficientes {side === 'home' ? 'en casa' : 'fuera'}.</p>
      )}
    </div>
  );
}

function VenueTile({ venue, match }: { venue: NonNullable<MatchFactors['venue']>; match: MatchSummary }) {
  return (
    <Tile title="Local / visita" icon={<House />} used={venue.usedInModel}>
      <TeamRows>
        {SIDES.map((s) => (
          <VenueBlock key={s} team={match[s]} side={s} v={venue[s]} />
        ))}
      </TeamRows>
      {venue.note && <p className="mt-2.5 border-t border-line/70 pt-2 text-[12px] leading-snug text-ink-3">Modelo: {venue.note}.</p>}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Bajas
// ---------------------------------------------------------------------------

function AbsenceRow({ a }: { a: FactorAbsence }) {
  const susp = a.kind === 'susp';
  return (
    <li className="flex min-w-0 items-start gap-2 py-1.5">
      <span className={cx('mt-0.5 shrink-0', susp ? 'text-loss' : 'text-ink-3')} aria-hidden="true">
        {susp ? <Ban className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate font-medium text-ink-1" title={a.name}>
            {a.name}
          </span>
          <span className="num shrink-0 text-[12px] text-ink-2" title="Cuota de los minutos del equipo en sus 5 últimos partidos">
            {pct(a.minutesShare)} min.
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-[12px] text-ink-3">
          <span>
            <span className={cx('font-semibold', susp ? 'text-ink-1' : 'text-ink-2')}>{absenceKindLabel(a.kind)}</span> · {absenceDetail(a.kind)}
          </span>
          <span className={cx('shrink-0', a.usedInModel ? 'text-ink-2' : 'text-ink-3')}>{absenceEffect(a)}</span>
        </div>
      </div>
    </li>
  );
}

function AbsencesTile({ absences, match }: { absences?: MatchFactors['absences']; match: MatchSummary }) {
  const used = !!absences && [...absences.home, ...absences.away].some((a) => a.usedInModel);
  return (
    <Tile title="Bajas probables" icon={<UserX />} used={used}>
      {!absences ? (
        <p className="text-[12.5px] text-ink-3">Sin bajas probables detectadas en los últimos partidos de ninguno de los dos equipos.</p>
      ) : (
        <>
          <TeamRows>
            {SIDES.map((s) => (
              <div key={s} className="min-w-0">
                <TeamTag team={match[s]} side={s} size={16} />
                {absences[s].length ? (
                  <ul className="mt-1 divide-y divide-line/50" aria-label={`Bajas probables de ${match[s].name}`}>
                    {absences[s].map((a) => (
                      <AbsenceRow key={a.playerId} a={a} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[12px] text-ink-3">Sin bajas detectadas.</p>
                )}
              </div>
            ))}
          </TeamRows>
          <p className="mt-2.5 border-t border-line/70 pt-2 text-[12px] leading-snug text-ink-3">
            Deducidas de quién jugó (no hay alineaciones ni partes médicos). Un sancionado no se publica en las props de jugadores.
          </p>
        </>
      )}
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Jugadores en forma
// ---------------------------------------------------------------------------

function InFormRow({ p }: { p: FactorInFormPlayer }) {
  return (
    <li className="py-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate font-medium text-ink-1" title={p.name}>
          {p.name}
        </span>
        <span className="num shrink-0 text-[12px] font-semibold text-ink-1">{int(p.formIndex)}</span>
      </div>
      <Meter value={p.formIndex / 100} height={4} className="mt-1" label={`Índice de forma de ${p.name}: ${int(p.formIndex)} de 100`} />
      {p.note && <p className="mt-1 text-[12px] leading-snug text-ink-3">{p.note}</p>}
    </li>
  );
}

function InFormTile({ inForm, match }: { inForm: NonNullable<MatchFactors['inForm']>; match: MatchSummary }) {
  return (
    <Tile title="Jugadores en forma" icon={<Flame />} used={false}>
      <TeamRows>
        {SIDES.map((s) => (
          <div key={s} className="min-w-0">
            <TeamTag team={match[s]} side={s} size={16} />
            {inForm[s].length ? (
              <ul className="mt-1 divide-y divide-line/50" aria-label={`Jugadores en forma de ${match[s].name}`}>
                {inForm[s].map((p) => (
                  <InFormRow key={p.playerId} p={p} />
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[12px] text-ink-3">Ninguno destacado.</p>
            )}
          </div>
        ))}
      </TeamRows>
      <p className="mt-2.5 border-t border-line/70 pt-2 text-[12px] leading-snug text-ink-3">Índice de forma 0–100, el mismo de las props de jugadores. No cambia las probabilidades.</p>
    </Tile>
  );
}

// ---------------------------------------------------------------------------
// Resumen y panel
// ---------------------------------------------------------------------------

const HIGHLIGHT_ICON: Record<FactorHighlight['kind'], ReactNode> = {
  referee: <RectangleVertical className="h-3.5 w-3.5 text-warn" aria-hidden="true" />,
  tie: <Swords className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />,
  absences: <UserX className="h-3.5 w-3.5 text-loss" aria-hidden="true" />,
  stakes: <Trophy className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />,
};

function Highlights({ items }: { items: FactorHighlight[] }) {
  if (!items.length) return null;
  return (
    <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Factores destacados">
      {items.map((h) => (
        <li key={h.key} className="chip max-w-full py-1 text-[12px] text-ink-1">
          {HIGHLIGHT_ICON[h.kind]}
          <span className="truncate">{h.label}</span>
          <span className="sr-only">{h.used ? ' (usado en el modelo)' : ' (informativo)'}</span>
        </li>
      ))}
    </ul>
  );
}

export function FactorsPanel({ factors, match }: { factors?: MatchFactors; match: MatchSummary }) {
  if (!factors) return null;
  const usage = factorUsage(factors);
  const highlights = factorHighlights(factors, match.home, match.away);
  const finished = match.status === 'finished' || match.status === 'live';
  return (
    <Panel
      id="factores"
      title="Factores del partido"
      icon={<ListChecks />}
      eyebrow="Antes del pitido inicial"
      description={
        <>
          Contexto calculado solo con información anterior al inicio{factors.asOf ? ` (${dateTime(factors.asOf)})` : ''}. Cada pieza indica si el modelo la usa o si es solo informativa.
        </>
      }
      action={
        <span className="text-2xs text-ink-3">
          <span className="num font-semibold text-ink-1">{usage.used}</span> en el modelo · <span className="num font-semibold text-ink-1">{usage.info}</span> informativos
        </span>
      }
    >
      <Highlights items={highlights} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <RefereeTile referee={factors.referee} finished={finished} />
        {factors.tie && <TieTile tie={factors.tie} match={match} />}
        <AbsencesTile absences={factors.absences} match={match} />
        {factors.stakes && <StakesTile stakes={factors.stakes} match={match} />}
        {factors.form && <FormTile form={factors.form} match={match} />}
        {factors.venue && <VenueTile venue={factors.venue} match={match} />}
        {factors.inForm && <InFormTile inForm={factors.inForm} match={match} />}
      </div>
      {factors.notes.length > 0 && (
        <details className="group mt-3 min-w-0 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12.5px] [overflow-wrap:anywhere]">
          <summary className="cursor-pointer select-none font-medium text-ink-2 hover:text-ink-1">Cómo entra cada factor en el modelo</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2 marker:text-ink-3">
            {factors.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
