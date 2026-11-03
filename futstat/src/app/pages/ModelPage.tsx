import { useMemo, useState } from 'react';
import { useMediaQuery } from '../lib/hooks';
import { Activity, BookOpen, CircleAlert, FlaskConical, Gauge, Layers, ListChecks, Scale, SlidersHorizontal, Sigma, Target, TrendingUp } from 'lucide-react';
import type { BacktestSummary, ModelFile } from '../../types/data';
import { Card, DataTable, Disclaimer, EmptyState, ErrorState, KpiTile, PageHeader, PageSkeleton, Section, SegmentedControl, TabPanel, Tabs, cx, useUrlTab, type Column } from '../components';
import { useMeta, useModel } from '../lib/data';
import { deltaClass } from '../lib/colors';
import { int, num, odds as fmtOdds, pct, plural, shortDate, signed, signedPct } from '../lib/format';
import { CalibrationPlot, RoiIntervalBar, SkillBars, binCI, expectedCalibrationError, roiInterval } from './extra/ModelCharts';
import { Glossary, Limitations, MethodologySteps, ParametersTable, SCORE_METRICS, SourceTable, skillVsBase, sourcesOf, type MetricKey } from './extra/ModelSections';
import { MiniStat } from './extra/ui';

const TABS = ['rendimiento', 'competiciones', 'metodologia'] as const;
type TabId = (typeof TABS)[number];

/** Variación relativa de una métrica de error frente a una referencia (negativa = menos error). */
const rel = (x: number, ref: number | undefined) => (ref && ref > 0 ? x / ref - 1 : undefined);

function errorDelta(x: number, ref: number | undefined, refLabel: string) {
  const r = rel(x, ref);
  if (r === undefined) return undefined;
  return { text: `${signedPct(r, 1)} error vs ${refLabel}`, direction: (r < -0.0005 ? 'down' : r > 0.0005 ? 'up' : 'flat') as 'down' | 'up' | 'flat', good: r < 0 };
}

function verdictVsMarket(bt: BacktestSummary): string | undefined {
  if (!bt.market || !(bt.market.rps > 0)) return undefined;
  const s = 1 - bt.model.rps / bt.market.rps;
  if (Math.abs(s) < 0.005) return 'prácticamente igual que el mercado de cierre';
  return s > 0 ? `un ${pct(s, 1)} mejor que el mercado de cierre` : `un ${pct(-s, 1)} peor que el mercado de cierre`;
}

// ---------------------------------------------------------------------------
// Pestaña Rendimiento
// ---------------------------------------------------------------------------
function PerformanceTab({ bt }: { bt: BacktestSummary }) {
  const [metric, setMetric] = useState<MetricKey>('rps');
  const sources = sourcesOf(bt);
  const def = SCORE_METRICS.find((m) => m.key === metric)!;
  const skillItems = sources
    .filter((s) => s.id !== 'base')
    .map((s) => {
      const v = skillVsBase(s.s, bt.baseline, metric);
      return {
        id: s.id,
        label: s.label,
        value: v,
        display: metric === 'accuracy' ? `${signed(v * 100, 1)} pp` : signedPct(v, 1),
        hint: s.id === 'market' && bt.marketMatches ? `${int(bt.marketMatches)} p.` : undefined,
        emphasis: s.emphasis,
      };
    });
  const accDelta = bt.model.accuracy - bt.baseline.accuracy;
  const ece = expectedCalibrationError(bt.calibration ?? []);
  const worst = (bt.calibration ?? []).filter((b) => b.n >= 30).reduce<{ d: number; label: string } | null>((acc, b) => {
    const d = b.observed - b.predicted;
    return !acc || Math.abs(d) > Math.abs(acc.d) ? { d, label: `${pct(b.from)}–${pct(b.to)}` } : acc;
  }, null);
  const outside = (bt.calibration ?? []).filter((b) => {
    const [lo, hi] = binCI(b);
    return b.predicted < lo || b.predicted > hi;
  }).length;
  const ci = bt.roi ? roiInterval(bt.roi) : undefined;
  const vsMarket = verdictVsMarket(bt);
  const rpsSkill = bt.baseline.rps > 0 ? 1 - bt.model.rps / bt.baseline.rps : 0;

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <KpiTile className="col-span-2 lg:col-span-1" label="Partidos evaluados" value={int(bt.matches)} hint={`${shortDate(bt.from)} – ${shortDate(bt.to)}`} icon={<Activity />} />
          <KpiTile
            label="Acierto 1X2"
            value={pct(bt.model.accuracy, 1)}
            accent
            icon={<Target />}
            delta={{ text: `${signed(accDelta * 100, 1)} pp vs base`, direction: accDelta > 0.0005 ? 'up' : accDelta < -0.0005 ? 'down' : 'flat', good: accDelta > 0 }}
            hint={`${bt.market ? `Mercado ${pct(bt.market.accuracy, 1)} · base` : 'Base'} ${pct(bt.baseline.accuracy, 1)}`}
          />
          <KpiTile
            label="RPS"
            value={num(bt.model.rps, 3)}
            icon={<Scale />}
            delta={errorDelta(bt.model.rps, bt.baseline.rps, 'base')}
            hint={`${bt.market ? `Mercado ${num(bt.market.rps, 3)} · base` : 'Base'} ${num(bt.baseline.rps, 3)}`}
          />
          <KpiTile
            label="Brier"
            value={num(bt.model.brier, 3)}
            icon={<Sigma />}
            delta={errorDelta(bt.model.brier, bt.baseline.brier, 'base')}
            hint={`${bt.market ? `Mercado ${num(bt.market.brier, 3)} · base` : 'Base'} ${num(bt.baseline.brier, 3)}`}
          />
          <KpiTile
            label="Log-loss"
            value={num(bt.model.logLoss, 3)}
            icon={<Gauge />}
            delta={errorDelta(bt.model.logLoss, bt.baseline.logLoss, 'base')}
            hint={`${bt.market ? `Mercado ${num(bt.market.logLoss, 3)} · base` : 'Base'} ${num(bt.baseline.logLoss, 3)}`}
          />
        </div>
        <p className="max-w-4xl text-[13.5px] leading-relaxed text-ink-2">
          En {plural(bt.matches, 'partido')} predichos sin mirar el futuro, el modelo reduce el error RPS de la referencia ingenua un{' '}
          <strong className="font-semibold text-ink-1">{pct(rpsSkill, 1)}</strong>
          {vsMarket ? (
            <>
              {' '}
              y queda <strong className="font-semibold text-ink-1">{vsMarket}</strong>
              {bt.marketMatches ? ` (en los ${int(bt.marketMatches)} partidos con cuotas)` : ''}
            </>
          ) : null}
          . Batir al mercado de forma sostenida es muy difícil: tómalo como un contraste, no como una promesa.
        </p>
      </div>

      <Section
        id="fuentes"
        eyebrow="Backtest walk-forward"
        title="Modelo, mercado y base"
        icon={<Scale />}
        description="Cada partido se predijo solo con la información anterior a su fecha. Las barras muestran cuánto mejora cada fuente a la referencia (0 = igual que la base; a la derecha, mejor)."
        action={
          <SegmentedControl
            ariaLabel="Métrica de comparación"
            size="sm"
            value={metric}
            onChange={setMetric}
            options={SCORE_METRICS.map((m) => ({ value: m.key, label: m.label }))}
          />
        }
      >
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
          <Card>
            <h3 className="font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">Mejora sobre la base · {def.label}</h3>
            <p className="mb-4 mt-0.5 text-[12px] text-ink-3">
              {metric === 'accuracy' ? 'Diferencia de acierto en puntos porcentuales.' : `Reducción relativa del ${def.label} (menos error = barra a la derecha).`}
            </p>
            <SkillBars items={skillItems} ariaLabel={`Mejora del ${def.label} frente a la base por fuente de predicción`} />
            {bt.market && bt.marketMatches && bt.marketMatches < bt.matches && (
              <p className="mt-4 text-2xs text-ink-3">El mercado solo se evalúa en los {int(bt.marketMatches)} partidos con cuotas de cierre; el resto de fuentes, en los {int(bt.matches)}.</p>
            )}
          </Card>
          <SourceTable rows={sources} />
        </div>
      </Section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] xl:gap-6">
        <Section
          id="calibracion"
          eyebrow="Fiabilidad"
          title="Calibración"
          icon={<Target />}
          description="Probabilidad predicha frente a frecuencia observada, por tramos de 10 puntos. Cerca de la diagonal = bien calibrado. Las líneas verticales son intervalos al 95%; abajo, cuántas predicciones hay en cada tramo."
        >
          <Card>
            <CalibrationPlot bins={bt.calibration ?? []} ariaLabel="Curva de calibración del modelo: probabilidad predicha frente a frecuencia observada, con el número de predicciones por tramo" />
            <div className="mt-4 grid grid-cols-3 gap-2">
              <MiniStat label="ECE" value={ece !== undefined ? `${num(ece * 100, 1)} pp` : '—'} hint="desv. media" />
              <MiniStat label="Máx. desvío" value={worst ? `${signed(worst.d * 100, 1)} pp` : '—'} hint={worst ? worst.label : '—'} />
              <MiniStat label="Fuera IC" value={`${outside}/${(bt.calibration ?? []).length}`} hint="tramos" />
            </div>
            {(bt.calibration ?? []).length > 0 && (
              <details className="mt-3 text-[12px] text-ink-2">
                <summary className="cursor-pointer text-ink-3 hover:text-ink-1">Ver tabla de calibración</summary>
                <table className="mt-2 w-full text-[12px]">
                  <caption className="sr-only">Calibración por tramos de probabilidad</caption>
                  <thead>
                    <tr className="text-2xs uppercase tracking-wider text-ink-3">
                      <th scope="col" className="py-1 text-left">Tramo</th>
                      <th scope="col" className="py-1 text-right">Predicho</th>
                      <th scope="col" className="py-1 text-right">Observado</th>
                      <th scope="col" className="py-1 text-right">IC 95%</th>
                      <th scope="col" className="py-1 text-right">N</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bt.calibration.map((b) => {
                      const [lo, hi] = binCI(b);
                      return (
                        <tr key={b.from} className="border-t border-line/70">
                          <th scope="row" className="num py-1 text-left font-normal">
                            {pct(b.from)}–{pct(b.to)}
                          </th>
                          <td className="num py-1 text-right">{pct(b.predicted, 1)}</td>
                          <td className="num py-1 text-right text-ink-1">{pct(b.observed, 1)}</td>
                          <td className="num py-1 text-right">
                            {pct(lo)}–{pct(hi)}
                          </td>
                          <td className="num py-1 text-right">{int(b.n)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </details>
            )}
          </Card>
        </Section>

        <div className="space-y-10">
          <Section id="roi" eyebrow="Picks de valor" title="ROI simulado" icon={<TrendingUp />} description="Una unidad a cada pick que el modelo habría marcado como valor, con la cuota disponible antes del partido.">
            {bt.roi ? (
              <Card className="space-y-4">
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat label="Apuestas" value={int(bt.roi.bets)} />
                  <MiniStat label="Aciertos" value={pct(bt.roi.hitRate)} />
                  <MiniStat label="Cuota media" value={fmtOdds(bt.roi.avgOdds)} />
                  <MiniStat label="Apostado" value={`${num(bt.roi.staked, 0)} u`} />
                  <MiniStat label="Beneficio" value={`${signed(bt.roi.profit, 1)} u`} />
                  <MiniStat label="ROI" value={signedPct(bt.roi.roi, 1)} />
                </div>
                {ci && (
                  <div>
                    <h3 className="eyebrow">Incertidumbre del ROI (IC 95% aprox.)</h3>
                    <RoiIntervalBar roi={bt.roi.roi} ci={ci} className="mt-1" />
                    <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
                      {ci[0] > 0
                        ? 'El intervalo queda por encima de 0, pero sigue siendo una muestra limitada y las cuotas reales pueden ser peores.'
                        : `Con ${int(bt.roi.bets)} apuestas el intervalo incluye pérdidas: el resultado es compatible con no tener ventaja real. No es concluyente.`}
                    </p>
                  </div>
                )}
              </Card>
            ) : (
              <EmptyState compact icon={<TrendingUp />} title="Sin simulación de ROI" description="Todavía no hay suficientes picks con cuotas para simular resultados." />
            )}
          </Section>

          {(bt.over25 || bt.btts) && (
            <Section id="goles" eyebrow="Mercados de goles" title="+2,5 y ambos marcan" icon={<Activity />} description="Brier binario: 0,250 equivale a decir siempre 50%; menor es mejor. «vs 50%» es la reducción relativa de ese error.">
              <Card>
                <div className="grid gap-4 sm:grid-cols-2">
                  {bt.over25 && (
                    <div>
                      <div className="mb-2 text-[13px] font-semibold text-ink-1">Más de 2,5 goles</div>
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Acierto" value={pct(bt.over25.accuracy)} hint={`${int(bt.over25.n)} partidos`} />
                        <MiniStat label="Brier" value={num(bt.over25.brier, 3)} hint={<span className={deltaClass(0.25 - bt.over25.brier, 0.0005)}>{signedPct(1 - bt.over25.brier / 0.25, 1)} vs 50%</span>} />
                      </div>
                    </div>
                  )}
                  {bt.btts && (
                    <div>
                      <div className="mb-2 text-[13px] font-semibold text-ink-1">Ambos marcan</div>
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Acierto" value={pct(bt.btts.accuracy)} hint={`${int(bt.btts.n)} partidos`} />
                        <MiniStat label="Brier" value={num(bt.btts.brier, 3)} hint={<span className={deltaClass(0.25 - bt.btts.brier, 0.0005)}>{signedPct(1 - bt.btts.brier / 0.25, 1)} vs 50%</span>} />
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pestaña Por competición
// ---------------------------------------------------------------------------
type CompRow = ModelFile['perCompetition'][number];

function CompetitionsTab({ rows }: { rows: CompRow[] }) {
  const { data: meta } = useMeta();
  const flag = (id: string) => meta?.competitions.find((c) => c.id === id)?.flag ?? '⚽';
  const valid = rows.filter((r) => r.backtest && r.backtest.matches > 0 && r.backtest.model && r.backtest.baseline);
  if (!valid.length) return <EmptyState icon={<Layers />} title="Sin backtest por competición" description="Todavía no hay suficientes partidos evaluados en ninguna competición." />;

  const skillBase = (r: CompRow) => (r.backtest.baseline?.rps > 0 ? 1 - r.backtest.model.rps / r.backtest.baseline.rps : 0);
  const skillMkt = (r: CompRow) => (r.backtest.market && r.backtest.market.rps > 0 ? 1 - r.backtest.model.rps / r.backtest.market.rps : undefined);
  const columns: Column<CompRow>[] = [
    {
      key: 'comp',
      header: 'Competición',
      sticky: true,
      sortValue: (r) => r.compName,
      className: 'min-w-[170px]',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-[14px] leading-none">
            {flag(r.compId)}
          </span>
          <span className="truncate font-semibold text-ink-1">{r.compName}</span>
        </span>
      ),
    },
    { key: 'n', header: 'Partidos', numeric: true, sortValue: (r) => r.backtest.matches, cell: (r) => int(r.backtest.matches) },
    { key: 'acc', header: 'Acierto', title: 'Acierto 1X2 del modelo', numeric: true, sortValue: (r) => r.backtest.model.accuracy, cell: (r) => pct(r.backtest.model.accuracy, 1) },
    { key: 'rps', header: 'RPS', title: 'RPS del modelo (menor es mejor)', numeric: true, firstDir: 'asc', sortValue: (r) => r.backtest.model.rps, cell: (r) => <span className="font-semibold text-ink-1">{num(r.backtest.model.rps, 4)}</span> },
    {
      key: 'mkt',
      header: 'RPS merc.',
      title: 'RPS del mercado de cierre en los partidos con cuotas',
      numeric: true,
      firstDir: 'asc',
      sortValue: (r) => r.backtest.market?.rps,
      cell: (r) => (r.backtest.market ? num(r.backtest.market.rps, 4) : <span className="text-ink-3">sin cuotas</span>),
    },
    {
      key: 'vsb',
      header: 'vs base',
      title: 'Reducción del RPS frente a la base (positivo = mejor)',
      numeric: true,
      sortValue: skillBase,
      cell: (r) => <span className={deltaClass(skillBase(r), 0.0005)}>{signedPct(skillBase(r), 1)}</span>,
    },
    {
      key: 'vsm',
      header: 'vs mercado',
      title: 'Reducción del RPS frente al mercado (positivo = el modelo es mejor)',
      numeric: true,
      sortValue: skillMkt,
      cell: (r) => {
        const s = skillMkt(r);
        return s === undefined ? <span className="text-ink-3">–</span> : <span className={deltaClass(s, 0.0005)}>{signedPct(s, 1)}</span>;
      },
    },
    { key: 'brier', header: 'Brier', numeric: true, hideBelow: 'lg', firstDir: 'asc', sortValue: (r) => r.backtest.model.brier, cell: (r) => num(r.backtest.model.brier, 3) },
    { key: 'll', header: 'Log-loss', numeric: true, hideBelow: 'lg', firstDir: 'asc', sortValue: (r) => r.backtest.model.logLoss, cell: (r) => num(r.backtest.model.logLoss, 3) },
    {
      key: 'ece',
      header: 'ECE',
      title: 'Error de calibración medio (puntos porcentuales; menor es mejor)',
      numeric: true,
      hideBelow: 'md',
      firstDir: 'asc',
      sortValue: (r) => expectedCalibrationError(r.backtest.calibration ?? []),
      cell: (r) => {
        const e = expectedCalibrationError(r.backtest.calibration ?? []);
        return e === undefined ? '—' : `${num(e * 100, 1)} pp`;
      },
    },
    {
      key: 'roi',
      header: 'ROI',
      title: 'ROI simulado de los picks de valor (nº de apuestas)',
      numeric: true,
      sortValue: (r) => r.backtest.roi?.roi,
      cell: (r) =>
        r.backtest.roi ? (
          <span>
            <span className={deltaClass(r.backtest.roi.roi, 0.0005)}>{signedPct(r.backtest.roi.roi, 1)}</span>
            <span className="ml-1 text-2xs text-ink-3">({int(r.backtest.roi.bets)})</span>
          </span>
        ) : (
          <span className="text-ink-3">–</span>
        ),
    },
  ];
  const sortedBySkill = [...valid].sort((a, b) => skillBase(b) - skillBase(a));
  const small = valid.filter((r) => r.backtest.matches < 100);

  return (
    <div className="space-y-10">
      <Section
        id="tabla-competiciones"
        eyebrow={plural(valid.length, 'competición', 'competiciones')}
        title="Rendimiento por competición"
        icon={<Layers />}
        description="Pulsa una fila para ver el backtest completo dentro de la competición. «vs base» y «vs mercado» son reducciones relativas del RPS: positivo = el modelo comete menos error."
      >
        <DataTable
          columns={columns}
          rows={valid}
          rowKey={(r) => r.compId}
          caption="Métricas de backtest por competición"
          initialSort={{ key: 'n', dir: 'desc' }}
          rowHref={(r) => `/c/${r.compId}?tab=modelo`}
        />
      </Section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card>
          <h3 className="font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">Mejora del RPS sobre la base</h3>
          <p className="mb-4 mt-0.5 text-[12px] text-ink-3">Por competición, con el nº de partidos evaluados. A la derecha del 0, el modelo mejora la referencia.</p>
          <SkillBars
            labelWidth={176}
            ariaLabel="Mejora del RPS frente a la base por competición"
            items={sortedBySkill.map((r) => ({
              id: r.compId,
              label: (
                <span>
                  <span aria-hidden="true">{flag(r.compId)} </span>
                  {r.compName}
                </span>
              ),
              value: skillBase(r),
              display: signedPct(skillBase(r), 1),
              hint: `${int(r.backtest.matches)} p.`,
            }))}
          />
        </Card>
        <Card className="flex gap-3">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <div className="space-y-2 text-[13px] leading-relaxed text-ink-2">
            <p className="font-semibold text-ink-1">Cómo leer las diferencias</p>
            <p>
              Con pocos partidos, las métricas de una competición oscilan mucho de una semana a otra. Diferencias de RPS menores de ~0,005 no suelen ser
              significativas con menos de 300 partidos.
            </p>
            {small.length > 0 && (
              <p>
                Muestra pequeña (&lt;100 partidos): <span className="text-ink-1">{small.map((r) => r.compName).join(', ')}</span>.
              </p>
            )}
            <p>Las copas y competiciones continentales mezclan equipos de ligas distintas: el modelo usa el Elo global y la fuerza doméstica de cada equipo.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pestaña Metodología
// ---------------------------------------------------------------------------
function MethodologyTab({ data }: { data: ModelFile }) {
  return (
    <div className="space-y-10">
      <Section id="como" eyebrow="Paso a paso" title="Cómo funciona el modelo" icon={<BookOpen />} description="Del dato bruto a la probabilidad publicada. Todo el proceso se ejecuta automáticamente cada día.">
        {data.sections?.length ? <MethodologySteps sections={data.sections} /> : <EmptyState compact icon={<BookOpen />} title="Metodología no publicada" />}
      </Section>
      <Section id="limitaciones" eyebrow="Transparencia" title="Limitaciones" icon={<CircleAlert />} description="Lo que el modelo no sabe. Tenlo en cuenta antes de usar cualquier probabilidad.">
        <Card pad="lg">
          <Limitations />
        </Card>
      </Section>
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] xl:gap-6">
        <Section id="parametros" eyebrow="Configuración actual" title="Parámetros" icon={<SlidersHorizontal />}>
          <ParametersTable parameters={data.parameters} />
        </Section>
        <Section id="glosario" eyebrow="Métricas" title="Glosario" icon={<ListChecks />}>
          <Card pad="lg">
            <Glossary />
          </Card>
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function ModelPage() {
  const { data, error, loading, reload } = useModel();
  const [tab, setTab] = useUrlTab<TabId>(TABS, 'rendimiento');
  const wide = useMediaQuery('(min-width: 640px)');
  const perComp = useMemo(() => (data?.perCompetition ?? []).filter((r) => r && r.backtest), [data]);

  if (loading && !data) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  const bt = data.backtest;
  const hasBacktest = !!bt && bt.matches > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Metodología y transparencia"
        title="Modelo"
        description="Cómo calculamos las probabilidades, con qué datos y cómo de bien han funcionado. Todas las métricas salen de un backtest walk-forward que se recalcula a diario."
      >
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1.5 text-[12.5px] text-ink-2">
          {hasBacktest && (
            <>
              <span>
                <strong className="num font-semibold text-ink-1">{int(bt.matches)}</strong> partidos evaluados
              </span>
              <span>
                Del <span className="text-ink-1">{shortDate(bt.from)}</span> al <span className="text-ink-1">{shortDate(bt.to)}</span>
              </span>
            </>
          )}
          <span>Ensamble Dixon-Coles + Elo + mercado</span>
        </div>
        <Tabs
          idBase="modelo"
          ariaLabel="Secciones del modelo"
          value={tab}
          onChange={setTab}
          className="-mx-4 px-4 sm:-mx-6 sm:px-6"
          tabs={[
            { id: 'rendimiento', label: 'Rendimiento', icon: wide ? <Gauge /> : undefined },
            { id: 'competiciones', label: wide ? 'Por competición' : 'Competiciones', icon: wide ? <Layers /> : undefined, badge: wide ? perComp.length || undefined : undefined },
            { id: 'metodologia', label: wide ? 'Metodología' : 'Método', icon: wide ? <FlaskConical /> : undefined },
          ]}
        />
      </PageHeader>

      <TabPanel idBase="modelo" id="rendimiento" active={tab}>
        {hasBacktest ? (
          <PerformanceTab bt={bt} />
        ) : (
          <EmptyState icon={<FlaskConical />} title="Backtest pendiente" description="Todavía no hay suficientes partidos terminados para evaluar el modelo. Vuelve en unos días." />
        )}
      </TabPanel>
      <TabPanel idBase="modelo" id="competiciones" active={tab}>
        <CompetitionsTab rows={perComp} />
      </TabPanel>
      <TabPanel idBase="modelo" id="metodologia" active={tab}>
        <MethodologyTab data={data} />
      </TabPanel>

      <p className={cx('text-[12px] text-ink-3')}>
        Datos: {hasBacktest ? `${int(bt.matches)} partidos` : 'sin backtest'} · actualizado el {shortDate(data.generatedAt)}. Las métricas pasadas no garantizan resultados futuros.
      </p>
      <Disclaimer compact />
    </div>
  );
}
