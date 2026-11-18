import { Link } from 'react-router-dom';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import type { ConfidencePick, MatchFile, MatchSummary } from '../../../types/data';
import { OutOfSampleNote, ResultMark, beyond90, ciText, confidenceMarket, confidenceSelection, cx, ownRate } from '../../components';
import { int, odds as fmtOdds, pct } from '../../lib/format';
import { localizeDecimals } from '../../lib/picks';
import { Panel } from './parts';

const RESULT_LABEL = { hit: 'Acierto', miss: 'Fallo', void: 'Nulo (se devuelve)' } as const;

function Figure({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="min-w-0" title={title}>
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
      <span className="num block text-[14px] font-semibold text-ink-1">{value}</span>
    </span>
  );
}

function PickItem({ pick, finished }: { pick: ConfidencePick; finished: boolean }) {
  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
          <span className="min-w-0 text-[15px] font-semibold text-ink-1">{confidenceSelection(pick)}</span>
          {finished && pick.result && (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2">
              <ResultMark result={pick.result} />
              {RESULT_LABEL[pick.result]}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-3">
          <span>{localizeDecimals(confidenceMarket(pick))}</span>
          <OutOfSampleNote pick={pick} />
          {pick.holdoutN !== undefined && (
            <span title="Acierto de esta familia de mercados en el holdout (partidos no usados para calibrar) · intervalo de Wilson al 90 %">
              {ownRate(pick.holdoutN)
                ? `Holdout ${pct(pick.holdoutHitRate, 0)} (n = ${int(pick.holdoutN)}${pick.holdoutWilsonLow !== undefined ? ` · ${ciText(pick.holdoutWilsonLow, pick.holdoutWilsonHigh, 0)}` : ''})`
                : `Holdout: muestra pequeña (n = ${int(pick.holdoutN)})`}
            </span>
          )}
          {pick.baseRate !== undefined && (
            <span title="Acierto de este mercado sin filtrar con el modelo (su selección natural en todos los partidos del holdout)">
              Tasa base del mercado {pct(pick.baseRate, 0)}
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 sm:flex sm:items-center sm:gap-5 sm:text-right">
        <Figure label="Prob." value={pct(pick.prob)} title="Probabilidad del modelo" />
        <Figure label="Justa" value={fmtOdds(pick.fairOdds)} title="Cuota justa (1 / probabilidad)" />
        <Figure
          label={pick.oddsKind === 'sintetica' ? 'Mercado*' : 'Mercado'}
          value={pick.marketOdds ? fmtOdds(pick.marketOdds) : '—'}
          title={pick.marketOdds ? (pick.oddsKind === 'sintetica' ? 'Cuota sintética calculada desde el 1X2 de la casa' : 'Cuota de la casa') : 'La fuente no publica cuota para este mercado'}
        />
      </div>
    </li>
  );
}

/**
 * Pronósticos de alta confianza del partido (máx. 2). Próximos: reglas actuales. Terminados: reconstrucción sin fuga
 * (reglas ajustadas sin este partido, cuotas de cierre) con ✓/✗.
 */
export function ConfidenceBlock({ file, match }: { file: MatchFile; match: MatchSummary }) {
  const picks = file.confidence ?? [];
  if (!picks.length) return null;
  const finished = match.status === 'finished';
  if (!finished && match.status !== 'scheduled') return null;
  const synthetic = picks.some((p) => p.oddsKind === 'sintetica' && p.marketOdds);
  const et = finished ? beyond90(match) : undefined;
  return (
    <Panel
      id="alta-confianza"
      title="Alta confianza"
      icon={<ShieldCheck />}
      flush
      description={
        finished
          ? `Lo que el método habría publicado antes del partido (con datos y reglas anteriores, cuotas de cierre) y cómo terminó.${
              et ? ` Hubo ${et}: se resuelven con el marcador a los 90 minutos, como en las casas.` : ''
            }`
          : 'Selecciones muy probables y de cuota baja de este partido, de mercados validados fuera de muestra. No son una ventaja frente a la casa: compáralas con la tasa base de su mercado.'
      }
      action={
        <Link to="/confianza" className="btn-ghost -mr-2 text-[12.5px]">
          Qué es
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      }
    >
      <ul className={cx('divide-y divide-line/70 border-t border-line/70')}>
        {picks.map((p) => (
          <PickItem key={p.family} pick={p} finished={finished} />
        ))}
      </ul>
      {synthetic && <p className="border-t border-line/70 px-4 py-2 text-2xs text-ink-3">* Cuota sintética: combinación de los precios 1X2 de la casa (realizable repartiendo la apuesta).</p>}
    </Panel>
  );
}
