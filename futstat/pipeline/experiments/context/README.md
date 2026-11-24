# Variantes «context*»: factores de contexto → λ (regresión de Poisson walk-forward)

**Conclusión: los factores de contexto NO mejoran los pronósticos.** Ni sobre la fuente de goles (Dixon-Coles /
Elo→goles) ni sobre el ensamble final con mercado. La única pieza con signo estable es una *calibración* de la
fuente de goles (contraer la diferencia de fuerzas del Dixon-Coles un ~9 %, variante `context-dlog`), y su efecto en
el ensamble es tan pequeño que su intervalo bootstrap cruza el 0 en T1 y en T2: **no es una mejora** según el
protocolo. Recomendación: no adoptar.

## Qué hace

1. **Rasgos** (`features.ts`, solo con la vista del pasado y las cuotas pre-partido): descanso de cada equipo
   (déficit < 4 días, ≥ 10 días, diferencia de descanso), partidos en los últimos 14 días, «tras competición europea»
   (último partido continental hace ≤ 4 días), recién ascendido, partidos jugados en la competición y temporada
   (inicio de temporada), partidos en 540 días (muestra del Dixon-Coles), ventaja local reciente de la competición
   y del equipo local, movimiento de cuotas apertura → cierre (1X2 y totales).
2. **Regresión de Poisson con offset** (`glm.ts`, `regressor.ts`): goles del equipo X ~ Poisson(λ_X·exp(β·x)), dos
   observaciones por partido, L2 hacia 0 (β = 0 = producción), reajuste cada 7 días en `combine.prepare` con los
   partidos terminados que empezaron ≥ 3 h antes (sin prórrogas sin resolver). Opcional: modelos separados para
   Dixon-Coles y Elo→goles, ponderación temporal, aplicar solo con/sin cuotas.
3. **Aplicación** en `combine.blend`: nivel `goal` = λ de la fuente de goles ajustados → 1X2 y más de 2,5 de goles →
   mismo pool lineal de producción (mismos pesos) y mismo objetivo de más de 2,5. Nivel `final` = λ finales del
   ensamble (fitLambdas como el núcleo) y delta sobre el 1X2 y el más de 2,5 de producción.
   No se usa `lambdaAdjust`: ese gancho se evalúa antes de cualquier `prepare`, así que no puede usar coeficientes
   estimados walk-forward. `adjustRow(row)` devuelve la fila con la fuente ajustada para encadenarla con otro
   combinador.

**Criterio de calendario:** solo partidos YA JUGADOS antes del inicio. Los ganchos no exponen el calendario
programado, así que «antes de competición europea» no se puede calcular (ver «Pendiente»). Los descansos solo ven las
27 competiciones del conjunto de datos (sin amistosos, Mundial de Clubes, selecciones ni copas menores).

## Cuántas configuraciones probé (todas en tuning/T1/T2 y pre; nunca el holdout)

15 configuraciones en un cribado sin comprobación de fuga (script en el scratchpad) + análisis exploratorio
in-sample de los residuos (regresión con todos los rasgos sobre filas anteriores al 16-sep). 4 de ellas son
variantes publicadas y pasaron la CLI oficial con comprobación de fuga (diferencia 0):

| Variante | Términos | Nivel |
|---|---|---|
| `context` | descanso (<4, ≥10), 14 días, Europa, ascenso, inicio | goles |
| `context-full` | lo anterior + local, HA liga, HA equipo, dlog, dlog×inicio, movimiento de cuotas | goles |
| `context-final` | contexto puro, κ = 100 | final (mercado incluido) |
| `context-dlog` | log(λ propio/λ rival), modelos separados DC / Elo→goles | goles |

Cribadas y descartadas además: contexto + ventaja local; contexto + HA + dlog; solo dlog común; HA + dlog por tipo;
nivel final con todo; dlog + dlog×inicio (ligas); dlog solo sin cuotas; dlog + ascendido×inicio; dlog + «pocos
datos»; nivel + local con vida media 90 días; dlog + diferencia de descanso.

## Resultados (CLI oficial, datos del 21-nov-2026, resultado a 90')

Δ RPS 1X2 con IC 95 % bootstrap por días (negativo = mejor):

| Variante | T1 (215) | T2 (1.142) | tuning (1.357) | pre (1.014, auxiliar) |
|---|---|---|---|---|
| `context` | +0,00003 [−0,00014; +0,00019] | +0,00002 [−0,00008; +0,00011] | +0,00002 [−0,00006; +0,00010] | −0,00014 [−0,00072; +0,00044] |
| `context-full` | +0,00022 [−0,00041; +0,00078] | +0,00000 [−0,00020; +0,00020] | +0,00004; **más/menos 2,5 +0,00057 [+0,00007; +0,00131]** | — |
| `context-final` | −0,00055 [−0,00222; +0,00069] | +0,00048; **más/menos 2,5 +0,00201 [+0,00002; +0,00422]** | +0,00032 [−0,00040; +0,00093] | — |
| `context-dlog` | −0,00006 [−0,00034; +0,00028] | −0,00008 [−0,00018; +0,00003] | −0,00008 [−0,00017; +0,00003] | −0,00020 [−0,00056; +0,00009] |

`context-dlog` en detalle (base → variante):

- tuning: RPS 0,1986 → 0,1985, log-loss 0,9819 → 0,9818, Brier 0,5850 → 0,5848, acierto 50,9 → 51,0 %; más/menos 2,5
  Brier 0,2326 → 0,2326 (+0,00004); ambos marcan 0,2417 → 0,2417 (−0,00006 [−0,00009; −0,00002]); con cuotas
  −0,00005 [−0,00009; 0,00000]; sin cuotas (47) −0,00092 [−0,00337; +0,00156]; ligas −0,00008; copas −0,00001;
  **top (tier ≥ 8) +0,00014 [−0,00001; +0,00032], P(mejora) 3 %**.
- T1: ambos marcan −0,00005 [−0,00013; +0,00001]; T2: −0,00006 [−0,00010; −0,00002].
- Fuente de goles sola (cribado; la CLI muestra la fuente ANTES del combinador): T1 0,2180 → 0,2163, T2 0,2077 →
  0,2072, tuning 0,2093 → 0,2086 (−0,0007 [−0,0018; +0,0003]), pre 0,2166 → 0,2162; sin cuotas en pre (815) −0,0005
  [−0,0013; +0,0003].
- Coeficientes a 10-sep: Dixon-Coles β = −0,091 ± 0,025 (diferencias de goles esperados ~9 % demasiado amplias);
  Elo→goles β = +0,033 ± 0,040 (sin señal).

Coeficientes de contexto (regresión con todos los rasgos, filas hasta el 10-sep, ± error estándar): déficit de
descanso propio −0,04 ± 0,05, del rival −0,03 ± 0,05; 14 días ≈ 0; tras Europa propio ≈ 0, del rival +0,13 ± 0,08;
ascendido ≈ 0; inicio ≈ 0; diferencia de descanso +0,03 ± 0,04. Con los λ finales (mercado) la razón de
verosimilitud de los 19 términos es ~29 (p ≈ 0,07): el mercado de cierre ya incorpora el contexto. El movimiento de
cuotas apertura → cierre añade información a la fuente de goles (β +0,3, z ≈ 5) pero nada sobre el cierre
(β +0,10 ± 0,06 global, +0,03 en T2).

## Pendiente (fuera de mi alcance)

- «Antes de competición europea» y congestión futura: haría falta un gancho con el calendario programado conocido en
  la fecha de predicción (el almacén no guarda cuándo se programó cada partido, ojo con aplazamientos).
- No hay gancho para aplicar rasgos por partido a córners/tarjetas (los ganchos `stats` son parámetros globales).
- `eval-model` mide «Fuente de goles sola» antes del combinador: los ajustes de la fuente hechos en `combine.blend`
  no aparecen ahí.
