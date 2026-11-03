import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Search, Store, X, Zap } from 'lucide-react';
import type { Market, MarketSelection, MatchFile, MatchSummary } from '../../../types/data';
import { Card, EmptyState, OddsButton, cx } from '../../components';
import { ev as fmtEv, fairOddsFromProb, normalizeText, odds as fmtOdds, pct } from '../../lib/format';
import {
  GROUP_ORDER,
  bestEv,
  buildEntries,
  fmtLine,
  isShortNote,
  localizeNumbers,
  mainLineIndex,
  marketLine,
  selectionLabel,
  stripLine,
  type MarketEntry,
} from './utils';

interface TabProps {
  file: MatchFile;
  match: MatchSummary;
}

const VALUE_EV = 0.05;
type GroupFilter = 'Todos' | (typeof GROUP_ORDER)[number];

function gridCols(n: number): string {
  if (n === 2) return 'grid-cols-2';
  if (n === 3) return 'grid-cols-3';
  if (n === 4) return 'grid-cols-2 sm:grid-cols-4';
  if (n === 6 || n === 9) return 'grid-cols-2 sm:grid-cols-3';
  return 'grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4';
}

/** Selecciones de un mercado como botones de cuota (con notas largas aparte). */
function Selections({ market, match, inFamily }: { market: Market; match: MatchSummary; inFamily?: boolean }) {
  const sels = market.selections ?? [];
  if (!sels.length) return <p className="text-[12px] text-ink-3">Sin selecciones</p>;
  const topIdx = sels.reduce((b, s, i) => (s.prob > sels[b].prob ? i : b), 0);
  const withOdds = sels.some((s) => typeof s.marketOdds === 'number' && s.marketOdds > 1);
  // Mercados largos sin cuota de la casa: botones compactos (sin la línea repetida "Cuota justa del modelo").
  const compact = !withOdds && sels.length >= 3;
  const longNotes = sels.filter((s) => s.note && !isShortNote(s.note));
  const uniqueNotes = [...new Set(longNotes.map((s) => s.note!))];
  const sharedNote = uniqueNotes.length === 1 && longNotes.length === sels.length;
  // Las notas por selección solo aportan en familias (hándicap: gana/medio gana/pierde) o mercados cortos.
  const showNotes = sharedNote || inFamily || sels.length <= 3;
  return (
    <>
      <div className={cx('grid gap-2', gridCols(sels.length))}>
        {sels.map((s: MarketSelection, i) => (
          <OddsButton
            key={`${s.label}-${i}`}
            label={isShortNote(s.note) ? `${s.note} · ${selectionLabel(s.label, match)}` : selectionLabel(s.label, match)}
            prob={s.prob}
            fairOdds={s.fairOdds}
            marketOdds={s.marketOdds}
            ev={s.ev}
            highlight={sels.length > 1 && i === topIdx}
            valueThreshold={VALUE_EV}
            compact={compact}
          />
        ))}
      </div>
      {showNotes && uniqueNotes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-2xs leading-snug text-ink-3">
          {sharedNote ? (
            <li>{localizeNumbers(uniqueNotes[0])}</li>
          ) : (
            longNotes.map((s, i) => (
              <li key={i}>
                <span className="text-ink-2">{selectionLabel(s.label, match)}:</span> {localizeNumbers(s.note!)}
              </li>
            ))
          )}
        </ul>
      )}
    </>
  );
}

/** Familia de líneas (O/U, hándicap): selector de línea + botones + tabla de todas las líneas. */
function LineFamily({ entry, match }: { entry: MarketEntry; match: MatchSummary }) {
  const [idx, setIdx] = useState(() => mainLineIndex(entry.markets));
  const [showAll, setShowAll] = useState(false);
  const tableId = useId();
  const markets = entry.markets;
  const current = markets[Math.min(idx, markets.length - 1)];
  const signedLines = markets.some((m) => (marketLine(m) ?? 0) < 0);
  const headers = (markets[0]?.selections ?? []).map((s) => selectionLabel(stripLine(s.label), match) || s.label);
  const hasMarketOdds = markets.some((m) => m.selections.some((s) => typeof s.marketOdds === 'number'));
  const main = mainLineIndex(markets);
  const railRef = useRef<HTMLDivElement>(null);
  // Centra la línea activa dentro del carril (sin mover la página).
  useEffect(() => {
    const rail = railRef.current;
    const el = rail?.children[idx] as HTMLElement | undefined;
    if (!rail || !el) return;
    rail.scrollLeft = Math.max(0, el.offsetLeft - rail.clientWidth / 2 + el.offsetWidth / 2);
  }, [idx]);
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="shrink-0 text-2xs font-medium text-ink-3">Línea</span>
        <div ref={railRef} role="radiogroup" aria-label={`Línea de ${entry.title}`} className="scrollbar-none mask-fade-x relative -mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 py-0.5">
          {markets.map((m, i) => {
            const l = marketLine(m);
            const active = i === idx;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setIdx(i)}
                className={cx(
                  'num shrink-0 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors',
                  active ? 'border-accent-text bg-accent/15 text-ink-1' : 'border-line bg-surface-2 text-ink-2 hover:border-line-strong hover:text-ink-1',
                )}
              >
                {l === undefined ? m.name : fmtLine(l, signedLines)}
                {i === main && hasMarketOdds && <span className="sr-only"> (línea de la casa)</span>}
                {i === main && hasMarketOdds && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-accent-text align-middle" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
      <Selections market={current} match={match} inFamily />
      <button type="button" className="btn-ghost -ml-2 mt-2 text-[12px]" aria-expanded={showAll} aria-controls={tableId} onClick={() => setShowAll((v) => !v)}>
        <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', showAll && 'rotate-180')} aria-hidden="true" />
        {showAll ? 'Ocultar todas las líneas' : `Ver las ${markets.length} líneas`}
      </button>
      <div id={tableId} hidden={!showAll} className="relative mt-1 overflow-x-auto rounded-lg border border-line">
        {showAll && (
          <table className="w-full min-w-[280px] text-[12.5px]">
            <caption className="sr-only">Todas las líneas de {entry.title}: probabilidad y cuota justa</caption>
            <thead className="bg-surface-2 text-2xs uppercase tracking-[0.06em] text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-semibold">Línea</th>
                {headers.map((h, i) => (
                  <th key={i} scope="col" className="px-3 py-1.5 text-right font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets.map((m, i) => (
                <tr key={m.id} className={cx('border-t border-line/70', i === idx && 'bg-accent/10')}>
                  <th scope="row" className="num px-3 py-1.5 text-left font-medium text-ink-1">
                    <button type="button" className="hover:text-accent-text" onClick={() => setIdx(i)} aria-label={`Seleccionar línea ${fmtLine(marketLine(m) ?? 0, signedLines)}`}>
                      {fmtLine(marketLine(m) ?? 0, signedLines)}
                    </button>
                  </th>
                  {m.selections.map((s, j) => (
                    <td key={j} className="num px-3 py-1.5 text-right">
                      <span className="text-ink-1">{pct(s.prob)}</span>
                      <span className="ml-1.5 text-ink-3">@{fmtOdds(s.fairOdds ?? (s.prob > 0 ? 1 / s.prob : undefined))}</span>
                      {typeof s.marketOdds === 'number' && (
                        <span className={cx('ml-1.5', typeof s.ev === 'number' && s.ev > 0 ? 'text-pos' : 'text-ink-2')}>
                          {fmtOdds(s.marketOdds)} ({fmtEv(s.ev)})
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MarketCard({ entry, match, open, onToggle }: { entry: MarketEntry; match: MatchSummary; open: boolean; onToggle: () => void }) {
  const bodyId = useId();
  const best = bestEv(entry.markets);
  const value = best !== undefined && best >= VALUE_EV;
  const single = entry.markets[0];
  const withOdds = entry.markets.some((m) => m.selections.some((x) => typeof x.marketOdds === 'number'));
  const count = `${entry.family ? `${entry.markets.length} líneas` : `${single.selections.length} opciones`}${withOdds ? ' · con cuota de la casa' : ' · cuota justa'}`;
  const preview = !entry.family && single.selections.length <= 3 ? single.selections : undefined;
  return (
    <Card pad="none" className={cx('mb-3 break-inside-avoid', value && 'border-accent-text/40')}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex w-full items-center gap-3 rounded-card px-3.5 py-3 text-left transition-colors hover:bg-surface-2/70"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold text-ink-1" title={entry.title}>
              {entry.title}
            </span>
            <span className="mt-0.5 flex items-center gap-2 text-2xs text-ink-3">
              <span>{count}</span>
              {!open && preview && (
                <span className="num hidden truncate sm:inline">
                  ·{' '}
                  {preview
                    .map((s) => fairOddsFromProb(s.prob))
                    .join(' · ')}
                </span>
              )}
            </span>
          </span>
          {value && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-ink">
              <Zap className="h-3 w-3" aria-hidden="true" /> Valor {fmtEv(best)}
            </span>
          )}
          <ChevronDown className={cx('h-4 w-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </button>
      </h3>
      <div id={bodyId} hidden={!open} className="border-t border-line/70 px-3.5 pb-3.5 pt-3">
        {open && (entry.family ? <LineFamily entry={entry} match={match} /> : <Selections market={single} match={match} />)}
      </div>
    </Card>
  );
}

function defaultOpen(entries: MarketEntry[]): Set<string> {
  const open = new Set<string>();
  const seen = new Map<string, number>();
  for (const e of entries) {
    const n = seen.get(e.group) ?? 0;
    seen.set(e.group, n + 1);
    if (e.group === 'Principales' || n < 2) open.add(e.key);
  }
  return open;
}

export function MarketsTab({ file, match }: TabProps) {
  const entries = useMemo(() => buildEntries(file.markets ?? [], match), [file.markets, match]);
  const [group, setGroup] = useState<GroupFilter>('Todos');
  const [query, setQuery] = useState('');
  const [onlyValue, setOnlyValue] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => defaultOpen(entries));
  const [searchClosed, setSearchClosed] = useState<Set<string>>(() => new Set());

  const groups = useMemo(() => {
    const present = new Set(entries.map((e) => e.group));
    const known = GROUP_ORDER.filter((g) => present.has(g));
    return known;
  }, [entries]);

  const q = normalizeText(query);
  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (group !== 'Todos' && e.group !== group) return false;
        if (onlyValue && !((bestEv(e.markets) ?? -1) >= VALUE_EV)) return false;
        if (!q) return true;
        const hay = normalizeText(
          [e.title, e.group, ...e.markets.flatMap((m) => [m.name, ...m.selections.map((s) => `${s.label} ${s.note ?? ''}`)])].join(' '),
        );
        return q.split(/\s+/).every((w) => hay.includes(w));
      }),
    [entries, group, onlyValue, q],
  );

  const valueCount = entries.filter((e) => (bestEv(e.markets) ?? -1) >= VALUE_EV).length;
  // Con búsqueda o filtro de valor, los resultados se abren todos (salvo los que el usuario cierre).
  const searching = q.length > 0 || onlyValue;
  const isOpen = (key: string) => (searching ? !searchClosed.has(key) : open.has(key));
  const flip = (s: Set<string>, key: string) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    return n;
  };
  const toggle = (key: string) => (searching ? setSearchClosed((s) => flip(s, key)) : setOpen((s) => flip(s, key)));
  const allOpen = filtered.length > 0 && filtered.every((e) => isOpen(e.key));
  const toggleAll = () => {
    if (searching) setSearchClosed(allOpen ? new Set(filtered.map((e) => e.key)) : new Set());
    else setOpen(allOpen ? new Set() : new Set([...open, ...filtered.map((e) => e.key)]));
  };
  const hasOdds = entries.some((e) => e.markets.some((m) => m.selections.some((s) => typeof s.marketOdds === 'number')));

  if (!entries.length) {
    return <EmptyState icon={<Store />} title="Sin mercados" description="El modelo no ha publicado mercados para este partido." />;
  }

  const sections = group === 'Todos' ? groups.filter((g) => filtered.some((e) => e.group === g)) : [group];

  return (
    <div className="space-y-5">
      {/* Filtros: una fila encima de todo lo que filtran */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-60">
            <span className="sr-only">Buscar mercado o selección</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchClosed(new Set());
              }}
              placeholder="Buscar mercado o selección (p. ej. «córners», «2-1», «hándicap»)"
              className="input pl-9 pr-9"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-3 hover:text-ink-1" aria-label="Borrar búsqueda">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </label>
          {hasOdds && (
            <button
              type="button"
              aria-pressed={onlyValue}
              onClick={() => setOnlyValue((v) => !v)}
              className={cx('btn', onlyValue && 'border-accent-text bg-accent/15')}
            >
              <Zap className={cx('h-4 w-4', onlyValue ? 'text-accent-text' : 'text-ink-3')} aria-hidden="true" />
              Solo valor
              <span className="num rounded bg-surface-3 px-1 text-2xs text-ink-2">{valueCount}</span>
            </button>
          )}
          <button
            type="button"
            className="btn"
            aria-label={allOpen ? 'Contraer todos los mercados' : 'Expandir todos los mercados'}
            onClick={toggleAll}
          >
            {allOpen ? <ChevronsDownUp className="h-4 w-4" aria-hidden="true" /> : <ChevronsUpDown className="h-4 w-4" aria-hidden="true" />}
            <span className="hidden sm:inline">{allOpen ? 'Contraer todo' : 'Expandir todo'}</span>
            <span className="sm:hidden">{allOpen ? 'Contraer' : 'Expandir'}</span>
          </button>
        </div>
        <div role="group" aria-label="Filtrar por grupo de mercados" className="scrollbar-none mask-fade-x relative -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5">
          {(['Todos', ...groups] as GroupFilter[]).map((g) => {
            const n = g === 'Todos' ? entries.length : entries.filter((e) => e.group === g).length;
            const active = g === group;
            return (
              <button
                key={g}
                type="button"
                aria-pressed={active}
                onClick={() => setGroup(g)}
                className={cx(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                  active ? 'border-accent-text bg-accent text-accent-ink' : 'border-line bg-surface-2 text-ink-2 hover:border-line-strong hover:text-ink-1',
                )}
              >
                {g}
                <span className={cx('num text-2xs', active ? 'text-accent-ink/80' : 'text-ink-3')}>{n}</span>
              </button>
            );
          })}
        </div>
        <p className="sr-only" aria-live="polite">
          {filtered.length} mercados mostrados
        </p>
        <p className="text-[12px] text-ink-3">
          Cuota mostrada: la de la casa si existe; si no, la cuota justa del modelo (1 / probabilidad).{' '}
          {hasOdds ? 'EV = probabilidad × cuota − 1; «Valor» cuando el EV supera el +5%.' : 'Este partido no tiene cuotas de mercado publicadas.'}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="Ningún mercado coincide"
          description="Prueba con otro término o cambia el grupo seleccionado."
          action={
            <button
              type="button"
              className="btn"
              onClick={() => {
                setQuery('');
                setGroup('Todos');
                setOnlyValue(false);
              }}
            >
              Limpiar filtros
            </button>
          }
        />
      ) : (
        <div className="space-y-6">
          {sections.map((g) => {
            const list = filtered.filter((e) => e.group === g);
            if (!list.length) return null;
            return (
              <section key={g} aria-labelledby={`mk-${g}`}>
                <h2 id={`mk-${g}`} className="eyebrow mb-2.5 flex items-center gap-2">
                  {g}
                  <span className="num rounded bg-surface-3 px-1 text-ink-2">{list.length}</span>
                </h2>
                <div className="gap-3 lg:columns-2">
                  {list.map((e) => (
                    <MarketCard key={e.key} entry={e} match={match} open={isOpen(e.key)} onToggle={() => toggle(e.key)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
