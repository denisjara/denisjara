/**
 * Piezas compartidas por las pestañas de la competición y la ficha de equipo.
 * (Componentes locales de página: no forman parte de src/app/components.)
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, History, Users, X } from 'lucide-react';
import type { MatchSummary, PlayerRef, PlayerSeasonRow, StandingRow, TeamRef } from '../../../types/data';
import { Card, EmptyState, MatchRow, Meter, Sparkline, TeamCrest, cx } from '../../components';
import { int, pct, sumFinite } from '../../lib/format';

export const POSITION_SHORT: Record<PlayerRef['position'], string> = { G: 'POR', D: 'DEF', M: 'MED', F: 'DEL', '?': '—' };
export const POSITION_LONG: Record<PlayerRef['position'], string> = {
  G: 'Portero',
  D: 'Defensa',
  M: 'Centrocampista',
  F: 'Delantero',
  '?': 'Sin posición',
};

/** Tramos de minutos de goalsByPeriod / concededByPeriod. */
export const PERIOD_LABELS = ['0-15', '16-30', '31-45+', '46-60', '61-75', '76-90+'];

/** Color de zona de la clasificación (viene como hex en los datos) → CSS válido o undefined. */
export function zoneColor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const h = color.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(h) || /^[0-9a-fA-F]{3}$/.test(h) ? `#${h}` : undefined;
}

/**
 * Paleta semántica de zonas. ESPN usa colores inconsistentes entre ligas (p. ej. "Europa League" llega con 4 tonos
 * distintos) y, dentro de una misma liga, grises casi idénticos para zonas diferentes (Europa vs Conference).
 * Se asigna el color por el significado de la etiqueta y se cae al color de ESPN si no se reconoce.
 */
const ZONE_PALETTE: [RegExp, string][] = [
  [/playoff de descenso/i, '#f59e0b'], // ámbar
  [/descen|eliminad/i, '#ef4444'], // rojo
  [/previa de champions|playoff de ascenso|\(cabeza de serie\)|primera ronda/i, '#2dd4bf'], // turquesa
  [/champions|libertadores|ascenso|octavos|cuartos|campe[oó]n|l[ií]der/i, '#22c55e'], // verde
  [/previa de europa/i, '#60a5fa'], // azul claro
  [/europa league|sudamericana/i, '#3b82f6'], // azul
  [/conference|comod[ií]n|sin cabeza|playoff|play-in/i, '#a78bfa'], // violeta
];

/** Color de una zona (nota de la clasificación): semántico por etiqueta, con el de ESPN como respaldo. */
export function noteColor(note: { label?: string; color?: string } | undefined): string | undefined {
  if (!note) return undefined;
  const label = note.label ?? '';
  for (const [re, c] of ZONE_PALETTE) if (re.test(label)) return c;
  return zoneColor(note.color);
}

/** Zonas distintas presentes en unas filas, en orden de aparición. */
export function zonesOf(rows: StandingRow[]): { label: string; color: string }[] {
  const seen = new Map<string, { label: string; color: string }>();
  for (const r of rows) {
    const c = noteColor(r.note);
    if (r.note?.label && c && !seen.has(r.note.label)) seen.set(r.note.label, { label: r.note.label, color: c });
  }
  return [...seen.values()];
}

/** Barra fina de color de zona + número de posición. El nombre de la zona va en title y en texto oculto. */
export function RankCell({ row }: { row: StandingRow }) {
  const c = noteColor(row.note);
  return (
    <span className="inline-flex items-center gap-2" title={row.note?.label}>
      <span className="h-5 w-[3px] shrink-0 rounded-full" style={{ background: c ?? 'transparent' }} aria-hidden="true" />
      <span className="num w-5 text-right font-semibold text-ink-1">{row.rank}</span>
      {row.note?.label && <span className="sr-only">({row.note.label})</span>}
    </span>
  );
}

/** Leyenda de zonas de la clasificación (color + nombre: nunca solo color). */
export function ZoneLegend({ rows, className }: { rows: StandingRow[]; className?: string }) {
  const zones = zonesOf(rows);
  if (!zones.length) return null;
  return (
    <ul className={cx('flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-2', className)} aria-label="Leyenda de zonas">
      {zones.map((z) => (
        <li key={z.label} className="inline-flex items-center gap-1.5">
          <span className="h-3 w-[3px] rounded-full" style={{ background: z.color }} aria-hidden="true" />
          {z.label}
        </li>
      ))}
    </ul>
  );
}

/** Escudo + nombre enlazado a la ficha del equipo (nombre corto en móvil). */
export function TeamLink({ team, size = 20, className, bold }: { team: TeamRef; size?: number; className?: string; bold?: boolean }) {
  return (
    <Link
      to={`/t/${team.id}`}
      className={cx('group/team inline-flex min-w-0 max-w-full items-center gap-2 rounded-sm', className)}
      title={team.name}
      onClick={(e) => e.stopPropagation()}
    >
      <TeamCrest team={team} size={size} />
      <span className={cx('min-w-0 truncate text-ink-1 decoration-line-strong underline-offset-4 group-hover/team:underline', bold ? 'font-semibold' : 'font-medium')}>
        <span className="sm:hidden">{team.short || team.name}</span>
        <span className="hidden sm:inline">{team.name}</span>
      </span>
    </Link>
  );
}

/** Índice de forma (0-100) con sparkline de las últimas notas. */
export function PlayerForm({ player }: { player: PlayerSeasonRow }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="num w-6 text-right font-semibold text-ink-1">{int(player.formIndex)}</span>
      <Sparkline
        values={player.formTrend ?? []}
        width={52}
        height={20}
        domain={[3, 10]}
        ariaLabel={`Notas de los últimos partidos de ${player.player.name}: ${(player.formTrend ?? []).map((v) => v.toFixed(1).replace('.', ',')).join(', ')}`}
      />
    </span>
  );
}

/** Pequeña etiqueta de posición (POR/DEF/MED/DEL). */
export function PositionTag({ position }: { position: PlayerRef['position'] }) {
  return (
    <span className="rounded bg-surface-3 px-1 font-mono text-[10px] font-medium text-ink-2" title={POSITION_LONG[position]}>
      {POSITION_SHORT[position]}
    </span>
  );
}

/** Texto explicativo pequeño bajo un gráfico/tabla. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('mt-2 text-[12px] leading-relaxed text-ink-3', className)}>{children}</p>;
}

/** Resumen de acierto del modelo (✓/✗) sobre una lista de partidos terminados. */
export function HitSummary({ matches }: { matches: MatchSummary[] }) {
  const judged = matches.filter((m) => typeof m.predictionHit === 'boolean');
  if (!judged.length) return null;
  const hits = judged.filter((m) => m.predictionHit).length;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface-2/70 px-3 py-2.5 sm:px-4">
      <span className="text-[13px] text-ink-2">
        El modelo acertó <strong className="font-semibold text-ink-1">{hits}</strong> de <strong className="font-semibold text-ink-1">{judged.length}</strong> pronósticos 1X2
      </span>
      <span className="inline-flex items-center gap-2">
        <span className="font-display text-[22px] font-extrabold leading-none text-ink-1">{pct(hits / judged.length)}</span>
        <span className="hidden gap-[2px] min-[420px]:flex" aria-hidden="true">
          {judged.slice(0, 14).map((m) => (
            <span key={m.id} className={cx('flex h-4 w-4 items-center justify-center rounded-[3px]', m.predictionHit ? 'bg-win text-win-ink' : 'bg-loss text-loss-ink')}>
              {m.predictionHit ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

/** Tarjeta de resultados recientes con acierto del modelo. */
export function ResultsCard({ matches, limit = 8, footer, compact = true }: { matches: MatchSummary[]; limit?: number; footer?: ReactNode; compact?: boolean }) {
  if (!matches.length) return <EmptyState compact icon={<History />} title="Sin resultados recientes" description="No hay partidos terminados en los últimos 30 días." />;
  return (
    <Card pad="none" className="overflow-hidden">
      <HitSummary matches={matches} />
      <ul className="divide-y divide-line/70">
        {matches.slice(0, limit).map((m) => (
          <li key={m.id}>
            <MatchRow match={m} showDate showHit compact={compact} />
          </li>
        ))}
      </ul>
      {footer && <div className="border-t border-line px-3 py-2 sm:px-4">{footer}</div>}
    </Card>
  );
}

/** Lista de jugadores en forma (índice de forma + notas recientes + G/A en últimos 5). */
export function HotPlayersList({ players, limit = 6, showTeam = true }: { players: PlayerSeasonRow[]; limit?: number; showTeam?: boolean }) {
  if (!players.length) return <EmptyState compact icon={<Users />} title="Sin datos de jugadores" />;
  const top = [...players].sort((a, b) => b.formIndex - a.formIndex).slice(0, limit);
  return (
    <Card pad="none" className="overflow-hidden">
      <ol className="divide-y divide-line/70">
        {top.map((p, i) => {
          const l5 = p.last5 ?? [];
          const g5 = sumFinite(l5, (x) => x.goals);
          const a5 = sumFinite(l5, (x) => x.assists);
          return (
            <li key={`${p.player.id}-${p.compId}`} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 sm:px-4">
              <span className="num text-[11px] font-semibold text-ink-3">{i + 1}</span>
              <span className="flex min-w-0 items-center gap-2.5">
                <TeamCrest team={p.team} size={22} />
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-semibold text-ink-1">{p.player.name}</span>
                  <span className="flex items-center gap-1.5 text-2xs text-ink-3">
                    <PositionTag position={p.player.position} />
                    {showTeam && (
                      <Link to={`/t/${p.team.id}`} className="truncate hover:text-ink-1 hover:underline">
                        {p.team.short || p.team.name}
                      </Link>
                    )}
                    {showTeam && <span aria-hidden="true">·</span>}
                    <span className="num shrink-0" title="Goles y asistencias en los últimos 5 partidos">
                      {int(g5)} G · {int(a5)} A <span className="hidden sm:inline">(últ. 5)</span>
                    </span>
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-3">
                <Sparkline values={p.formTrend ?? []} width={56} height={22} domain={[3, 10]} ariaLabel={`Notas recientes de ${p.player.name}`} className="hidden sm:block" />
                <span className="w-[54px]">
                  <span className="num block text-right text-[14px] font-bold text-ink-1">{int(p.formIndex)}</span>
                  <Meter value={p.formIndex / 100} height={4} label={`Índice de forma ${int(p.formIndex)} de 100`} />
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** Media de un array (0 si vacío). */
export function avg(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}

/** Ordinal español corto: 1 → "1.º" */
export function ordinal(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}.º` : '—';
}
