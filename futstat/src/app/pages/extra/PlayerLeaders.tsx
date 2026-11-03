import type { ReactNode } from 'react';
import { Crosshair, Flame, Goal, RectangleVertical } from 'lucide-react';
import type { PlayerSeasonRow } from '../../../types/data';
import { Card, CompetitionBadge, Meter, TeamCrest, cx } from '../../components';
import { int, num, plural } from '../../lib/format';
import { PositionTag } from './ui';

interface LeaderItem {
  row: PlayerSeasonRow;
  value: number;
  display: string;
  sub: string;
}

interface LeaderSpec {
  id: string;
  title: string;
  icon: ReactNode;
  note: string;
  unit: string;
  items: LeaderItem[];
}

const sum5 = (r: PlayerSeasonRow, k: 'goals' | 'assists') => (r.last5 ?? []).reduce((s, x) => s + (x[k] ?? 0), 0);

function top(rows: PlayerSeasonRow[], value: (r: PlayerSeasonRow) => number, tie: (r: PlayerSeasonRow) => number, n = 5): PlayerSeasonRow[] {
  return [...rows]
    .filter((r) => Number.isFinite(value(r)))
    .sort((a, b) => value(b) - value(a) || tie(b) - tie(a))
    .slice(0, n)
    .filter((r) => value(r) > 0);
}

export function buildLeaders(players: PlayerSeasonRow[], p90Floor: number): LeaderSpec[] {
  const qualified = players.filter((p) => (p.minutes ?? 0) >= p90Floor);
  return [
    {
      id: 'forma',
      title: 'Más en forma',
      icon: <Flame />,
      note: 'Índice 0-100',
      unit: 'índice de forma',
      items: top(players, (r) => r.formIndex, (r) => r.minutes).map((r) => ({
        row: r,
        value: r.formIndex,
        display: int(r.formIndex),
        sub: `Últ. 5: ${sum5(r, 'goals')} G · ${sum5(r, 'assists')} A`,
      })),
    },
    {
      id: 'goles',
      title: 'Máximos goleadores',
      icon: <Goal />,
      note: 'Temporada',
      unit: 'goles',
      items: top(players, (r) => r.goals, (r) => -r.minutes).map((r) => ({
        row: r,
        value: r.goals,
        display: int(r.goals),
        sub: `${num(r.per90?.goals, 2)} por 90 · ${int(r.minutes)} min`,
      })),
    },
    {
      id: 'tap',
      title: 'Más tiros a puerta /90',
      icon: <Crosshair />,
      note: `Mín. ${int(p90Floor)} min`,
      unit: 'tiros a puerta por 90 minutos',
      items: top(qualified, (r) => r.per90?.shotsOnTarget ?? 0, (r) => r.minutes).map((r) => ({
        row: r,
        value: r.per90.shotsOnTarget,
        display: num(r.per90.shotsOnTarget, 2),
        sub: `${int(r.shotsOnTarget)} de ${int(r.shots)} tiros · ${int(r.minutes)} min`,
      })),
    },
    {
      id: 'tarjetas',
      title: 'Más tarjetas /90',
      icon: <RectangleVertical />,
      note: `Mín. ${int(p90Floor)} min`,
      unit: 'tarjetas por 90 minutos',
      items: top(qualified, (r) => r.per90?.cards ?? 0, (r) => r.minutes).map((r) => ({
        row: r,
        value: r.per90.cards,
        display: num(r.per90.cards, 2),
        sub: `${plural(r.yellow, 'amarilla')} · ${plural(r.red, 'roja')} · ${plural(r.foulsCommitted, 'falta')}`,
      })),
    },
  ];
}

function LeaderCard({ spec, onSelect }: { spec: LeaderSpec; onSelect: (r: PlayerSeasonRow) => void }) {
  const max = Math.max(1e-9, ...spec.items.map((i) => i.value));
  const [first, ...rest] = spec.items;
  const headingId = `lider-${spec.id}`;
  return (
    <Card pad="none" className="flex w-[86%] max-w-[380px] shrink-0 snap-start flex-col overflow-hidden md:w-auto md:max-w-none" as="section" aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 id={headingId} className="flex min-w-0 items-center gap-2 font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">
          <span className="shrink-0 text-accent-text [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">
            {spec.icon}
          </span>
          <span className="truncate">{spec.title}</span>
        </h3>
        <span className="shrink-0 text-2xs text-ink-3">{spec.note}</span>
      </div>
      {!first ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-3">Ningún jugador cumple el filtro.</p>
      ) : (
        <ol className="flex-1 divide-y divide-line/70">
          <li>
            <button
              type="button"
              onClick={() => onSelect(first.row)}
              className="relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
              aria-label={`1. ${first.row.player.name}, ${first.row.team.name}: ${first.display} ${spec.unit}. Ver en la tabla`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="relative shrink-0">
                  <TeamCrest team={first.row.team} size={36} />
                  <span className="num absolute -left-1.5 -top-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-ink ring-2 ring-surface-1" aria-hidden="true">
                    1
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold text-ink-1">{first.row.player.name}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-2xs text-ink-3">
                    <PositionTag position={first.row.player.position} />
                    <span className="truncate">{first.row.team.short || first.row.team.name}</span>
                  </span>
                  <span className="block truncate text-2xs text-ink-3">{first.sub}</span>
                </span>
              </span>
              <span className="text-right">
                <span className="block font-display text-[34px] font-extrabold leading-none text-ink-1">{first.display}</span>
                <CompetitionBadge compId={first.row.compId} className="mt-1 justify-end text-2xs font-medium text-ink-3" />
              </span>
            </button>
          </li>
          {rest.map((it, i) => (
            <li key={`${it.row.player.id}-${it.row.compId}`}>
              <button
                type="button"
                onClick={() => onSelect(it.row)}
                className="grid w-full grid-cols-[14px_minmax(0,1fr)_64px] items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-surface-2"
                aria-label={`${i + 2}. ${it.row.player.name}, ${it.row.team.name}: ${it.display} ${spec.unit}. Ver en la tabla`}
              >
                <span className="num text-[11px] font-semibold text-ink-3">{i + 2}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <TeamCrest team={it.row.team} size={20} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-ink-1">{it.row.player.short || it.row.player.name}</span>
                    <span className="block truncate text-2xs text-ink-3">{it.row.team.short || it.row.team.name}</span>
                  </span>
                </span>
                <span className="block">
                  <span className="num block text-right text-[13px] font-semibold text-ink-1">{it.display}</span>
                  <Meter value={it.value / max} height={3} color="rgb(var(--c-ink-3) / 0.7)" className="mt-1" />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Cuatro bloques destacados (top 5) sobre el conjunto filtrado. */
export function PlayerLeaders({ players, p90Floor, onSelect, className }: { players: PlayerSeasonRow[]; p90Floor: number; onSelect: (r: PlayerSeasonRow) => void; className?: string }) {
  const specs = buildLeaders(players, p90Floor);
  return (
    <div
      className={cx(
        'scrollbar-none -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:snap-none md:grid-cols-2 md:gap-4 md:overflow-visible md:px-0 md:pb-0 2xl:grid-cols-4',
        className,
      )}
      role="region"
      aria-label="Jugadores destacados (desliza para ver más)"
    >
      {specs.map((s) => (
        <LeaderCard key={s.id} spec={s} onSelect={onSelect} />
      ))}
    </div>
  );
}
