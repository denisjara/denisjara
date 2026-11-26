# Banco de pruebas de modelos

Aquí se prueban ideas para mejorar los pronósticos **sin tocar el núcleo**. Cada idea es una *variante*: un archivo
`pipeline/experiments/<nombre>.ts` que exporta por defecto un `ModelVariant` (contrato en [`types.ts`](types.ts)) con
ganchos opcionales. El núcleo (`ratings`, `predict`, `projections`, `publish/context`) consulta esos ganchos; **sin
ganchos el resultado es idéntico a producción** (comprobado: mismos JSON publicados byte a byte y mismas predicciones
walk-forward en los 4.086 partidos, también con una variante que activa todos los ganchos con los valores de
producción; ver `tests/experiments/bench.test.ts`).

```bash
npx tsx scripts/eval-model.ts --variant=example                 # ventana de ajuste (tuning)
npx tsx scripts/eval-model.ts --variant=example --window=T1     # y T2: la mejora debe aparecer en las dos
npx tsx scripts/eval-model.ts --variant=a,b,c --window=T2       # varias variantes en una ejecución
npx tsx scripts/eval-model.ts --variant=example --window=pre    # auxiliar: ene–may, casi todo SIN cuotas
npx tsx scripts/eval-model.ts --variant=example --window=prev   # confirmatoria: temporadas PASADAS ene–may (pre-registro)
npx tsx scripts/eval-model.ts --variant=example --window=pooled # tuning + prev juntas (criterio conjunto del pre-registro)
```

Siempre se compara contra `baseline` (producción). Informe en consola y JSON en `.cache/eval/<variante>-<ventana>.json`.
Tiempo: ~15 s la primera vez (línea base, luego en caché) + ~9–20 s por variante + ~20 s de comprobación de fuga.

---

## Protocolo anti-autoengaño (obligatorio)

1. **Walk-forward estricto.** Para cada partido solo se usa información con fecha **anterior a su inicio**: parámetros
   ajustados, medias, dispersión, normalizaciones y pesos de combinadores incluidos. El núcleo ya lo garantiza para
   todo lo que entrega a los ganchos (ver «Qué ve cada gancho»); tu código no puede saltárselo.
2. **Ventana de ajuste (`tuning`)** = partidos terminados con inicio entre **2026-06-01 y 2026-09-15**: aquí se comparan
   y eligen ideas. Sub-ventanas de estabilidad **T1** = 06-01..07-31 y **T2** = 08-01..09-15: una mejora tiene que
   aparecer **en las dos** (T1 es pequeña: es el verano del Mundial, casi solo ligas americanas y rondas previas).
3. **Holdout** = 2026-09-16 en adelante. **Nadie lo mira** salvo el agente de combinación, **una vez**, con `--final`.
   Sin `--final` la CLI se niega a mostrarlo; con `--final` cada ejecución añade una línea (fecha, variante, cifras) a
   `.cache/holdout-looks.log`.
4. **Honestidad.** Si algo no mejora, se dice. No se maquillan cifras, no se elige la ventana que sale bien, no se
   prueban 40 variantes y se informa de la mejor sin decirlo (cuenta cuántas probaste).
5. Una diferencia cuyo intervalo bootstrap (por días) cruza el 0 **no es una mejora**: es ruido.

`--window=pre` (2026-01-01..05-31) es **auxiliar** y anterior al ajuste (nunca holdout): el 80 % de sus partidos no
tiene cuotas, así que es el único sitio con muestra para el segmento *sin cuotas* (en `tuning` solo hay 47). Úsala como
evidencia adicional para ideas de ese segmento; la decisión sigue siendo T1 + T2.

### Pre-registro (2026-11-26): ventana confirmatoria `prev` y regla de adopción de factores

Escrito el **2026-11-26**, cuando el banco ya tiene los ganchos de árbitro y jugadores pero **antes de que exista ningún
resultado** de las variantes de factores (árbitro, forma de jugadores y bajas, necesidad de marcar en eliminatorias y
en la recta final de liga, forma del equipo, rendimiento local/visitante). Hasta ahora solo se han calculado cifras de
la línea base (`baseline` y `production`). Esta sección no se cambia después de ver resultados; si hubiera que
cambiarla, se añade una enmienda con fecha y motivo, sin borrar esto.

**Propósito de `prev`.** El walk-forward de producción (y el banco hasta hoy) solo predice partidos de la temporada
**actual** de cada competición, así que las segundas vueltas de las ligas europeas 2025-26, las eliminatorias de la
UEFA de 2026, las copas 2025-26, la Saudí 2025-26 y la Clausura 2026 de la Liga MX **nunca se han evaluado**. `prev` =
partidos terminados de temporadas pasadas (`currentSeason = false`) con inicio entre **2026-01-01 y 2026-05-31**
(2.636 partidos en el data-store; la composición exacta sale en cada informe). Es una ventana confirmatoria limpia y
es donde están casi todas las situaciones de los factores nuevos: recta final de liga (en `tuning` no hay ninguna
temporada actual en su último 25 %), vueltas de la UEFA y árbitros de las ligas europeas. Solo la usa el banco
(`BuildOptions.pastSeasonsFrom`): el build y el backtest publicado no cambian. Las predicciones de `prev` son igual de
walk-forward: Dixon-Coles adicional ajustado cada semana desde el 2026-01-01 con partidos anteriores, parámetros de
pretemporada con corte en el primer partido de cada temporada pasada (sin ellos el partido no se predice) y
estadísticas con los partidos de esa temporada. **`prev` casi no tiene líneas de jugador** (empiezan el 2026-05-07:
192 partidos con props, y solo 1 en el segmento «falta un habitual»), y casi no tiene cuotas (292 de 2.636): los
factores de jugadores se juzgan sin `prev`.

**Regla de decisión de cada factor** (una variante por factor, con sus *métricas objetivo* escritas en la cabecera del
archivo de la variante ANTES de evaluarla; p. ej. árbitro → tarjetas y faltas, total y por equipo; jugadores → props;
necesidad de marcar → 1X2, más/menos y goles por equipo):

1. Mejora (Δ < 0, estimación puntual) en sus métricas objetivo **en T2 y en `prev`**.
2. El IC 95 % bootstrap por día de alguna métrica objetivo **excluye el 0 en al menos una** de: T2, `prev` o la ventana
   conjunta `pooled` (tuning + prev).
3. **No es significativamente peor** (IC entero por encima de 0) **en T1**, ni en **ninguna otra métrica principal**
   (las de `MAIN_METRICS`/`PLAYER_METRICS` en `bench.ts`) en T1, T2 o `prev`.
4. Comprobación de fuga OK en todas las ventanas evaluadas.
5. **Sin muestra en una ventana** (p. ej. jugadores en `prev`, vueltas de eliminatoria en T1, árbitros después de
   septiembre): el factor se juzga en las ventanas donde sí la tiene, y el informe lo dice **explícitamente** (qué
   ventana falta y por qué). Una ventana con muestra mínima (n del segmento < 30) cuenta como «sin muestra» solo si se
   declara así antes de evaluarla.
6. Se informa de **cuántas** variantes se probaron por factor (no solo de la mejor).

Después, la variante **combinada final** (solo los factores adoptados) recibe **UNA** mirada más al holdout (2026-09-16
en adelante): será la **SEGUNDA** en total, registrada en `.cache/holdout-looks.log` con `--final`. Se adopta en
producción solo si sus métricas objetivo **no empeoran** en el holdout (estimación puntual). Si empeoran, no se integra
y no se hace ningún ajuste posterior con el holdout.

---

## Cómo escribir una variante

```ts
// pipeline/experiments/mi-idea.ts   (el nombre del archivo = `name`)
import type { ModelVariant } from './types';

const v: ModelVariant = {
  name: 'mi-idea',
  description: 'Qué cambia y por qué',
  // …solo los ganchos que necesites; los demás quedan como en producción
};
export default v;
```

Ejemplo completo y trivial: [`example.ts`](example.ts) (rasgo «días de descanso» calculado con la vista del pasado y
−1 % de goles esperados con menos de 3 días). No mejora nada: está para enseñar el contrato.

### Orden de la predicción de un partido

```
Elo pre-partido ─┐
Dixon-Coles walk-forward (o Elo→goles en cruces entre ligas) → λ ─ features ─ lambdaAdjust → 1X2 de goles ─┐
Mercado sin margen (cuotas de cierre en terminados) ─────────────────────────────────────────────────────┤
                                     combine.blend (o pool lineal de producción) → 1X2 final + objetivo de más de 2,5
                                     → fitLambdas (λ coherentes con el 1X2) → totals.adjustTotal → matriz de marcadores
Córners / tarjetas / faltas / tiros: binomial negativa con su propio contexto (`stats`), independiente de lo anterior
                                     → medias por equipo (expectedPair) × stats.adjust → distribuciones (projectStatsFor)
Props de jugadores: tasas por 90 (players.rateHalfLifeDays) · minutos esperados · λ final del equipo · factores del
                                     rival de las proyecciones (cardsFactor = tarjetas proyectadas / media del equipo)
                                     → players.adjust → buildPlayerProps (propsFor)
```

### Ganchos (todos opcionales; por defecto = producción)

| Gancho | Qué hace | Producción |
|---|---|---|
| `dc.xi`, `dc.windowDays`, `dc.priorWeight` | decaimiento temporal, ventana y prior del Dixon-Coles | 0,0019 · 540 días · 2 |
| `dc.fitGoals(m)` | goles «ajustados» de un partido **histórico** para el ajuste (p. ej. mezcla con xG por tiros: `m.stats`). Solo datos del propio `m`. Pueden no ser enteros; la corrección τ/ρ usa el marcador real | marcador |
| `dc.weight(m)` | peso extra (≥ 0) de un partido histórico (se multiplica por el decaimiento) | 1 |
| `elo.k`, `elo.homeAdv`, `elo.tierOffset` | K, ventaja local (también en la diferencia que usan las probabilidades), puntos por tier del Elo inicial | 20 · 65 · 30 |
| `elo.kMultiplier(m, comp)` | multiplicador de K por partido | 1,2 continental · 0,9 copa · 1 liga |
| `elo.goalMultiplier(gd)` | multiplicador por diferencia de goles | 1 · 1,5 · (11+gd)/8 |
| `features(ctx, match, before)` | rasgos pre-partido (`Record<string, number>`); se pasan a `lambdaAdjust`, `combine` y `totals` | `{}` |
| `lambdaAdjust({ctx, match, lambdaHome, lambdaAway, features})` | ajusta los λ de la fuente de goles **antes** del ensamble | sin cambio |
| `combine.blend(row)` | 1X2 final (y opcionalmente `{ p, over25 }`) desde los componentes | pool lineal DC 0,05 / Elo 0,15 / mercado 0,8; sin cuotas 0,5 / 0,5 |
| `combine.prepare(rows, asOf)` | reajuste del combinador con filas **estrictamente anteriores** a `asOf`; `combine.refitEvery`: `'monthly'` (día 1 de cada mes, por defecto) o cada N días | — |
| `totals.adjustTotal(input)` | factor del total de goles manteniendo el 1X2 (se recalcula el objetivo de más de 2,5 con λ·factor y se recalibra) | 1 |
| `stats.priorN`, `stats.halfLifeDays`, `stats.leaguePriorN` | contracción de las tasas de equipo, vida media, prior de la media de liga (córners, tarjetas…) | 6 · 150 · 20 |
| `stats.dispersion` | `'pooled'` (producción), `'global'`, `'team'` (por equipo contraída hacia la común), `'poisson'` o un número fijo | `'pooled'` |
| `stats.adjust({ctx, match, history, base})` | **multiplicadores** (> 0) por equipo de la media de cada estadística (`base` = medias de producción de las que se proyectan), justo después de `expectedPair`: árbitro, necesidad de marcar… Llega a TODAS las proyecciones (`projectStatsFor`: fichas, pronósticos del día, alta confianza, cuota alta, banco) y, por `cardsFactor`, a las props de tarjeta | sin cambio |
| `players.rateHalfLifeDays` | vida media (días) de la ponderación temporal de las tasas por 90 de cada jugador, con referencia en el inicio del partido | sin ponderar (365 días) |
| `players.adjust({ctx, match, teamId, side, history, base})` | cambios de la entrada de las props de un equipo (`Partial<PlayerPropsInput>`): `minutesFactor` por jugador (0 = no juega), `cardsFactor`, `teamLambda`… | sin cambio |

### Qué ve cada gancho (y por qué no puede mirar el futuro)

- `match` es un **`PreMatch`**: el partido sin marcador, estadísticas, eventos, forma de ESPN ni estado final (las
  cuotas de cierre sí están: son pre-partido).
- `before` / `ctx.history` es una **`HistoryView`** cortada en el inicio del partido: `teamMatches(id)`,
  `compMatches(id)` (solo partidos **terminados con inicio anterior**), `eloBefore(id)`, `playerLines(teamId)` (líneas
  de jugador de partidos anteriores, cronológicas; existen desde el 2026-05-07 y nunca en la Nations League) y
  `refereeMatches(refereeId)` (partidos terminados anteriores dirigidos por ese árbitro, todas las competiciones).
- El árbitro designado está en `match.referee` (`{ id, name }`, información previa al partido). ESPN lo tiene en
  los partidos terminados de 2025-01 a ~2026-09-20; desde octubre de 2026 (y en los programados) suele faltar.
- Lo que necesitan los factores ya se alcanza con esto: **eliminatorias** (`match.round` con «· Vuelta» y la ida en
  `history.compMatches(match.compId)`, mismo `season` y equipos cruzados; el marcador guardado de la ida es el final),
  **recta final de liga** (tabla a la fecha con `computeStandingsFromMatches` de `analytics/teamStats.ts` sobre
  `compMatches` de la temporada, zonas en `ctx.comp.simulationZones`, jornadas restantes ≈ 2(n−1) − jugados; no uses
  `store.standings`, que es la tabla de HOY), **forma del equipo** (`teamMatches`: marcador, estadísticas y eventos con
  `playerId`), **local/visitante** (`teamMatches` + `m.home.id`). Las variantes pueden importar funciones puras del
  núcleo (`analytics/*`); solo se prohíbe leer datos por su cuenta.
- `HookInfo` (en `lambdaAdjust` y `totals`): Elo pre-partido, modelo Dixon-Coles walk-forward usado (ajustado con días
  anteriores), ρ, mercado sin margen, partidos Elo previos y los rasgos.
- `combine.prepare` recibe `WalkForwardRow`: componentes pre-partido + resultado a 90' de partidos **anteriores** a la
  fecha de reajuste. En el build las filas existen solo para la temporada actual (el walk-forward empieza en su primer
  partido, enero de 2026 en las competiciones de año natural); en el banco incluyen además los partidos de temporadas
  pasadas desde el 2026-01-01 (ventana `prev`).
- `dc.fitGoals(m)` / `dc.weight(m)` reciben partidos históricos anteriores a la fecha de reajuste del Dixon-Coles.
- Única excepción documentada del núcleo: `ctx.homeLeague` (liga doméstica de cada equipo) se calcula con el
  calendario completo; solo decide qué modelo de goles se usa. **No la uses como señal.**

### Prohibido

- Leer datos por tu cuenta: `fs`, el data-store, `public/data`, la red, `createContext`/`computeWalkForward`… El cargador
  lo rechaza (`checkVariantSource`). Si separas código en módulos auxiliares, nómbralos `_algo.ts` (no se listan como
  variantes) y aplícales la misma regla.
- **Estado global entre llamadas** (cachés que se rellenan con lo que ven otros partidos): el walk-forward no recorre
  los partidos en orden cronológico global (va competición a competición), así que una caché global filtra el futuro.
  Si necesitas estado, que lo gestione `combine.prepare` (que solo recibe el pasado).
- Aleatoriedad sin semilla. Los ganchos deben ser deterministas.

### Comprobación de fuga (automática)

Para cada variante con ganchos, `eval-model` vuelve a predecir los partidos del día con más partidos de T1 y de T2
(y de `pre`/`prev` cuando se evalúa esa ventana) **añadiendo partidos «del futuro» envenenados** (los mismos equipos,
al día siguiente, en una copa ficticia, con 9-0, 30 córners, 9 tarjetas, cuotas extremas, **el mismo árbitro** y
**líneas de jugador extremas** de los jugadores del último partido de cada equipo) y exige que **todas** las salidas
(1X2, más de 2,5, ambos marcan, λ, córners, tarjetas, faltas, tiros, líneas por equipo y props de cada jugador) sean
idénticas. Si algo cambia: `¡FUGA DETECTADA!`, código de salida 2 y resultados no válidos. Producción y `example` la
pasan con diferencia 0; variantes con estado global (también en `stats.adjust` y `players.adjust`) la fallan (tests).

---

## Qué mide `eval-model`

En la ventana pedida, sobre los partidos con resultado y predicción de la base y de la variante:

- **1X2**: RPS (métrica principal), log-loss, Brier, acierto.
- **Más/menos 2,5** y **ambos marcan**: Brier, log-loss, acierto.
- **Goles por equipo**: deviance Poisson media de λ frente a los goles reales.
- **Córners**: Brier de más de 8,5 / 9,5 / 10,5, MAE del total y log-verosimilitud negativa del total exacto.
  **Tarjetas**: igual con 3,5 / 4,5. **Faltas** 20,5 / 22,5 / 24,5, **tiros** 22,5 / 24,5 / 26,5 y **tiros a puerta**
  7,5 / 8,5 / 9,5 (mismos datos válidos que los pronósticos del día).
- **Por equipo**: goles más de 0,5 / 1,5 (Poisson con los λ finales: ignora la corrección τ de Dixon-Coles, es una
  aproximación), tarjetas 1,5 / 2,5 y córners 3,5 / 4,5 / 5,5 (binomial negativa de cada equipo de la proyección).
  Brier medio de local y visitante.
- **Props de jugadores** (solo partidos con líneas de jugador válidas: sin prórroga, ≥ 7 jugadores por equipo, algún
  tiro): goleador, ≥ 1 tiro a puerta, ≥ 2 tiros y tarjeta, Brier y log-loss (probabilidad recortada a [0,001; 0,999]),
  sobre los pares partido-jugador que **publican la base y la variante** (`propsFor`, máx. 14 por equipo). Quien no
  jugó cuenta como 0 en todo (las probabilidades publicadas ya incluyen la posibilidad de no jugar). El informe da
  cuántos pares publica solo una de las dos y cuántos de esos jugadores jugaron (efecto de las bajas).
- **Segmentos** (cada uno con todas las métricas principales y su n): con/sin cuotas, ligas/copas/continentales, top
  (tier ≥ 8: LaLiga, Premier, Serie A, Bundesliga, Ligue 1, Champions, Europa League, Libertadores) / resto, y cuatro
  definidos solo con información previa al partido: **árbitro conocido** (≥ 5 partidos anteriores dirigidos),
  **vuelta de eliminatoria** («· Vuelta»), **liga: último 25 %** (fase regular con ≥ 75 % de sus partidos del calendario
  ya jugados antes del inicio) y **falta un habitual** (un jugador con ≥ 60 % de los minutos de su equipo en sus 5
  últimos partidos que no jugó el último).
- **Diferencia con la base** e **intervalo bootstrap al 95 % remuestreando días completos** (1.000 réplicas, semilla
  fija) para todas las métricas principales (también en cada segmento). `P(mejora)` = fracción de réplicas en que la
  variante pierde menos.
- **Composición**: partidos por competición de la ventana.
- **Referencias**: Elo solo, fuente de goles sola y mercado de cierre frente al ensamble en los partidos con cuotas.

Resultado a **90 minutos** (como liquidan las casas): con prórroga/penaltis los goles se reconstruyen con los eventos
(2 partidos sin eventos completos se excluyen) y córners/tarjetas se excluyen; 0 tarjetas = dato ausente. Por eso las
cifras difieren un poco del backtest publicado (`model.json`, que usa el marcador final).

## Cifras de la línea base (datos del 21-nov-2026, 4.086 partidos con predicción walk-forward)

| Ventana | n | RPS | Log-loss | Brier | Acierto | O/U 2,5 Brier · acierto | Ambos marcan Brier · acierto | Córners Brier · MAE | Tarjetas Brier · MAE | Sin cuotas |
|---|---|---|---|---|---|---|---|---|---|---|
| tuning | 1.357 | 0,1986 | 0,9819 | 0,5850 | 50,9 % | 0,2326 · 59,5 % | 0,2417 · 56,2 % | 0,2422 · 2,87 | 0,2367 · 1,68 | 47 |
| T1 | 215 | 0,2058 | 0,9972 | 0,5954 | 53,0 % | 0,2452 · 55,8 % | 0,2472 · 53,0 % | 0,2481 · 2,71 | 0,2464 · 1,88 | 14 |
| T2 | 1.142 | 0,1973 | 0,9791 | 0,5830 | 50,5 % | 0,2302 · 60,2 % | 0,2407 · 56,8 % | 0,2415 · 2,89 | 0,2349 · 1,65 | 33 |
| pre (auxiliar) | 1.014 | 0,2148 | 1,0349 | 0,6226 | 48,6 % | 0,2399 · 58,8 % | 0,2485 · 55,1 % | 0,2479 · 2,80 | 0,2138 · 1,82 | 815 |

Referencias en `tuning`: Elo solo 0,2085, fuente de goles sola 0,2093; en los 1.310 partidos con cuotas, mercado de
cierre 0,1974 frente al ensamble 0,1980 (T2: 0,1959 frente a 0,1965). **Batir al mercado de cierre en 1X2 es muy
difícil**; el margen realista está en los partidos sin cuotas, en la señal estadística propia y en totales, ambos
marcan, córners y tarjetas.

**Dónde están los partidos sin cuotas:** el ~27 % de toda la temporada sin cuotas está casi entero en enero–mayo (ESPN
solo da cuotas de cierre en los resúmenes, que se descargan para los últimos 180 días). Desde junio la cobertura es del
88–97 % por mes. En `tuning` el segmento sin cuotas tiene 47 partidos: no basta para decidir nada; usa `pre`.

---

## Cifras de la línea base con las métricas nuevas (datos del 26-nov-2026, `production`, antes de cualquier factor)

`eval-model --variant=baseline,production` en cada ventana (datos `4649537288eee65d`, 6.827 partidos con predicción
walk-forward en el banco, 2.636 de ellos de temporadas pasadas). Producción actual; entre paréntesis, n. Brier medio de
las líneas en las estadísticas; props sobre pares partido-jugador. Fuga OK en todas (también en un día de `pre` y de
`prev`).

| Ventana | n | RPS | O/U 2,5 | Ambos | Goles eq. | Córners | Córners eq. | Tarjetas | Tarjetas eq. | Faltas | Tiros | A puerta | Goleador | ≥1 a puerta | ≥2 tiros | Tarjeta jug. |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tuning | 1.357 | 0,1986 | 0,2322 | 0,2417 | 0,1974 | 0,2381 (1.242) | 0,2234 | 0,2326 | 0,2206 | 0,2189 (1.242) | 0,2192 | 0,2344 | 0,0684 (32.674) | 0,1535 | 0,1506 | 0,0932 |
| T1 | 215 | 0,2058 | 0,2443 | 0,2468 | 0,2058 | 0,2382 (142) | 0,2234 | 0,2446 | 0,2213 | 0,2295 (142) | 0,2178 | 0,2469 | 0,0599 (3.668) | 0,1489 | 0,1463 | 0,0887 |
| T2 | 1.142 | 0,1973 | 0,2300 | 0,2407 | 0,1958 | 0,2380 (1.100) | 0,2234 | 0,2303 | 0,2205 | 0,2175 (1.100) | 0,2194 | 0,2328 | 0,0695 (29.006) | 0,1541 | 0,1512 | 0,0937 |
| pre | 1.014 | 0,2148 | 0,2360 | 0,2467 | 0,2027 | 0,2391 (980) | 0,2233 | 0,2088 | 0,2128 | 0,2101 (979) | 0,2296 | 0,2341 | 0,0691 (4.065) | 0,1580 | 0,1524 | 0,1191 |
| prev | 2.636 | 0,2039 | 0,2450 | 0,2475 | 0,2017 | 0,2367 (2.602) | 0,2207 | 0,2318 | 0,2237 | 0,2028 (2.602) | 0,2261 | 0,2300 | 0,0714 (5.236) | 0,1618 | 0,1561 | 0,0997 |
| pooled | 3.993 | 0,2021 | 0,2407 | 0,2455 | 0,2002 | 0,2372 (3.844) | 0,2216 | 0,2321 | 0,2226 | 0,2080 (3.844) | 0,2239 | 0,2314 | 0,0689 (37.910) | 0,1546 | 0,1514 | 0,0941 |

Composición de `prev`: Championship 271, LaLiga 2 253, Serie A 214, LaLiga 209, Saudí 207, Premier 194, Bundesliga
171, Liga MX 167, Primeira 164, Ligue 1 161, Eredivisie 157, Süper Lig 153, Champions 81, Europa League 81, FA Cup 63,
Conference 45, Copa del Rey 18, Coppa Italia 11, DFB-Pokal 7, Carabao 5, Nations League 4. Segmentos en `prev`: árbitro
conocido 2.540, liga último 25 % 1.026, vuelta de eliminatoria 83; en `tuning`: 1.218, 2 y 26; falta un habitual 662.

Nota de la línea base: frente a la producción anterior (`baseline`, priorN 6), la actual (priorN 40) mejora córners,
tarjetas y tiros a puerta en todas las ventanas, pero sus props de jugador de tiros y tarjetas son algo peores en
tuning (≥ 1 a puerta +0,0006, ≥ 2 tiros +0,0005, tarjeta +0,0003 de Brier, IC por encima de 0): los factores del
rival de las props salen de esas proyecciones.

## Caché y rendimiento

- `.cache/eval/cache/baseline-<datos>-<código>.json`: predicciones de la línea base y Dixon-Coles walk-forward. Se
  invalida sola si cambian los datos (tamaño/fecha de `data-store/*.json`) o el código del núcleo (todo `pipeline/`
  salvo las variantes, `src/lib/models` y la CLI). `--no-cache` fuerza el recálculo.
- En memoria, una variante reutiliza de la base lo que sus ganchos no cambian: modelos actuales y Elo (sin `elo`/`dc`),
  Dixon-Coles walk-forward (sin `dc`), estadísticas (mismos ganchos `stats`; con `stats.adjust` solo si es el mismo
  objeto) y props (además, mismo gancho `players` y mismos λ).
- Versión de la caché: 4 (ventana `prev`, faltas/tiros, líneas por equipo y props).
- Los datos no se descargan durante los experimentos: todos los agentes usan el mismo `data-store`.

## Llevar una variante a producción

Solo el agente de combinación: `npx tsx pipeline/build.ts --variant=<nombre> --out=<directorio>` publica con la
variante en un directorio aparte para revisar los JSON (no lo uses para `public/data`). La integración definitiva se hace
en el núcleo (`MODEL` en `pipeline/config.ts` o el código correspondiente), con la cifra del holdout mirada una vez.
