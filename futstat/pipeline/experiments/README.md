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
Córners / tarjetas: binomial negativa con su propio contexto (`stats`), independiente de lo anterior.
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

### Qué ve cada gancho (y por qué no puede mirar el futuro)

- `match` es un **`PreMatch`**: el partido sin marcador, estadísticas, eventos, forma de ESPN ni estado final (las
  cuotas de cierre sí están: son pre-partido).
- `before` / `ctx.history` es una **`HistoryView`** cortada en el inicio del partido: `teamMatches(id)`,
  `compMatches(id)` (solo partidos **terminados con inicio anterior**) y `eloBefore(id)`.
- `HookInfo` (en `lambdaAdjust` y `totals`): Elo pre-partido, modelo Dixon-Coles walk-forward usado (ajustado con días
  anteriores), ρ, mercado sin margen, partidos Elo previos y los rasgos.
- `combine.prepare` recibe `WalkForwardRow`: componentes pre-partido + resultado a 90' de partidos **anteriores** a la
  fecha de reajuste. Las filas existen solo para la temporada actual (el walk-forward empieza en su primer partido,
  enero de 2026 en las competiciones de año natural): en junio hay ~1.000 filas, casi todas sin cuotas.
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
**añadiendo partidos «del futuro» envenenados** (los mismos equipos, al día siguiente, en una copa ficticia, con 9-0,
30 córners, 9 tarjetas y cuotas extremas) y exige que **todas** las salidas (1X2, más de 2,5, ambos marcan, λ,
córners, tarjetas) sean idénticas. Si algo cambia: `¡FUGA DETECTADA!`, código de salida 2 y resultados no válidos.
Producción y `example` la pasan con diferencia 0; una variante con estado global la falla (test incluido).

---

## Qué mide `eval-model`

En la ventana pedida, sobre los partidos con resultado y predicción de la base y de la variante:

- **1X2**: RPS (métrica principal), log-loss, Brier, acierto.
- **Más/menos 2,5** y **ambos marcan**: Brier, log-loss, acierto.
- **Goles por equipo**: deviance Poisson media de λ frente a los goles reales.
- **Córners**: Brier de más de 8,5 / 9,5 / 10,5, MAE del total y log-verosimilitud negativa del total exacto.
  **Tarjetas**: igual con 3,5 / 4,5.
- **Segmentos**: con/sin cuotas, ligas/copas/continentales, top (tier ≥ 8: LaLiga, Premier, Serie A, Bundesliga,
  Ligue 1, Champions, Europa League, Libertadores) / resto.
- **Diferencia con la base** e **intervalo bootstrap al 95 % remuestreando días completos** (1.000 réplicas, semilla
  fija) para RPS, log-loss, Brier, más/menos, ambos marcan, deviance, córners y tarjetas, y para el RPS de cada
  segmento. `P(mejora)` = fracción de réplicas en que la variante pierde menos.
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

## Caché y rendimiento

- `.cache/eval/cache/baseline-<datos>-<código>.json`: predicciones de la línea base y Dixon-Coles walk-forward. Se
  invalida sola si cambian los datos (tamaño/fecha de `data-store/*.json`) o el código del núcleo (todo `pipeline/`
  salvo las variantes, `src/lib/models` y la CLI). `--no-cache` fuerza el recálculo.
- En memoria, una variante reutiliza de la base lo que sus ganchos no cambian: modelos actuales y Elo (sin `elo`/`dc`),
  Dixon-Coles walk-forward (sin `dc`) y córners/tarjetas (sin `stats`).
- Los datos no se descargan durante los experimentos: todos los agentes usan el mismo `data-store`.

## Llevar una variante a producción

Solo el agente de combinación: `npx tsx pipeline/build.ts --variant=<nombre> --out=<directorio>` publica con la
variante en un directorio aparte para revisar los JSON (no lo uses para `public/data`). La integración definitiva se hace
en el núcleo (`MODEL` en `pipeline/config.ts` o el código correspondiente), con la cifra del holdout mirada una vez.
