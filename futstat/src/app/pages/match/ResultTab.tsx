import { ArrowLeftRight, BarChart3, Check, CircleDot, ClipboardCheck, ListOrdered, Minus, X } from 'lucide-react';
import type { MatchEventPublic, MatchFile, MatchSummary, StatProjection, TeamMatchStatsPublic } from '../../../types/data';
import { EmptyState, HitMark, StatCompareBar, cx, type StatFormat } from '../../components';
import { PICK_LABEL, num, pct, scoreOutcome, signed, topOutcome, xg } from '../../lib/format';
import { Panel, TeamTag } from './parts';
import { asShare, minuteValue, scoreProb, validMatrix } from './utils';

interface TabProps {
  file: MatchFile;
  match: MatchSummary;
}

// ---------------------------------------------------------------------------
// Predicción vs realidad
// ---------------------------------------------------------------------------
type Verdict = 'hit' | 'miss' | 'neutral';

interface CompareRow {
  key: string;
  label: string;
  model: string;
  modelHint?: string;
  actual: string;
  verdict: Verdict;
  verdictLabel?: string;
}

function quantile(dist: number[], q: number): number {
  let acc = 0;
  for (let k = 0; k < dist.length; k++) {
    acc += dist[k];
    if (acc >= q) return k;
  }
  return dist.length - 1;
}

function actualTotal(key: StatProjection['key'], a: TeamMatchStatsPublic, b: TeamMatchStatsPublic): number | undefined {
  const sum = (x?: number, y?: number) => (typeof x === 'number' && typeof y === 'number' ? x + y : undefined);
  switch (key) {
    case 'corners':
      return sum(a.corners, b.corners);
    case 'cards':
      return sum((a.yellow ?? 0) + (a.red ?? 0), (b.yellow ?? 0) + (b.red ?? 0));
    case 'shots':
      return sum(a.shots, b.shots);
    case 'shotsOnTarget':
      return sum(a.shotsOnTarget, b.shotsOnTarget);
    case 'fouls':
      return sum(a.fouls, b.fouls);
    case 'offsides':
      return sum(a.offsides, b.offsides);
    default:
      return undefined;
  }
}

function VerdictIcon({ v, label }: { v: Verdict; label?: string }) {
  if (v === 'neutral') return <Minus className="ml-auto h-4 w-4 text-ink-3" aria-label={label ?? 'Sin valoración'} />;
  return (
    <span
      className={cx('ml-auto inline-flex h-6 w-6 items-center justify-center rounded-full', v === 'hit' ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss')}
      role="img"
      aria-label={label ?? (v === 'hit' ? 'Acierto' : 'Fallo')}
      title={label ?? (v === 'hit' ? 'Acierto' : 'Fallo')}
    >
      {v === 'hit' ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" /> : <X className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />}
    </span>
  );
}

function PredictionPanel({ file, match }: TabProps) {
  const s = match.score;
  if (!s) return null;
  const m = file.model;
  const probs = m?.ensemble ?? match.prediction?.p;
  const real = scoreOutcome(s.home, s.away);
  const rows: CompareRow[] = [];
  const hs = match.home.short || match.home.name;
  const as = match.away.short || match.away.name;
  const outcomeName = (o: 'home' | 'draw' | 'away') => (o === 'home' ? hs : o === 'away' ? as : PICK_LABEL.draw);

  if (probs) {
    const top = topOutcome(probs);
    rows.push({
      key: '1x2',
      label: 'Resultado (1X2)',
      model: `${outcomeName(top)} · ${pct(probs[top])}`,
      modelHint: `Al resultado real le daba ${pct(probs[real])}`,
      actual: outcomeName(real),
      verdict: top === real ? 'hit' : 'miss',
    });
  }
  const matrix = m?.scoreMatrix;
  const likely = match.prediction?.likelyScore;
  if (likely || validMatrix(matrix)) {
    const pReal = validMatrix(matrix) ? scoreProb(matrix, s.home, s.away) : undefined;
    rows.push({
      key: 'cs',
      label: 'Marcador exacto',
      model: likely ? `${likely}${match.prediction ? ` · ${pct(match.prediction.likelyScoreProb, 1)}` : ''}` : '—',
      modelHint: pReal !== undefined ? `Al ${s.home}-${s.away} le daba ${pct(pReal, 1)}` : undefined,
      actual: `${s.home}-${s.away}`,
      verdict: likely === `${s.home}-${s.away}` ? 'hit' : 'miss',
    });
  }
  const lh = m?.lambdaHome ?? match.prediction?.xgHome;
  const la = m?.lambdaAway ?? match.prediction?.xgAway;
  if (typeof lh === 'number') rows.push({ key: 'gh', label: `Goles ${hs}`, model: `xG ${xg(lh)}`, actual: String(s.home), verdict: 'neutral', modelHint: `Diferencia ${signed(s.home - lh, 2)}` });
  if (typeof la === 'number') rows.push({ key: 'ga', label: `Goles ${as}`, model: `xG ${xg(la)}`, actual: String(s.away), verdict: 'neutral', modelHint: `Diferencia ${signed(s.away - la, 2)}` });
  const o25 = match.prediction?.over25;
  if (typeof o25 === 'number') {
    const yes = s.home + s.away > 2.5;
    rows.push({ key: 'o25', label: 'Más de 2,5 goles', model: o25 >= 0.5 ? `Sí · ${pct(o25)}` : `No · ${pct(1 - o25)}`, actual: yes ? 'Sí' : 'No', verdict: o25 >= 0.5 === yes ? 'hit' : 'miss' });
  }
  const btts = match.prediction?.btts;
  if (typeof btts === 'number') {
    const yes = s.home > 0 && s.away > 0;
    rows.push({ key: 'btts', label: 'Ambos marcan', model: btts >= 0.5 ? `Sí · ${pct(btts)}` : `No · ${pct(1 - btts)}`, actual: yes ? 'Sí' : 'No', verdict: btts >= 0.5 === yes ? 'hit' : 'miss' });
  }
  if (file.actual) {
    for (const p of file.projections ?? []) {
      const real = actualTotal(p.key, file.actual.home, file.actual.away);
      if (real === undefined) continue;
      const dist = p.totalDist ?? [];
      const lo = dist.length ? quantile(dist, 0.1) : undefined;
      const hi = dist.length ? quantile(dist, 0.9) : undefined;
      const inside = lo !== undefined && hi !== undefined ? real >= lo && real <= hi : undefined;
      rows.push({
        key: `p-${p.key}`,
        label: p.label,
        model: `${num(p.total, 1)} esperados`,
        modelHint: lo !== undefined ? `Intervalo 80%: ${lo}–${hi}` : undefined,
        actual: String(real),
        verdict: inside === undefined ? 'neutral' : inside ? 'hit' : 'miss',
        verdictLabel: inside === undefined ? undefined : inside ? 'Dentro del intervalo del 80%' : 'Fuera del intervalo del 80%',
      });
    }
  }
  const judged = rows.filter((r) => r.verdict !== 'neutral');
  const hits = judged.filter((r) => r.verdict === 'hit').length;
  const hit = match.predictionHit ?? (probs ? topOutcome(probs) === real : undefined);

  return (
    <Panel
      title="Predicción vs realidad"
      icon={<ClipboardCheck />}
      description="Lo que esperaba el modelo antes del partido frente a lo que ocurrió."
      flush
      action={
        typeof hit === 'boolean' ? (
          <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-ink-1">
            <HitMark hit={hit} />
            {hit ? 'Pronóstico 1X2 acertado' : 'Pronóstico 1X2 fallado'}
          </span>
        ) : undefined
      }
    >
      <div className="relative overflow-x-auto border-t border-line/70">
        <table className="w-full text-[13px]">
          <caption className="sr-only">Comparación entre la predicción del modelo y el resultado real</caption>
          <thead>
            <tr className="bg-surface-2 text-2xs uppercase tracking-[0.08em] text-ink-3">
              <th scope="col" className="py-2 pl-4 pr-2 text-left font-semibold">Métrica</th>
              <th scope="col" className="px-2 py-2 text-left font-semibold">Modelo</th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">Real</th>
              <th scope="col" className="py-2 pl-2 pr-4 text-right font-semibold">
                <span className="sr-only">Valoración</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-line/70">
                <th scope="row" className="py-2.5 pl-4 pr-2 text-left font-medium text-ink-1">
                  {r.label}
                </th>
                <td className="px-2 py-2.5">
                  <span className="num block text-ink-1">{r.model}</span>
                  {r.modelHint && <span className="block text-2xs text-ink-3">{r.modelHint}</span>}
                </td>
                <td className="num px-2 py-2.5 text-right text-[14px] font-semibold text-ink-1">{r.actual}</td>
                <td className="py-2.5 pl-2 pr-4 text-right">
                  <VerdictIcon v={r.verdict} label={r.verdictLabel} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {judged.length > 0 && (
        <p className="border-t border-line/70 px-4 py-2.5 text-[12px] text-ink-2">
          Aciertos: <span className="num font-semibold text-ink-1">{hits}</span> de <span className="num">{judged.length}</span> comprobaciones
          <span className="text-ink-3"> · en proyecciones, acierto = el valor real cae dentro del intervalo central del 80%.</span>
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Estadísticas reales
// ---------------------------------------------------------------------------
const ACTUAL_ROWS: { key: keyof TeamMatchStatsPublic; label: string; format: StatFormat; better: 'high' | 'low' }[] = [
  { key: 'possession', label: 'Posesión', format: 'pct', better: 'high' },
  { key: 'shots', label: 'Tiros', format: 'int', better: 'high' },
  { key: 'shotsOnTarget', label: 'Tiros a puerta', format: 'int', better: 'high' },
  { key: 'corners', label: 'Córners', format: 'int', better: 'high' },
  { key: 'saves', label: 'Paradas', format: 'int', better: 'high' },
  { key: 'passes', label: 'Pases', format: 'int', better: 'high' },
  { key: 'passPct', label: 'Precisión de pase', format: 'pct', better: 'high' },
  { key: 'tackles', label: 'Entradas', format: 'int', better: 'high' },
  { key: 'fouls', label: 'Faltas', format: 'int', better: 'low' },
  { key: 'offsides', label: 'Fueras de juego', format: 'int', better: 'low' },
  { key: 'yellow', label: 'Tarjetas amarillas', format: 'int', better: 'low' },
  { key: 'red', label: 'Tarjetas rojas', format: 'int', better: 'low' },
];

function ActualStatsPanel({ file, match }: TabProps) {
  const a = file.actual;
  if (!a) {
    return (
      <Panel title="Estadísticas del partido" icon={<BarChart3 />}>
        <EmptyState compact title="Sin estadísticas" description="La fuente no ha publicado las estadísticas de este partido." />
      </Panel>
    );
  }
  const rows = ACTUAL_ROWS.filter((r) => typeof a.home[r.key] === 'number' && typeof a.away[r.key] === 'number');
  const val = (side: TeamMatchStatsPublic, r: (typeof ACTUAL_ROWS)[number]) => {
    const v = side[r.key] as number;
    return r.format === 'pct' ? asShare(v) ?? 0 : v;
  };
  return (
    <Panel title="Estadísticas del partido" icon={<BarChart3 />} description="Datos reales del encuentro. El lado que gana cada métrica va en color pleno.">
      <div className="mb-4 flex items-center justify-between gap-3">
        <TeamTag team={match.home} side="home" size={22} className="text-[13px]" />
        <span className="num font-display text-[24px] font-extrabold text-ink-1">
          {a.home.goals} – {a.away.goals}
        </span>
        <TeamTag team={match.away} side="away" size={22} className="flex-row-reverse text-[13px]" />
      </div>
      <div className="space-y-3.5">
        {rows.map((r) => (
          <StatCompareBar key={r.key} label={r.label} home={val(a.home, r)} away={val(a.away, r)} format={r.format} better={r.better} />
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Cronología
// ---------------------------------------------------------------------------
const EVENT_LABEL: Record<MatchEventPublic['type'], string> = {
  goal: 'Gol',
  'own-goal': 'Gol en propia puerta',
  penalty: 'Gol de penalti',
  yellow: 'Tarjeta amarilla',
  red: 'Tarjeta roja',
  sub: 'Cambio',
};

function EventIcon({ type }: { type: MatchEventPublic['type'] }) {
  if (type === 'yellow') return <span className="inline-block h-3.5 w-2.5 rounded-[2px] bg-warn" aria-hidden="true" />;
  if (type === 'red') return <span className="inline-block h-3.5 w-2.5 rounded-[2px] bg-loss" aria-hidden="true" />;
  if (type === 'sub') return <ArrowLeftRight className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />;
  return <CircleDot className={cx('h-4 w-4', type === 'own-goal' ? 'text-neg' : 'text-accent-text')} aria-hidden="true" />;
}

function EventBody({ e, align }: { e: MatchEventPublic; align: 'left' | 'right' }) {
  const isGoal = e.type === 'goal' || e.type === 'penalty' || e.type === 'own-goal';
  return (
    <div className={cx('flex min-w-0 items-center gap-2', align === 'right' && 'flex-row-reverse text-right')}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2">
        <EventIcon type={e.type} />
      </span>
      <div className="min-w-0">
        <div className={cx('truncate text-[13px]', isGoal ? 'font-semibold text-ink-1' : 'text-ink-1')}>{e.player ?? EVENT_LABEL[e.type]}</div>
        <div className="truncate text-2xs text-ink-3">
          {EVENT_LABEL[e.type]}
          {e.detail ? ` · ${e.detail}` : ''}
        </div>
      </div>
    </div>
  );
}

function TimelinePanel({ file, match }: TabProps) {
  const events = [...(file.events ?? [])].sort((a, b) => minuteValue(a.minute) - minuteValue(b.minute));
  const s = match.score;
  if (!events.length) {
    return (
      <Panel title="Cronología" icon={<ListOrdered />}>
        <EmptyState compact title="Sin eventos" description="No hay goles ni tarjetas registrados para este partido." />
      </Panel>
    );
  }
  // marcador acumulado tras cada gol
  let h = 0;
  let a = 0;
  const items = events.map((e) => {
    const goal = e.type === 'goal' || e.type === 'penalty' || e.type === 'own-goal';
    if (goal) {
      if (e.teamId === match.home.id) h++;
      else if (e.teamId === match.away.id) a++;
    }
    return { e, running: goal ? `${h}-${a}` : undefined };
  });
  const htIndex = items.findIndex((it) => minuteValue(it.e.minute) >= 46);
  const hasHt = typeof s?.htHome === 'number' && typeof s?.htAway === 'number';

  const Divider = ({ label }: { label: string }) => (
    <li className="flex items-center gap-3 py-1" aria-label={label}>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="eyebrow rounded-md border border-line bg-surface-2 px-2 py-0.5 text-ink-2">{label}</span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </li>
  );

  return (
    <Panel title="Cronología" icon={<ListOrdered />} description="Goles y tarjetas minuto a minuto.">
      <div className="mb-3 flex items-center justify-between gap-3 text-[12px]">
        <TeamTag team={match.home} side="home" size={18} />
        <TeamTag team={match.away} side="away" size={18} className="flex-row-reverse" />
      </div>
      <ol className="space-y-1.5">
        {items.map((it, i) => {
          const isHome = it.e.teamId === match.home.id;
          const showHt = i === htIndex && htIndex > 0;
          return [
            showHt ? <Divider key={`ht-${i}`} label={hasHt ? `Descanso · ${s!.htHome}-${s!.htAway}` : 'Descanso'} /> : null,
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_56px_minmax(0,1fr)] items-center gap-2">
              <div className="min-w-0">{isHome && <EventBody e={it.e} align="right" />}</div>
              <div className="flex flex-col items-center">
                <span className="num rounded-md bg-surface-3 px-1.5 py-0.5 text-[11.5px] font-semibold text-ink-1">{it.e.minute}</span>
                {it.running && <span className="num mt-0.5 text-2xs font-semibold text-accent-text">{it.running}</span>}
              </div>
              <div className="min-w-0">{!isHome && <EventBody e={it.e} align="left" />}</div>
              <span className="sr-only">{isHome ? match.home.name : match.away.name}</span>
            </li>,
          ];
        })}
        {s && <Divider label={`${match.statusDetail && match.statusDetail !== 'FT' ? match.statusDetail : 'Final'} · ${s.home}-${s.away}`} />}
      </ol>
    </Panel>
  );
}

export function ResultTab({ file, match }: TabProps) {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <PredictionPanel file={file} match={match} />
        <ActualStatsPanel file={file} match={match} />
      </div>
      <TimelinePanel file={file} match={match} />
    </div>
  );
}
