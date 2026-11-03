import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { PlayerSeasonRow } from '../../../types/data';
import { CompetitionBadge, TeamCrest, cx } from '../../components';
import { int, num, pct, plural, shortDate } from '../../lib/format';
import { METRIC_BY_KEY, PEER_MIN_MINUTES, PERCENTILE_METRICS, metricValue, percentile, type PeerTable } from './players';
import { POSITION_LONG } from './ui';

const POSITION_PLURAL = { G: 'porteros', D: 'defensas', M: 'centrocampistas', F: 'delanteros', '?': 'jugadores' } as const;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/60 px-2.5 py-2">
      <dt className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-3" title={label}>
        {label}
      </dt>
      <dd className="num mt-0.5 truncate text-[15px] font-semibold leading-tight text-ink-1">{value}</dd>
      {sub && <dd className="num truncate text-2xs text-ink-3">{sub}</dd>}
    </div>
  );
}

/** Barra de percentil (un solo tono neutro: la posición en la escala, no un juicio bueno/malo). */
function PercentileBar({ label, value, pctl }: { label: string; value: string; pctl: number | undefined }) {
  return (
    <li className="grid grid-cols-[minmax(92px,120px)_minmax(0,1fr)_auto] items-center gap-3 text-[12.5px]">
      <span className="truncate text-ink-2">{label}</span>
      <span className="relative h-2 rounded-full bg-surface-3" aria-hidden="true">
        {pctl !== undefined && <span className="absolute inset-y-0 left-0 rounded-full bg-ink-2/70" style={{ width: `${Math.max(2, pctl)}%` }} />}
        <span className="absolute inset-y-[-3px] left-1/2 w-px bg-ink-3/70" />
      </span>
      <span className="num w-[92px] text-right text-ink-1">
        {value}
        <span className="ml-1.5 text-2xs text-ink-3">{pctl !== undefined ? `P${pctl}` : '—'}</span>
      </span>
    </li>
  );
}

function RatingCell({ rating, minutes }: { rating: number; minutes: number }) {
  if (!(minutes > 0) || !(rating > 0)) return <span className="text-2xs text-ink-3">No jugó</span>;
  const w = Math.max(0, Math.min(1, (rating - 3) / 7));
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="relative hidden h-1.5 w-12 rounded-full bg-surface-3 sm:block" aria-hidden="true">
        <span className={cx('absolute inset-y-0 left-0 rounded-full', rating >= 7.5 ? 'bg-accent-text' : 'bg-ink-3')} style={{ width: `${w * 100}%` }} />
      </span>
      <span className="font-semibold text-ink-1">{num(rating, 1)}</span>
    </span>
  );
}

/** Detalle desplegable de un jugador: resumen de temporada, percentiles por posición y últimos 5 partidos. */
export function PlayerDetail({ row, peers }: { row: PlayerSeasonRow; peers: PeerTable }) {
  const last5 = row.last5 ?? [];
  const played = last5.filter((g) => g.minutes > 0);
  const tot = played.reduce(
    (acc, g) => ({ g: acc.g + g.goals, a: acc.a + g.assists, s: acc.s + g.shots, sot: acc.sot + g.shotsOnTarget, c: acc.c + g.cards, r: acc.r + g.rating, min: acc.min + g.minutes }),
    { g: 0, a: 0, s: 0, sot: 0, c: 0, r: 0, min: 0 },
  );
  const peerList = peers[row.player.position];
  const enoughMinutes = (row.minutes ?? 0) >= PEER_MIN_MINUTES;
  const accuracy = row.shots > 0 ? row.shotsOnTarget / row.shots : undefined;
  const ga90 = (row.per90?.goals ?? 0) + (row.per90?.assists ?? 0);

  return (
    <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-6">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-2">
          <span className="font-semibold text-ink-1">{POSITION_LONG[row.player.position]}</span>
          <Link to={`/t/${row.team.id}`} className="inline-flex min-w-0 items-center gap-1.5 hover:text-ink-1 hover:underline" onClick={(e) => e.stopPropagation()}>
            <TeamCrest team={row.team} size={16} />
            <span className="truncate">{row.team.name}</span>
          </Link>
          <CompetitionBadge compId={row.compId} link short={false} className="text-[12.5px] font-medium" />
        </div>
        <dl className="grid grid-cols-3 gap-2">
          <Stat label="Partidos" value={int(row.apps)} sub={`${int(row.starts)} de titular`} />
          <Stat label="Minutos" value={int(row.minutes)} sub={row.apps ? `${int(row.minutes / row.apps)} por partido` : undefined} />
          <Stat label="G + A /90" value={num(ga90, 2)} sub="goles + asist." />
          <Stat label="Goles" value={int(row.goals)} sub={`${num(row.per90?.goals, 2)} por 90`} />
          <Stat label="Asistencias" value={int(row.assists)} sub={`${num(row.per90?.assists, 2)} por 90`} />
          <Stat label="Precisión" value={accuracy !== undefined ? pct(accuracy) : '–'} sub={`${int(row.shotsOnTarget)} de ${int(row.shots)} a puerta`} />
          <Stat label="Tarjetas" value={`${int(row.yellow)} · ${int(row.red)}`} sub="amar. · rojas" />
          <Stat label="Faltas" value={`${int(row.foulsCommitted)} · ${int(row.foulsSuffered)}`} sub="comet. · recib." />
          {typeof row.saves === 'number' ? <Stat label="Paradas" value={int(row.saves)} /> : <Stat label="Fuera de juego" value={int(row.offsides)} sub="temporada" />}
        </dl>
        <div>
          <h4 className="eyebrow mb-2">Percentil por 90 frente a otros {POSITION_PLURAL[row.player.position]}</h4>
          {!enoughMinutes || !peerList ? (
            <p className="text-[12px] text-ink-3">Hacen falta al menos {PEER_MIN_MINUTES} minutos jugados y un grupo de comparación suficiente.</p>
          ) : (
            <ul className="space-y-2" aria-label="Percentiles por 90 minutos frente a jugadores de su misma posición">
              {PERCENTILE_METRICS.map((k) => {
                const v = metricValue(row, k, 'p90');
                return <PercentileBar key={k} label={METRIC_BY_KEY[k].label} value={num(v, 2)} pctl={percentile(peerList[k], v)} />;
              })}
            </ul>
          )}
          <p className="mt-2 text-2xs text-ink-3">P50 = mediana (línea central). Percentil alto = valor alto, no necesariamente mejor (p. ej. tarjetas).</p>
        </div>
      </div>

      <div className="min-w-0">
        <h4 className="eyebrow mb-2">Últimos {last5.length || 5} partidos de su equipo</h4>
        {last5.length === 0 ? (
          <p className="text-[12px] text-ink-3">Sin partidos recientes registrados.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[460px] border-separate border-spacing-0 text-[12.5px]">
              <caption className="sr-only">Últimos partidos de {row.player.name}, del más reciente al más antiguo</caption>
              <thead>
                <tr className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">
                  <th scope="col" className="border-b border-line bg-surface-2 px-2.5 py-2 text-left">Fecha</th>
                  <th scope="col" className="border-b border-line bg-surface-2 px-2.5 py-2 text-left">Rival</th>
                  <th scope="col" title="Minutos" className="border-b border-line bg-surface-2 px-2 py-2 text-right">Min</th>
                  <th scope="col" title="Goles" className="border-b border-line bg-surface-2 px-2 py-2 text-right">G</th>
                  <th scope="col" title="Asistencias" className="border-b border-line bg-surface-2 px-2 py-2 text-right">A</th>
                  <th scope="col" title="Tiros (a puerta)" className="border-b border-line bg-surface-2 px-2 py-2 text-right">Tiros</th>
                  <th scope="col" title="Tarjetas" className="border-b border-line bg-surface-2 px-2 py-2 text-right">Tarj.</th>
                  <th scope="col" title="Nota del partido (0-10)" className="border-b border-line bg-surface-2 px-2.5 py-2 text-right">Nota</th>
                </tr>
              </thead>
              <tbody>
                {last5.map((g) => {
                  const dnp = !(g.minutes > 0);
                  return (
                    <tr key={g.matchId} className={cx(dnp && 'text-ink-3')}>
                      <td className="num whitespace-nowrap border-b border-line/70 px-2.5 py-2 text-ink-2">{shortDate(g.date)}</td>
                      <th scope="row" className="max-w-[140px] truncate border-b border-line/70 px-2.5 py-2 text-left font-medium text-ink-1">
                        {g.opponent}
                      </th>
                      <td className="num border-b border-line/70 px-2 py-2 text-right">{dnp ? '–' : `${g.minutes}'`}</td>
                      <td className={cx('num border-b border-line/70 px-2 py-2 text-right', g.goals > 0 && 'font-semibold text-ink-1')}>{dnp ? '–' : g.goals}</td>
                      <td className={cx('num border-b border-line/70 px-2 py-2 text-right', g.assists > 0 && 'font-semibold text-ink-1')}>{dnp ? '–' : g.assists}</td>
                      <td className="num whitespace-nowrap border-b border-line/70 px-2 py-2 text-right">
                        {dnp ? (
                          '–'
                        ) : (
                          <>
                            {g.shots}
                            <span className="text-ink-3"> ({g.shotsOnTarget})</span>
                          </>
                        )}
                      </td>
                      <td className="num border-b border-line/70 px-2 py-2 text-right">
                        {dnp ? (
                          '–'
                        ) : g.cards > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <span className="h-3 w-2 rounded-[1px] bg-warn" aria-hidden="true" />
                            {g.cards}
                          </span>
                        ) : (
                          0
                        )}
                      </td>
                      <td className="num border-b border-line/70 px-2.5 py-2 text-right">
                        <RatingCell rating={g.rating} minutes={g.minutes} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {played.length > 0 && (
          <p className="mt-2 text-[12px] text-ink-2">
            En {played.length === 1 ? 'su último partido jugado' : `sus últimos ${played.length} partidos jugados`}:{' '}
            <strong className="font-semibold text-ink-1">{plural(tot.g, 'gol', 'goles')}</strong>, <strong className="font-semibold text-ink-1">{plural(tot.a, 'asistencia')}</strong>,{' '}
            <span className="text-ink-1">{plural(tot.s, 'tiro')}</span> ({tot.sot} a puerta), <span className="text-ink-1">{plural(tot.c, 'tarjeta')}</span>, nota media{' '}
            <strong className="num font-semibold text-ink-1">{num(tot.r / played.length, 1)}</strong> en {plural(tot.min, 'minuto')}.
          </p>
        )}
        <Link to={`/t/${row.team.id}`} className="btn-ghost -ml-2.5 mt-2" onClick={(e) => e.stopPropagation()}>
          Ficha de {row.team.short || row.team.name}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
