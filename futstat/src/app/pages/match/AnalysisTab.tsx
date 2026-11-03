import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Brain, Grid3x3, Lightbulb, ListOrdered, Scale, Sigma, Zap } from 'lucide-react';
import type { MatchFile, MatchSummary, OddsSnapshot, Prob1X2, StandingRow, ValuePick } from '../../../types/data';
import { EmptyState, FormChips, Heatmap, Meter, ProbBar1X2, SegmentedControl, TeamCrest, cx } from '../../components';
import { useMediaQuery } from '../../lib/hooks';
import { ev as fmtEv, fairOddsFromProb, int, num, odds as fmtOdds, pct, signed, signedPct, xg } from '../../lib/format';
import { noteColor } from '../competition/shared';
import { pickMarketLabel } from '../../lib/picks';
import { DistColumns, SplitBar } from './charts';
import { Panel, Stat, TeamTag } from './parts';
import { foldTail, fmtLine, localizeNumbers, matrixStats, topScores, totalGoalsDist, validMatrix } from './utils';

interface TabProps {
  file: MatchFile;
  match: MatchSummary;
}

const METHOD_LABEL: Record<string, string> = { shin: 'Shin', multiplicative: 'multiplicativo', power: 'potencia' };

// ---------------------------------------------------------------------------
// 1X2 por fuente
// ---------------------------------------------------------------------------
interface SourceRow {
  id: string;
  name: string;
  detail?: string;
  weight?: number;
  probs?: Prob1X2;
  final?: boolean;
}

function OddsMove({ open, close }: { open?: number; close?: number }) {
  if (!close) return <span className="text-ink-3">–</span>;
  const moved = open && Math.abs(close - open) >= 0.01;
  const Icon = !moved ? ArrowRight : close < open! ? ArrowDownRight : ArrowUpRight;
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {moved && <span className="num hidden text-ink-3 line-through decoration-ink-3/60 sm:inline">{fmtOdds(open)}</span>}
      {moved && <Icon className={cx('h-3 w-3', close < open! ? 'text-neg' : 'text-pos')} aria-label={close < open! ? 'baja' : 'sube'} />}
      <span className="num font-semibold text-ink-1">{fmtOdds(close)}</span>
    </span>
  );
}

function OddsStrip({ probs, odds }: { probs: Prob1X2; odds?: OddsSnapshot }) {
  const sides = ['home', 'draw', 'away'] as const;
  const open = { home: odds?.homeOpen, draw: odds?.drawOpen, away: odds?.awayOpen };
  return (
    <div className="relative mt-4 overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-[12.5px]">
        <caption className="sr-only">Cuota justa del modelo frente a la cuota de mercado</caption>
        <thead className="bg-surface-2 text-2xs uppercase tracking-[0.08em] text-ink-3">
          <tr>
            <th scope="col" className="px-2.5 py-2 text-left font-semibold sm:px-3">Cuota</th>
            <th scope="col" className="px-2.5 py-2 text-right font-semibold sm:px-3">1</th>
            <th scope="col" className="px-2.5 py-2 text-right font-semibold sm:px-3">X</th>
            <th scope="col" className="px-2.5 py-2 text-right font-semibold sm:px-3">2</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line/70">
            <th scope="row" className="px-2.5 py-2 text-left font-medium text-ink-2 sm:px-3">Justa (modelo)</th>
            {sides.map((s) => (
              <td key={s} className="num px-2.5 py-2 text-right font-semibold text-ink-1 sm:px-3">
                {fairOddsFromProb(probs[s])}
              </td>
            ))}
          </tr>
          {odds && (odds.home || odds.draw || odds.away) && (
            <tr className="border-t border-line/70">
              <th scope="row" className="px-2.5 py-2 text-left font-medium text-ink-2 sm:px-3">
                {odds.provider || 'Mercado'}
                <span className="hidden text-2xs font-normal text-ink-3 sm:block">apertura → actual</span>
              </th>
              {sides.map((s) => (
                <td key={s} className="px-2.5 py-2 text-right sm:px-3">
                  <OddsMove open={open[s]} close={odds[s]} />
                </td>
              ))}
            </tr>
          )}
          {odds && (odds.home || odds.draw || odds.away) && (
            <tr className="border-t border-line/70">
              <th scope="row" className="px-2.5 py-2 text-left font-medium text-ink-2 sm:px-3">Valor esperado</th>
              {sides.map((s) => {
                const o = odds[s];
                const e = o ? probs[s] * o - 1 : undefined;
                return (
                  <td key={s} className={cx('num px-2.5 py-2 text-right font-semibold sm:px-3', e === undefined ? 'text-ink-3' : e > 0 ? 'text-pos' : 'text-ink-3')}>
                    {fmtEv(e)}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SourcesPanel({ file, match }: TabProps) {
  const m = file.model;
  const rows: SourceRow[] = [
    { id: 'ensemble', name: 'Modelo final', detail: 'Ensamble ponderado de las fuentes', probs: m.ensemble, final: true },
    {
      id: 'dc',
      name: 'Dixon-Coles',
      detail: m.dixonColes ? `Poisson bivariante · λ ${xg(m.dixonColes.lambdaHome)}–${xg(m.dixonColes.lambdaAway)}` : 'Sin datos suficientes',
      weight: m.weights?.dixonColes,
      probs: m.dixonColes?.probs,
    },
    {
      id: 'elo',
      name: 'Elo',
      detail: m.elo ? `${int(m.elo.home)} vs ${int(m.elo.away)} · dif. ${signed(m.elo.diff, 0)} (con campo)` : undefined,
      weight: m.weights?.elo,
      probs: m.elo?.probs,
    },
    {
      id: 'market',
      name: 'Mercado',
      detail: m.market ? `Sin margen (${METHOD_LABEL[m.market.method] ?? m.market.method}) · margen ${pct(m.market.margin, 1)}` : 'Sin cuotas disponibles',
      weight: m.weights?.market,
      probs: m.market?.probs,
    },
  ];
  return (
    <Panel
      title="Probabilidades 1X2 por fuente"
      icon={<Scale />}
      description="El pronóstico final combina tres fuentes independientes. El peso de cada una depende de los datos disponibles."
      info="Dixon-Coles estima ataque y defensa de cada equipo con ponderación temporal; Elo mide la fuerza global con todos los partidos; el mercado es la cuota de la casa sin su margen."
    >
      <ProbBar1X2 p={m.ensemble} market={m.market?.probs} size="lg" legend labels={{ home: match.home.short, draw: 'Empate', away: match.away.short }} />
      <div className="relative mt-4 overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <caption className="sr-only">Probabilidades de cada fuente del modelo y su peso en el ensamble</caption>
          <thead>
            <tr className="text-2xs uppercase tracking-[0.08em] text-ink-3">
              <th scope="col" className="border-b border-line py-2 pr-3 text-left font-semibold">Fuente</th>
              <th scope="col" className="border-b border-line px-2 py-2 text-right font-semibold" title="Peso en el ensamble">
                Peso
              </th>
              <th scope="col" className="border-b border-line px-2 py-2 text-right font-semibold" title={`Victoria ${match.home.name}`}>
                1
              </th>
              <th scope="col" className="border-b border-line px-2 py-2 text-right font-semibold" title="Empate">
                X
              </th>
              <th scope="col" className="border-b border-line py-2 pl-2 text-right font-semibold" title={`Victoria ${match.away.name}`}>
                2
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cx(r.final && 'bg-surface-2/70')}>
                <th scope="row" className={cx('border-b border-line/70 py-2.5 pr-3 text-left align-top font-normal', r.final && 'pl-2')}>
                  <span className={cx('block text-[13px]', r.final ? 'font-semibold text-ink-1' : 'font-medium text-ink-1')}>{r.name}</span>
                  {r.detail && <span className="block text-2xs text-ink-3">{r.detail}</span>}
                  {r.probs && <ProbBar1X2 p={r.probs} size="sm" className="mt-1.5 max-w-[220px]" />}
                </th>
                <td className="num border-b border-line/70 px-2 py-2.5 text-right align-top text-ink-2">
                  {r.final ? '—' : r.weight !== undefined ? pct(r.weight) : '–'}
                  {!r.final && r.weight !== undefined && <Meter value={r.weight} height={3} className="ml-auto mt-1.5 !w-10" color="rgb(var(--c-ink-3))" />}
                </td>
                {(['home', 'draw', 'away'] as const).map((s, i) => (
                  <td key={s} className={cx('num border-b border-line/70 py-2.5 text-right align-top', i === 2 ? 'pl-2' : 'px-2', r.final ? 'font-semibold text-ink-1' : 'text-ink-1')}>
                    {r.probs ? pct(r.probs[s]) : '–'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OddsStrip probs={m.ensemble} odds={match.odds} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// λ y explicación
// ---------------------------------------------------------------------------
function LambdaPanel({ file, match }: TabProps) {
  const m = file.model;
  const max = Math.max(3, m.lambdaHome, m.lambdaAway);
  return (
    <Panel title="Goles esperados (λ)" icon={<Sigma />} info="λ es la media de goles de cada equipo en el modelo de Poisson ajustado al pronóstico final; equivale a los xG previos al partido.">
      <div className="grid grid-cols-2 gap-3">
        {(['home', 'away'] as const).map((side) => {
          const team = match[side];
          const l = side === 'home' ? m.lambdaHome : m.lambdaAway;
          return (
            <div key={side} className={cx('min-w-0 rounded-lg border border-line bg-surface-2/60 p-3', side === 'away' && 'text-right')}>
              <TeamTag team={team} side={side} className={cx('text-[12.5px]', side === 'away' && 'flex-row-reverse')} />
              <div className="mt-2 font-display text-[40px] font-extrabold leading-none text-ink-1">{num(l, 2)}</div>
              <div className={cx('mt-2 flex h-1.5 rounded-full bg-surface-3', side === 'away' && 'justify-end')} aria-hidden="true">
                <div className={cx('h-full rounded-full', side === 'home' ? 'bg-home' : 'bg-away')} style={{ width: `${(l / max) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <SplitBar home={m.lambdaHome} away={m.lambdaAway} className="mt-3" height={4} />
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <Stat label="Goles totales esperados" value={num(m.lambdaHome + m.lambdaAway, 2)} />
        <Stat label="ρ Dixon-Coles" value={num(m.rho, 3)} hint="Corrección de marcadores bajos" />
        {m.dixonColes && <Stat label="λ Dixon-Coles (sin ajustar)" value={`${xg(m.dixonColes.lambdaHome)} – ${xg(m.dixonColes.lambdaAway)}`} />}
        {m.elo && <Stat label="Elo local · visitante" value={`${int(m.elo.home)} · ${int(m.elo.away)}`} hint={`Diferencia ${signed(m.elo.diff, 0)} con ventaja de campo`} />}
      </dl>
    </Panel>
  );
}

function ExplanationPanel({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <Panel title="Claves del pronóstico" icon={<Lightbulb />}>
      <ul className="space-y-2">
        {items.map((t, i) => (
          <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-ink-1">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-text" aria-hidden="true" />
            <span>{localizeNumbers(t)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Marcador exacto
// ---------------------------------------------------------------------------
function ScoreMatrixPanel({ file, match }: TabProps) {
  const matrix = file.model.scoreMatrix;
  const narrow = !useMediaQuery('(min-width: 640px)');
  if (!validMatrix(matrix)) {
    return (
      <Panel title="Marcador exacto" icon={<Grid3x3 />}>
        <EmptyState compact title="Sin matriz de marcadores" description="El modelo no publicó la distribución de marcadores para este partido." />
      </Panel>
    );
  }
  const top = topScores(matrix, 5);
  const cols = Math.max(...matrix.map((r) => r.length));
  const topSum = top.reduce((s, c) => s + c.p, 0);
  const hs = match.home.short || match.home.name;
  const as = match.away.short || match.away.name;
  return (
    <Panel
      title="Marcador exacto"
      icon={<Grid3x3 />}
      description={`Probabilidad de cada resultado. Filas: goles de ${hs}; columnas: goles de ${as}. El recuadro marca el más probable.`}
    >
      <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex min-w-0 items-start gap-1">
          <span className="eyebrow mt-12 shrink-0 rotate-180 [writing-mode:vertical-rl]" aria-hidden="true">
            Goles {hs}
          </span>
        <Heatmap
          rows={matrix.map((_, i) => String(i))}
          cols={Array.from({ length: cols }, (_, j) => String(j))}
          values={matrix}
          colTitle={`Goles ${as}`}
          cellSize={narrow ? 30 : 36}
          rowLabelWidth={20}
          caption={`Matriz de probabilidades de marcador exacto ${match.home.name} contra ${match.away.name}`}
          describe={(r, c, v) => `${hs} ${r} – ${c} ${as}: ${pct(v, 1)} · cuota justa ${fairOddsFromProb(v)}`}
          format={(v) => pct(v, !narrow && v < 0.095 && v >= 0.005 ? 1 : 0)}
          className="min-w-0"
        />
        </div>
        <div className="min-w-0">
          <h3 className="eyebrow mb-2 flex items-center gap-1.5">
            <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" /> Top 5 marcadores
          </h3>
          <ol className="space-y-2">
            {top.map((c, i) => (
              <li key={`${c.home}-${c.away}`} className="grid grid-cols-[18px_52px_minmax(0,1fr)_auto] items-center gap-2.5">
                <span className="num text-[11px] font-semibold text-ink-3">{i + 1}</span>
                <span className="num rounded-md border border-line bg-surface-2 px-1.5 py-1 text-center text-[14px] font-semibold text-ink-1">
                  {c.home}-{c.away}
                </span>
                <Meter value={c.p / top[0].p} height={6} color="rgb(var(--c-seq))" label={`${c.home}-${c.away}: ${pct(c.p, 1)}`} />
                <span className="text-right">
                  <span className="num block text-[13px] font-semibold text-ink-1">{pct(c.p, 1)}</span>
                  <span className="num block text-2xs text-ink-3">@ {fairOddsFromProb(c.p)}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[12px] text-ink-3">
            Los 5 marcadores suman <span className="num text-ink-2">{pct(topSum)}</span>: el fútbol reparte mucho la probabilidad.
          </p>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Distribución de goles
// ---------------------------------------------------------------------------
const GOAL_LINES = ['0.5', '1.5', '2.5', '3.5', '4.5'] as const;

function GoalsPanel({ file, match }: TabProps) {
  const matrix = file.model.scoreMatrix;
  const [line, setLine] = useState<(typeof GOAL_LINES)[number]>('2.5');
  const data = useMemo(() => {
    if (!validMatrix(matrix)) return null;
    const stats = matrixStats(matrix);
    const dist = foldTail(totalGoalsDist(matrix), 7);
    return { stats, dist };
  }, [matrix]);
  if (!data) return null;
  const { stats, dist } = data;
  const last = dist.length - 1;
  const teamRow = (side: 'home' | 'away') => {
    const g = foldTail(side === 'home' ? stats.homeGoals : stats.awayGoals, 4);
    return g;
  };
  const lv = Number(line);
  return (
    <Panel
      title="Goles totales"
      icon={<Sigma />}
      description="Distribución del número total de goles según la matriz del modelo."
      action={
        <SegmentedControl
          size="sm"
          ariaLabel="Línea de goles"
          value={line}
          onChange={setLine}
          options={GOAL_LINES.map((l) => ({ value: l, label: fmtLine(Number(l)) }))}
        />
      }
    >
      <DistColumns
        dist={dist}
        kLabel={(k) => (k === last ? `${k}+` : String(k))}
        unit="goles"
        line={lv}
        ariaLabel={`Distribución de goles totales de ${match.home.name} contra ${match.away.name}`}
        height={110}
      />
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Más de 1,5" value={pct(stats.over15)} hint={`@ ${fairOddsFromProb(stats.over15)}`} />
        <Stat label="Más de 2,5" value={pct(stats.over25)} hint={`@ ${fairOddsFromProb(stats.over25)}`} />
        <Stat label="Más de 3,5" value={pct(stats.over35)} hint={`@ ${fairOddsFromProb(stats.over35)}`} />
        <Stat label="Ambos marcan" value={pct(stats.btts)} hint={`@ ${fairOddsFromProb(stats.btts)}`} />
        <Stat label={`Portería a cero ${match.home.short}`} value={pct(stats.csHome)} />
        <Stat label={`Portería a cero ${match.away.short}`} value={pct(stats.csAway)} />
      </dl>
      <div className="relative mt-4 overflow-x-auto">
        <table className="w-full min-w-[300px] text-[12.5px]">
          <caption className="mb-1.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">Goles por equipo</caption>
          <thead>
            <tr className="text-2xs text-ink-3">
              <th scope="col" className="py-1 text-left font-medium">
                <span className="sr-only">Equipo</span>
              </th>
              {['0', '1', '2', '3', '4+'].map((k) => (
                <th key={k} scope="col" className="num px-1 py-1 text-right font-medium">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['home', 'away'] as const).map((side) => (
              <tr key={side} className="border-t border-line/70">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                  <TeamTag team={match[side]} side={side} size={16} className="text-[12.5px]" />
                </th>
                {teamRow(side).map((p, k) => (
                  <td key={k} className="num px-1 py-1.5 text-right text-ink-1">
                    {pct(p)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Value bets
// ---------------------------------------------------------------------------
const CONF_CLASS: Record<ValuePick['confidence'], string> = {
  alta: 'border-accent-text/50 text-accent-text',
  media: 'border-line-strong text-ink-1',
  baja: 'border-line text-ink-3',
};

function ValuePanel({ file, match }: TabProps) {
  const bets = [...(file.valueBets ?? [])].sort((a, b) => b.ev - a.ev);
  const hasOdds = !!match.odds || !!file.model.market;
  return (
    <Panel
      title="Apuestas de valor"
      icon={<Zap />}
      description="Selecciones en las que la probabilidad del modelo supera la implícita en la cuota. Stake: Kelly fraccional sobre la banca."
      flush={bets.length > 0}
    >
      {bets.length === 0 ? (
        <EmptyState
          compact
          icon={<Zap />}
          title={hasOdds ? 'Sin valor detectado' : 'Sin cuotas de mercado'}
          description={
            hasOdds
              ? 'Ninguna cuota disponible supera el umbral de valor esperado del modelo para este partido.'
              : 'No hay cuotas publicadas para este partido; consulta las cuotas justas del modelo en la pestaña Mercados.'
          }
        />
      ) : (
        <ul className="divide-y divide-line/70 border-t border-line/70">
          {bets.map((b) => (
            <li key={`${b.marketId}-${b.selection}`} className="grid grid-cols-2 items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,0.6fr))]">
              <div className="col-span-2 flex min-w-0 items-center gap-2.5 sm:col-span-1">
                <Zap className="h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-semibold text-ink-1">{localizeNumbers(b.selection)}</div>
                  <div className="flex items-center gap-2 text-2xs text-ink-3">
                    <span className="truncate">{pickMarketLabel(b)}</span>
                    <span className={cx('shrink-0 rounded border px-1 py-px text-[10px] font-semibold uppercase tracking-wide', CONF_CLASS[b.confidence])}>
                      Confianza {b.confidence}
                    </span>
                  </div>
                </div>
              </div>
              <ValueCell label="Prob. modelo" value={pct(b.prob, 1)} />
              <ValueCell label="Cuota" value={fmtOdds(b.odds)} strong />
              <ValueCell label="Cuota justa" value={fmtOdds(b.fairOdds)} />
              <ValueCell label="EV" value={fmtEv(b.ev)} className="text-pos" strong />
              <ValueCell label="Stake (Kelly)" value={`${pct(b.kelly, 1)}`} hint={`Ventaja ${signedPct(b.edge, 1)}`} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ValueCell({ label, value, hint, strong, className }: { label: string; value: string; hint?: string; strong?: boolean; className?: string }) {
  return (
    <div className="min-w-0 sm:text-right">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cx('num text-[14px]', strong ? 'font-bold' : 'text-ink-1', className ?? 'text-ink-1')}>{value}</div>
      {hint && <div className="num text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clasificación
// ---------------------------------------------------------------------------
type TableItem = { kind: 'row'; row: StandingRow } | { kind: 'gap'; key: string };

function nearbyRows(rows: StandingRow[], ranks: number[], radius = 2): TableItem[] {
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  if (!ranks.length) return sorted.slice(0, 6).map((row) => ({ kind: 'row', row }));
  const keep = sorted.filter((r) => ranks.some((k) => Math.abs(r.rank - k) <= radius));
  const out: TableItem[] = [];
  let prev: number | undefined;
  for (const row of keep) {
    if (prev !== undefined && row.rank - prev > 1) out.push({ kind: 'gap', key: `gap-${prev}` });
    out.push({ kind: 'row', row });
    prev = row.rank;
  }
  return out;
}

function TablePanel({ file, match }: TabProps) {
  const t = file.table;
  if (!t || !t.rows?.length) return null;
  const homeRow = t.rows.find((r) => r.team.id === match.home.id);
  const awayRow = t.rows.find((r) => r.team.id === match.away.id);
  const ranks = [t.homeRank ?? homeRow?.rank, t.awayRank ?? awayRow?.rank].filter((x): x is number => typeof x === 'number');
  const items = nearbyRows(t.rows, ranks);
  const total = t.rows.length;
  const hasXpts = t.rows.some((r) => typeof r.xPts === 'number');
  const sideOf = (id: string): 'home' | 'away' | undefined => (id === match.home.id ? 'home' : id === match.away.id ? 'away' : undefined);
  return (
    <Panel
      title="Contexto de clasificación"
      icon={<ListOrdered />}
      eyebrow={t.group}
      description="Posiciones cercanas a ambos equipos."
      flush
      action={
        <Link to={`/c/${match.compId}`} className="btn-ghost -mr-2 text-[12.5px]">
          Clasificación completa
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      }
    >
      <div className="relative overflow-x-auto border-t border-line/70">
        <table className="w-full min-w-[520px] border-separate border-spacing-0 text-[13px]">
          <caption className="sr-only">Clasificación de {t.group} alrededor de {match.home.name} y {match.away.name}</caption>
          <thead>
            <tr className="bg-surface-2 text-2xs uppercase tracking-[0.08em] text-ink-3">
              <th scope="col" className="w-12 py-2 pl-4 pr-2 text-left font-semibold">#</th>
              <th scope="col" className="px-2 py-2 text-left font-semibold">Equipo</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold" title="Partidos jugados">PJ</th>
              <th scope="col" className="hidden px-2 py-2 text-right font-semibold sm:table-cell" title="Ganados-Empatados-Perdidos">G-E-P</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold" title="Diferencia de goles">DG</th>
              {hasXpts && (
                <th scope="col" className="hidden px-2 py-2 text-right font-semibold md:table-cell" title="Puntos esperados según el modelo">
                  xPts
                </th>
              )}
              <th scope="col" className="hidden px-2 py-2 text-left font-semibold md:table-cell">Forma</th>
              <th scope="col" className="py-2 pl-2 pr-4 text-right font-semibold" title="Puntos">Pts</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              if (it.kind === 'gap') {
                return (
                  <tr key={it.key} aria-hidden="true">
                    <td colSpan={8} className="border-b border-line/70 py-1 pl-4 text-ink-3">
                      ⋯
                    </td>
                  </tr>
                );
              }
              const r = it.row;
              const side = sideOf(r.team.id);
              return (
                <tr key={r.team.id} className={cx(side === 'home' && 'bg-home/10', side === 'away' && 'bg-away/10')}>
                  <td className={cx('relative border-b border-line/70 py-2 pl-4 pr-2', side && 'font-semibold')}>
                    {side && <span className={cx('absolute inset-y-0 left-0 w-[3px]', side === 'home' ? 'bg-home' : 'bg-away')} aria-hidden="true" />}
                    <span className="inline-flex items-center gap-1.5">
                      {noteColor(r.note) && <span className="h-3 w-[3px] rounded-full" style={{ background: noteColor(r.note) }} title={r.note?.label} aria-hidden="true" />}
                      <span className="num text-ink-1">{r.rank}</span>
                    </span>
                  </td>
                  <th scope="row" className="border-b border-line/70 px-2 py-2 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <TeamCrest team={r.team} size={18} />
                      <span className={cx('truncate', side ? 'font-semibold text-ink-1' : 'text-ink-1')}>{r.team.name}</span>
                      {side && (
                        <span className="shrink-0 rounded border border-line-strong px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-2">
                          {side === 'home' ? 'Local' : 'Visitante'}
                        </span>
                      )}
                      {r.note?.label && <span className="sr-only">({r.note.label})</span>}
                    </span>
                  </th>
                  <td className="num border-b border-line/70 px-2 py-2 text-right text-ink-2">{r.played}</td>
                  <td className="num hidden border-b border-line/70 px-2 py-2 text-right text-ink-2 sm:table-cell">
                    {r.won}-{r.drawn}-{r.lost}
                  </td>
                  <td className="num border-b border-line/70 px-2 py-2 text-right text-ink-2">{signed(r.gd, 0)}</td>
                  {hasXpts && <td className="num hidden border-b border-line/70 px-2 py-2 text-right text-ink-2 md:table-cell">{num(r.xPts, 1)}</td>}
                  <td className="hidden border-b border-line/70 px-2 py-2 md:table-cell">
                    <FormChips form={r.form} size="xs" />
                  </td>
                  <td className="num border-b border-line/70 py-2 pl-2 pr-4 text-right text-[14px] font-bold text-ink-1">{r.points}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2.5 text-2xs text-ink-3">
        {total} equipos{ranks.length === 2 ? ` · ${Math.abs(ranks[0] - ranks[1])} puestos de diferencia` : ''}
        {homeRow && awayRow ? ` · ${Math.abs(homeRow.points - awayRow.points)} puntos de diferencia` : ''}
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Pestaña
// ---------------------------------------------------------------------------
export function AnalysisTab({ file, match }: TabProps) {
  if (!file.model) {
    return <EmptyState icon={<Brain />} title="Sin modelo para este partido" description="El análisis del modelo no está disponible todavía." />;
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <SourcesPanel file={file} match={match} />
        <div className="flex min-w-0 flex-col gap-6">
          <LambdaPanel file={file} match={match} />
          <ExplanationPanel items={file.model.explanation ?? []} />
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <ScoreMatrixPanel file={file} match={match} />
        <GoalsPanel file={file} match={match} />
      </div>
      <ValuePanel file={file} match={match} />
      <TablePanel file={file} match={match} />
    </div>
  );
}
