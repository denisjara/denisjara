import { useId, useState, type ReactNode } from 'react';
import { Ban, Calculator, CircleCheck, CircleMinus, ShieldAlert, TrendingDown } from 'lucide-react';
import { Card, SegmentedControl, cx } from '../../components';
import { deltaClass } from '../../lib/colors';
import { ev as fmtEv, int, num, odds as fmtOdds, pct, signed } from '../../lib/format';
import { kelly as kellyStake } from '../../../lib/models/kelly';
import type { ValueItem } from './ValueCard';
import { pickSelection } from '../../lib/picks';

/** Tope de stake por pick usado por el pipeline (MODEL.kellyCap en pipeline/config.ts). */
export const KELLY_CAP = 0.05;

// ---------------------------------------------------------------------------
// Aviso destacado de juego responsable
// ---------------------------------------------------------------------------
export function ResponsibleBanner({ className }: { className?: string }) {
  return (
    <aside aria-labelledby="jr-title" className={cx('relative overflow-hidden rounded-card border border-warn/45 bg-warn/[0.06] p-4 sm:p-5', className)}>
      <div className="flex items-start gap-3 sm:gap-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-warn font-display text-[13px] font-extrabold text-ink-1 sm:h-11 sm:w-11 sm:text-[16px]" aria-hidden="true">
          18+
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="jr-title" className="flex min-h-9 items-center gap-2 font-display text-[18px] font-bold uppercase leading-tight tracking-wide text-ink-1 sm:min-h-11 sm:text-[19px]">
            <ShieldAlert className="h-[18px] w-[18px] shrink-0 text-warn" aria-hidden="true" />
            Antes de nada: juego responsable
          </h2>
          <ul className="mt-2.5 grid gap-x-6 gap-y-2 text-[13px] leading-snug text-ink-2 md:grid-cols-3">
            <li className="flex gap-2">
              <Ban className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
              <span>
                <strong className="text-ink-1">Solo mayores de 18 años.</strong> Apuesta únicamente dinero que puedas permitirte perder y fija límites.
              </span>
            </li>
            <li className="flex gap-2">
              <CircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
              <span>
                <strong className="text-ink-1">No hay garantías.</strong> Un EV positivo es una ventaja estadística a largo plazo; la mayoría de picks individuales
                pueden perder.
              </span>
            </li>
            <li className="flex gap-2">
              <TrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
              <span>
                <strong className="text-ink-1">Las cuotas cambian.</strong> Comprueba la cuota actual: por debajo de la «cuota mínima» el valor desaparece.
              </span>
            </li>
          </ul>
          <p className="mt-3 text-[12px] text-ink-3">
            FutStat Lab no es una casa de apuestas ni acepta apuestas. Ayuda y autoexclusión en{' '}
            <a className="link" href="https://www.jugarbien.es" target="_blank" rel="noopener noreferrer">
              jugarbien.es
            </a>
            .
          </p>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Conceptos: EV, cuota justa, edge y Kelly (con ejemplo real)
// ---------------------------------------------------------------------------
function Concept({ n, title, formula, children }: { n: number; title: string; formula: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] font-semibold text-ink-2">{n}</span>
        <h3 className="font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">{title}</h3>
      </div>
      <div className="num overflow-x-auto whitespace-nowrap rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink-1">{formula}</div>
      <div className="space-y-1.5 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </Card>
  );
}

export function ValueConcepts({ example, kellyFraction, minEv }: { example?: ValueItem; kellyFraction: number; minEv: number }) {
  const p = example?.pick.prob ?? 0.45;
  const o = example?.pick.odds ?? 2.5;
  const evv = p * o - 1;
  const implied = 1 / o;
  const full = Math.max(0, (p * o - 1) / (o - 1));
  const stake = Math.min(KELLY_CAP, full * kellyFraction);
  const ex = example ? (
    <>
      {example.match.home.short || example.match.home.name} – {example.match.away.short || example.match.away.name}, «{pickSelection(example.pick)}»
    </>
  ) : (
    'valores ilustrativos'
  );
  const fracLabel = kellyFraction === 0.25 ? '¼' : kellyFraction === 0.5 ? '½' : num(kellyFraction, 2);
  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
      <Concept n={1} title="Cuota justa" formula={<>cuota justa = 1 / p</>}>
        <p>
          <strong className="text-ink-1">p</strong> es la probabilidad del modelo. Si el suceso ocurre un {pct(p, 1)} de las veces, la cuota que no da ventaja a nadie
          es <span className="num text-ink-1">{fmtOdds(1 / p)}</span>.
        </p>
        <p className="text-[12px] text-ink-3">Ejemplo: {ex}.</p>
      </Concept>
      <Concept n={2} title="Valor esperado (EV)" formula={<>EV = p × cuota − 1</>}>
        <p>
          Lo que ganarías de media por cada euro apostado si repitieras la apuesta muchas veces. Con p = {pct(p, 1)} y cuota {fmtOdds(o)}:{' '}
          <span className="num text-ink-1">
            {num(p, 3)} × {fmtOdds(o)} − 1 = <span className={deltaClass(evv)}>{fmtEv(evv)}</span>
          </span>
          .
        </p>
        <p className="text-[12px] text-ink-3">Solo publicamos picks con EV ≥ {pct(minEv)}, probabilidad ≥ 12% y cuota ≤ 8.</p>
      </Concept>
      <Concept n={3} title="Ventaja (edge)" formula={<>edge = p − 1 / cuota</>}>
        <p>
          Diferencia entre la probabilidad del modelo y la implícita en la cuota ({pct(implied, 1)} en el ejemplo):{' '}
          <span className="num text-ink-1">{signed((p - implied) * 100, 1)} puntos</span>. La implícita incluye el margen de la casa, así que el edge real es algo mayor.
        </p>
      </Concept>
      <Concept n={4} title={`Kelly ${fracLabel}`} formula={<>f = (p × cuota − 1) / (cuota − 1)</>}>
        <p>
          Kelly completo da la fracción de banca que maximiza el crecimiento a largo plazo ({pct(full, 1)} en el ejemplo), pero es muy agresivo si el modelo se
          equivoca. Usamos <strong className="text-ink-1">Kelly {fracLabel}</strong> con tope del {pct(KELLY_CAP)}:{' '}
          <span className="num text-ink-1">{pct(stake, 1)} de la banca</span>.
        </p>
        <p className="text-[12px] text-ink-3">Si sigues varios picks a la vez, reduce los stakes en proporción.</p>
      </Concept>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calculadora
// ---------------------------------------------------------------------------
const parseNum = (s: string) => {
  const v = Number(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
};

function NumberField({ id, label, value, onChange, suffix, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; suffix?: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="eyebrow">
        {label}
      </label>
      <span className="relative mt-1.5 block">
        <input id={id} type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} className="input num h-[38px] pr-8 text-[14px]" aria-describedby={hint ? `${id}-hint` : undefined} />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-ink-3">{suffix}</span>}
      </span>
      {hint && (
        <span id={`${id}-hint`} className="mt-1 block text-2xs text-ink-3">
          {hint}
        </span>
      )}
    </div>
  );
}

function Out({ label, value, emphasis, tone }: { label: string; value: string; emphasis?: boolean; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/70 py-1.5 last:border-b-0">
      <dt className="text-[12.5px] text-ink-2">{label}</dt>
      <dd className={cx('num text-right', emphasis ? 'text-[16px] font-semibold' : 'text-[13px]', tone ?? 'text-ink-1')}>{value}</dd>
    </div>
  );
}

export function ValueCalculator({ example, kellyFraction, minEv }: { example?: ValueItem; kellyFraction: number; minEv: number }) {
  const uid = useId();
  const [probS, setProbS] = useState(() => num((example?.pick.prob ?? 0.45) * 100, 1));
  const [oddsS, setOddsS] = useState(() => num(example?.pick.odds ?? 2.4, 2));
  const [bankS, setBankS] = useState('1000');
  const fracOptions = ['0.25', '0.5', '1'] as const;
  const initialFrac = fracOptions.find((f) => Math.abs(Number(f) - kellyFraction) < 1e-9) ?? '0.25';
  const [frac, setFrac] = useState<(typeof fracOptions)[number]>(initialFrac);

  const p = parseNum(probS) / 100;
  const o = parseNum(oddsS);
  const bank = parseNum(bankS);
  const valid = p > 0 && p < 1 && o > 1;
  const evv = valid ? p * o - 1 : NaN;
  const full = valid ? Math.max(0, (p * o - 1) / (o - 1)) : NaN;
  const stake = valid ? kellyStake(p, o, Number(frac), KELLY_CAP) : NaN;
  const capped = valid && full * Number(frac) > KELLY_CAP;
  const minOdds = valid ? (1 + minEv) / p : NaN;

  let verdict: { icon: ReactNode; text: string; cls: string };
  if (!valid) verdict = { icon: <CircleMinus className="h-4 w-4" />, text: 'Introduce una probabilidad entre 0 y 100 y una cuota mayor que 1.', cls: 'text-ink-3' };
  else if (evv >= minEv) verdict = { icon: <CircleCheck className="h-4 w-4" />, text: `Con valor: el EV supera el umbral del ${pct(minEv)}.`, cls: 'text-pos' };
  else if (evv > 0) verdict = { icon: <CircleMinus className="h-4 w-4" />, text: `Valor marginal: EV positivo pero por debajo del ${pct(minEv)}; el error del modelo puede anularlo.`, cls: 'text-ink-2' };
  else verdict = { icon: <Ban className="h-4 w-4" />, text: 'Sin valor: a esta cuota la apuesta pierde dinero a largo plazo.', cls: 'text-neg' };

  return (
    <Card as="section" aria-labelledby={`${uid}-t`} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <h3 id={`${uid}-t`} className="flex items-center gap-2 font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">
          <Calculator className="h-4 w-4 text-accent-text" aria-hidden="true" />
          Calculadora de valor
        </h3>
        <p className="mt-1 text-[12.5px] text-ink-2">
          Comprueba si un pick sigue teniendo valor con la cuota que ves ahora mismo. Precargada con el pick de mayor EV publicado hoy.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <NumberField id={`${uid}-p`} label="Prob. del modelo" value={probS} onChange={setProbS} suffix="%" />
          <NumberField id={`${uid}-o`} label="Cuota actual" value={oddsS} onChange={setOddsS} hint="Decimal (p. ej. 2,10)" />
          <NumberField id={`${uid}-b`} label="Banca" value={bankS} onChange={setBankS} suffix="€" />
          <div className="min-w-0">
            <span className="eyebrow" id={`${uid}-f`}>
              Fracción de Kelly
            </span>
            <SegmentedControl
              ariaLabel="Fracción de Kelly"
              className="mt-1.5"
              full
              value={frac}
              onChange={setFrac}
              options={[
                { value: '0.25', label: '¼' },
                { value: '0.5', label: '½' },
                { value: '1', label: 'Completo' },
              ]}
            />
          </div>
        </div>
      </div>
      <div className="min-w-0 rounded-lg border border-line bg-surface-2/60 p-3 sm:p-4" aria-live="polite">
        <dl>
          <Out label="Prob. implícita en la cuota" value={valid ? pct(1 / o, 1) : '–'} />
          <Out label="Cuota justa del modelo" value={valid ? fmtOdds(1 / p) : '–'} />
          <Out label="Ventaja (edge)" value={valid ? `${signed((p - 1 / o) * 100, 1)} pp` : '–'} tone={valid ? deltaClass(p - 1 / o) : undefined} />
          <Out label="Valor esperado" value={valid ? fmtEv(evv) : '–'} emphasis tone={valid ? deltaClass(evv) : undefined} />
          <Out label="Kelly completo" value={valid ? pct(full, 1) : '–'} />
          <Out
            label={`Stake sugerido${capped ? ' (tope)' : ''}`}
            value={valid ? `${pct(stake, 1)}${bank > 0 ? ` · ${int(bank * stake)} €` : ''}` : '–'}
            emphasis
          />
          <Out label={`Cuota mínima para EV ≥ ${pct(minEv)}`} value={valid ? fmtOdds(minOdds) : '–'} />
        </dl>
        <p className={cx('mt-3 flex items-start gap-2 text-[12.5px] font-medium', verdict.cls)}>
          <span className="mt-px shrink-0" aria-hidden="true">
            {verdict.icon}
          </span>
          {verdict.text}
        </p>
      </div>
    </Card>
  );
}
