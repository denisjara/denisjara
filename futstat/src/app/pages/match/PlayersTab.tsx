import { useMemo, useState, type ReactNode } from 'react';
import { Crosshair, Footprints, Goal, Handshake, Square, Users } from 'lucide-react';
import type { MatchFile, MatchSummary, PlayerProp, TeamRef } from '../../../types/data';
import { Card, DataTable, EmptyState, Meter, SegmentedControl, TeamCrest, cx, type Column } from '../../components';
import { fairOddsFromProb, int, pct } from '../../lib/format';
import { Panel } from './parts';

interface TabProps {
  file: MatchFile;
  match: MatchSummary;
}

type Row = PlayerProp & { team: TeamRef; side: 'home' | 'away' };
type TeamFilter = 'home' | 'away' | 'both';
type Display = 'prob' | 'odds';

const POS: Record<string, string> = { G: 'POR', D: 'DEF', M: 'MED', F: 'DEL', '?': '—' };
const POS_TITLE: Record<string, string> = { G: 'Portero', D: 'Defensa', M: 'Centrocampista', F: 'Delantero', '?': 'Posición desconocida' };

const PROB_COLS: { key: keyof PlayerProp; header: string; title: string }[] = [
  { key: 'pGoal', header: 'Gol', title: 'Probabilidad de marcar (en cualquier momento)' },
  { key: 'pAssist', header: 'Asist.', title: 'Probabilidad de dar una asistencia' },
  { key: 'pGoalOrAssist', header: 'G o A', title: 'Probabilidad de gol o asistencia' },
  { key: 'pShots1', header: 'Tiro ≥1', title: 'Probabilidad de al menos 1 tiro' },
  { key: 'pShots2', header: 'Tiros ≥2', title: 'Probabilidad de al menos 2 tiros' },
  { key: 'pSot1', header: 'Puerta ≥1', title: 'Probabilidad de al menos 1 tiro a puerta' },
  { key: 'pSot2', header: 'Puerta ≥2', title: 'Probabilidad de al menos 2 tiros a puerta' },
  { key: 'pCard', header: 'Tarjeta', title: 'Probabilidad de ver tarjeta' },
  { key: 'pFouls2', header: 'Faltas ≥2', title: 'Probabilidad de cometer al menos 2 faltas' },
];

function rowSummary(r: Row): string {
  return `${r.player.name}, ${r.team.name}. Gol ${pct(r.pGoal)} (cuota justa ${fairOddsFromProb(r.pGoal)}), asistencia ${pct(r.pAssist)} (${fairOddsFromProb(r.pAssist)}), tiro a puerta ${pct(r.pSot1)} (${fairOddsFromProb(r.pSot1)}), tarjeta ${pct(r.pCard)} (${fairOddsFromProb(r.pCard)}).`;
}

function buildColumns(display: Display, showTeam: boolean): Column<Row>[] {
  const probCell = (v: number | undefined) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return <span className="text-ink-3">–</span>;
    const main = display === 'prob' ? pct(v) : fairOddsFromProb(v);
    const alt = display === 'prob' ? `@${fairOddsFromProb(v)}` : pct(v);
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <span className={cx(v >= 0.5 ? 'font-semibold text-ink-1' : v >= 0.2 ? 'text-ink-1' : 'text-ink-2')}>{main}</span>
        <span className="text-2xs text-ink-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" aria-hidden="true">
          {alt}
        </span>
      </span>
    );
  };
  return [
    {
      key: 'player',
      header: 'Jugador',
      sticky: true,
      sortValue: (r) => r.player.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="w-8 shrink-0 rounded bg-surface-3 px-1 text-center font-mono text-[10px] text-ink-2" title={POS_TITLE[r.player.position] ?? ''}>
            {POS[r.player.position] ?? '—'}
          </span>
          {showTeam && <TeamCrest team={r.team} size={16} />}
          <span className="min-w-0">
            <span
              tabIndex={0}
              aria-label={rowSummary(r)}
              className="block max-w-[150px] truncate rounded-sm font-semibold text-ink-1 focus-visible:outline-offset-2 sm:max-w-[200px]"
              title={r.player.name}
            >
              {r.player.short || r.player.name}
            </span>
            <span className="num block whitespace-nowrap text-2xs text-ink-3">
              {r.goals} G · {r.assists} A · {r.apps} PJ
            </span>
            <span className="num block whitespace-nowrap text-2xs text-ink-3 sm:hidden">
              Forma {Math.round(r.formIndex)} · {int(r.expMinutes)}′
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'form',
      header: 'Forma',
      title: 'Índice de forma (0–100)',
      numeric: true,
      hideBelow: 'sm',
      sortValue: (r) => r.formIndex,
      cell: (r) => (
        <span className="inline-flex flex-col items-end gap-1">
          <span className="text-ink-1">{Math.round(r.formIndex)}</span>
          <Meter value={r.formIndex / 100} height={3} className="!w-9" label={`Forma ${Math.round(r.formIndex)} de 100`} />
        </span>
      ),
    },
    {
      key: 'expMinutes',
      header: 'Min.',
      title: 'Minutos esperados en este partido',
      numeric: true,
      hideBelow: 'sm',
      sortValue: (r) => r.expMinutes,
      cell: (r) => <span className="text-ink-2">{int(r.expMinutes)}′</span>,
    },
    ...PROB_COLS.map<Column<Row>>((c) => ({
      key: c.key,
      header: c.header,
      title: c.title,
      numeric: true,
      sortValue: (r) => r[c.key] as number | undefined,
      cell: (r) => probCell(r[c.key] as number | undefined),
    })),
  ];
}

function Highlight({ icon, label, row, value }: { icon: ReactNode; label: string; row?: Row; value: (r: Row) => number }) {
  if (!row) return null;
  const v = value(row);
  return (
    <Card className="flex min-w-0 flex-col gap-2" pad="sm">
      <span className="eyebrow flex items-center gap-1.5">
        <span className="text-accent-text [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">
          {icon}
        </span>
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <TeamCrest team={row.team} size={22} />
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold text-ink-1" title={row.player.name}>
            {row.player.name}
          </span>
          <span className="block truncate text-2xs text-ink-3">{row.team.short || row.team.name}</span>
        </span>
      </span>
      <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="font-display text-[28px] font-extrabold leading-none text-ink-1">{pct(v)}</span>
        <span className="num text-[12px] text-ink-2">
          cuota justa <span className="font-semibold text-ink-1">{fairOddsFromProb(v)}</span>
        </span>
      </span>
    </Card>
  );
}

export function PlayersTab({ file, match }: TabProps) {
  const [team, setTeam] = useState<TeamFilter>('home');
  const [display, setDisplay] = useState<Display>('prob');
  const all = useMemo<Row[]>(
    () => [
      ...(file.players?.home ?? []).map((p) => ({ ...p, team: match.home, side: 'home' as const })),
      ...(file.players?.away ?? []).map((p) => ({ ...p, team: match.away, side: 'away' as const })),
    ],
    [file.players, match.home, match.away],
  );
  const rows = useMemo(() => (team === 'both' ? all : all.filter((r) => r.side === team)), [all, team]);
  const columns = useMemo(() => buildColumns(display, team === 'both'), [display, team]);
  const best = (f: (r: Row) => number | undefined) =>
    all.reduce<Row | undefined>((b, r) => {
      const v = f(r);
      return typeof v === 'number' && (!b || v > (f(b) ?? -1)) ? r : b;
    }, undefined);

  if (!all.length) {
    return <EmptyState icon={<Users />} title="Sin datos de jugadores" description="No hay estadísticas individuales suficientes para estimar props de jugadores en este partido." />;
  }
  const nHome = file.players?.home?.length ?? 0;
  const nAway = file.players?.away?.length ?? 0;

  return (
    <div className="space-y-6">
      <section aria-labelledby="props-dest" className="min-w-0">
        <h2 id="props-dest" className="eyebrow mb-2.5">
          Destacados del partido
        </h2>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Highlight icon={<Goal />} label="Goleador probable" row={best((r) => r.pGoal)} value={(r) => r.pGoal} />
          <Highlight icon={<Handshake />} label="Asistente probable" row={best((r) => r.pAssist)} value={(r) => r.pAssist} />
          <Highlight icon={<Crosshair />} label="≥2 tiros a puerta" row={best((r) => r.pSot2)} value={(r) => r.pSot2} />
          <Highlight icon={<Square />} label="Tarjeta probable" row={best((r) => r.pCard)} value={(r) => r.pCard} />
        </div>
      </section>

      <Panel
        title="Props de jugadores"
        icon={<Footprints />}
        description="Probabilidades por jugador según su forma, minutos esperados y la fuerza del rival. Pasa el cursor o enfoca una fila para ver la cuota justa."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              size="sm"
              ariaLabel="Equipo"
              value={team}
              onChange={setTeam}
              options={[
                { value: 'home', label: match.home.short || match.home.name, count: nHome },
                { value: 'away', label: match.away.short || match.away.name, count: nAway },
                { value: 'both', label: 'Ambos' },
              ]}
            />
            <SegmentedControl
              size="sm"
              ariaLabel="Mostrar"
              value={display}
              onChange={setDisplay}
              options={[
                { value: 'prob', label: '%' },
                { value: 'odds', label: 'Cuota justa' },
              ]}
            />
          </div>
        }
      >
        <DataTable
          caption={`Props de jugadores: ${team === 'both' ? `${match.home.name} y ${match.away.name}` : match[team].name}`}
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.side}-${r.player.id}`}
          initialSort={{ key: 'pGoal', dir: 'desc' }}
          dense
          maxHeight={620}
          emptyText="Sin jugadores para este equipo"
        />
        <p className="mt-2 text-2xs text-ink-3">
          {display === 'prob' ? 'Valores en probabilidad; la cuota justa (1/p) aparece debajo al pasar el cursor o enfocar.' : 'Valores en cuota justa (1/p); la probabilidad aparece debajo al pasar el cursor o enfocar.'}{' '}
          Min. = minutos esperados. G · A · PJ = goles, asistencias y partidos de la temporada.
        </p>
      </Panel>
    </div>
  );
}
