import { Activity, Check, FlaskConical, Scale, Target, TrendingUp } from 'lucide-react';
import type { BacktestSummary, CompetitionFile, ScoreSet } from '../../../../types/data';
import { Card, EmptyState, KpiTile, Section, cx } from '../../../components';
import { deltaClass } from '../../../lib/colors';
import { int, num, odds as fmtOdds, pct, shortDate, signed, signedPct } from '../../../lib/format';
import { BarList, CalibrationChart } from '../charts';
import { Note } from '../shared';

type MetricKey = keyof ScoreSet;
const METRICS: { key: MetricKey; label: string; title: string; better: 'low' | 'high'; fmt: (x: number) => string }[] = [
  { key: 'brier', label: 'Brier', title: 'Brier multiclase (menor es mejor)', better: 'low', fmt: (x) => num(x, 3) },
  { key: 'logLoss', label: 'Log-loss', title: 'Pérdida logarítmica (menor es mejor)', better: 'low', fmt: (x) => num(x, 3) },
  { key: 'rps', label: 'RPS', title: 'Ranked Probability Score (menor es mejor)', better: 'low', fmt: (x) => num(x, 4) },
  { key: 'accuracy', label: 'Acierto', title: 'Acierto del resultado más probable (mayor es mejor)', better: 'high', fmt: (x) => pct(x, 1) },
];

interface SourceRow {
  id: string;
  label: string;
  detail: string;
  s: ScoreSet;
  emphasis?: boolean;
}

function sourcesOf(bt: BacktestSummary): SourceRow[] {
  const out: SourceRow[] = [{ id: 'model', label: 'Modelo FutStat', detail: 'Ensamble final', s: bt.model, emphasis: true }];
  if (bt.dixonColes) out.push({ id: 'dc', label: 'Dixon-Coles', detail: 'Goles Poisson corregido', s: bt.dixonColes });
  if (bt.elo) out.push({ id: 'elo', label: 'Elo', detail: 'Rating de fuerza', s: bt.elo });
  if (bt.market) out.push({ id: 'market', label: 'Mercado', detail: bt.marketMatches ? `Cuotas de cierre · ${int(bt.marketMatches)} partidos` : 'Cuotas de cierre sin margen', s: bt.market });
  out.push({ id: 'base', label: 'Base', detail: 'Frecuencias de la liga', s: bt.baseline });
  return out;
}

function ComparisonTable({ rows, baseRps }: { rows: SourceRow[]; baseRps: number }) {
  const best: Partial<Record<MetricKey, number>> = {};
  for (const m of METRICS) {
    const vals = rows.map((r) => r.s[m.key]).filter((x) => Number.isFinite(x));
    best[m.key] = m.better === 'low' ? Math.min(...vals) : Math.max(...vals);
  }
  return (
    <div className="relative overflow-x-auto rounded-card border border-line bg-surface-1/90" role="region" aria-label="Comparativa de fuentes de predicción" tabIndex={0}>
      <table className="w-full min-w-[560px] border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">Métricas de backtest por fuente de predicción. La mejor de cada columna va marcada.</caption>
        <thead>
          <tr className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">
            <th scope="col" className="border-b border-line bg-surface-2 px-3 py-2.5 text-left">
              Fuente
            </th>
            {METRICS.map((m) => (
              <th key={m.key} scope="col" title={m.title} className="border-b border-line bg-surface-2 px-3 py-2.5 text-right">
                {m.label}
              </th>
            ))}
            <th scope="col" title="Mejora del RPS frente a la base (positivo es mejor)" className="border-b border-line bg-surface-2 px-3 py-2.5 text-right">
              vs base
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const skill = baseRps > 0 ? 1 - r.s.rps / baseRps : undefined;
            return (
              <tr key={r.id} className={cx('group', r.emphasis && 'bg-accent/[0.06]')}>
                <th scope="row" className="border-b border-line/70 px-3 py-2.5 text-left font-normal group-last:border-b-0">
                  <span className={cx('block', r.emphasis ? 'font-semibold text-ink-1' : 'font-medium text-ink-1')}>{r.label}</span>
                  <span className="block text-2xs text-ink-3">{r.detail}</span>
                </th>
                {METRICS.map((m) => {
                  const val = r.s[m.key];
                  const isBest = Number.isFinite(val) && val === best[m.key];
                  return (
                    <td key={m.key} className="num border-b border-line/70 px-3 py-2.5 text-right group-last:border-b-0">
                      <span className={cx('inline-flex items-center gap-1', isBest ? 'font-semibold text-ink-1' : 'text-ink-2')}>
                        {isBest && <Check className="h-3.5 w-3.5 text-accent-text" strokeWidth={3} aria-hidden="true" />}
                        {m.fmt(val)}
                        {isBest && <span className="sr-only">(mejor)</span>}
                      </span>
                    </td>
                  );
                })}
                <td className="num border-b border-line/70 px-3 py-2.5 text-right group-last:border-b-0">
                  {r.id === 'base' || skill === undefined ? <span className="text-ink-3">–</span> : <span className={deltaClass(skill, 0.001)}>{signedPct(skill, 1)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className="font-display text-[22px] font-extrabold leading-tight text-ink-1">{value}</div>
      {hint && <div className="text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}

/** Pestaña Modelo: backtest walk-forward de la competición con comparativa, calibración y ROI simulado. */
export function ModelTab({ data }: { data: CompetitionFile }) {
  const bt = data.backtest;
  if (!bt) return <EmptyState icon={<FlaskConical />} title="Sin backtest" description="Todavía no hay suficientes partidos evaluados para medir el modelo en esta competición." />;
  const rows = sourcesOf(bt);
  const accDelta = bt.model.accuracy - bt.baseline.accuracy;
  const rpsSkill = bt.baseline.rps > 0 ? 1 - bt.model.rps / bt.baseline.rps : undefined;
  const accItems = rows.map((r) => ({ id: r.id, label: r.label, value: r.s.accuracy, display: pct(r.s.accuracy, 1), emphasis: r.emphasis }));

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Partidos evaluados" value={int(bt.matches)} hint={`${shortDate(bt.from)} – ${shortDate(bt.to)}`} icon={<Activity />} />
        <KpiTile
          label="Acierto 1X2"
          value={pct(bt.model.accuracy)}
          accent
          icon={<Target />}
          delta={{ text: `${signed(accDelta * 100, 1)} pp vs base`, direction: accDelta > 0.0005 ? 'up' : accDelta < -0.0005 ? 'down' : 'flat', good: accDelta > 0 }}
          hint={bt.market ? `Mercado ${pct(bt.market.accuracy)}` : undefined}
        />
        <KpiTile
          label="RPS del modelo"
          value={num(bt.model.rps, 3)}
          icon={<Scale />}
          delta={rpsSkill !== undefined ? { text: `${signedPct(rpsSkill, 1)} vs base`, direction: rpsSkill > 0 ? 'up' : 'down', good: rpsSkill > 0 } : undefined}
          hint={bt.market ? `Mercado ${num(bt.market.rps, 3)}` : undefined}
        />
        {bt.roi ? (
          <KpiTile
            label="ROI simulado"
            value={signedPct(bt.roi.roi, 1)}
            icon={<TrendingUp />}
            hint={`${int(bt.roi.bets)} apuestas · ${signed(bt.roi.profit, 2)} u`}
          />
        ) : (
          <KpiTile label="Log-loss" value={num(bt.model.logLoss, 3)} icon={<TrendingUp />} hint={`Base ${num(bt.baseline.logLoss, 3)}`} />
        )}
      </div>

      <Section
        id="model-compare"
        eyebrow="Backtest walk-forward"
        title="Modelo frente a mercado y base"
        icon={<Scale />}
        description="Cada partido se predijo solo con información anterior a su fecha. Brier, log-loss y RPS miden el error de las probabilidades (menor es mejor)."
      >
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <ComparisonTable rows={rows} baseRps={bt.baseline.rps} />
          <Card>
            <h3 className="font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">Acierto del favorito</h3>
            <p className="mb-4 mt-0.5 text-[12px] text-ink-3">% de partidos en que el resultado más probable de cada fuente fue el real.</p>
            <BarList items={accItems} domain={[0, Math.max(0.6, ...accItems.map((i) => i.value)) * 1.05]} ariaLabel="Acierto por fuente de predicción" />
          </Card>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:gap-6">
        <Section id="model-calibration" eyebrow="Fiabilidad" title="Calibración" icon={<Target />} description="Si el modelo dice 40%, ¿ocurre el 40% de las veces? Puntos cerca de la diagonal = bien calibrado. El tamaño indica cuántos casos hay en cada tramo.">
          <Card>
            {bt.calibration.length ? (
              <CalibrationChart bins={bt.calibration} ariaLabel={`Curva de calibración del modelo en ${data.meta.name}: probabilidad predicha frente a frecuencia observada`} />
            ) : (
              <p className="text-[13px] text-ink-3">Sin datos de calibración.</p>
            )}
            {bt.calibration.length > 0 && (
              <details className="mt-3 text-[12px] text-ink-2">
                <summary className="cursor-pointer text-ink-3 hover:text-ink-1">Ver tabla de calibración</summary>
                <table className="mt-2 w-full text-[12px]">
                  <caption className="sr-only">Tabla de calibración por tramos</caption>
                  <thead>
                    <tr className="text-2xs uppercase tracking-wider text-ink-3">
                      <th scope="col" className="py-1 text-left">Tramo</th>
                      <th scope="col" className="py-1 text-right">Predicho</th>
                      <th scope="col" className="py-1 text-right">Observado</th>
                      <th scope="col" className="py-1 text-right">Casos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bt.calibration.map((b) => (
                      <tr key={b.from} className="border-t border-line/70">
                        <th scope="row" className="num py-1 text-left font-normal">
                          {pct(b.from)}–{pct(b.to)}
                        </th>
                        <td className="num py-1 text-right">{pct(b.predicted, 1)}</td>
                        <td className="num py-1 text-right">{pct(b.observed, 1)}</td>
                        <td className="num py-1 text-right">{int(b.n)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </Card>
        </Section>

        <div className="space-y-10">
          {bt.roi && (
            <Section id="model-roi" eyebrow="Apuestas de valor" title="ROI simulado" icon={<TrendingUp />} description="Una unidad a cada pick de valor que el modelo habría recomendado, con las cuotas registradas para ese partido.">
              <Card>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MiniStat label="Apuestas" value={int(bt.roi.bets)} />
                  <MiniStat label="Aciertos" value={pct(bt.roi.hitRate)} />
                  <MiniStat label="Cuota media" value={fmtOdds(bt.roi.avgOdds)} />
                  <MiniStat label="Apostado" value={`${num(bt.roi.staked, 0)} u`} />
                  <MiniStat label="Beneficio" value={`${signed(bt.roi.profit, 2)} u`} />
                  <MiniStat label="ROI" value={signedPct(bt.roi.roi, 1)} />
                </div>
                <p className={cx('mt-3 text-[12px]', 'text-ink-3')}>
                  {bt.roi.bets < 100
                    ? `Con solo ${int(bt.roi.bets)} apuestas el ROI tiene mucha varianza: no es una muestra concluyente.`
                    : 'El ROI pasado no garantiza resultados futuros.'}
                </p>
              </Card>
            </Section>
          )}
          {(bt.over25 || bt.btts) && (
            <Section id="model-goals" eyebrow="Mercados de goles" title="+2,5 y ambos marcan" icon={<Activity />}>
              <Card>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {bt.over25 && (
                    <div>
                      <div className="mb-2 text-[13px] font-semibold text-ink-1">Más de 2,5 goles</div>
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Acierto" value={pct(bt.over25.accuracy)} hint={`${int(bt.over25.n)} partidos`} />
                        <MiniStat label="Brier" value={num(bt.over25.brier, 3)} hint="0,250 = azar" />
                      </div>
                    </div>
                  )}
                  {bt.btts && (
                    <div>
                      <div className="mb-2 text-[13px] font-semibold text-ink-1">Ambos marcan</div>
                      <div className="grid grid-cols-2 gap-2">
                        <MiniStat label="Acierto" value={pct(bt.btts.accuracy)} hint={`${int(bt.btts.n)} partidos`} />
                        <MiniStat label="Brier" value={num(bt.btts.brier, 3)} hint="0,250 = azar" />
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </Section>
          )}
        </div>
      </div>

      <Card>
        <h3 className="font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">Cómo leer estas métricas</h3>
        <ul className="mt-2 grid gap-x-8 gap-y-2 text-[13px] leading-relaxed text-ink-2 md:grid-cols-2">
          <li>
            <strong className="text-ink-1">Brier:</strong> suma de errores al cuadrado de las tres probabilidades (local, empate, visitante). Un modelo que siempre dijera
            33/33/33 obtendría ≈0,667.
          </li>
          <li>
            <strong className="text-ink-1">Log-loss:</strong> penaliza mucho las predicciones muy seguras que fallan. Menor es mejor.
          </li>
          <li>
            <strong className="text-ink-1">RPS:</strong> tiene en cuenta el orden de los resultados (predecir empate cuando gana el local es «menos malo» que predecir
            visitante). Es la métrica de referencia en fútbol.
          </li>
          <li>
            <strong className="text-ink-1">Mercado:</strong> probabilidades implícitas de las cuotas de cierre sin margen; es el rival más difícil de batir. «vs base» indica
            cuánto mejora cada fuente el RPS respecto a usar solo las frecuencias de la liga.
          </li>
        </ul>
      </Card>
      <Note>Muestra: {int(bt.matches)} partidos entre {shortDate(bt.from)} y {shortDate(bt.to)}. Métricas recalculadas a diario.</Note>
    </div>
  );
}
