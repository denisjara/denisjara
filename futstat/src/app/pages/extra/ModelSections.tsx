import { Fragment, type ReactNode } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import type { BacktestSummary, ScoreSet } from '../../../types/data';
import { Card, cx } from '../../components';
import { int, num, pct } from '../../lib/format';
import { fmtParam } from './ui';

// ---------------------------------------------------------------------------
// Fuentes de predicción y métricas
// ---------------------------------------------------------------------------
export type MetricKey = keyof ScoreSet;
export interface MetricDef {
  key: MetricKey;
  label: string;
  title: string;
  better: 'low' | 'high';
  fmt: (x: number) => string;
}
export const SCORE_METRICS: MetricDef[] = [
  { key: 'rps', label: 'RPS', title: 'Ranked Probability Score (menor es mejor)', better: 'low', fmt: (x) => num(x, 4) },
  { key: 'brier', label: 'Brier', title: 'Brier multiclase (menor es mejor)', better: 'low', fmt: (x) => num(x, 4) },
  { key: 'logLoss', label: 'Log-loss', title: 'Pérdida logarítmica (menor es mejor)', better: 'low', fmt: (x) => num(x, 4) },
  { key: 'accuracy', label: 'Acierto', title: 'Acierto del resultado más probable (mayor es mejor)', better: 'high', fmt: (x) => pct(x, 1) },
];

export interface SourceRow {
  id: 'model' | 'dc' | 'elo' | 'market' | 'base';
  label: string;
  detail: string;
  s: ScoreSet;
  n: number;
  emphasis?: boolean;
}

export function sourcesOf(bt: BacktestSummary): SourceRow[] {
  const out: SourceRow[] = [{ id: 'model', label: 'Modelo FutStat', detail: 'Ensamble final', s: bt.model, n: bt.matches, emphasis: true }];
  if (bt.dixonColes) out.push({ id: 'dc', label: 'Dixon-Coles', detail: 'Poisson bivariante', s: bt.dixonColes, n: bt.matches });
  if (bt.elo) out.push({ id: 'elo', label: 'Elo', detail: 'Rating de fuerza', s: bt.elo, n: bt.matches });
  if (bt.market) out.push({ id: 'market', label: 'Mercado', detail: 'Cierre sin margen', s: bt.market, n: bt.marketMatches ?? bt.matches });
  out.push({ id: 'base', label: 'Base', detail: 'Frecuencias de la liga', s: bt.baseline, n: bt.matches });
  return out;
}

/** Mejora relativa frente a la base (positivo = mejor). En acierto: diferencia en puntos. */
export function skillVsBase(s: ScoreSet, base: ScoreSet, key: MetricKey): number {
  if (key === 'accuracy') return s.accuracy - base.accuracy;
  const b = base[key];
  return b > 0 ? 1 - s[key] / b : 0;
}

export function SourceTable({ rows }: { rows: SourceRow[] }) {
  const best: Partial<Record<MetricKey, number>> = {};
  for (const m of SCORE_METRICS) {
    const vals = rows.map((r) => r.s[m.key]).filter((x) => Number.isFinite(x));
    best[m.key] = m.better === 'low' ? Math.min(...vals) : Math.max(...vals);
  }
  const th = 'border-b border-line bg-surface-2 px-3 py-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3';
  return (
    <div className="relative overflow-x-auto rounded-card border border-line bg-surface-1/90" role="region" aria-label="Métricas por fuente de predicción" tabIndex={0}>
      <table className="w-full min-w-[600px] border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">Métricas del backtest por fuente de predicción. La mejor de cada columna va marcada con un check.</caption>
        <thead>
          <tr>
            <th scope="col" className={cx(th, 'text-left')}>
              Fuente
            </th>
            <th scope="col" className={cx(th, 'text-right')} title="Partidos evaluados">
              Partidos
            </th>
            {SCORE_METRICS.map((m) => (
              <th key={m.key} scope="col" title={m.title} className={cx(th, 'text-right')}>
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={cx('group', r.emphasis && 'bg-accent/[0.06]')}>
              <th scope="row" className="border-b border-line/70 px-3 py-2.5 text-left font-normal group-last:border-b-0">
                <span className={cx('block text-ink-1', r.emphasis ? 'font-semibold' : 'font-medium')}>{r.label}</span>
                <span className="block text-2xs text-ink-3">{r.detail}</span>
              </th>
              <td className="num border-b border-line/70 px-3 py-2.5 text-right text-ink-2 group-last:border-b-0">{int(r.n)}</td>
              {SCORE_METRICS.map((m) => {
                const v = r.s[m.key];
                const isBest = Number.isFinite(v) && v === best[m.key];
                return (
                  <td key={m.key} className="num border-b border-line/70 px-3 py-2.5 text-right group-last:border-b-0">
                    <span className={cx('inline-flex items-center gap-1', isBest ? 'font-semibold text-ink-1' : 'text-ink-2')}>
                      {isBest && <Check className="h-3.5 w-3.5 text-accent-text" strokeWidth={3} aria-hidden="true" />}
                      {m.fmt(v)}
                      {isBest && <span className="sr-only">(mejor)</span>}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metodología
// ---------------------------------------------------------------------------
/** Texto con **negritas** y `código` mínimos (las secciones vienen del pipeline en texto plano). */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i} className="font-semibold text-ink-1">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith('`') && p.endsWith('`') ? (
          <code key={i} className="num rounded bg-surface-3 px-1 text-[12px] text-ink-1">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export function MethodologySteps({ sections }: { sections: { title: string; body: string[] }[] }) {
  return (
    <ol className="grid gap-4 md:grid-cols-2">
      {sections.map((s, i) => (
        <li key={`${s.title}-${i}`} className="min-w-0">
          <Card className="h-full">
            <div className="flex items-center gap-3">
              <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent-text/50 text-[12px] font-semibold text-accent-text">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="font-display text-[18px] font-bold uppercase tracking-wide text-ink-1">{s.title}</h3>
            </div>
            <div className="mt-3 space-y-2 text-[13.5px] leading-relaxed text-ink-2">
              {(s.body ?? []).map((b, j) =>
                b.trim().startsWith('- ') ? (
                  <p key={j} className="flex gap-2">
                    <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3" aria-hidden="true" />
                    <span>
                      <RichText text={b.trim().slice(2)} />
                    </span>
                  </p>
                ) : (
                  <p key={j}>
                    <RichText text={b} />
                  </p>
                ),
              )}
            </div>
          </Card>
        </li>
      ))}
    </ol>
  );
}

const LIMITS: { title: string; text: ReactNode }[] = [
  {
    title: 'Solo datos públicos',
    text: 'Todo procede de la API pública de ESPN: calendarios, resultados, estadísticas de equipo y fichas de jugador. Si ESPN no publica un dato (o lo corrige tarde), nosotros tampoco lo tenemos.',
  },
  {
    title: 'Sin xG real',
    text: 'No disponemos de goles esperados por tiro. Lo que llamamos «xG» es la λ del modelo (goles esperados según fuerza de ataque y defensa), un sustituto razonable pero no equivalente.',
  },
  {
    title: 'Sin alineaciones ni lesiones',
    text: 'Las predicciones se publican antes de conocer las alineaciones confirmadas. Bajas, rotaciones por calendario o cambios de entrenador no se reflejan hasta que afectan a los resultados.',
  },
  {
    title: 'Un solo proveedor de cuotas',
    text: 'Las cuotas son las de un único operador (DraftKings vía ESPN) y pueden estar desactualizadas o no estar disponibles en tu país. El mercado de cierre se usa solo cuando existe.',
  },
  {
    title: 'Muestras pequeñas',
    text: 'Al inicio de temporada, en copas y en competiciones continentales hay pocos partidos por equipo: el modelo se apoya más en el Elo global y la incertidumbre es mayor.',
  },
  {
    title: 'El pasado no garantiza el futuro',
    text: 'Un backtest positivo puede deberse a la varianza. Los mercados se ajustan y un modelo que batía al mercado puede dejar de hacerlo.',
  },
];

export function Limitations() {
  return (
    <ul className="grid gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
      {LIMITS.map((l) => (
        <li key={l.title} className="flex gap-3">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
          <div>
            <h3 className="text-[14px] font-semibold text-ink-1">{l.title}</h3>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{l.text}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Glossary() {
  const items: [string, string][] = [
    ['RPS', 'Ranked Probability Score: error acumulado que respeta el orden local · empate · visitante (predecir empate cuando gana el local es «menos malo» que predecir visitante). Es la métrica de referencia en fútbol; menor es mejor.'],
    ['Brier', 'Suma de errores al cuadrado de las tres probabilidades. Un modelo que siempre dijera 33/33/33 obtendría ≈0,667; menor es mejor.'],
    ['Log-loss', 'Penaliza mucho las predicciones muy seguras que fallan. Menor es mejor; ≈1,099 equivale a no saber nada (33/33/33).'],
    ['Acierto', '% de partidos en que el resultado más probable fue el real. Es intuitivo pero ignora la confianza de cada predicción.'],
    ['Calibración', 'Si el modelo dice 40%, el suceso debería ocurrir ~40% de las veces. El ECE es la desviación media ponderada entre lo predicho y lo observado.'],
    ['Base', 'Referencia ingenua: las frecuencias históricas de victoria local, empate y visitante de cada liga. Cualquier modelo útil debe mejorarla.'],
  ];
  return (
    <dl className="grid gap-x-8 gap-y-3 md:grid-cols-2">
      {items.map(([t, d]) => (
        <div key={t} className="min-w-0">
          <dt className="text-[13.5px] font-semibold text-ink-1">{t}</dt>
          <dd className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{d}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ParametersTable({ parameters }: { parameters: Record<string, number | string> }) {
  const entries = Object.entries(parameters ?? {});
  if (!entries.length) return <p className="text-[13px] text-ink-3">Sin parámetros publicados.</p>;
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface-1/90">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">Parámetros del modelo usados en la última actualización</caption>
        <thead>
          <tr>
            <th scope="col" className="border-b border-line bg-surface-2 px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">
              Parámetro
            </th>
            <th scope="col" className="border-b border-line bg-surface-2 px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">
              Valor
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="group">
              <th scope="row" className="border-b border-line/70 px-4 py-2 text-left font-normal text-ink-2 group-last:border-b-0">
                {k}
              </th>
              <td className="num border-b border-line/70 px-4 py-2 text-right font-semibold text-ink-1 group-last:border-b-0">{fmtParam(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
