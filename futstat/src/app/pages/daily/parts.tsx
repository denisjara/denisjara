import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Check, ChevronDown, CircleSlash, Layers } from 'lucide-react';
import type { CompetitionMeta, DailyCategory, DailyCombo, DailyExpected, DailyFile, DailyMatch, DailyPick, MatchSummary } from '../../../types/data';
import { DAILY_CATEGORY_LABEL, hasStarted, picksByCategory } from '../../lib/daily';
import { SIDE_COLOR } from '../../lib/colors';
import { useTheme } from '../../lib/theme';
import { safeImageUrl } from '../../lib/safeUrl';
import { capitalize, int, num, odds as fmtOdds, pct, plural, time } from '../../lib/format';
import {
  CATEGORY_ICON,
  Card,
  CategoryBadge,
  DailyKickoff,
  DailyLiftNote,
  DailyNum,
  DailyRecordNote,
  DataTable,
  Meter,
  PlayerVoidNote,
  RateCI,
  ResultMark,
  TeamCrest,
  ciText,
  cx,
  dailyMarket,
  dailySelection,
  marketOddsText,
  marketOddsTitle,
  matchHref,
  ownRate,
  type Column,
} from '../../components';

type Triple = { home: number; away: number; total: number };

// ---------------------------------------------------------------------------
// Valores esperados del partido
// ---------------------------------------------------------------------------
const EXPECTED: { key: keyof DailyExpected; label: string; digits: number }[] = [
  { key: 'goals', label: 'Goles', digits: 2 },
  { key: 'shotsOnTarget', label: 'Tiros a puerta', digits: 1 },
  { key: 'shots', label: 'Tiros', digits: 1 },
  { key: 'corners', label: 'Córners', digits: 1 },
  { key: 'cards', label: 'Tarjetas', digits: 1 },
  { key: 'fouls', label: 'Faltas', digits: 1 },
];

/** Tira de valores esperados (proyecciones del modelo): total grande y reparto local–visitante con su marca de color. */
export function ExpectedStrip({ expected, home, away }: { expected: DailyExpected; home: string; away: string }) {
  const cells = EXPECTED.map((c) => ({ ...c, v: (expected as Partial<Record<keyof DailyExpected, Triple>>)[c.key] })).filter((c): c is typeof c & { v: Triple } => !!c.v);
  if (!cells.length) return null;
  return (
    <dl className="grid grid-cols-3 gap-1.5" aria-label={`Valores esperados: ${home} – ${away}`}>
      {cells.map((c) => (
        <div key={c.key} className="min-w-0 rounded-lg border border-line bg-surface-2/60 px-2 py-1.5">
          <dt className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-3" title={`${c.label} esperados`}>
            {c.label}
          </dt>
          <dd className="mt-0.5">
            <span className="num block text-[15px] font-semibold leading-tight text-ink-1">
              <span className="sr-only">Total </span>
              {num(c.v.total, c.digits)}
            </span>
            <span className="num mt-0.5 flex items-center gap-1 whitespace-nowrap text-[10.5px] leading-tight text-ink-3">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SIDE_COLOR.home }} aria-hidden="true" />
              <span className="sr-only">{home}: </span>
              {num(c.v.home, c.digits)}
              <span aria-hidden="true">–</span>
              <span className="sr-only">; {away}: </span>
              {num(c.v.away, c.digits)}
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SIDE_COLOR.away }} aria-hidden="true" />
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Tarjeta de partido
// ---------------------------------------------------------------------------
const POSITION: Record<string, string> = { G: 'Portero', D: 'Defensa', M: 'Centrocampista', F: 'Delantero' };

function PickLine({ pick, match, showReason = true }: { pick: DailyPick; match: MatchSummary; showReason?: boolean }) {
  const pl = pick.player;
  const team = pl ? (pl.teamId === match.home.id ? match.home : pl.teamId === match.away.id ? match.away : undefined) : undefined;
  return (
    <li className="min-w-0">
      {pl && (
        <p className="mb-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-ink-3">
          {team && <TeamCrest team={team} size={14} />}
          <span className="truncate">
            <span className="font-semibold text-ink-2">{pl.name}</span>
            {pl.position && POSITION[pl.position] ? ` · ${POSITION[pl.position]}` : ''}
            {pl.expMinutes !== undefined ? ` · ${int(pl.expMinutes)}' previstos` : ''}
          </span>
        </p>
      )}
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold leading-snug text-ink-1">{dailySelection(pick)}</p>
          <p className="mt-0.5 text-2xs text-ink-3">{dailyMarket(pick)}</p>
        </div>
        <div className="w-[52px] shrink-0 text-right" title="Probabilidad del modelo">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">Prob.</span>
          <span className="num block text-[14px] font-semibold leading-tight text-ink-1">{pct(pick.prob)}</span>
          <Meter value={pick.prob} height={4} className="mt-1" label={`Probabilidad ${pct(pick.prob)}`} />
        </div>
        <DailyNum label="Justa" value={fmtOdds(pick.fairOdds)} title="Cuota justa (1 / probabilidad)" className="w-[40px]" />
        <DailyNum label="Mercado" value={marketOddsText(pick)} title={marketOddsTitle(pick)} className="w-[52px]" />
        {pick.result && <ResultMark result={pick.result} />}
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <DailyRecordNote pick={pick} />
        <DailyLiftNote pick={pick} />
      </p>
      {showReason && pick.reason && <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{pick.reason}</p>}
      {pick.category === 'jugadores' && <PlayerVoidNote className="mt-1" />}
    </li>
  );
}

/** Línea compacta de un pick (tarjeta plegada): categoría, selección, probabilidad y cuota justa. */
function PickSummary({ pick, label }: { pick: DailyPick; label?: string }) {
  const Icon = CATEGORY_ICON[pick.category];
  return (
    <li className="flex min-w-0 items-center gap-2 py-[7px]">
      <Icon className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
      <span className="sr-only">{label ?? DAILY_CATEGORY_LABEL[pick.category]}: </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-1" title={dailySelection(pick)}>
        {dailySelection(pick)}
      </span>
      <span className="num shrink-0 text-[13px] font-semibold text-ink-1" title="Probabilidad del modelo">
        {pct(pick.prob)}
      </span>
      <span className="num w-[38px] shrink-0 text-right text-[12px] text-ink-3" title="Cuota justa (1 / probabilidad)">
        <span className="sr-only">cuota justa </span>
        {fmtOdds(pick.fairOdds)}
      </span>
      {pick.result && <ResultMark result={pick.result} className="h-5 w-5" />}
    </li>
  );
}

/** Nota de un partido que ya no se puede jugar antes del inicio (en juego, terminado, aplazado o cancelado). */
function startedNote(m: MatchSummary, settled: boolean): string {
  if (m.status === 'postponed' || m.status === 'cancelled') return 'No se juega en esta fecha: sus pronósticos no aplican';
  if (m.status === 'finished') return settled ? 'Terminado: ✓ acierto · ✗ fallo, con el marcador a los 90 minutos' : 'Terminado: los pronósticos eran para antes del inicio';
  return 'Ya ha empezado: los pronósticos eran para antes del inicio';
}

export interface DailyMatchCardProps {
  item: DailyMatch;
  /** categorías en el orden de daily.json, con su etiqueta */
  categories: { id: DailyCategory; label: string }[];
  now: number;
  /** día del listado (YYYY-MM-DD) */
  day: string;
  /** detalle desplegado al cargar (escritorio); plegada muestra una línea por pick */
  defaultOpen?: boolean;
}

/**
 * Tarjeta de un partido del día: escudos y hora local, tira de valores esperados, picks agrupados por categoría (con
 * probabilidad, cuotas, récord fuera de muestra de su familia y la frase con los datos), lectura del partido y enlace
 * al análisis completo.
 */
export function DailyMatchCard({ item, categories, now, day, defaultOpen = true }: DailyMatchCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const m = item.match;
  const started = hasStarted(m, now);
  const label = Object.fromEntries(categories.map((c) => [c.id, c.label])) as Partial<Record<DailyCategory, string>>;
  const groups = picksByCategory(
    item.picks,
    categories.map((c) => c.id),
  );
  const titleId = `partido-${m.id}-titulo`;
  const detailId = `partido-${m.id}-detalle`;
  return (
    <Card as="article" pad="none" id={`partido-${m.id}`} aria-labelledby={titleId} className="flex scroll-mt-24 flex-col overflow-hidden">
      <header className="border-b border-line bg-surface-2/50 px-3 py-3 sm:px-4">
        <h3 id={titleId} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <TeamCrest team={m.home} size={28} />
            <span className="truncate font-display text-[19px] font-extrabold uppercase leading-none text-ink-1" title={m.home.name}>
              {m.home.short || m.home.name}
            </span>
          </span>
          <span className="flex flex-col items-center gap-1">
            <span className="sr-only"> contra </span>
            {m.score && m.status !== 'scheduled' && (
              <span className="num font-display text-[22px] font-extrabold leading-none text-ink-1">
                {m.score.home}-{m.score.away}
              </span>
            )}
            <DailyKickoff match={m} now={now} day={day} className={cx(!started && 'font-display text-[17px] font-bold leading-none text-ink-1')} />
          </span>
          <span className="flex min-w-0 items-center justify-end gap-2 text-right">
            <span className="truncate font-display text-[19px] font-extrabold uppercase leading-none text-ink-1" title={m.away.name}>
              {m.away.short || m.away.name}
            </span>
            <TeamCrest team={m.away} size={28} />
          </span>
        </h3>
        {(m.round || started) && (
          <p className="mt-1.5 text-center text-2xs text-ink-3">
            {m.round}
            {m.round && started ? ' · ' : ''}
            {started ? startedNote(m, item.picks.some((p) => p.result)) : ''}
          </p>
        )}
      </header>

      <div className="border-b border-line px-3 py-3 sm:px-4">
        <p className="eyebrow mb-1.5">Lo que espera el modelo</p>
        <ExpectedStrip expected={item.expected} home={m.home.short || m.home.name} away={m.away.short || m.away.name} />
      </div>

      {open ? (
        <div id={detailId}>
          <div className="divide-y divide-line/70">
            {groups.map((g) => (
              <section key={g.category} aria-label={label[g.category] ?? DAILY_CATEGORY_LABEL[g.category]} className="grid gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-[96px_minmax(0,1fr)] sm:px-4">
                <div>
                  <CategoryBadge category={g.category} title={label[g.category]} />
                </div>
                <ul className="min-w-0 space-y-3">
                  {g.picks.map((p, i) => (
                    // la misma frase no se repite en dos picks seguidos de la categoría
                    <PickLine key={`${p.family}-${p.selection}`} pick={p} match={m} showReason={i === 0 || p.reason !== g.picks[i - 1].reason} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {item.analysis.length > 0 && (
            <div className="border-t border-line px-3 py-3 sm:px-4">
              <p className="eyebrow mb-1.5">Lectura del partido</p>
              <ul className="space-y-1.5 text-[12.5px] leading-snug text-ink-2">
                {item.analysis.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent-text" aria-hidden="true" />
                    <span className="min-w-0">{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-line/60 px-3 py-1 sm:px-4" aria-label={`Pronósticos de ${m.home.name} – ${m.away.name}`}>
          {item.picks.map((p) => (
            <PickSummary key={`${p.family}-${p.selection}`} pick={p} label={label[p.category]} />
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center justify-between gap-x-2 border-t border-line px-3 py-2 sm:px-4">
        <button type="button" className="btn-ghost -ml-2.5" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => setOpen((o) => !o)}>
          <ChevronDown className={cx('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          {open ? 'Ocultar detalle' : 'Ver detalle'}
          <span className="sr-only"> de los pronósticos: cuotas, récord fuera de muestra y lectura del partido</span>
        </button>
        <Link to={matchHref(m)} className="btn-ghost -mr-2.5" aria-label={`Ver análisis completo de ${m.home.name} – ${m.away.name}`}>
          Ver análisis completo
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Combinadas sugeridas
// ---------------------------------------------------------------------------
type ComboTrack = NonNullable<DailyFile['track']['combos']>[number];
const COMBO_HINT: Record<string, string> = {
  segura: 'Las patas más probables del día',
  equilibrada: 'Algo más de cuota, mercados variados',
  atrevida: 'Más patas: más cuota y bastante más riesgo',
};

/** «92% × 90% × 89%» si el producto de las patas reproduce la probabilidad combinada publicada (si no, no se muestra). */
function chain(combo: DailyCombo): { text: string; calibrated: boolean } | undefined {
  for (const calibrated of [true, false]) {
    const ps = combo.legs.map((l) => (calibrated ? (l.pick.calibratedProb ?? l.pick.prob) : l.pick.prob));
    const prod = ps.reduce((a, b) => a * b, 1);
    if (Math.abs(prod - combo.prob) < 0.008) return { text: ps.map((p) => pct(p)).join(' × '), calibrated };
  }
  return undefined;
}

export function ComboCard({ combo, track, matches, now }: { combo: DailyCombo; track?: ComboTrack; matches: Map<string, MatchSummary>; now: number }) {
  const started = combo.legs.some((l) => {
    const m = matches.get(l.matchId);
    return m ? hasStarted(m, now) : false;
  });
  const ch = chain(combo);
  const titleId = `combo-${combo.id}`;
  return (
    <Card as="article" aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">
            {plural(combo.legs.length, 'pata')} · partidos distintos
          </p>
          <h3 id={titleId} className="mt-1 font-display text-[19px] font-bold uppercase leading-tight text-ink-1">
            {combo.label}
          </h3>
          {COMBO_HINT[combo.id] && <p className="mt-0.5 text-2xs text-ink-3">{COMBO_HINT[combo.id]}</p>}
        </div>
        <div className="shrink-0 text-right">
          <span className="block font-display text-[36px] font-extrabold leading-none text-ink-1">{pct(combo.prob)}</span>
          <span className="block text-2xs text-ink-3">de acertar todas</span>
        </div>
      </div>
      <Meter value={combo.prob} label={`Probabilidad combinada ${pct(combo.prob)}`} />
      <dl className="grid grid-cols-2 gap-2 text-[12px]">
        <div className="rounded-lg border border-line bg-surface-2/60 px-2.5 py-1.5">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Cuota justa</dt>
          <dd className="num text-[15px] font-semibold text-ink-1">{fmtOdds(combo.fairOdds)}</dd>
        </div>
        <div className="rounded-lg border border-line bg-surface-2/60 px-2.5 py-1.5" title={combo.marketOdds ? 'Producto de las cuotas de la casa de todas las patas' : 'Alguna pata no tiene cuota publicada en la fuente'}>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Cuota de mercado</dt>
          <dd className="num text-[15px] font-semibold text-ink-1">
            {combo.marketOdds ? fmtOdds(combo.marketOdds) : <span className="font-sans text-[12px] font-normal text-ink-3">Sin cuota publicada</span>}
            {combo.marketOdds !== undefined && (
              <span className="block font-sans text-2xs font-normal text-ink-3">{combo.marketOdds < combo.fairOdds ? 'Por debajo de la justa: a la larga pierde' : 'No está por debajo de la justa'}</span>
            )}
          </dd>
        </div>
      </dl>
      <ol className="divide-y divide-line/70 border-y border-line/70">
        {combo.legs.map((l, i) => {
          const m = matches.get(l.matchId);
          const inner = (
            <>
              <span className="num mt-px w-4 shrink-0 text-2xs font-semibold text-ink-3">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-snug text-ink-1">{dailySelection(l.pick)}</span>
                <span className="block truncate text-2xs text-ink-3" title={`${l.home} – ${l.away}${l.compName ? ` · ${l.compName}` : ''}`}>
                  {m ? (hasStarted(m, now) ? 'Empezado · ' : <><span className="num">{time(m.date)}</span> · </>) : null}
                  {l.home} – {l.away}
                  {l.compName ? ` · ${l.compName}` : ''}
                </span>
              </span>
              <CategoryBadge category={l.pick.category} className="mt-0.5 hidden min-[420px]:inline-flex" />
              <span className="num w-[38px] shrink-0 text-right text-[13px] font-semibold text-ink-1">{pct(ch?.calibrated === false ? l.pick.prob : (l.pick.calibratedProb ?? l.pick.prob))}</span>
            </>
          );
          return (
            <li key={`${l.matchId}-${l.pick.family}`}>
              {m ? (
                <Link to={matchHref(m)} className="-mx-1.5 flex items-start gap-2 rounded-md px-1.5 py-2 transition-colors hover:bg-surface-2">
                  {inner}
                </Link>
              ) : (
                <span className="flex items-start gap-2 py-2">{inner}</span>
              )}
            </li>
          );
        })}
      </ol>
      {ch && (
        <p className="num text-2xs text-ink-3">
          {ch.text} = <span className="font-semibold text-ink-2">{pct(combo.prob)}</span>
          <span className="font-sans"> {ch.calibrated ? '(probabilidades recalibradas)' : ''}</span>
        </p>
      )}
      <div className="mt-auto rounded-lg border border-line bg-surface-2/60 px-2.5 py-2 text-[12px] leading-snug text-ink-2">
        {track ? (
          <>
            <span className="eyebrow mb-0.5 block">Histórico fuera de muestra</span>
            Habría acertado <strong className="num font-semibold text-ink-1">{int(track.hits)}</strong> de <strong className="num font-semibold text-ink-1">{int(track.days)}</strong> días{' '}
            <RateCI rate={track.hitRate} n={track.days} hits={track.hits} digits={0} className="ml-1 align-baseline" />
            {(track.avgLegs || track.avgFairOdds) && (
              <span className="block text-2xs text-ink-3">
                {track.avgLegs ? `Media de ${num(track.avgLegs, 1)} patas` : ''}
                {track.avgLegs && track.avgFairOdds ? ' · ' : ''}
                {track.avgFairOdds ? `cuota justa media ${fmtOdds(track.avgFairOdds)}` : ''}
              </span>
            )}
          </>
        ) : (
          <span className="text-ink-3">Sin histórico todavía para este tipo de combinada.</span>
        )}
      </div>
      {started && (
        <p className="flex items-start gap-1 text-2xs text-ink-2">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
          Alguno de sus partidos ya ha empezado: ya no se puede jugar entera antes del inicio.
        </p>
      )}
    </Card>
  );
}

/** Aviso obligatorio sobre las combinadas: cada pata multiplica el riesgo. */
export function ComboWarning({ combos }: { combos: DailyCombo[] }) {
  const longest = [...combos].sort((a, b) => b.legs.length - a.legs.length)[0];
  return (
    <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/[0.06] px-3 py-2 text-[12.5px] leading-snug text-ink-2">
      <Layers className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
      <span>
        <strong className="text-ink-1">Cada pata que añades baja la probabilidad:</strong> para cobrar hay que acertarlas todas. Tres selecciones del 90% juntas solo salen el 73% de las
        veces
        {longest && longest.legs.length >= 4 ? `; la de ${longest.legs.length} patas de aquí abajo se queda en el ${pct(longest.prob)}` : ''}. Y la casa cobra su margen en cada pata.
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Bloque destacado: competición de cartel del día
// ---------------------------------------------------------------------------
export function FeaturedCompetition({
  meta,
  compName,
  matches,
  picks,
  dayLabel,
  now,
  active,
  onFilter,
}: {
  meta?: CompetitionMeta;
  compName: string;
  matches: DailyMatch[];
  picks: number;
  /** «Hoy», «Mañana», «El jue 26 nov» */
  dayLabel: string;
  now: number;
  /** el filtro de esta competición ya está puesto */
  active: boolean;
  onFilter: () => void;
}) {
  const [theme] = useTheme();
  const [failed, setFailed] = useState<string[]>([]);
  const logo = (theme === 'dark' ? [meta?.logoDark, meta?.logo] : [meta?.logo]).map(safeImageUrl).find((u): u is string => !!u && !failed.includes(u));
  const name = meta?.name ?? compName;
  const pending = matches.filter((m) => !hasStarted(m.match, now));
  const times = [...new Set(pending.map((m) => time(m.match.date)))].slice(0, 4);
  const jump = (id: string) => {
    const el = document.getElementById(`partido-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return (
    <section aria-labelledby="destacada-titulo" className="relative overflow-hidden rounded-card border border-accent-text/40 bg-surface-1/80">
      <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-accent/15 blur-3xl" aria-hidden="true" />
      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3 px-4 pt-4 sm:px-5">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-line bg-surface-2">
          {logo ? (
            <img src={logo} alt="" className="h-9 w-9 object-contain" onError={() => setFailed((f) => [...f, logo])} />
          ) : (
            <span className="max-w-[2em] shrink-0 overflow-hidden whitespace-nowrap text-[28px] leading-none" aria-hidden="true">
              {meta?.flag ?? '⚽'}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 basis-[240px]">
          <p className="eyebrow text-accent-text">Partidos destacados</p>
          <h2 id="destacada-titulo" className="display mt-1 text-[24px] text-ink-1 sm:text-[30px]">
            {dayLabel} juega la {name} <span className="whitespace-nowrap text-ink-3">· {plural(matches.length, 'partido')}</span>
          </h2>
          <p className="mt-1 text-[13px] text-ink-2">
            {plural(picks, 'pronóstico')} validados
            {times.length ? ` · ${pending.length === matches.length ? 'empiezan' : `${plural(pending.length, 'partido')} por empezar,`} a las ${times.join(' y ').replace(/ y (?=.* y )/g, ', ')}` : ' · todos han empezado ya'}
          </p>
        </div>
        <button type="button" className={active ? 'btn' : 'btn-accent'} onClick={onFilter} aria-pressed={active}>
          {active ? 'Ver todas las competiciones' : `Ver solo ${meta?.shortName ?? name}`}
        </button>
      </div>
      <ul className="relative mt-3 flex gap-2 overflow-x-auto px-4 pb-4 scrollbar-none sm:px-5" aria-label={`Partidos de ${name}`}>
        {matches.map(({ match: m, picks: ps }) => (
          <li key={m.id} className="shrink-0">
            <button
              type="button"
              onClick={() => jump(m.id)}
              className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-left transition-colors hover:border-line-strong hover:bg-surface-3"
              aria-label={`${m.home.name} – ${m.away.name}: ir a sus ${plural(ps.length, 'pronóstico')}`}
            >
              <span className="flex shrink-0 -space-x-1.5">
                <TeamCrest team={m.home} size={18} className="ring-2 ring-surface-2" />
                <TeamCrest team={m.away} size={18} className="ring-2 ring-surface-2" />
              </span>
              <span className="whitespace-nowrap text-[12.5px] font-semibold text-ink-1">
                {m.home.abbr} – {m.away.abbr}
              </span>
              <DailyKickoff match={m} now={now} className="text-2xs" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cómo leer esto
// ---------------------------------------------------------------------------
type CatRow = DailyFile['track']['byCategory'][number];
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x * 100), 1)} pp`;
const dayUtc = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('.', '') : '';
};

export function HowToRead({ file }: { file: DailyFile }) {
  const t = file.track;
  const o = t.overall;
  const b = t.baseline;
  const columns: Column<CatRow>[] = [
    {
      key: 'cat',
      header: 'Categoría',
      sticky: true,
      sortValue: (r) => r.label,
      firstDir: 'asc',
      cell: (r) => <CategoryBadge category={r.category} label={r.label} />,
    },
    {
      key: 'rate',
      header: 'Acierto',
      title: 'Acierto fuera de muestra (walk-forward mensual). Con menos de 50 casos no se da acierto propio.',
      numeric: true,
      sortValue: (r) => (ownRate(r.n) ? r.hitRate : r.n ? -1 + r.n / 1000 : undefined),
      cell: (r) => (ownRate(r.n) ? <span className="num font-semibold text-ink-1">{pct(r.hitRate, 1)}</span> : r.n > 0 ? <span className="whitespace-nowrap font-sans text-ink-3">Muestra pequeña</span> : <span className="text-ink-3">—</span>),
    },
    { key: 'n', header: 'n', title: 'Pronósticos resueltos (acierto o fallo)', numeric: true, sortValue: (r) => r.n, cell: (r) => <span className="num text-ink-2">{int(r.n)}</span> },
    {
      key: 'ci',
      header: 'Intervalo 90%',
      title: 'Intervalo de Wilson al 90 % del acierto',
      numeric: true,
      className: 'whitespace-nowrap',
      sortValue: (r) => (ownRate(r.n) ? r.wilsonLow : undefined),
      cell: (r) => (ownRate(r.n) && r.wilsonLow !== undefined && r.wilsonHigh !== undefined ? <span className="num text-ink-2">{ciText(r.wilsonLow, r.wilsonHigh)}</span> : <span className="text-ink-3">—</span>),
    },
    {
      key: 'base',
      header: 'Tasa base',
      title: 'Lo que aciertan esos mismos mercados sin filtrar con el modelo',
      numeric: true,
      sortValue: (r) => r.baseRate,
      cell: (r) => (r.baseRate !== undefined ? <span className="num text-ink-2">{pct(r.baseRate, 1)}</span> : <span className="text-ink-3">—</span>),
    },
    {
      key: 'lift',
      header: 'Diferencia',
      title: 'Acierto − tasa base, en puntos porcentuales (solo con al menos 50 casos)',
      numeric: true,
      hideBelow: 'sm',
      className: 'whitespace-nowrap',
      sortValue: (r) => (ownRate(r.n) && r.baseRate !== undefined ? r.hitRate - r.baseRate : undefined),
      cell: (r) =>
        ownRate(r.n) && r.baseRate !== undefined ? <span className={cx('num font-semibold', r.hitRate - r.baseRate < 0 ? 'text-warn' : 'text-ink-1')}>{pp(r.hitRate - r.baseRate)}</span> : <span className="text-ink-3">—</span>,
    },
  ];
  const period = dayUtc(o.from) && dayUtc(o.to) ? `${dayUtc(o.from)} – ${dayUtc(o.to)}` : '';
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <ul className="grid gap-x-8 gap-y-2.5 text-[13.5px] leading-snug text-ink-2 lg:grid-cols-2">
          <li className="flex gap-2.5">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-win" aria-hidden="true" />
            <span>
              Son <strong className="text-ink-1">selecciones muy probables con cuota baja</strong>: lo que el modelo ve más claro en cada partido (goles, tiros, córners, tarjetas,
              faltas y jugadores), no «apuestas seguras».
            </span>
          </li>
          <li className="flex gap-2.5">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-win" aria-hidden="true" />
            <span>
              El acierto está <strong className="text-ink-1">medido fuera de muestra</strong>: cada partido se predijo solo con datos anteriores a su inicio y se resuelve a 90
              minutos. Junto a cada pronóstico va el récord de su mercado con su n; con menos de 50 casos, «muestra pequeña».
            </span>
          </li>
          <li className="flex gap-2.5">
            <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
            <span>
              <strong className="text-ink-1">No es una ventaja frente a la casa.</strong>
              {b ? ` Apostar siempre lo mismo sin ningún modelo (${b.label}) acierta un ${pct(b.hitRate, 1)}.` : ''} Aciertan mucho porque son fáciles; la casa las paga poco y
              cobra su margen. Si la cuota que te ofrecen es menor que la «justa», a la larga se pierde.
            </span>
          </li>
          <li className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/70 px-3 py-2 text-[12.5px]">
            <span className="mt-px shrink-0 font-display text-[13px] font-extrabold text-ink-1">+18</span>
            <span>Información estadística, no consejos de apuesta. Si apuestas, solo con dinero que puedas permitirte perder y con límites.</span>
          </li>
        </ul>
        {file.note && <p className="text-[12.5px] leading-snug text-ink-3">{file.note}</p>}
        <p className="text-[12.5px] text-ink-3">
          Cómo se validan las reglas, el holdout y las limitaciones:{' '}
          <Link to="/confianza" className="link">
            metodología de alta confianza
          </Link>
          .
        </p>
      </Card>
      <div className="min-w-0 space-y-2">
        <DataTable columns={columns} rows={t.byCategory} rowKey={(r) => r.category} caption="Acierto fuera de muestra de los pronósticos del día, por categoría" dense emptyText="Todavía no hay histórico por categoría." />
        <p className="text-2xs text-ink-3">
          {capitalize('walk-forward mensual')}
          {period ? ` (${period})` : ''}: las reglas se reajustan cada mes solo con partidos anteriores.
          {ownRate(o.n) ? ` En total, ${pct(o.hitRate, 1)} en ${int(o.n)} pronósticos resueltos (intervalo ${ciText(o.wilsonLow, o.wilsonHigh) || '—'}).` : ''} «Diferencia» negativa: publicar ese
          mercado siempre habría acertado más que filtrarlo.
        </p>
      </div>
    </div>
  );
}
