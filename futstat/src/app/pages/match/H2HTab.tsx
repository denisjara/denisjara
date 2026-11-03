import { Swords } from 'lucide-react';
import type { MatchFile, MatchSummary } from '../../../types/data';
import { EmptyState, KpiTile, MatchRow, cx } from '../../components';
import { SIDE_COLOR, SIDE_INK, type Side } from '../../lib/colors';
import { num, pct, plural } from '../../lib/format';
import { Panel, TeamTag } from './parts';

interface TabProps {
  file: MatchFile;
  match: MatchSummary;
}

/** Goles medios de un equipo en el historial (sea local o visitante). */
function teamGoals(matches: MatchSummary[], teamId: string): number | undefined {
  const xs = matches
    .filter((m) => m.score)
    .map((m) => (m.home.id === teamId ? m.score!.home : m.away.id === teamId ? m.score!.away : undefined))
    .filter((x): x is number => typeof x === 'number');
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
}

export function H2HTab({ file, match }: TabProps) {
  const h = file.h2h;
  const list = h?.matches ?? [];
  const total = h ? h.homeWins + h.draws + h.awayWins : 0;
  if (!h || (total === 0 && list.length === 0)) {
    return (
      <EmptyState
        icon={<Swords />}
        title="Sin enfrentamientos previos"
        description={`No hay partidos entre ${match.home.name} y ${match.away.name} en nuestros datos (últimas temporadas).`}
      />
    );
  }
  const parts: { side: Side; n: number; label: string }[] = [
    { side: 'home', n: h.homeWins, label: `Victorias ${match.home.short || match.home.name}` },
    { side: 'draw', n: h.draws, label: 'Empates' },
    { side: 'away', n: h.awayWins, label: `Victorias ${match.away.short || match.away.name}` },
  ];
  const gH = teamGoals(list, match.home.id);
  const gA = teamGoals(list, match.away.id);
  return (
    <div className="space-y-6">
      <Panel title="Historial directo" icon={<Swords />} description={`${plural(total, 'enfrentamiento')} en nuestros datos. Victorias contadas por equipo, sin importar dónde se jugó.`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <TeamTag team={match.home} side="home" size={22} full className="text-[13px]" />
          <TeamTag team={match.away} side="away" size={22} full className="flex-row-reverse text-[13px]" />
        </div>
        {total > 0 && (
          <>
            <div
              className="flex h-9 w-full gap-[2px]"
              role="img"
              aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(', ')}
            >
              {parts.map((p) =>
                p.n > 0 ? (
                  <div
                    key={p.side}
                    className="forced-border flex min-w-[28px] items-center justify-center rounded-[4px] font-display text-[18px] font-extrabold"
                    style={{ width: `${(p.n / total) * 100}%`, background: SIDE_COLOR[p.side], color: SIDE_INK[p.side] }}
                    title={`${p.label}: ${p.n}`}
                  >
                    {p.n}
                  </div>
                ) : null,
              )}
            </div>
            <ul className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
              {parts.map((p, i) => (
                <li key={p.side} className={cx('flex min-w-0 flex-col', i === 1 && 'items-center text-center', i === 2 && 'items-end text-right')}>
                  <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SIDE_COLOR[p.side] }} aria-hidden="true" />
                    <span className="truncate">{p.label}</span>
                  </span>
                  <span className="num font-semibold text-ink-1">
                    {p.n} <span className="font-normal text-ink-3">({pct(p.n / total)})</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile label="Goles por partido" value={num(h.avgGoals, 2)} hint={gH !== undefined && gA !== undefined ? `${num(gH, 1)} – ${num(gA, 1)} por equipo` : undefined} />
          <KpiTile label="Ambos marcan" value={pct(h.bttsPct)} />
          <KpiTile label="Más de 2,5 goles" value={pct(h.over25Pct)} />
          <KpiTile label="Partidos" value={String(total || list.length)} hint={list[0] ? `Último: ${list[0].score ? `${list[0].home.short} ${list[0].score.home}-${list[0].score.away} ${list[0].away.short}` : '–'}` : undefined} />
        </div>
      </Panel>
      <Panel title="Enfrentamientos" icon={<Swords />} flush>
        {list.length ? (
          <ul className="divide-y divide-line/70 border-t border-line/70">
            {list.map((m) => (
              <li key={m.id}>
                <MatchRow match={m} showComp showDate showPrediction={false} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 pb-4">
            <EmptyState compact title="Sin detalle de partidos" description="Solo disponemos del resumen agregado del historial." />
          </div>
        )}
      </Panel>
    </div>
  );
}
