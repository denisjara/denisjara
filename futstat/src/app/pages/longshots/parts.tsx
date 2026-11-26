import { Link } from 'react-router-dom';
import { AlertTriangle, Calculator, Check, CircleSlash, Layers, Scale, TrendingDown } from 'lucide-react';
import type { CalibrationBin, LongshotBet, LongshotFile, LongshotRecord } from '../../../types/data';
import { LONGSHOT_KIND_PLURAL, betStarted, calibrationDomain, excludedKinds, longshotSummary, minOddsLabel, netWin, settledOf } from '../../lib/longshots';
import { int, num, odds as fmtOdds, pct, plural, signedPct } from '../../lib/format';
import {
  Card,
  DataTable,
  LONGSHOT_KIND_ICON,
  LONGSHOT_PLAYER_NOTE,
  LongshotEv,
  LongshotKindBadge,
  LongshotLegRow,
  Meter,
  RateCI,
  ResultMark,
  cx,
  type Column,
} from '../../components';
import { CalibrationPlot } from '../extra/ModelCharts';

/** Importe con euros: «10 €», «12,50 €». */
export const money = (x: number | undefined, digits?: number) => (x === undefined || !Number.isFinite(x) ? '—' : `${num(x, digits ?? (Number.isInteger(x) ? 0 : 2))} €`);

const RESULT_TEXT = { hit: 'Resuelta: acertada', miss: 'Resuelta: fallada', void: 'Resuelta: nula (se devuelve lo apostado)' } as const;

/** «52% × 41% × 66%» si el producto de las patas reproduce la probabilidad publicada (si no, no se muestra). */
function chain(bet: LongshotBet): string | undefined {
  if (bet.legs.length < 2) return undefined;
  const prod = bet.legs.reduce((a, l) => a * l.prob, 1);
  if (Math.abs(prod - bet.prob) > Math.max(0.003, bet.prob * 0.03)) return undefined;
  return bet.legs.map((l) => pct(l.prob)).join(' × ');
}

// ---------------------------------------------------------------------------
// Tarjeta de una apuesta
// ---------------------------------------------------------------------------
export interface LongshotCardProps {
  bet: LongshotBet;
  now: number;
  /** día del listado (YYYY-MM-DD): la hora de una pata lleva día si cae en otro */
  day: string;
  /** importe de la calculadora */
  stake: number;
}

/**
 * Tarjeta de una apuesta de cuota alta: tipo, título, cuota total grande (la de la casa si existe, si no la justa),
 * probabilidad total («1 de cada N»), valor esperado con color semántico, patas con su probabilidad y cuotas, la frase
 * con los datos, el aviso de goleador y una calculadora sin promesas («si apuestas 10, ganarías X si acierta»).
 */
export function LongshotCard({ bet, now, day, stake }: LongshotCardProps) {
  const started = betStarted(bet, now);
  const win = netWin(stake, bet.displayOdds);
  const ch = chain(bet);
  const hasPlayer = bet.kind === 'goleador' || bet.legs.some((l) => l.player);
  const titleId = `apuesta-${bet.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  return (
    <Card as="article" pad="none" aria-labelledby={titleId} className="flex flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b border-line bg-surface-2/50 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <LongshotKindBadge kind={bet.kind} />
            {bet.legs.length > 1 && <span className="text-2xs text-ink-3">{plural(bet.legs.length, 'pata')} · partidos distintos</span>}
          </div>
          <h3 id={titleId} className="mt-1.5 font-display text-[19px] font-bold uppercase leading-tight text-ink-1 [overflow-wrap:anywhere]">
            {bet.label}
          </h3>
        </div>
        <div className="shrink-0 text-right">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">{bet.marketOdds ? 'Cuota de la casa' : 'Cuota justa'}</span>
          <span className="block font-display text-[38px] font-extrabold leading-none text-ink-1 sm:text-[42px]">{fmtOdds(bet.displayOdds)}</span>
          <span className="mt-0.5 block text-2xs text-ink-3">{bet.marketOdds ? <>justa <span className="num">{fmtOdds(bet.fairOdds)}</span></> : 'sin cuota de la casa'}</span>
        </div>
      </header>

      <div className="grid gap-3 border-b border-line px-3 py-3 sm:grid-cols-2 sm:px-4">
        <div className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">Probabilidad total</span>
          <span className="mt-0.5 flex items-baseline gap-2">
            <span className="num text-[22px] font-semibold leading-none text-ink-1">{pct(bet.prob, 1)}</span>
            <span className="text-[12.5px] text-ink-2">
              · <strong className="font-semibold text-ink-1">1 de cada {int(bet.oneIn)}</strong>
            </span>
          </span>
          <Meter value={bet.prob} height={5} className="mt-2" label={`Probabilidad total ${pct(bet.prob, 1)}`} />
          {ch && <span className="num mt-1.5 block text-2xs text-ink-3">{ch} = {pct(bet.prob, 1)}</span>}
        </div>
        <div className="min-w-0">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-ink-3">Valor esperado</span>
          <LongshotEv bet={bet} />
        </div>
      </div>

      <ol className="divide-y divide-line/70 border-b border-line" aria-label={bet.legs.length > 1 ? 'Patas de la combinada' : 'Selección'}>
        {bet.legs.map((l, i) => (
          <li key={`${l.matchId}-${l.selection}`}>
            <LongshotLegRow leg={l} index={bet.legs.length > 1 ? i : undefined} now={now} day={day} settled={!!bet.result || !!l.result} showResult={bet.legs.length > 1} />
          </li>
        ))}
      </ol>

      <div className="flex flex-1 flex-col gap-2.5 px-3 py-3 sm:px-4">
        {bet.reason && <p className="text-[12.5px] leading-snug text-ink-2">{bet.reason}</p>}
        {hasPlayer && (
          <p className="flex items-start gap-1.5 text-2xs text-ink-2">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
            {LONGSHOT_PLAYER_NOTE}
          </p>
        )}
        <div className="mt-auto rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-[12.5px] leading-snug text-ink-2">
          <span className="eyebrow mb-0.5 flex items-center gap-1">
            <Calculator className="h-3 w-3" aria-hidden="true" />
            Si apuestas {money(stake)}
          </span>
          {win !== undefined ? (
            <>
              ganarías <strong className="num font-semibold text-ink-1">{money(win, 2)}</strong> si acierta (cobrarías {money(stake * bet.displayOdds, 2)} en total). Si falla —el{' '}
              {pct(1 - bet.prob)} de las veces— pierdes los {money(stake)}.
              {!bet.marketOdds && <span className="mt-0.5 block text-2xs text-ink-3">Calculado con la cuota justa: tu casa pagará menos.</span>}
            </>
          ) : (
            <span className="text-ink-3">Sin cuota válida para calcularlo.</span>
          )}
        </div>
        {bet.result ? (
          <p className="flex items-center gap-2 text-2xs text-ink-2">
            <ResultMark result={bet.result} className="h-5 w-5" />
            {RESULT_TEXT[bet.result]}, con el marcador a los 90 minutos.
          </p>
        ) : (
          started && (
            <p className="flex items-start gap-1 text-2xs text-ink-2">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
              {bet.legs.length > 1 ? 'Alguno de sus partidos ya ha empezado: ya no se puede hacer antes del inicio.' : 'El partido ya ha empezado: ya no se puede hacer antes del inicio.'}
            </p>
          )
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Historial fuera de muestra
// ---------------------------------------------------------------------------
const dayUtc = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('.', '') : '';
};
const pp = (x: number) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x * 100), 1)} pp`;

/** Frase del historial resumido: «En X apuestas pasadas: Y aciertos (Z %); ROI con cuotas de cierre: R % (n = …)». */
export function TrackSentence({ file, className }: { file: LongshotFile; className?: string }) {
  const s = longshotSummary(file.track.byKind);
  if (!s.bets) return <p className={cx('text-ink-2', className)}>Todavía no hay historial fuera de muestra de estas apuestas.</p>;
  return (
    <p className={cx('text-ink-2', className)}>
      En <strong className="num font-semibold text-ink-1">{int(s.bets)}</strong> apuestas pasadas: <strong className="num font-semibold text-ink-1">{int(s.hits)}</strong> aciertos
      {s.hitRate !== undefined ? (
        <>
          {' '}
          (<span className="num">{pct(s.hitRate, 1)}</span>
          {s.settled < s.bets ? ` de las ${int(s.settled)} resueltas` : ''}
          {s.oneIn ? `, 1 de cada ${int(s.oneIn)}` : ''})
        </>
      ) : null}
      {s.roi ? (
        <>
          ; ROI con cuotas de cierre: <strong className={cx('num font-semibold', s.roi.roi < 0 ? 'text-neg' : 'text-pos')}>{signedPct(s.roi.roi, 1)}</strong>{' '}
          <span className="whitespace-nowrap text-ink-3">(n = {int(s.roi.bets)})</span>
        </>
      ) : (
        '; sin cuotas de cierre para calcular el ROI'
      )}
      .
    </p>
  );
}

function KindCell({ r }: { r: LongshotRecord }) {
  const Icon = LONGSHOT_KIND_ICON[r.kind];
  return (
    <span className="flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-ink-1">
        <Icon className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
        {LONGSHOT_KIND_PLURAL[r.kind]}
      </span>
      {r.excluded && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-2xs text-ink-2" title={`No se publica ahora: ${r.excluded}`}>
          <AlertTriangle className="h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
          No se publica
        </span>
      )}
    </span>
  );
}

/** Historial por tipo en móvil: las mismas cifras que la tabla, sin scroll horizontal. */
function TrackListMobile({ rows, className }: { rows: LongshotRecord[]; className?: string }) {
  if (!rows.length) return <p className={cx('text-[13px] text-ink-3', className)}>Todavía no hay historial de estas apuestas.</p>;
  const cell = 'text-[10px] font-semibold uppercase tracking-wider text-ink-3';
  return (
    <Card pad="none" className={cx('overflow-hidden', className)}>
      <ul className="divide-y divide-line/70" aria-label="Historial fuera de muestra por tipo">
        {rows.map((r) => {
          const n = settledOf(r);
          return (
            <li key={r.kind} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <KindCell r={r} />
                <span className="text-right">
                  <span className={cx(cell, 'block')}>ROI (cierre)</span>
                  {r.roi ? (
                    <span className={cx('num text-[13px] font-semibold', r.roi.roi < 0 ? 'text-neg' : 'text-pos')}>
                      {signedPct(r.roi.roi, 1)} <span className="text-2xs font-normal text-ink-3">n = {int(r.roi.bets)}</span>
                    </span>
                  ) : (
                    <span className="text-2xs text-ink-3">Sin cuotas</span>
                  )}
                </span>
              </div>
              <dl className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <div>
                  <dt className={cell}>Acierto</dt>
                  <dd>
                    <RateCI rate={r.hitRate} n={n} hits={r.hits} lo={r.wilsonLow} hi={r.wilsonHigh} stacked className="flex-wrap whitespace-nowrap !items-start !text-left" />
                  </dd>
                </div>
                <div>
                  <dt className={cell}>Esperado</dt>
                  <dd className="num text-[13px] text-ink-2">{finite(r.expectedHitRate) ? pct(r.expectedHitRate, 1) : '—'}</dd>
                </div>
                <div>
                  <dt className={cell}>Peor racha</dt>
                  <dd className="num text-[13px] text-ink-2">{r.longestLosingStreak !== undefined ? `${int(r.longestLosingStreak)} seguidas` : '—'}</dd>
                </div>
              </dl>
              <p className="text-2xs text-ink-3">
                {plural(r.hits, 'acierto')} en {plural(r.bets, 'apuesta')}
                {r.voids ? ` (${plural(r.voids, 'nula')})` : ''} · cuota media <span className="num">{fmtOdds(r.avgOdds)}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Lista de los tipos que ahora no se publican, con su motivo (sin muestra o mal calibrados). */
export function ExcludedNote({ file, className }: { file: LongshotFile; className?: string }) {
  const ex = excludedKinds(file.track.byKind);
  if (!ex.length) return null;
  return (
    <div className={cx('flex items-start gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-[12.5px] leading-snug text-ink-2', className)}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold text-ink-1">No se publican ahora como recomendación</p>
        <ul className="mt-0.5 space-y-0.5">
          {ex.map((e) => (
            <li key={e.kind}>
              <strong className="font-semibold text-ink-1">{e.label}</strong>: {e.reason}.
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const finite = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** Medias ponderadas por n de la calibración (predicho y observado). */
function calibrationMeans(bins: CalibrationBin[]): { predicted: number; observed: number; n: number } | undefined {
  const n = bins.reduce((s, b) => s + b.n, 0);
  if (!n) return undefined;
  return { predicted: bins.reduce((s, b) => s + b.n * b.predicted, 0) / n, observed: bins.reduce((s, b) => s + b.n * b.observed, 0) / n, n };
}

export function TrackBlock({ file }: { file: LongshotFile }) {
  const t = file.track;
  const columns: Column<LongshotRecord>[] = [
    { key: 'kind', header: 'Tipo', sticky: true, sortValue: (r) => r.kind, firstDir: 'asc', cell: (r) => <KindCell r={r} /> },
    {
      key: 'rate',
      header: 'Acierto',
      title: 'Aciertos / apuestas resueltas, con el intervalo de Wilson al 90 %. Con menos de 50 resueltas no se da acierto propio.',
      numeric: true,
      className: 'whitespace-nowrap',
      sortValue: (r) => r.hitRate,
      cell: (r) => <RateCI rate={r.hitRate} n={settledOf(r)} hits={r.hits} lo={r.wilsonLow} hi={r.wilsonHigh} stacked />,
    },
    {
      key: 'exp',
      header: 'Esperado',
      title: 'Probabilidad media que el modelo daba a esas apuestas. Si el acierto real queda por debajo, el modelo era optimista.',
      numeric: true,
      className: 'whitespace-nowrap',
      sortValue: (r) => (finite(r.expectedHitRate) ? r.expectedHitRate : undefined),
      cell: (r) =>
        finite(r.expectedHitRate) ? (
          <span className="flex flex-col items-end">
            <span className="num text-ink-2">{pct(r.expectedHitRate, 1)}</span>
            {settledOf(r) >= 50 && <span className={cx('num text-2xs', r.hitRate < r.expectedHitRate ? 'text-ink-2' : 'text-ink-3')}>real {pp(r.hitRate - r.expectedHitRate)}</span>}
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    {
      key: 'roi',
      header: 'ROI (cierre)',
      title: 'Apostando 1 a cada una con la cuota de CIERRE de la casa, solo en las apuestas con cuota publicada en todas sus patas',
      numeric: true,
      className: 'whitespace-nowrap',
      sortValue: (r) => r.roi?.roi,
      cell: (r) =>
        r.roi ? (
          <span className="flex flex-col items-end">
            <span className={cx('num font-semibold', r.roi.roi < 0 ? 'text-neg' : 'text-pos')}>{signedPct(r.roi.roi, 1)}</span>
            <span className="num text-2xs text-ink-3">n = {int(r.roi.bets)}</span>
          </span>
        ) : (
          <span className="whitespace-nowrap font-sans text-2xs text-ink-3" title="La fuente no publica cuotas de cierre para este mercado">
            Sin cuotas
          </span>
        ),
    },
    {
      key: 'streak',
      header: 'Peor racha',
      title: 'Racha más larga de apuestas falladas seguidas',
      numeric: true,
      className: 'whitespace-nowrap',
      sortValue: (r) => r.longestLosingStreak,
      cell: (r) => (r.longestLosingStreak !== undefined ? <span className="num text-ink-2">{int(r.longestLosingStreak)} seguidas</span> : <span className="text-ink-3">—</span>),
    },
    { key: 'hits', header: 'Aciertos', numeric: true, sortValue: (r) => r.hits, cell: (r) => <span className="num text-ink-1">{int(r.hits)}</span> },
    { key: 'bets', header: 'Apuestas', title: 'Apuestas que habría publicado la regla (incluidas las nulas)', numeric: true, sortValue: (r) => r.bets, cell: (r) => (
        <span className="flex flex-col items-end">
          <span className="num text-ink-2">{int(r.bets)}</span>
          {r.voids ? <span className="num text-2xs text-ink-3">{plural(r.voids, 'nula')}</span> : null}
        </span>
      ) },
    {
      key: 'odds',
      header: 'Cuota media',
      title: 'Cuota media de esas apuestas (la de la casa si existía; si no, la justa)',
      numeric: true,
      hideBelow: 'sm',
      sortValue: (r) => (finite(r.avgOdds) ? r.avgOdds : undefined),
      cell: (r) => <span className="num text-ink-2">{fmtOdds(r.avgOdds)}</span>,
    },
  ];
  const period = dayUtc(t.from) && dayUtc(t.to) ? `${dayUtc(t.from)} – ${dayUtc(t.to)}` : '';
  const cal = t.calibration.filter((b) => b.n > 0);
  const means = calibrationMeans(cal);
  const top = calibrationDomain(cal);
  const sum = longshotSummary(t.byKind);
  // la calibración del archivo puede incluir todas las selecciones evaluadas de la banda (muchas más que las publicadas)
  const pooled = !!means && means.n > sum.bets * 1.5;
  const worstStreak = Math.max(0, ...t.byKind.map((r) => r.longestLosingStreak ?? 0));
  return (
    <div className="space-y-5">
      <div className="min-w-0 space-y-2">
        <div className="hidden sm:block">
          <DataTable columns={columns} rows={t.byKind} rowKey={(r) => r.kind} caption="Historial fuera de muestra de las apuestas de cuota alta, por tipo" dense emptyText="Todavía no hay historial de estas apuestas." />
        </div>
        <TrackListMobile rows={t.byKind} className="sm:hidden" />
        <ExcludedNote file={file} />
        <p className="text-2xs text-ink-3">
          Walk-forward{period ? ` (${period})` : ''}: la misma regla de cada día aplicada a días pasados, con datos anteriores a cada partido y resuelta a 90
          minutos. El ROI usa cuotas de cierre y solo existe donde la casa publica precio (1X2, más/menos de la línea principal y hándicap principal).
        </p>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <h3 className="font-display text-[17px] font-bold uppercase text-ink-1">Calibración en la banda baja</h3>
          <p className="mb-3 mt-0.5 text-[12.5px] text-ink-3">
            Probabilidad que daba el modelo frente a lo que pasó, por debajo del {pct(top)}
            {pooled ? `: todas las selecciones de esa banda que evaluó (n = ${int(means!.n)}), no solo las publicadas.` : '.'}
          </p>
          {cal.length ? (
            <CalibrationPlot
              bins={cal}
              max={top}
              ariaLabel={`Calibración de las apuestas de cuota alta: probabilidad predicha frente a frecuencia observada, entre 0 y ${pct(top)}, con el número de apuestas por tramo`}
            />
          ) : (
            <p className="text-[13px] text-ink-3">Sin datos de calibración todavía.</p>
          )}
        </Card>
        <Card className="min-w-0 space-y-3 text-[13px] leading-snug text-ink-2">
          <h3 className="font-display text-[17px] font-bold uppercase text-ink-1">Cómo leerlo</h3>
          {means && (
            <p>
              {pooled ? 'En todas las selecciones de la banda' : 'En conjunto'} el modelo daba un <strong className="num font-semibold text-ink-1">{pct(means.predicted, 1)}</strong> y
              se acertó un <strong className="num font-semibold text-ink-1">{pct(means.observed, 1)}</strong> (n = {int(means.n)}).{' '}
              {means.observed < means.predicted - 0.005
                ? 'Por debajo de la diagonal: con cuotas altas el modelo es algo optimista, así que una cuota que parece justa suele no serlo.'
                : means.observed > means.predicted + 0.005
                  ? 'Por encima de la diagonal: en este periodo acertaron algo más de lo previsto; no hay garantía de que se repita.'
                  : 'Muy cerca de la diagonal: de media, las probabilidades se han cumplido.'}
            </p>
          )}
          {sum.hitRate !== undefined && sum.expectedHitRate !== undefined && (
            <p>
              En las <strong className="text-ink-1">apuestas que elige la regla</strong> ({int(sum.settled)} resueltas), el modelo esperaba un{' '}
              <strong className="num font-semibold text-ink-1">{pct(sum.expectedHitRate, 1)}</strong> y se acertó un{' '}
              <strong className="num font-semibold text-ink-1">{pct(sum.hitRate, 1)}</strong> ({pp(sum.hitRate - sum.expectedHitRate)}).{' '}
              {sum.hitRate < sum.expectedHitRate - 0.005
                ? 'Al quedarse con las que más le gustan, el modelo es optimista: su «1 de cada N» se queda corto.'
                : 'En este periodo se ha cumplido lo esperado; no garantiza que se repita.'}
            </p>
          )}
          <p>
            Un acierto <strong className="text-ink-1">por debajo del esperado</strong> significa que el modelo sobrestimaba esas apuestas. Un ROI negativo con cuotas de cierre significa
            que, apostando a todas, se habría perdido dinero.
          </p>
          {worstStreak > 0 && (
            <p>
              Con cuotas de {minOddsLabel(file.minOdds)} o más son normales las rachas largas sin acertar: dentro de un mismo tipo, la peor fue de{' '}
              <strong className="num font-semibold text-ink-1">{int(worstStreak)}</strong> apuestas seguidas falladas.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Antes de apostar
// ---------------------------------------------------------------------------
export function BeforeBetting({ file }: { file: LongshotFile }) {
  const m = minOddsLabel(file.minOdds);
  const roi = longshotSummary(file.track.byKind).roi;
  return (
    <Card className="space-y-3">
      <ul className="grid gap-x-8 gap-y-2.5 text-[13.5px] leading-snug text-ink-2 lg:grid-cols-2">
        <li className="flex gap-2.5">
          <Scale className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span>
            Una cuota de {m} paga {num(file.minOdds - 1, Number.isInteger(file.minOdds) ? 0 : 2)} por cada 1 apostado si aciertas. La casa la fija como si acertaras{' '}
            <strong className="text-ink-1">1 de cada {m} ({pct(1 / file.minOdds, 1)})</strong> y además cobra su margen: según la propia casa, aciertas aún menos.
          </span>
        </li>
        <li className="flex gap-2.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-win" aria-hidden="true" />
          <span>
            <strong className="text-ink-1">Cuota justa</strong> = 1 / probabilidad del modelo. Si tu casa paga menos, a la larga pierdes. Si paga más, el valor esperado es positivo,
            pero la mayoría de las veces igualmente pierdes: solo compensa repetida muchas veces.
          </span>
        </li>
        <li className="flex gap-2.5">
          <Layers className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
          <span>
            En las <strong className="text-ink-1">combinadas</strong> la probabilidad es el producto de las patas y el margen de la casa se cobra en cada una: tres patas del 50% salen
            solo el 12,5% de las veces.
          </span>
        </li>
        <li className="flex gap-2.5">
          <TrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-neg" aria-hidden="true" />
          <span>
            <strong className="text-ink-1">No es una forma de ganar dinero.</strong>{' '}
            {roi
              ? roi.roi < 0
                ? `En el historial, apostando a todas con cuotas de cierre, se habría perdido un ${pct(-roi.roi, 1)} de lo apostado (n = ${int(roi.bets)}). `
                : `En el historial, con cuotas de cierre, el resultado fue de ${signedPct(roi.roi, 1)} (n = ${int(roi.bets)}): con tan pocas apuestas acertadas es sobre todo suerte, no hay garantía de que se repita. `
              : ''}
            Apuesta solo importes pequeños y fijos, nunca para recuperar lo perdido.
          </span>
        </li>
        <li className="flex gap-2.5">
          <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <span>
            <strong className="text-ink-1">Goleador:</strong> si el jugador no juega, la apuesta suele anularse. Comprueba la alineación. Sin cuota de la casa para goleador, marcador
            exacto y otros mercados: compara siempre con tu casa.
          </span>
        </li>
        <li className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/70 px-3 py-2 text-[12.5px]">
          <span className="mt-px shrink-0 font-display text-[13px] font-extrabold text-ink-1">+18</span>
          <span>Información estadística, no consejos de apuesta. Si apuestas, solo con dinero que puedas permitirte perder y con límites.</span>
        </li>
      </ul>
      {file.note && <p className="text-[12.5px] leading-snug text-ink-3">{file.note}</p>}
      <p className="text-[12.5px] text-ink-3">
        Cómo se calculan las probabilidades y su validación:{' '}
        <Link to="/modelo" className="link">
          Modelo y backtest
        </Link>
        .
      </p>
    </Card>
  );
}
