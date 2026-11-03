import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, ListOrdered, Search, Sparkles, Users, X } from 'lucide-react';
import type { PlayerSeasonRow } from '../../types/data';
import { Card, EmptyState, ErrorState, PageHeader, PageSkeleton, Section, SegmentedControl } from '../components';
import { usePlayers, useMeta } from '../lib/data';
import { useMediaQuery, useReducedMotion } from '../lib/hooks';
import { byTier } from '../lib/competitions';
import { int, normalizeText, plural } from '../lib/format';
import { PlayerLeaders } from './extra/PlayerLeaders';
import { PlayerRankingTable } from './extra/PlayerRankingTable';
import { METRICS, METRIC_BY_KEY, PEER_MIN_MINUTES, buildPeerTable, rowKey, sortPlayers, type Mode, type SortKey } from './extra/players';
import { FilterField, SelectInput, useUrlParam, type SelectOption } from './extra/ui';

const PAGE = 50;
const POS_VALUES = ['all', 'G', 'D', 'M', 'F'] as const;
const POS_LABEL: Record<(typeof POS_VALUES)[number], string> = { all: 'Todos', G: 'POR', D: 'DEF', M: 'MED', F: 'DEL' };
const MIN_VALUES = ['0', '90', '270', '450', '900'] as const;
const P90_FLOOR = PEER_MIN_MINUTES;

export default function PlayersPage() {
  const { data, error, loading, reload } = usePlayers();
  const { data: meta } = useMeta();
  const reduced = useReducedMotion();
  const wide = useMediaQuery('(min-width: 640px)');

  const [comp, setComp] = useUrlParam('comp', 'all');
  const [pos, setPos] = useUrlParam('pos', 'all', POS_VALUES);
  const [minMin, setMinMin] = useUrlParam('min', '0', MIN_VALUES);
  const [mode, setMode] = useState<Mode>('total');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'form', dir: 'desc' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const rankingRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const players = useMemo(() => data?.players ?? [], [data]);
  const minMinutes = Number(minMin) || 0;

  // Competiciones presentes (orden de prestigio) con su nº de jugadores
  const compOptions = useMemo<SelectOption[]>(() => {
    const counts = new Map<string, number>();
    for (const p of players) counts.set(p.compId, (counts.get(p.compId) ?? 0) + 1);
    const known = (meta?.competitions ?? []).filter((c) => counts.has(c.id)).sort(byTier);
    const knownIds = new Set(known.map((c) => c.id));
    const extra = [...counts.keys()].filter((id) => !knownIds.has(id)).sort();
    return [
      { value: 'all', label: 'Todas las competiciones', count: players.length },
      ...known.map((c) => ({ value: c.id, label: `${c.flag} ${c.name}`, count: counts.get(c.id) })),
      ...extra.map((id) => ({ value: id, label: id, count: counts.get(id) })),
    ];
  }, [players, meta]);
  const compValue = compOptions.some((o) => o.value === comp) ? comp : 'all';

  // Filtro de competición + minutos (base de los contadores por posición)
  const byCompMinutes = useMemo(
    () => players.filter((p) => (compValue === 'all' || p.compId === compValue) && (p.minutes ?? 0) >= minMinutes),
    [players, compValue, minMinutes],
  );
  const posCounts = useMemo(() => {
    const c: Record<string, number> = { all: byCompMinutes.length };
    for (const p of byCompMinutes) c[p.player.position] = (c[p.player.position] ?? 0) + 1;
    return c;
  }, [byCompMinutes]);
  const scoped = useMemo(() => (pos === 'all' ? byCompMinutes : byCompMinutes.filter((p) => p.player.position === pos)), [byCompMinutes, pos]);

  const peers = useMemo(() => buildPeerTable(players), [players]);

  const sorted = useMemo(() => {
    const nq = normalizeText(q);
    const found = nq
      ? scoped.filter((p) => normalizeText(p.player.name).includes(nq) || normalizeText(p.team.name).includes(nq) || normalizeText(p.team.short ?? '').includes(nq))
      : scoped;
    return sortPlayers(found, sort.key, sort.dir, mode);
  }, [scoped, q, sort, mode]);

  useEffect(() => setLimit(PAGE), [compValue, pos, minMinutes, q, sort, mode]);

  const p90Floor = Math.max(minMinutes, P90_FLOOR);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  const focusPlayer = (r: PlayerSeasonRow) => {
    setQ(r.player.name);
    setExpanded(rowKey(r));
    requestAnimationFrame(() => rankingRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }));
  };

  if (loading && !data) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  const compLabel = compValue === 'all' ? 'todas las competiciones' : meta?.competitions.find((c) => c.id === compValue)?.name ?? compValue;
  const nComps = compOptions.length - 1;
  const sortMetric = METRICS.some((m) => m.key === sort.key) ? sort.key : '';
  const visible = sorted.slice(0, limit);

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Estado de forma · análisis diario"
        title="Jugadores"
        description={
          players.length
            ? `Ranking de forma de ${int(players.length)} jugadores de ${plural(nComps, 'competición', 'competiciones')}: nota por partido, goles, asistencias, tiros, tarjetas y faltas, en totales o por 90 minutos.`
            : 'Ranking diario de forma: nota por partido, goles, asistencias, tiros, tarjetas y faltas, en totales o por 90 minutos.'
        }
      >
        {players.length > 0 && (
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3" role="group" aria-label="Filtros de jugadores">
          <FilterField label="Competición" htmlFor="jug-comp" className="w-full sm:w-auto">
            <SelectInput id="jug-comp" value={compValue} onChange={setComp} options={compOptions} className="w-full sm:w-[260px]" />
          </FilterField>
          <FilterField label="Posición" className="max-w-full">
            <SegmentedControl
              ariaLabel="Posición"
              size="sm"
              value={pos as (typeof POS_VALUES)[number]}
              onChange={setPos}
              className="max-w-full overflow-x-auto scrollbar-none"
              options={POS_VALUES.map((v) => ({ value: v, label: POS_LABEL[v], count: wide ? posCounts[v] ?? 0 : undefined, disabled: v !== 'all' && !posCounts[v] }))}
            />
          </FilterField>
          <FilterField label="Mínimo de minutos" className="max-w-full">
            <SegmentedControl
              ariaLabel="Mínimo de minutos jugados"
              size="sm"
              value={minMin as (typeof MIN_VALUES)[number]}
              onChange={setMinMin}
              className="max-w-full overflow-x-auto scrollbar-none"
              options={MIN_VALUES.map((v) => ({ value: v, label: v === '0' ? 'Todos' : `${v}'` }))}
            />
          </FilterField>
          <p className="ml-auto pb-1.5 text-[12px] text-ink-3" aria-live="polite">
            {plural(scoped.length, 'jugador', 'jugadores')} en {compLabel}
          </p>
        </div>
        )}
      </PageHeader>

      {players.length === 0 ? (
        <EmptyState icon={<Users />} title="Sin datos de jugadores" description="Las estadísticas individuales se publican cuando hay fichas de partido disponibles. Vuelve tras la próxima actualización diaria." />
      ) : (
        <>
          <Section
            id="destacados"
            eyebrow={compValue === 'all' ? 'Todas las competiciones' : compLabel}
            title="Destacados"
            icon={<Sparkles />}
            description={`Top 5 con los filtros actuales. Las métricas por 90 exigen al menos ${int(p90Floor)} minutos para evitar muestras pequeñas. Pulsa un jugador para verlo en el ranking.`}
          >
            {scoped.length ? (
              <PlayerLeaders players={scoped} p90Floor={p90Floor} onSelect={focusPlayer} />
            ) : (
              <EmptyState compact icon={<Users />} title="Nadie cumple los filtros" description="Prueba con otra posición o con menos minutos mínimos." />
            )}
          </Section>

          <div ref={rankingRef} className="scroll-mt-20">
            <Section
              id="ranking"
              eyebrow="Ranking"
              title="Ranking de forma"
              icon={<ListOrdered />}
              description="Ordena por cualquier métrica (también pulsando la cabecera) y despliega un jugador para ver sus percentiles y sus últimos 5 partidos."
            >
              <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-3">
                <FilterField label="Buscar" htmlFor="jug-q" className="w-full sm:w-[260px]">
                  <span className="relative block">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
                    <input
                      id="jug-q"
                      ref={searchRef}
                      type="search"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Jugador o equipo…"
                      className="input h-[34px] pl-8 pr-8"
                      autoComplete="off"
                    />
                    {q && (
                      <button
                        type="button"
                        onClick={() => {
                          setQ('');
                          searchRef.current?.focus();
                        }}
                        className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-3 hover:text-ink-1"
                        aria-label="Borrar búsqueda"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </FilterField>
                <FilterField label="Ordenar por" htmlFor="jug-sort">
                  <SelectInput
                    id="jug-sort"
                    value={sortMetric}
                    onChange={(v) => v && setSort({ key: v as SortKey, dir: 'desc' })}
                    options={[...(sortMetric ? [] : [{ value: '', label: 'Personalizado' }]), ...METRICS.map((m) => ({ value: m.key, label: m.label }))]}
                    className="w-[180px]"
                  />
                </FilterField>
                <FilterField label="Valores">
                  <SegmentedControl
                    ariaLabel="Valores totales o por 90 minutos"
                    size="sm"
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: 'total', label: 'Totales' },
                      { value: 'p90', label: 'Por 90' },
                    ]}
                  />
                </FilterField>
                <p className="ml-auto pb-1.5 text-[12px] text-ink-3" aria-live="polite">
                  {sorted.length === scoped.length ? plural(sorted.length, 'jugador', 'jugadores') : `${int(sorted.length)} de ${plural(scoped.length, 'jugador', 'jugadores')}`}
                  {' · '}por {METRIC_BY_KEY[sort.key as keyof typeof METRIC_BY_KEY]?.label.toLowerCase() ?? (sort.key === 'name' ? 'nombre' : sort.key === 'apps' ? 'partidos' : 'minutos')}
                  {mode === 'p90' && sort.key !== 'form' && sort.key !== 'name' && sort.key !== 'apps' && sort.key !== 'minutes' ? ' /90' : ''}
                </p>
              </div>

              <PlayerRankingTable
                rows={visible}
                mode={mode}
                sort={sort}
                onSort={onSort}
                expanded={expanded}
                onToggle={(k) => setExpanded((e) => (e === k ? null : k))}
                peers={peers}
                caption={`Ranking de jugadores (${mode === 'p90' ? 'por 90 minutos' : 'totales'}) en ${compLabel}`}
                maxHeight="min(80vh, 820px)"
                showComp={compValue === 'all'}
              />

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] text-ink-3">
                  Mostrando {int(visible.length)} de {int(sorted.length)}. {mode === 'p90' ? 'Valores por 90 minutos jugados.' : 'TaP = tiros a puerta; rojas junto a las tarjetas.'}
                </p>
                {sorted.length > visible.length && (
                  <button type="button" className="btn" onClick={() => setLimit((l) => l + PAGE)}>
                    Mostrar {int(Math.min(PAGE, sorted.length - visible.length))} más
                  </button>
                )}
              </div>
            </Section>
          </div>

          <Card className="flex gap-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
            <div className="space-y-1.5 text-[12.5px] leading-relaxed text-ink-2">
              <p>
                <strong className="text-ink-1">Nota por partido (0-10):</strong> parte de 6,0 y suma +1,2 por gol, +0,8 por asistencia, +0,3 por tiro a puerta y +0,1
                por tiro; resta 0,3 por amarilla y 1,5 por roja. Los porteros suman paradas y portería a cero y restan goles encajados. El efecto se escala por los minutos
                jugados.
              </p>
              <p>
                <strong className="text-ink-1">Índice de forma (0-100):</strong> media exponencial (más peso a lo reciente) de las notas de los últimos 5 partidos de su
                equipo —un partido sin jugar cuenta como 0— más un bonus por minutos disputados. En la línea de tendencia, los puntos huecos en la base son partidos que no
                jugó.
              </p>
              <p className="text-ink-3">
                Fuente: fichas públicas de partido (ESPN). No incluye xG, pases clave ni datos de tracking; las cifras por 90 de jugadores con pocos minutos son muy
                volátiles.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
