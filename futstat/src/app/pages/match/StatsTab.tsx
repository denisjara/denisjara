import { useState, type ReactNode } from 'react';
import { BarChart3, Crosshair, CornerUpRight, Flag, Footprints, Hand, Scale, Square } from 'lucide-react';
import type { ComparisonRow, MatchFile, MatchSummary, StatProjection } from '../../../types/data';
import { EmptyState, ProbBar1X2, StatCompareBar, cx } from '../../components';
import { fairOddsFromProb, num, odds as fmtOdds, pct, signed } from '../../lib/format';
import { DistColumns, SplitBar } from './charts';
import { Panel, TeamTag } from './parts';
import { fmtLine, massRange } from './utils';

interface TabProps {
  file: MatchFile;
  match: MatchSummary;
}

const ICON: Record<StatProjection['key'], ReactNode> = {
  corners: <CornerUpRight />,
  cards: <Square />,
  shots: <Crosshair />,
  shotsOnTarget: <Crosshair />,
  fouls: <Hand />,
  offsides: <Flag />,
};

const UNIT: Record<StatProjection['key'], string> = {
  corners: 'córners',
  cards: 'tarjetas',
  shots: 'tiros',
  shotsOnTarget: 'tiros a puerta',
  fouls: 'faltas',
  offsides: 'fueras de juego',
};

const MARKET_PREFIX: Record<StatProjection['key'], string> = {
  corners: 'corners-ou',
  cards: 'cards-ou',
  shots: 'shots-ou',
  shotsOnTarget: 'shotsOnTarget-ou',
  fouls: 'fouls-ou',
  offsides: 'offsides-ou',
};

/** Cuota de la casa para la línea, si el mercado la trae. */
function marketOddsFor(file: MatchFile, key: StatProjection['key'], line: number): { over?: number; under?: number } {
  const m = (file.markets ?? []).find((x) => x.id === `${MARKET_PREFIX[key]}-${line}`);
  return { over: m?.selections[0]?.marketOdds, under: m?.selections[1]?.marketOdds };
}

function defaultLine(p: StatProjection): number | undefined {
  if (!p.lines?.length) return undefined;
  return p.lines.reduce((b, l) => (Math.abs(l.over - 0.5) < Math.abs(b.over - 0.5) ? l : b), p.lines[0]).line;
}

function ProjectionCard({ p, file, match }: { p: StatProjection; file: MatchFile; match: MatchSummary }) {
  const [line, setLine] = useState<number | undefined>(() => defaultLine(p));
  const dist = p.totalDist ?? [];
  const lines = p.lines ?? [];
  const range = dist.length ? massRange(dist, 0.003, 8) : undefined;
  const delta = typeof p.leagueAvg === 'number' ? p.total - p.leagueAvg : undefined;
  const unit = UNIT[p.key] ?? p.label.toLowerCase();
  const hs = match.home.short || match.home.name;
  const as = match.away.short || match.away.name;
  return (
    <Panel
      title={p.label}
      icon={ICON[p.key] ?? <BarChart3 />}
      action={
        <div className="text-right">
          <div className="font-display text-[30px] font-extrabold leading-none text-ink-1">{num(p.total, 1)}</div>
          <div className="text-2xs text-ink-3">
            esperados
            {delta !== undefined && (
              <>
                {' · '}media liga <span className="num text-ink-2">{num(p.leagueAvg, 1)}</span>{' '}
                <span className={cx('num font-semibold', Math.abs(delta) < 0.05 ? 'text-ink-2' : 'text-ink-1')}>({signed(delta, 1)})</span>
              </>
            )}
          </div>
        </div>
      }
    >
      {/* Local vs visitante */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3">
        <div className="min-w-0">
          <TeamTag team={match.home} side="home" size={16} className="text-[12px]" />
          <div className="num mt-1 text-[20px] font-semibold text-ink-1">{num(p.home, 1)}</div>
        </div>
        <span className="pb-1 text-2xs uppercase tracking-wider text-ink-3">esperado</span>
        <div className="min-w-0 text-right">
          <TeamTag team={match.away} side="away" size={16} className="flex-row-reverse text-[12px]" />
          <div className="num mt-1 text-[20px] font-semibold text-ink-1">{num(p.away, 1)}</div>
        </div>
      </div>
      <SplitBar home={p.home} away={p.away} className="mt-2" height={6} />
      {p.most && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-2xs text-ink-3">
            <span>¿Quién tendrá más {unit}?</span>
          </div>
          <ProbBar1X2 p={p.most} size="sm" legend labels={{ home: hs, draw: 'Igual', away: as }} />
        </div>
      )}

      {/* Distribución del total */}
      {dist.length > 1 && (
        <div className="mt-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="eyebrow">Distribución del total</h3>
            {lines.length > 0 && (
              <div role="radiogroup" aria-label={`Línea de ${p.label}`} className="flex flex-wrap gap-1">
                {lines.map((l) => (
                  <button
                    key={l.line}
                    type="button"
                    role="radio"
                    aria-checked={l.line === line}
                    onClick={() => setLine(l.line)}
                    className={cx(
                      'num rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium transition-colors',
                      l.line === line ? 'border-accent-text bg-accent/15 text-ink-1' : 'border-line bg-surface-2 text-ink-2 hover:text-ink-1',
                    )}
                  >
                    {fmtLine(l.line)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <DistColumns
            dist={dist}
            range={range}
            unit={unit}
            line={line}
            height={100}
            ariaLabel={`Distribución de ${unit} totales: ${match.home.name} contra ${match.away.name}`}
          />
        </div>
      )}

      {/* Escalera over/under */}
      {lines.length > 0 && (
        <div className="relative mt-4 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[300px] text-[12.5px]">
            <caption className="sr-only">Escalera de más/menos de {unit}: probabilidad y cuota justa por línea</caption>
            <thead className="bg-surface-2 text-2xs uppercase tracking-[0.06em] text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-semibold">Línea</th>
                <th scope="col" className="px-3 py-1.5 text-right font-semibold">Más</th>
                <th scope="col" className="px-3 py-1.5 text-right font-semibold">Menos</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const mk = marketOddsFor(file, p.key, l.line);
                const sel = l.line === line;
                return (
                  <tr key={l.line} className={cx('border-t border-line/70', sel && 'bg-accent/10')}>
                    <th scope="row" className="px-3 py-1.5 text-left font-medium">
                      <button
                        type="button"
                        onClick={() => setLine(l.line)}
                        className={cx('num hover:text-accent-text', sel ? 'font-semibold text-ink-1' : 'text-ink-2')}
                        aria-pressed={sel}
                        aria-label={`Marcar la línea ${fmtLine(l.line)} en el gráfico`}
                      >
                        {fmtLine(l.line)}
                      </button>
                    </th>
                    {(['over', 'under'] as const).map((k) => (
                      <td key={k} className="num px-3 py-1.5 text-right">
                        <span className={cx('text-ink-1', l[k] >= 0.5 && 'font-semibold')}>{pct(l[k])}</span>
                        <span className="ml-1.5 text-ink-3">@{fairOddsFromProb(l[k])}</span>
                        {mk[k] && <span className="ml-1.5 text-ink-2">casa {fmtOdds(mk[k])}</span>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ComparisonPanel({ rows, match }: { rows: ComparisonRow[]; match: MatchSummary }) {
  if (!rows.length) return null;
  const half = Math.ceil(rows.length / 2);
  const cols = [rows.slice(0, half), rows.slice(half)];
  return (
    <Panel
      title="Comparación de temporada"
      icon={<Scale />}
      description="Promedios de la temporada. El lado que gana cada métrica va en color pleno; entre paréntesis, la media de la liga."
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <TeamTag team={match.home} side="home" size={22} full className="text-[13px]" />
        <TeamTag team={match.away} side="away" size={22} full className="flex-row-reverse text-[13px]" />
      </div>
      <div className="grid grid-cols-1 gap-x-10 gap-y-4 lg:grid-cols-2">
        {cols.map((c, i) => (
          <div key={i} className="min-w-0 space-y-4">
            {c.map((r) => (
              <StatCompareBar
                key={r.key}
                label={r.label}
                home={r.format === 'pct' ? asFraction(r.home) : r.home}
                away={r.format === 'pct' ? asFraction(r.away) : r.away}
                format={r.format}
                better={r.better}
                leagueAvg={r.leagueAvg !== undefined && r.format === 'pct' ? asFraction(r.leagueAvg) : r.leagueAvg}
              />
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function asFraction(v: number): number {
  return v > 1.0001 ? v / 100 : v;
}

export function StatsTab({ file, match }: TabProps) {
  const projections = file.projections ?? [];
  const comparison = file.comparison ?? [];
  if (!projections.length && !comparison.length) {
    return <EmptyState icon={<Footprints />} title="Sin estadísticas" description="Todavía no hay proyecciones ni datos de temporada para este partido." />;
  }
  return (
    <div className="space-y-6">
      {projections.length > 0 ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {projections.map((p) => (
            <ProjectionCard key={p.key} p={p} file={file} match={match} />
          ))}
        </div>
      ) : (
        <EmptyState compact icon={<BarChart3 />} title="Sin proyecciones" description="No hay datos suficientes para proyectar córners, tarjetas o tiros." />
      )}
      <ComparisonPanel rows={comparison} match={match} />
      <p className="text-[12px] text-ink-3">
        Proyecciones con binomial negativa (sobredispersión) y contracción hacia la media de la liga para equipos con pocos partidos.
      </p>
    </div>
  );
}
