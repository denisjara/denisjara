# FutStat Lab — Sistema de diseño de la UI

> **Dirección: "Estadio de noche / grafismo de retransmisión".** Producto premium de analítica
> deportiva. Oscuro por defecto (tema claro conmutable), denso en datos pero legible. Rótulos en
> tipografía de marcador de estadio, números monoespaciados, un único acento "foco de estadio"
> (lima) usado con moderación. Marca propia: **no** imites colores, logos ni estilos de casas de
> apuestas reales.

Todo texto visible: **español**. Fechas y números en `es-ES` (coma decimal: `2,10`, `54%`).

---

## 1. Reglas de oro (léelas antes de escribir una página)

1. **Nunca uses hex sueltos.** Usa clases Tailwind de los tokens (`bg-surface-1`, `text-ink-2`,
   `bg-home`…) o `token('home')` / `SIDE_COLOR` de `lib/colors.ts` en SVG/estilos inline.
2. **Colores semánticos fijos en toda la app** (sección 3). Local = azul, Empate = gris,
   Visitante = naranja. V/E/D = verde/gris/rojo **con letra visible**. No los reutilices para
   otra cosa (p. ej. no pintes "serie 2" de un gráfico con el color de Visitante salvo que sea el
   equipo visitante).
3. **El acento lima (`accent`) es escaso:** pestaña/nav activa, foco, valor (EV+), una KPI
   destacada, la fecha seleccionada. Para marcas de datos/texto en acento usa `accent-text`
   (en tema claro es verde oliva legible; `accent` es un relleno con `text-accent-ink`).
4. **El texto nunca lleva el color de la serie.** Valores y etiquetas en `ink-1/2/3`; el color
   va en una marca al lado (punto, barra, línea). Excepción: texto dentro de un relleno → usa la
   tinta `*-ink` del token (`text-home-ink` sobre `bg-home`).
5. **Números:** en tablas/columnas `num` (mono + tabular). Cifras grandes (KPI, marcador) en
   `font-display` (proporcional). Formatea **siempre** con `lib/format.ts` (`pct`, `odds`, `num`,
   `xg`, `ev`…), nunca con `toFixed` a mano.
6. **Datos:** solo por los hooks de `lib/data.ts` y **tipos de `src/types/data.ts`**. Maneja los
   tres estados: `PageSkeleton`/`Skeleton` (cargando), `ErrorState` (error, con `onRetry={reload}`),
   `EmptyState` (vacío).
7. **Accesible:** un `h1` por página (`PageHeader`/`CompetitionHeader`), secciones con `Section`
   (h2), foco visible (no quites outlines), `aria-label` en gráficos, tablas con `caption`, nada
   transmitido solo por color, respeta `prefers-reduced-motion` (ya global en `index.css`).
8. **Móvil primero:** a 390 px no puede haber scroll horizontal de página. Tablas anchas dentro de
   `DataTable` (scroll propio) y gutter de 16 px (`px-4`) ya lo pone el shell.
9. Avisos de **juego responsable**: `<Disclaimer />` al final de páginas con cuotas/picks/stakes.

---

## 2. Tokens

Definidos en `src/index.css` como tripletas `R G B` en `:root` (oscuro) y
`:root[data-theme='light']`; expuestos en `tailwind.config.js` (admiten opacidad: `bg-home/20`).

| Token Tailwind | Uso | Oscuro | Claro |
|---|---|---|---|
| `bg` | fondo de página | `#080b10` | `#f1f2ee` |
| `surface-1` | tarjetas | `#10151c` | `#ffffff` |
| `surface-2` | cabeceras de tabla, controles, celdas | `#161c25` | `#f7f8f5` |
| `surface-3` | hover, pistas de medidores, activo | `#1e2530` | `#eceee9` |
| `line` / `line-strong` | hairlines / bordes hover | `#242c38` / `#323c4b` | `#e0e3dd` / `#cdd2ca` |
| `ink-1` / `ink-2` / `ink-3` | texto principal / secundario / atenuado (AA) | `#eef2f6` / `#aab4c0` / `#8792a0` | `#0d1117` / `#48515c` / `#626b76` |
| `accent` (+`accent-ink`) | relleno lima "foco" | `#c6f135` | `#beec28` |
| `accent-text` | acento como texto/marca | `#c6f135` | `#4a7a00` |
| `home` (+`home-ink`) | **Local** | `#3b8cf0` | `#2268c9` |
| `draw` (+`draw-ink`) | **Empate** | `#9aa4b2` | `#9aa3ae` |
| `away` (+`away-ink`) | **Visitante** | `#e4672a` | `#c24e18` |
| `win` / `loss` (+`-ink`) | V / D (la E usa `draw`) | `#22a866` / `#e5484d` | `#13844a` / `#c93338` |
| `pos` / `neg` | deltas y EV positivo / negativo (texto) | `#3ccf7e` / `#f06266` | `#13844a` / `#c93338` |
| `warn` | aplazado, datos antiguos, "destacado" | `#fab219` | `#b07000` |
| `live` | en vivo (punto pulsante) | `#ff4d4f` | `#d62828` |
| `seq` (+`seq-ink`) | escala secuencial (heatmaps) | lima | oliva |

Validación dataviz: Local/Empate/Visitante es un **esquema divergente** (frío · neutro · cálido);
azul↔naranja pasa CVD (ΔE 26) y visión normal en ambos temas; el gris de empate es el punto medio
neutro (sin croma a propósito). V/E/D llevan **letra** (V, E, D) además del color.

Otras variables: `--header-h` 60px, `--sidebar-w` 256px, `--bottom-nav-h` 64px.
Radio de tarjeta `rounded-card` (14px); controles `rounded-lg` (8px); chips `rounded-md`.
Sombras: `shadow-card`, `shadow-pop` (popovers/tooltips).

## 3. Color semántico (resumen)

```ts
import { SIDE_COLOR, SIDE_INK, SIDE_CLASS, OUTCOME_CLASS, deltaClass, seqFill, teamColor, token } from '../lib/colors';
SIDE_COLOR.home   // "rgb(var(--c-home))" para SVG/inline
SIDE_CLASS.away.bg // "bg-away"
OUTCOME_CLASS.W   // "bg-win text-win-ink"
deltaClass(ev)    // "text-pos" | "text-neg" | "text-ink-2"
seqFill(t)        // { background, color } para celdas de calor (t ∈ [0,1])
teamColor(team)   // color identitario del equipo (fallback estable por nombre)
```

- **1X2 / comparativas local-visitante:** `home` y `away` (y `draw` para X).
- **Forma V/E/D:** `FormChips` / `OutcomeChip`. Letras: V = Victoria, E = Empate, D = Derrota
  (`OUTCOME_LETTER` en `format.ts`). El más reciente a la derecha.
- **Valor (EV+):** icono `Zap` + `text-pos` con signo `+` + borde `accent-text`. Nunca solo color.
- **Acierto del modelo:** ✓ en `win`, ✗ en `loss` (icono + `aria-label`).
- **Magnitud (heatmaps, distribuciones):** un solo tono `seq` con transparencia (`seqFill`).
- **Series genéricas de gráficos** (cuando no son local/visitante): `SERIES_COLORS` de `LineChart`
  (acento, azul, naranja, tinta) en ese orden fijo; máximo 4 series, si no, facetar.

## 4. Tipografía

Cargadas en `index.html` (Google Fonts):

| Clase | Fuente | Uso |
|---|---|---|
| `font-display` / `.display` | **Big Shoulders Display** 600–900 | Títulos h1/h2 (MAYÚSCULAS), marcadores, cifras KPI, días de la tira de fechas |
| `font-sans` (por defecto) | **IBM Plex Sans** 400–700 | Texto, etiquetas, botones |
| `font-mono` / `.num` | **IBM Plex Mono** 400–600 | Números en tablas, cuotas, %, minutos (tabulares) |

Nota: la skill de dataviz recomienda la sans también en cifras grandes; aquí, por la dirección de marca
("marcador de estadio"), las cifras héroe/KPI y los marcadores usan `font-display` (proporcional), y
**todo lo tabular** (tablas, ejes, cuotas, %) usa `num` (mono tabular).

Escala: h1 `display text-[34px] sm:text-[44px]` (PageHeader); h2 `display text-[22px] sm:text-[26px]`
(Section); h3 de tarjeta `font-display text-[17px] font-bold uppercase`; cuerpo 14px; secundario 13px;
etiquetas `.eyebrow` (11px, mayúsculas, tracking 0.12em, `ink-3`); mínimo absoluto 10px solo en
cabeceras de micro-métricas.

## 5. Espaciado y layout

- Shell: barra lateral fija ≥1024px (`lg`), contenido `max-w-page` (1360px) con `px-4 sm:px-6`.
  En móvil, cabecera de 56px + barra inferior (el `main` ya reserva su alto).
- Página: `<div className="space-y-6">` (o `space-y-10` en páginas largas con Sections).
- Rejillas: tarjetas de partido `grid gap-4 md:grid-cols-2 2xl:grid-cols-3`; dos columnas de
  contenido `grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]`; KPIs `grid grid-cols-2 lg:grid-cols-4 gap-3`.
- Dentro de tarjetas: `p-4` (Card por defecto), listas con `divide-y divide-line/70` y filas `px-3 py-2.5 sm:px-4`.
- Usa siempre `min-w-0` + `truncate` en flex/grid con nombres de equipo. `Section` y `Card` ya llevan
  `min-w-0` para que tablas/heatmaps anchos hagan scroll dentro y no desborden la página en móvil.

## 6. Componentes (`import { … } from '../components'`)

### Estructura
- **`PageHeader`** `{ title, eyebrow?, description?, actions?, children?, pitch?=true }` — h1 con marcas
  de campo. `children` debajo (KPIs, filtros, tira de fechas).
- **`CompetitionHeader`** `{ meta: CompetitionMeta, subtitle?, stats?: {label,value}[], actions?, children? }`
  — h1 de competición (logo/bandera, país · tipo · temporada). Pon `<Tabs>` como `children`.
- **`Section`** `{ title, eyebrow?, description?, icon?, moreTo?, moreLabel?, action?, id? }` — h2 + contenido.
  `action` para un `SegmentedControl` a la derecha.
- **`Card`** `{ as?, pad?: 'none'|'sm'|'md'|'lg', interactive?, className }` — superficie base.
- **`cx(...)`** — unir clases.

### Partidos
- **`MatchCard`** `{ match: MatchSummary, live?: LiveScore, hideCompetition?, hotThreshold?=85, delay? }` —
  tarjeta de portada: competición, hora/estado/marcador, forma, barra 1X2 (con mercado), xG, +2,5,
  ambos marcan, marcador probable, pick de valor y confianza. Enlaza a `/m/:id` (o `/c/:compId` si `!hasDetail`).
- **`MatchRow`** `{ match, live?, showComp?, showDate?, showPrediction?=true, showHit?, compact? }` — fila compacta
  (equipos apilados, nombre corto en móvil; 1X2 mini; +2,5/ambos en ≥md; pick en ≥xl; ✓/✗ con `showHit`).
  Pensada para **ancho completo**; dentro de columnas estrechas (< ~640px) pasa `compact` (solo 1X2).
- **`MatchGroup`** `{ compId, compName, meta?, matches, live?, showDate?, showPrediction?, showHit?, compact? }` —
  tarjeta "competición + filas". Úsala con `groupMatchesByCompetition(matches, meta.competitions)` y apílalas
  en `space-y-4` (no en dos columnas, salvo con `compact`).
- **`HitMark`** `{ hit: boolean }` — ✓/✗ de acierto del modelo.
- **`Mini1X2`** `{ p }` — tres celdas 1·X·2 con el favorito subrayado en su color.
- **`StatusPill`** `{ status, detail?, date?, withDay? }` — "● 67'", "Final", "Aplazado" u hora.
- **`CompetitionBadge`** `{ compId, name?, link?, short?=true }` — bandera + nombre (lee meta.json).
- **`matchHref(match)`** — ruta del análisis.

### Probabilidades y cuotas
- **`ProbBar1X2`** `{ p, market?, size?: 'sm'|'md'|'lg', legend?, labels? }` — barra apilada con 2px de
  separación; % dentro solo si cabe (usa `md`/`lg` con ≥240px de ancho, si no `sm`). `market` añade
  barra fina "Mercado". `legend` añade `Legend1X2` (con Δ vs mercado).
- **`ProbabilityBadge`** `{ p, label?, tone?: 'neutral'|'accent'|'home'|'draw'|'away', size? }` — píldora % + mini medidor.
- **`OddsButton`** `{ label, prob, fairOdds?, marketOdds?, ev?, note?, highlight?, valueThreshold?=0.05, selected?, onClick?, href?, compact? }`
  — selección estilo casa de apuestas: cuota (mercado si existe, si no justa), % modelo, "Justa x · EV ±y%",
  insignia "Valor" si hay cuota de mercado y EV ≥ `valueThreshold`. Rejillas de mercados:
  `grid grid-cols-2 sm:grid-cols-3 gap-2` (3 selecciones → `grid-cols-3`).
- **`ValuePickChip`** `{ pick: ValuePick, showKelly? }` — "⚡ Local @ 2,10 +6,2%".
- **`ConfidenceMeter`** `{ value, showLabel? }` — 5 barras + Alta/Media/Baja. **`Meter`** `{ value, color?, height?, label? }`.

### Forma y equipos
- **`TeamCrest`** `{ team: {name, abbr?, logo?, color?}, size?=24, alt? }` — logo o iniciales sobre color del equipo.
- **`FormChips`** `{ form: "WWDLW", max?=5, size?: 'xs'|'sm'|'md', label? }` — V/E/D con letra; último a la derecha subrayado.
- **`OutcomeChip`** `{ outcome: 'W'|'D'|'L' }`.

### Datos tabulares y gráficos (SVG propio, sin librerías)
- **`DataTable<R>`** `{ columns: Column<R>[], rows, rowKey, caption, initialSort?, maxHeight?, dense?, rowHref?, onRowClick?, rowClassName?, emptyText? }`
  `Column`: `{ key, header, title?, cell?, sortValue?, numeric?, align?, sticky?, width?, firstDir?, hideBelow?: 'sm'|'md'|'lg' }`.
  Ordenable (aria-sort), cabecera fija, numéricas a la derecha (mono), scroll horizontal propio,
  primera columna `sticky`. Abrevia cabeceras (`PJ`, `xG`) y pon el texto completo en `title`.
  Las celdas de texto pueden partir línea; añade `className: 'whitespace-nowrap'` a la columna si no quieres.
- **`StatCompareBar`** `{ label, home, away, format?: 'int'|'dec1'|'dec2'|'pct', better?: 'high'|'low', leagueAvg? }` —
  barra enfrentada; apila varias en `space-y-3`.
- **`Sparkline`** `{ values, width?, height?, color?, area?, domain?, ariaLabel? }` — tendencia mínima.
- **`LineChart`** `{ series: {id,label,points:{x,y}[],color?}[], height?, yFormat?, xFormat?, yDomain?, refLines?, area?, ariaLabel }`
  — rejilla hairline, cruz + tooltip con todas las series, ←/→ con teclado, leyenda si ≥2 series. Para
  Elo usa `yFormat={(v)=>num(v,0)}`; para probabilidades `yDomain={[0,1]}` y `yFormat={(v)=>pct(v)}`.
  **Un solo eje Y siempre** (nada de doble eje).
- **`Heatmap`** `{ rows, cols, values[][], caption, format?, rowTitle?, colTitle?, max?, minLabel?, highlightMax?, cellSize?, describe?, rowLabelWidth? }`
  — tabla HTML coloreada (gráfico + vista de tabla a la vez). Marcador exacto: filas = goles local,
  columnas = goles visitante. Distribución de posiciones: filas = equipos, columnas = 1..N.
- **`KpiTile`** `{ label, value, unit?, hint?, delta?: {text, direction, good?}, trend?, icon?, accent? }`.

### Navegación y controles
- **`Tabs`** `{ tabs: {id,label,icon?,badge?}[], value, onChange, idBase, ariaLabel? }` + **`TabPanel`**
  `{ idBase, id, active }` + **`useUrlTab(ids, defaultId, param='tab')`** (sincroniza `?tab=`):
  ```tsx
  const TABS = ['resumen', 'clasificacion'] as const;
  const [tab, setTab] = useUrlTab(TABS, 'resumen');
  <Tabs idBase="comp" value={tab} onChange={setTab} tabs={[{ id: 'resumen', label: 'Resumen' }, …]} />
  <TabPanel idBase="comp" id="resumen" active={tab}>…</TabPanel>
  ```
- **`SegmentedControl`** `{ options: {value,label,count?}[], value, onChange, ariaLabel, size?, full? }` (radiogroup).
- **`Tooltip`** `{ content, side?, align? }` y **`InfoTip`** `{ content }` (icono ⓘ). Nunca como única vía de un dato.

### Estados y avisos
- **`PageSkeleton`**, **`Skeleton`** `{className}`, **`SkeletonCard`** `{lines}`.
- **`EmptyState`** `{ title, description?, icon?, action?, compact? }`.
- **`ErrorState`** `{ error, title?, onRetry?, compact? }` (detecta 404 → "No hay datos disponibles").
- **`Disclaimer`** `{ compact? }` — juego responsable (+18, jugarbien.es).

### Clases CSS utilitarias (`index.css`)
`.card`, `.card-hover`, `.eyebrow`, `.display`, `.num`, `.chip`, `.btn`, `.btn-ghost`, `.btn-accent`,
`.link`, `.input`, `.stretched-link` (toda una tarjeta clicable sin anidar interactivos),
`.pitch-lines` (marcas de campo decorativas), `.skeleton`, `.scrollbar-none`, `.mask-fade-x`.

## 7. Librería (`src/app/lib`)

- **`data.ts`**: `useMeta()`, `useHome()`, `useCompetition(id)`, `useMatch(id)`, `useTeam(id)`, `usePlayers()`,
  `useValue()`, `useModel()` → `{ data, error, loading, reload }`. `useCompetitionMeta(id)`,
  `useCompetitions(ids)` (varias en paralelo, resultados parciales), `fetchJson(path)` con caché,
  `DataError` (`notFound`). Base: `BASE_URL + (VITE_DATA_DIR ?? 'data')`.
- **`format.ts`**: `pct(p, d?)`, `num(x, d?)`, `int`, `compact`, `odds(o)`, `fairOddsFromProb(p)`, `xg`, `ev`,
  `signed`, `signedPct`, `minute`, `time`, `shortDate` ("mar 4 nov"), `longDate`, `dateTime`, `relativeDay`
  ("Hoy/Mañana/Ayer"), `kickoff` ("Hoy · 21:00"), `timeAgo`, `dayKey`, `addDays`, `normalizeText`, `plural`,
  `topOutcome`, `OUTCOME_LETTER/LABEL`, `STATUS_LABEL`, `PICK_LABEL`.
- **`live.ts`**: `useLiveScores(matches)` → `Record<matchId, LiveScore>` (ESPN cada 60 s, solo partidos de hoy en
  ventana de juego; desactivado con `VITE_DATA_DIR=mock-data` salvo `VITE_LIVE=1`), `applyLive`, `withLive`.
- **`colors.ts`**: ver sección 3. **`competitions.ts`**: `groupCompetitions`, `leagueRegion`, `KIND_LABEL`,
  `byTier`, `groupMatchesByCompetition`. **`hooks.ts`**: `useMediaQuery`, `useElementWidth`, `useHotkey`,
  `useNow`, `useDismiss`, `useReducedMotion`. **`theme.ts`**: `useTheme()`.

## 8. Patrón para componer una página nueva

```tsx
import { useParams } from 'react-router-dom';
import { useCompetition } from '../../lib/data';
import { CompetitionHeader, ErrorState, PageSkeleton, Section, Tabs, TabPanel, useUrlTab, Disclaimer } from '../../components';

const TABS = ['resumen', 'clasificacion', 'partidos'] as const;

export default function CompetitionPage() {
  const { compId } = useParams();
  const { data, error, loading, reload } = useCompetition(compId);
  const [tab, setTab] = useUrlTab(TABS, 'resumen');
  if (loading && !data) return <PageSkeleton />;
  if (error || !data) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="space-y-6">
      <CompetitionHeader meta={data.meta} stats={[{ label: 'Partidos', value: data.meta.finishedCount }]}>
        <Tabs idBase="comp" value={tab} onChange={setTab} tabs={[{ id: 'resumen', label: 'Resumen' }, { id: 'clasificacion', label: 'Clasificación' }, { id: 'partidos', label: 'Partidos' }]} />
      </CompetitionHeader>
      <TabPanel idBase="comp" id="resumen" active={tab}>
        <div className="space-y-10">
          <Section title="Próximos partidos" eyebrow="Jornada">…</Section>
        </div>
      </TabPanel>
      …
      <Disclaimer compact />
    </div>
  );
}
```

Checklist antes de entregar una página: `npx tsc -p tsconfig.app.json --noEmit` limpio · probada a 1440 y
390 px en ambos temas · sin errores de consola · estados de carga/error/vacío · `h1` único · textos en español.

## 9. Datos de desarrollo

`npm run data:mock` genera `public/mock-data/` (meta, home, competiciones `laliga`, `premier`, `seriea`,
`brasileirao`, `saudi`, `champions`, `copadelrey`, 14 partidos con análisis completo — 2 en vivo, 2 terminados,
el resto próximos —, 6 equipos, players, value, model). Las fechas son relativas al momento de generarlo
(siempre hay partidos hoy/mañana/en vivo): regenera si lo usas otro día.
Arranca con `VITE_DATA_DIR=mock-data npx vite --port <tu puerto> --strictPort`.

- Partidos con detalle: los `MatchSummary` con `hasDetail: true` (p. ej. en `home.json → popular`) →
  `matches/<id>.json`.
- Equipos con ficha (`teams/<id>.json`, ids deterministas): Real Madrid `3001`, Barcelona `3002`,
  Atlético de Madrid `3003`, Arsenal `3021`, Liverpool `3023`, Inter `3041`.
- Competiciones sin tabla: `copadelrey` (`standings: []`, sin simulación). `saudi` no tiene cuotas.
- El marcador en vivo (ESPN) está desactivado con mock (`VITE_LIVE=1` para forzarlo).
