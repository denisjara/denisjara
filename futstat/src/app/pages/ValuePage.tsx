import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgePercent, BookOpen, Coins, Gauge, LayoutGrid, Percent, Table2, Zap } from 'lucide-react';
import { Card, DataTable, Disclaimer, EmptyState, ErrorState, KpiTile, PageHeader, PageSkeleton, Section, SegmentedControl, TeamCrest, matchHref, type Column } from '../components';
import { useMeta, useValue } from '../lib/data';
import { useMediaQuery, useNow } from '../lib/hooks';
import { byTier } from '../lib/competitions';
import { ev as fmtEv, int, kickoff, odds as fmtOdds, pct, plural, signed } from '../lib/format';
import { marketFamily, pickMarketLabel, pickSelection } from '../lib/picks';
import { ProbVsImplied, ValueCard, minOddsFor, startedLabel, type ValueItem } from './extra/ValueCard';
import { ResponsibleBanner, ValueCalculator, ValueConcepts, valueSettings } from './extra/ValueExplainer';
import { ConfidenceTag, FilterField, SelectInput, ToggleSwitch, useUrlParam, type SelectOption } from './extra/ui';

const PAGE = 24;
const PAGE_MOBILE = 10;
const CONF_RANK = { alta: 3, media: 2, baja: 1 } as const;

type SortKey = 'ev' | 'edge' | 'kelly' | 'prob' | 'odds' | 'date';
const SORT_OPTIONS: SelectOption[] = [
  { value: 'ev', label: 'Mayor EV' },
  { value: 'edge', label: 'Mayor ventaja' },
  { value: 'kelly', label: 'Mayor stake' },
  { value: 'prob', label: 'Más probable' },
  { value: 'odds', label: 'Cuota más alta' },
  { value: 'date', label: 'Próximos primero' },
];
const sortFn: Record<SortKey, (a: ValueItem, b: ValueItem) => number> = {
  ev: (a, b) => b.pick.ev - a.pick.ev,
  edge: (a, b) => b.pick.edge - a.pick.edge,
  kelly: (a, b) => b.pick.kelly - a.pick.kelly,
  prob: (a, b) => b.pick.prob - a.pick.prob,
  odds: (a, b) => b.pick.odds - a.pick.odds,
  date: (a, b) => a.match.date.localeCompare(b.match.date),
};
const TABLE_SORT_KEY: Record<SortKey, string> = { ev: 'ev', edge: 'edge', kelly: 'stake', prob: 'prob', odds: 'odds', date: 'match' };

const keyOf = (it: ValueItem) => `${it.match.id}-${it.pick.marketId}-${it.pick.selection}`;
const isStarted = (it: ValueItem, now: number) => it.match.status !== 'scheduled' || Date.parse(it.match.date) <= now;

export default function ValuePage() {
  const { data, error, loading, reload } = useValue();
  const { data: meta } = useMeta();
  const now = useNow(60_000).getTime();
  const desktop = useMediaQuery('(min-width: 1024px)');

  const [comp, setComp] = useUrlParam('comp', 'all');
  const [market, setMarket] = useUrlParam('mercado', 'all');
  const [minEvKey, setMinEvKey] = useState('base');
  const [conf, setConf] = useState<'all' | 'media' | 'alta'>('all');
  const [sort, setSort] = useState<SortKey>('ev');
  const [hideStarted, setHideStarted] = useState(true);
  const [view, setView] = useState<'cards' | 'table' | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const viewMode = view ?? (desktop ? 'table' : 'cards');
  const pageSize = desktop ? PAGE : PAGE_MOBILE;

  const bets = useMemo<ValueItem[]>(() => (data?.bets ?? []).filter((b) => b && b.match && b.pick), [data]);
  const settings = useMemo(() => valueSettings(data), [data]);
  const baseMinEv = settings.minEv;
  const kellyFraction = settings.kellyFraction;

  const evSteps = useMemo(() => [baseMinEv, ...[0.1, 0.15, 0.25].filter((x) => x > baseMinEv + 1e-9)], [baseMinEv]);
  const minEv = minEvKey === 'base' ? baseMinEv : Number(minEvKey);

  const pool = useMemo(() => (hideStarted ? bets.filter((b) => !isStarted(b, now)) : bets), [bets, hideStarted, now]);

  const compOptions = useMemo<SelectOption[]>(() => {
    const counts = new Map<string, number>();
    const names = new Map<string, string>();
    for (const b of pool) {
      counts.set(b.match.compId, (counts.get(b.match.compId) ?? 0) + 1);
      names.set(b.match.compId, b.match.compName);
    }
    const known = (meta?.competitions ?? []).filter((c) => counts.has(c.id)).sort(byTier);
    const knownIds = new Set(known.map((c) => c.id));
    return [
      { value: 'all', label: 'Todas las competiciones', count: pool.length },
      ...known.map((c) => ({ value: c.id, label: `${c.flag} ${c.name}`, count: counts.get(c.id) })),
      ...[...counts.keys()].filter((id) => !knownIds.has(id)).map((id) => ({ value: id, label: names.get(id) ?? id, count: counts.get(id) })),
    ];
  }, [pool, meta]);
  const compValue = compOptions.some((o) => o.value === comp) ? comp : 'all';

  const byComp = useMemo(() => (compValue === 'all' ? pool : pool.filter((b) => b.match.compId === compValue)), [pool, compValue]);

  const marketOptions = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const b of byComp) {
      const fam = marketFamily(b.pick);
      const cur = m.get(fam.key);
      if (cur) cur.count++;
      else m.set(fam.key, { label: fam.label, count: 1 });
    }
    // familias ordenadas por número de picks (las más frecuentes primero)
    const fams = [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label, 'es'));
    return [{ value: 'all', label: 'Todos', count: byComp.length }, ...fams.map(([value, v]) => ({ value, label: v.label, count: v.count }))];
  }, [byComp]);
  const marketValue = marketOptions.some((o) => o.value === market) ? market : 'all';

  const filtered = useMemo(() => {
    const out = byComp.filter(
      (b) =>
        (marketValue === 'all' || marketFamily(b.pick).key === marketValue) &&
        b.pick.ev >= minEv - 1e-9 &&
        (conf === 'all' || CONF_RANK[b.pick.confidence] >= CONF_RANK[conf]),
    );
    // los partidos ya empezados (si se muestran) van al final
    return out.sort((a, b) => Number(isStarted(a, now)) - Number(isStarted(b, now)) || sortFn[sort](a, b) || b.pick.ev - a.pick.ev);
  }, [byComp, marketValue, minEv, conf, sort, now]);

  useEffect(() => setLimit(pageSize), [compValue, marketValue, minEv, conf, sort, hideStarted, pageSize]);

  const stats = useMemo(() => {
    const n = filtered.length;
    if (!n) return null;
    const mean = (f: (x: ValueItem) => number) => filtered.reduce((s, x) => s + f(x), 0) / n;
    const evs = filtered.map((x) => x.pick.ev).sort((a, b) => a - b);
    return {
      n,
      matches: new Set(filtered.map((x) => x.match.id)).size,
      ev: mean((x) => x.pick.ev),
      evMedian: evs[Math.floor((n - 1) / 2)],
      odds: mean((x) => x.pick.odds),
      prob: mean((x) => x.pick.prob),
      kelly: mean((x) => x.pick.kelly),
      alta: filtered.filter((x) => x.pick.confidence === 'alta').length,
    };
  }, [filtered]);

  const example = filtered[0] ?? pool[0] ?? bets[0];
  const globalBest = useMemo(() => [...bets].sort((a, b) => b.pick.ev - a.pick.ev)[0], [bets]);

  if (loading && !data) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;

  const startedCount = bets.filter((b) => isStarted(b, now)).length;

  const columns: Column<ValueItem>[] = [
    {
      key: 'match',
      header: 'Partido',
      sticky: true,
      sortValue: (r) => r.match.date,
      firstDir: 'asc',
      className: 'min-w-[190px] max-w-[250px]',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex shrink-0 -space-x-1.5">
            <TeamCrest team={r.match.home} size={20} className="ring-2 ring-surface-1" />
            <TeamCrest team={r.match.away} size={20} className="ring-2 ring-surface-1" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-ink-1" title={`${r.match.home.name} – ${r.match.away.name}`}>
              {r.match.home.short || r.match.home.name} – {r.match.away.short || r.match.away.name}
            </span>
            <span className="block truncate text-2xs text-ink-3">
              {meta?.competitions.find((c) => c.id === r.match.compId)?.flag ?? '⚽'} {r.match.compName} · {isStarted(r, now) ? startedLabel(r.match) : kickoff(r.match.date)}
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'sel',
      header: 'Selección',
      sortValue: (r) => r.pick.selection,
      className: 'min-w-[130px] max-w-[190px]',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="flex items-center gap-1.5 font-semibold text-ink-1">
            <Zap className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
            <span className="truncate">{pickSelection(r.pick)}</span>
          </span>
          <span className="block truncate text-2xs text-ink-3">{pickMarketLabel(r.pick)}</span>
        </span>
      ),
    },
    {
      key: 'prob',
      header: 'Prob.',
      title: 'Probabilidad del modelo frente a la implícita en la cuota',
      numeric: true,
      sortValue: (r) => r.pick.prob,
      className: 'min-w-[124px]',
      cell: (r) => <ProbVsImplied compact prob={r.pick.prob} odds={r.pick.odds} edge={r.pick.edge} />,
    },
    { key: 'odds', header: 'Cuota', title: 'Cuota del mercado (decimal)', numeric: true, sortValue: (r) => r.pick.odds, cell: (r) => <span className="text-[14px] font-semibold text-ink-1">{fmtOdds(r.pick.odds)}</span> },
    { key: 'fair', header: 'Justa', title: 'Cuota justa del modelo (1 / probabilidad)', numeric: true, hideBelow: 'lg', sortValue: (r) => r.pick.fairOdds, firstDir: 'asc', cell: (r) => fmtOdds(r.pick.fairOdds) },
    {
      key: 'min',
      header: 'Mín.',
      title: `Cuota mínima para mantener un EV ≥ ${pct(baseMinEv)}`,
      numeric: true,
      hideBelow: 'md',
      sortValue: (r) => minOddsFor(r.pick.prob, baseMinEv),
      firstDir: 'asc',
      cell: (r) => <span className="text-ink-2">{fmtOdds(minOddsFor(r.pick.prob, baseMinEv))}</span>,
    },
    { key: 'ev', header: 'EV', title: 'Valor esperado por unidad apostada', numeric: true, sortValue: (r) => r.pick.ev, cell: (r) => <span className="font-semibold text-pos">{fmtEv(r.pick.ev)}</span> },
    { key: 'edge', header: 'Ventaja', title: 'Probabilidad del modelo menos la implícita (puntos porcentuales)', numeric: true, hideBelow: 'md', sortValue: (r) => r.pick.edge, cell: (r) => `${signed(r.pick.edge * 100, 1)} pp` },
    { key: 'stake', header: 'Stake', title: 'Stake Kelly fraccional (% de la banca)', numeric: true, sortValue: (r) => r.pick.kelly, cell: (r) => pct(r.pick.kelly, 1) },
    { key: 'conf', header: 'Conf.', title: 'Confianza del modelo', sortValue: (r) => CONF_RANK[r.pick.confidence], firstDir: 'desc', cell: (r) => <ConfidenceTag level={r.pick.confidence} /> },
  ];

  const visible = filtered.slice(0, limit);
  const compLabel = compValue === 'all' ? '' : ` en ${meta?.competitions.find((c) => c.id === compValue)?.name ?? compValue}`;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Valor esperado · actualizado a diario"
        title="Apuestas de valor"
        description={`Selecciones en las que la probabilidad del modelo supera la implícita en la cuota con un valor esperado de al menos ${pct(baseMinEv)}. Stake orientativo con Kelly ${kellyFraction === 0.25 ? '¼' : pct(kellyFraction)} (máximo ${pct(settings.kellyCap)} de la banca por pick).`}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12.5px] text-ink-2">
          <span>
            <strong className="num font-semibold text-ink-1">{int(bets.length)}</strong> picks publicados
          </span>
          {startedCount > 0 && (
            <span>
              <strong className="num font-semibold text-ink-1">{int(startedCount)}</strong> ya empezados
            </span>
          )}
          <button
            type="button"
            className="link text-[12.5px]"
            onClick={() => document.getElementById('como-funciona')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            ¿Qué es el EV y el stake Kelly?
          </button>
        </div>
      </PageHeader>

      <ResponsibleBanner />

      {bets.length === 0 ? (
        <EmptyState
          icon={<BadgePercent />}
          title="Sin apuestas de valor"
          description="Hoy ninguna cuota disponible supera el umbral de valor esperado del modelo. Es normal: el mercado suele estar bien ajustado."
          action={
            <Link to="/partidos" className="btn">
              Ver calendario
            </Link>
          }
        />
      ) : (
        <>
          <Card pad="md" className="space-y-3">
            <div className="flex flex-wrap items-end gap-x-5 gap-y-3" role="group" aria-label="Filtros de apuestas de valor">
              <FilterField label="Competición" htmlFor="val-comp" className="w-full sm:w-auto">
                <SelectInput id="val-comp" value={compValue} onChange={setComp} options={compOptions} className="w-full sm:w-[250px]" />
              </FilterField>
              <FilterField label="Mercado" className="max-w-full">
                <SegmentedControl ariaLabel="Mercado" size="sm" value={marketValue} onChange={setMarket} options={marketOptions} className="max-w-full overflow-x-auto scrollbar-none" />
              </FilterField>
              <FilterField label="EV mínimo" className="max-w-full">
                <SegmentedControl
                  ariaLabel="Valor esperado mínimo"
                  size="sm"
                  value={minEvKey}
                  onChange={setMinEvKey}
                  options={evSteps.map((x, i) => ({ value: i === 0 ? 'base' : String(x), label: `+${pct(x)}` }))}
                />
              </FilterField>
              <FilterField label="Confianza" className="max-w-full">
                <SegmentedControl
                  ariaLabel="Confianza mínima"
                  size="sm"
                  value={conf}
                  onChange={setConf}
                  options={[
                    { value: 'all', label: 'Todas' },
                    { value: 'media', label: 'Media o alta' },
                    { value: 'alta', label: 'Alta' },
                  ]}
                />
              </FilterField>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line pt-3">
              <span className="inline-flex items-center gap-2">
                <label htmlFor="val-sort" className="text-[12.5px] text-ink-3">
                  Ordenar
                </label>
                <SelectInput id="val-sort" value={sort} onChange={(v) => setSort(v as SortKey)} options={SORT_OPTIONS} className="w-[170px]" />
              </span>
              <ToggleSwitch checked={hideStarted} onChange={setHideStarted} label="Ocultar partidos empezados" />
              <SegmentedControl
                ariaLabel="Vista"
                size="sm"
                value={viewMode}
                onChange={(v) => setView(v)}
                className="ml-auto"
                options={[
                  {
                    value: 'cards',
                    label: (
                      <>
                        <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> Tarjetas
                      </>
                    ),
                  },
                  {
                    value: 'table',
                    label: (
                      <>
                        <Table2 className="h-3.5 w-3.5" aria-hidden="true" /> Tabla
                      </>
                    ),
                  },
                ]}
              />
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-live="polite">
            <KpiTile label="Picks" value={int(stats?.n ?? 0)} hint={stats ? `En ${plural(stats.matches, 'partido')}${compLabel}` : 'Ninguno con estos filtros'} icon={<Zap />} />
            <KpiTile label="EV medio" value={stats ? fmtEv(stats.ev) : '—'} hint={stats ? `Mediana ${fmtEv(stats.evMedian)}` : undefined} icon={<Percent />} accent />
            <KpiTile label="Cuota media" value={stats ? fmtOdds(stats.odds) : '—'} hint={stats ? `Prob. media del modelo ${pct(stats.prob)}` : undefined} icon={<Coins />} />
            <KpiTile
              label="Stake medio"
              value={stats ? pct(stats.kelly, 1) : '—'}
              hint={stats ? `de la banca · ${plural(stats.alta, 'pick', 'picks')} de confianza alta` : undefined}
              icon={<Gauge />}
            />
          </div>

          <Section
            id="picks"
            eyebrow={`${plural(filtered.length, 'selección', 'selecciones')}`}
            title="Picks de valor"
            icon={<Zap />}
            description="Prob. = barra del modelo frente a la marca de la probabilidad implícita en la cuota. «Mín.» es la cuota más baja a la que el pick mantiene el valor mínimo."
          >
            {filtered.length === 0 ? (
              <EmptyState
                icon={<BadgePercent />}
                title="Ningún pick con estos filtros"
                description={hideStarted && startedCount > 0 && pool.length === 0 ? 'Todos los partidos con valor ya han empezado. Vuelve tras la próxima actualización.' : 'Prueba a bajar el EV mínimo o la confianza, o elige otra competición.'}
              />
            ) : viewMode === 'table' ? (
              <DataTable
                key={sort}
                columns={columns}
                rows={filtered}
                rowKey={keyOf}
                caption={`Apuestas de valor${compLabel}, ${filtered.length} selecciones`}
                initialSort={{ key: TABLE_SORT_KEY[sort], dir: sort === 'date' ? 'asc' : 'desc' }}
                rowHref={(r) => matchHref(r.match)}
                rowClassName={(r) => (isStarted(r, now) ? 'opacity-60' : undefined)}
                maxHeight="min(78vh, 760px)"
              />
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                  {visible.map((it) => (
                    <ValueCard key={keyOf(it)} item={it} minEv={baseMinEv} started={isStarted(it, now)} />
                  ))}
                </div>
                {filtered.length > visible.length && (
                  <div className="mt-4 flex justify-center">
                    <button type="button" className="btn" onClick={() => setLimit((l) => l + pageSize)}>
                      Mostrar {int(Math.min(pageSize, filtered.length - visible.length))} más
                    </button>
                  </div>
                )}
              </>
            )}
          </Section>
        </>
      )}

      <Section
        id="como-funciona"
        eyebrow="Explicación"
        title="Cómo funciona"
        icon={<BookOpen />}
        description={`Un pick tiene valor cuando la cuota paga más de lo que el riesgo merece según el modelo. Ejemplo calculado con ${example ? 'el primer pick de la lista' : 'valores ilustrativos'}.`}
      >
        <div className="space-y-4">
          <ValueConcepts example={example} settings={settings} />
          <ValueCalculator key={globalBest ? keyOf(globalBest) : 'none'} example={globalBest} settings={settings} />
        </div>
      </Section>

      <Disclaimer />
    </div>
  );
}
