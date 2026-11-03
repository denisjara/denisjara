import { useMemo } from 'react';
import { Crosshair, Gauge } from 'lucide-react';
import type { CompetitionFile, TeamRating } from '../../../../types/data';
import { Card, DataTable, EmptyState, Section, Sparkline, type Column } from '../../../components';
import { deltaClass, token } from '../../../lib/colors';
import { int, num, signed } from '../../../lib/format';
import { AttackDefenceScatter } from '../charts';
import { Note, TeamLink } from '../shared';

function eloDelta(r: TeamRating): number | undefined {
  const h = r.eloHistory ?? [];
  return h.length >= 2 ? h[h.length - 1].elo - h[0].elo : undefined;
}

/** Pestaña Ratings: ranking Elo con barras e historia + dispersión ataque vs defensa (Dixon-Coles). */
export function RatingsTab({ data }: { data: CompetitionFile }) {
  const ratings = data.ratings;
  const [lo, hi] = useMemo(() => {
    const es = ratings.map((r) => r.elo).filter((e) => Number.isFinite(e));
    const mn = Math.min(...es);
    const mx = Math.max(...es);
    return [Math.floor((mn - 60) / 50) * 50, mx];
  }, [ratings]);
  const hasDC = ratings.some((r) => typeof r.attack === 'number' && typeof r.defence === 'number');
  const hasGlobal = ratings.some((r) => typeof r.globalEloRank === 'number');

  const cols: Column<TeamRating>[] = [
    { key: 'rank', header: '#', title: 'Posición en el ranking Elo de la competición', numeric: true, cell: (r) => <span className="font-semibold text-ink-1">{r.eloRank}</span>, sortValue: (r) => r.eloRank, firstDir: 'asc', width: 44 },
    { key: 'team', header: 'Equipo', sticky: true, cell: (r) => <TeamLink team={r.team} />, sortValue: (r) => r.team.name, className: 'min-w-[150px] max-w-[220px]' },
    {
      key: 'elo',
      header: 'Elo',
      title: 'Rating Elo actual',
      numeric: true,
      sortValue: (r) => r.elo,
      className: 'min-w-[150px] sm:min-w-[220px]',
      cell: (r) => {
        const w = Math.max(0.02, Math.min(1, (r.elo - lo) / (hi - lo || 1)));
        return (
          <span className="flex items-center justify-end gap-2.5">
            <span className="relative hidden h-1.5 flex-1 sm:block" aria-hidden="true">
              <span className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `${w * 100}%`, background: token('accent-text', 0.7) }} />
            </span>
            <span className="w-11 font-semibold text-ink-1">{int(r.elo)}</span>
          </span>
        );
      },
    },
    {
      key: 'trend',
      header: 'Evolución',
      title: 'Historia reciente del Elo',
      cell: (r) => (
        <Sparkline
          values={(r.eloHistory ?? []).map((h) => h.elo)}
          width={88}
          height={24}
          ariaLabel={`Evolución del Elo de ${r.team.name}`}
        />
      ),
    },
    {
      key: 'delta',
      header: 'Δ',
      title: 'Variación del Elo en el periodo mostrado',
      numeric: true,
      cell: (r) => {
        const d = eloDelta(r);
        return d === undefined ? '–' : <span className={deltaClass(d, 0.5)}>{signed(d, 0)}</span>;
      },
      sortValue: (r) => eloDelta(r),
    },
  ];
  if (hasGlobal) cols.push({ key: 'global', header: 'Global', title: 'Posición en el ranking Elo global (todas las competiciones)', numeric: true, cell: (r) => (r.globalEloRank ? `${r.globalEloRank}.º` : '–'), sortValue: (r) => r.globalEloRank, firstDir: 'asc', hideBelow: 'sm' });
  if (hasDC) {
    cols.push(
      { key: 'att', header: 'Ataque', title: 'Multiplicador de ataque Dixon-Coles (1 = media; más alto, mejor)', numeric: true, cell: (r) => num(r.attack, 2), sortValue: (r) => r.attack },
      { key: 'def', header: 'Defensa', title: 'Multiplicador de defensa Dixon-Coles (1 = media; más bajo, mejor)', numeric: true, cell: (r) => num(r.defence, 2), sortValue: (r) => r.defence, firstDir: 'asc' },
    );
  }

  if (!ratings.length) return <EmptyState icon={<Gauge />} title="Sin ratings" description="Todavía no hay ratings publicados para esta competición." />;

  const points = ratings
    .filter((r) => typeof r.attack === 'number' && typeof r.defence === 'number')
    .map((r) => ({ team: r.team, attack: r.attack!, defence: r.defence!, elo: r.elo }));

  return (
    <div className="space-y-10">
      <Section
        id="ratings-elo"
        eyebrow="Fuerza de los equipos"
        title="Ranking Elo"
        icon={<Gauge />}
        description="Elo estilo World Football: sube al ganar (más si el rival es fuerte o la goleada es amplia) y baja al perder. Calculado de forma cronológica con todas las competiciones."
      >
        <DataTable columns={cols} rows={ratings} rowKey={(r) => r.team.id} caption={`Ranking Elo de ${data.meta.name}`} initialSort={{ key: 'elo', dir: 'desc' }} dense maxHeight={ratings.length > 24 ? 720 : undefined} />
      </Section>

      {hasDC && points.length >= 3 && (
        <Section
          id="ratings-dc"
          eyebrow="Modelo Dixon-Coles"
          title="Ataque vs defensa"
          icon={<Crosshair />}
          description="Cada punto es un equipo. Derecha: marca más que la media; arriba: encaja menos que la media. Pasa el cursor o usa las flechas del teclado para ver el detalle."
        >
          <Card>
            <AttackDefenceScatter points={points} ariaLabel={`Dispersión de ataque frente a defensa de los equipos de ${data.meta.name}`} />
          </Card>
          <Note>
            Ataque = goles que marca el equipo respecto a un rival medio (1,20 = un 20% más que la media). Defensa = goles que concede respecto a la media (0,80 = un
            20% menos). Los valores exactos están en las columnas Ataque y Defensa de la tabla superior.
          </Note>
        </Section>
      )}
    </div>
  );
}
