/**
 * Utilidades sobre CompetitionMeta: agrupación del menú (Ligas Europa/América/Otras,
 * Competiciones continentales/copas), etiquetas y orden.
 */
import type { CompetitionKind, CompetitionMeta, MatchSummary } from '../../types/data';

const EUROPE = new Set([
  'España', 'Inglaterra', 'Italia', 'Alemania', 'Francia', 'Países Bajos', 'Portugal', 'Turquía', 'Escocia', 'Bélgica',
  'Grecia', 'Austria', 'Suiza', 'Dinamarca', 'Noruega', 'Suecia', 'Polonia', 'Croacia', 'Serbia', 'Rusia', 'Ucrania',
  'Chequia', 'República Checa', 'Rumanía', 'Irlanda', 'Gales', 'Europa',
]);
const AMERICAS = new Set([
  'Brasil', 'Argentina', 'México', 'EE. UU.', 'Estados Unidos', 'Chile', 'Colombia', 'Uruguay', 'Perú', 'Ecuador', 'Paraguay',
  'Bolivia', 'Venezuela', 'Canadá', 'Costa Rica', 'Sudamérica', 'Norteamérica', 'Concacaf',
]);

export type LeagueRegion = 'Europa' | 'América' | 'Otras';
export const LEAGUE_REGIONS: LeagueRegion[] = ['Europa', 'América', 'Otras'];

export function leagueRegion(c: Pick<CompetitionMeta, 'country'>): LeagueRegion {
  if (EUROPE.has(c.country)) return 'Europa';
  if (AMERICAS.has(c.country)) return 'América';
  return 'Otras';
}

export const KIND_LABEL: Record<CompetitionKind, string> = {
  league: 'Liga',
  cup: 'Copa',
  continental: 'Continental',
};

/** Orden de menús: tier desc, luego nombre. */
export function byTier(a: CompetitionMeta, b: CompetitionMeta): number {
  return b.tier - a.tier || a.name.localeCompare(b.name, 'es');
}

export interface NavGroups {
  leagues: { region: LeagueRegion; items: CompetitionMeta[] }[];
  competitions: { label: string; items: CompetitionMeta[] }[];
}

export function groupCompetitions(list: CompetitionMeta[]): NavGroups {
  const leagues = LEAGUE_REGIONS.map((region) => ({
    region,
    items: list.filter((c) => c.kind === 'league' && leagueRegion(c) === region).sort(byTier),
  })).filter((g) => g.items.length > 0);
  const competitions = [
    { label: 'Continentales', items: list.filter((c) => c.kind === 'continental').sort(byTier) },
    { label: 'Copas', items: list.filter((c) => c.kind === 'cup').sort(byTier) },
  ].filter((g) => g.items.length > 0);
  return { leagues, competitions };
}

/** Agrupa partidos por competición conservando el orden de prestigio (tier) y luego cronológico. */
export function groupMatchesByCompetition(
  matches: MatchSummary[],
  comps: CompetitionMeta[] | undefined,
): { compId: string; compName: string; meta?: CompetitionMeta; matches: MatchSummary[] }[] {
  const metaById = new Map((comps ?? []).map((c) => [c.id, c]));
  const groups = new Map<string, MatchSummary[]>();
  for (const m of matches) {
    if (!groups.has(m.compId)) groups.set(m.compId, []);
    groups.get(m.compId)!.push(m);
  }
  return [...groups.entries()]
    .map(([compId, ms]) => ({
      compId,
      compName: metaById.get(compId)?.name ?? ms[0]?.compName ?? compId,
      meta: metaById.get(compId),
      matches: [...ms].sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => (b.meta?.tier ?? 0) - (a.meta?.tier ?? 0) || a.compName.localeCompare(b.compName, 'es'));
}
