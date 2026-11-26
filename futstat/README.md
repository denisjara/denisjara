# FutStat Lab

[![Actualización diaria](https://github.com/denisjara/denisjara/actions/workflows/futstat-daily.yml/badge.svg)](https://github.com/denisjara/denisjara/actions/workflows/futstat-daily.yml)

**Dashboard de analítica y predicción de fútbol que se actualiza solo, cada 3 horas.**

Web publicada: **https://denisjara.github.io/denisjara/**

FutStat Lab reúne en una sola aplicación lo que ofrecen las apps de las casas de apuestas (calendario,
mercados, cuotas, estadísticas de partido y de jugadores) y le añade una capa de analítica propia:
modelos de rating, modelos de goles, mercado sin margen, ensamble calibrado, proyecciones de córners,
tarjetas y tiros, *props* de jugadores, simulación de temporada y un backtest público que mide cuánto
acierta el modelo frente a las casas de apuestas.

> **Juego responsable (+18).** FutStat Lab es una herramienta informativa y educativa. No es una casa
> de apuestas, no acepta apuestas ni está afiliada a ningún operador. Ninguna probabilidad garantiza un
> resultado. Lee el [aviso completo](#juego-responsable-18) al final.

---

## Índice

1. [Qué es FutStat Lab](#qué-es-futstat-lab)
2. [Secciones de la app](#secciones-de-la-app)
3. [Competiciones cubiertas](#competiciones-cubiertas)
4. [Modelos estadísticos](#modelos-estadísticos)
5. [Fuente de datos y limitaciones](#fuente-de-datos-y-limitaciones)
6. [Actualización automática](#actualización-automática)
7. [Uso local](#uso-local)
8. [Seguridad y robustez](#seguridad-y-robustez)
9. [Estructura del proyecto](#estructura-del-proyecto)
10. [Contrato de datos](#contrato-de-datos)
11. [Juego responsable (+18)](#juego-responsable-18)

---

## Qué es FutStat Lab

FutStat Lab tiene dos piezas:

1. **Un pipeline de datos en Node/TypeScript** (`pipeline/`) que descarga datos públicos de ESPN,
   guarda un almacén incremental (`data-store/`), ajusta todos los modelos y publica ficheros JSON
   estáticos en `public/data/`.
2. **Una app web en React + Vite + TypeScript + Tailwind** (`src/app/`) que lee esos JSON y los presenta
   como un dashboard deportivo: partidos populares, una sección por liga y por competición, análisis
   completo de cada partido, jugadores, apuestas de valor y la metodología con su backtest.

Un workflow de GitHub Actions ejecuta el pipeline **cada 3 horas**, compila la web y la despliega en
GitHub Pages. No hay servidor ni base de datos: todo es estático, rápido y gratuito de alojar.

Durante los partidos, la propia web consulta el marcador del día de ESPN cada 60 segundos para mostrar
resultados en vivo sin esperar a la siguiente actualización.

### Versión portátil (un solo archivo)

Además de la web, cada actualización genera **`FutStat-Lab.html`**: un único archivo (~15 MB) con la app,
las tipografías, **todos** los datos del día (las ~900 fichas de competiciones, partidos, equipos y
jugadores, comprimidas dentro del propio HTML) y los **escudos** de los equipos. Se descarga desde la web
publicada (`https://denisjara.github.io/denisjara/FutStat-Lab.html`) y se abre con **doble clic** en
cualquier navegador moderno (Safari 16.4+, Chrome, Edge, Firefox), sin instalar nada, sin servidor y sin
conexión; con internet además funciona el marcador en vivo. **Se actualiza solo:** cada vez que lo abres
con internet comprueba si la web publicada tiene datos más nuevos y, si los tiene, los usa (sin descargar
nada de nuevo); sin conexión usa los datos que lleva dentro. Hay una copia en
[`descargas/FutStat-Lab.html`](descargas/FutStat-Lab.html) (en GitHub: botón «Download raw file»).
Para generarlo en local: `npm run build:standalone` → `standalone/FutStat-Lab.html`.

---

## Secciones de la app

| Sección | Ruta | Qué muestra |
|---|---|---|
| **Inicio / Partidos populares** | `/` | Los partidos más relevantes de las próximas 72 h (ranking de popularidad), partidos de hoy y de mañana, resultados recientes con acierto del modelo, mejores apuestas de valor, jugadores en mejor forma y titulares del día. |
| **Pronósticos del día** | `/hoy` | Los mejores pronósticos de hoy y de los 3 días siguientes con partidos, en todos los mercados validados fuera de muestra: resultado, goles, tiros y tiros a puerta, córners, tarjetas, faltas y jugadores. Bloque destacado para la competición continental del día (Champions, Europa League…), filtros por día, competición y categoría (`?dia=&comp=&cat=`), «Top del día» (uno por partido), combinadas sugeridas con su histórico fuera de muestra y, por partido, números esperados, lectura en viñetas y una frase con las cifras de cada pronóstico. |
| **Calendario** | `/partidos` | Todos los partidos por día y competición, con probabilidades 1X2, goles esperados, marcador más probable y cuotas cuando existen. |
| **Alta confianza** | `/confianza` | Selecciones muy probables y de cuota baja cuyo mercado ha acertado al menos el 80 % fuera de muestra. Cabecera con el acierto real del holdout (n e intervalo de Wilson) junto a la línea base sin modelo, la tasa base y el lift; qué es y qué no es; picks de los próximos 14 días por día (probabilidad, cuota justa y de mercado, validación de su regla); acierto por mercado frente a su tasa base y resultados recientes con ✓/✗. |
| **Ligas** | `/c/<liga>` | Una sección propia por cada liga (LaLiga, Premier League, Serie A, Bundesliga…) con pestañas: clasificación (con xPts y Elo), próximos partidos, resultados, estadísticas de equipos (goles, córners, tarjetas, tiros, posesión, over/BTTS, porterías a cero, goles por tramo de minutos), ratings, simulación de temporada, jugadores y backtest de esa liga. |
| **Competiciones** | `/c/<competición>` | Champions, Europa League, Conference, Libertadores, Sudamericana, Nations League y copas nacionales, con la misma estructura (tabla de fase de liga cuando existe). |
| **Análisis de partido** | `/m/<id>` | Ficha completa al estilo de una casa de apuestas: más de 20 familias de mercados (1X2, doble oportunidad, empate no apuesta, más/menos goles, ambos marcan, hándicap asiático y europeo, marcador exacto, mitades, descanso/final, goles por equipo, córners, tarjetas, tiros, faltas…) con probabilidad del modelo, cuota justa, cuota de mercado y valor esperado; matriz de marcadores; desglose del modelo (Dixon-Coles, Elo, mercado y ensamble) con explicación en lenguaje natural; forma reciente de ambos equipos; cara a cara; comparativa estadística; proyecciones de córners, tarjetas, tiros, tiros a puerta, faltas y fueras de juego; *props* de jugadores; y, en partidos terminados, estadísticas reales y eventos. |
| **Equipo** | `/t/<id>` | Elo e historial, estadísticas de temporada (local/visitante), forma, todos sus partidos, próximos rivales y plantilla con estado de forma. |
| **Jugadores y estado de forma** | `/jugadores` | Ranking global por índice de forma (0–100) con goles, asistencias, tiros, tiros a puerta, tarjetas, faltas cometidas y recibidas, fueras de juego, paradas, métricas por 90 minutos y sus últimos 5 partidos. |
| **Apuestas de valor** | `/valor` | Selecciones donde la probabilidad del modelo supera a la implícita en la cuota (EV positivo), con *edge*, cuota justa, confianza y stake sugerido por Kelly fraccional. |
| **Modelo / Backtest** | `/modelo` | Metodología explicada, parámetros, y resultados del backtest *walk-forward*: Brier, log-loss, RPS, acierto, calibración y comparación contra el mercado y contra una referencia ingenua. |

---

## Competiciones cubiertas

Definidas en [`pipeline/config.ts`](pipeline/config.ts) (añadir una competición es añadir una línea).

- **Ligas de Europa:** LaLiga, Premier League, Serie A, Bundesliga, Ligue 1, Eredivisie, Primeira Liga,
  Süper Lig, LaLiga Hypermotion, Championship y Saudi Pro League.
- **Ligas de América:** Brasileirão Série A, Liga Profesional Argentina, Liga MX, MLS y Primera División de Chile.
- **Competiciones continentales:** UEFA Champions League, UEFA Europa League, UEFA Conference League,
  CONMEBOL Libertadores, CONMEBOL Sudamericana y UEFA Nations League.
- **Copas nacionales:** Copa del Rey, FA Cup, Carabao Cup, Coppa Italia, DFB-Pokal y Copa Chile.

---

## Modelos estadísticos

Toda la matemática vive en [`src/lib/models/`](src/lib/models/) como funciones puras (sin I/O),
cubiertas por tests y utilizables tanto en Node como en el navegador. El pipeline
([`pipeline/analytics/`](pipeline/analytics/)) las combina.

### 1. Elo global

- Un único rating Elo para **todos los equipos de todas las competiciones**, actualizado en orden
  cronológico, de modo que los partidos europeos e internacionales conectan la fuerza relativa entre ligas.
- Estilo *World Football Elo*: `ΔR = K · G · (W − We)`, con `K = 20`, ventaja de campo de 65 puntos y
  multiplicador por diferencia de goles `G` (1 con uno o ninguno, 1,5 con dos y `(11 + dif) / 8` con tres o más).
- Los equipos nuevos arrancan en `1500 + (tier − 5) · 30` según el prestigio de su liga doméstica; los recién
  ascendidos, algo por debajo de la media de su liga.
- Los equipos que **solo aparecen en copas** (categorías no cubiertas: Primera Federación, League One, amateurs de la
  FA Cup…) arrancan con tier 1 (1380 puntos) y, en la Copa del Rey y la DFB-Pokal, cuyas primeras rondas enfrentan a
  clubes regionales con los de primera, con tier −2 (1290). En el backtest del Elo sobre los 611 partidos de copa con
  algún equipo sin liga, el RPS baja de 0,213 (tier 3, el valor anterior) a 0,195.
- Las **selecciones nacionales** (Nations League) tienen su propio Elo y su propio ranking: el ranking Elo global se
  calcula solo entre clubes.
- La probabilidad de empate se modela explícitamente: `P(empate) = base · exp(−(dif / escala)²)`, con
  `base` y `escala` ajustados por máxima verosimilitud sobre los partidos históricos.

### 2. Dixon-Coles con decaimiento temporal

- Modelo de Poisson bivariante de goles: `λ_local = base · ataque_local · defensa_visitante · ventaja_local`
  y `λ_visitante = base · ataque_visitante · defensa_local`.
- Corrección de Dixon-Coles (parámetro `ρ` ∈ [−0,2; 0,2]) para los marcadores bajos (0-0, 1-0, 0-1, 1-1),
  que el Poisson independiente subestima o sobrestima.
- **Ponderación temporal** `w = exp(−ξ · días)` con `ξ = 0,0019` (vida media ≈ 1 año) sobre una ventana de
  540 días: los partidos recientes pesan más.
- **Regularización** hacia la media de la liga para equipos con pocos partidos (recién ascendidos, inicio
  de temporada).
- En copas y competiciones continentales se combinan el Elo (convertido a goles esperados) y el
  Dixon-Coles de la liga doméstica de cada equipo cuando existe.

### 3. Mercado sin margen (método de Shin)

- Se leen las cuotas publicadas por ESPN (DraftKings), se convierten de americanas a decimales y se mide
  el margen de la casa (`overround = Σ 1/cuota − 1`).
- Para obtener la probabilidad "real" que descuenta el mercado se elimina el margen con el **método de
  Shin**, que modela la presencia de apostadores informados y corrige el sesgo favorito/no favorito
  (también hay métodos multiplicativo y de potencia).
- Se guarda el histórico de cuotas de cada ejecución para ver el **movimiento de línea** (apertura → actual).

### 4. Ensamble y recalibración de λ

- La probabilidad final 1X2 es un **pool lineal** de las fuentes, con dos juegos de pesos calibrados por separado:
  - **con cuotas:** Dixon-Coles 5 %, Elo 15 % y mercado sin margen 80 %;
  - **sin cuotas:** Dixon-Coles 50 % y Elo 50 %.
- Los pesos salen de una rejilla sobre el backtest *walk-forward* (3.666 partidos, 2.629 con cuotas de cierre),
  quedándose con el menor RPS. Con cuotas: 0,2/0,2/0,6 → 0,1992; 0,1/0,1/0,8 → 0,1978; 0,05/0,15/0,8 → 0,1977.
  Sin cuotas: 0,7/0,3 → 0,2183; 0,5/0,5 → 0,2182. El peso del mercado se limita al 80 %: el backtest usa **cuotas de
  cierre** (las más precisas), mientras que los partidos próximos se predicen con cuotas previas; sin ese límite el
  óptimo sería copiar el mercado y el modelo no aportaría una opinión propia.
- En cruces entre ligas sin Dixon-Coles, la parte de goles sale del modelo Elo→goles y pesa el 20 % de lo que
  pesaría Dixon-Coles.
- Si alguno de los equipos tiene **menos de 10 partidos en el Elo** (recién llegado, equipo de copa) y hay cuotas, el
  peso de Dixon-Coles y Elo baja de forma lineal en favor del mercado (en esos 404 partidos el RPS pasa de 0,1773 a
  0,1763).
- Después se **recalibran los goles esperados**: se buscan los `(λ_local, λ_visitante)` cuya matriz de
  Dixon-Coles reproduce el 1X2 del ensamble (y la línea de 2,5 goles cuando existe). Así **todos** los
  mercados derivados son coherentes con la probabilidad final y no solo el 1X2.
- **Partidos sin línea de goles de la casa** (salvo copas nacionales), desde el 22-nov-2026: el total de goles esperado
  se contrae hacia la media de la competición, `T' = L + 0,5 · (T − L)`, manteniendo el 1X2 (`L` = goles por partido de
  la competición en los últimos 365 días, vida media 180 días, 30 partidos ficticios hacia 2,6; solo partidos
  anteriores). Sin mercado, los totales de Dixon-Coles estaban demasiado dispersos (donde predecía 1,78 goles hubo 2,12;
  donde 3,25, hubo 2,85). Ver [Cambios del modelo](#13-cambios-del-modelo-22-nov-2026).
- Un índice de confianza (0–1) combina el acuerdo entre fuentes y el volumen de datos disponible.

### 5. Mercados derivados

A partir de la matriz de marcadores (0–7 goles por equipo) se calculan de forma exacta:

- 1X2, doble oportunidad, empate no apuesta.
- Más/menos goles 0,5–5,5, goles por equipo, goles totales exactos, par/impar.
- Ambos marcan y ambos marcan + resultado.
- Hándicap asiático (líneas −2,5 a +2,5 cada 0,25, incluidas medias líneas y líneas de cuarto) y hándicap europeo.
- Marcador exacto (top 15 + "otro"), margen de victoria, portería a cero, gana sin encajar, primer equipo en marcar.
- Mitades: 1X2 al descanso, más/menos en la 1.ª y 2.ª parte, descanso/final (9 combinaciones); la primera
  parte usa el 45 % de los goles esperados y la segunda el 55 %.

Cada selección muestra probabilidad, **cuota justa** (`1 / p`), cuota de mercado cuando existe y **valor
esperado** (`EV = p · cuota − 1`).

### 6. Binomial negativa para córners, tarjetas, tiros y faltas

- Para córners, tarjetas, tiros, tiros a puerta, faltas y fueras de juego se estima la media de cada equipo
  cruzando lo que genera con lo que concede su rival, con *shrinkage* hacia la media de la liga (40 partidos ficticios
  desde el 22-nov-2026; antes 6, demasiado débil: en el holdout el Brier de córners bajó de 0,2463 a 0,2400 y el de
  tarjetas de 0,2372 a 0,2295).
- Estas variables están **sobredispersas** (varianza mayor que la media), así que se modelan con una
  **binomial negativa** cuya dispersión se estima por el método de momentos.
- La distribución del total se obtiene por convolución de las de ambos equipos: escalera de líneas
  más/menos, total exacto y "quién tendrá más" (local/igual/visitante).

### 7. Jugadores: estado de forma y *props*

- Estadísticas por partido de cada jugador (minutos, goles, asistencias, tiros, tiros a puerta, tarjetas,
  faltas cometidas y recibidas, fueras de juego, paradas) y métricas por 90 minutos.
- **Índice de forma 0–100** ponderado por recencia y una nota 0–10 por partido para los últimos 5.
- *Props* por partido: minutos esperados y probabilidad de marcar, asistir, marcar o asistir, al menos 1 o
  2 tiros, al menos 1 o 2 tiros a puerta, ver tarjeta y cometer 2 o más faltas. Las tasas individuales se
  regularizan para no sobrerreaccionar a muestras pequeñas y se ajustan a los minutos esperados y al
  contexto del partido.

### 8. Simulación Monte Carlo de temporada

- Se simulan **10 000 veces** los partidos que quedan con los goles esperados del modelo. El calendario es el real:
  en las temporadas que acaban el año siguiente (Ago→May, fase de liga UEFA) también se descargan los partidos de
  enero a mayo; solo si la fuente aún no los publica se completan cruces de forma sintética.
- Resultado: puntos esperados, posición esperada, distribución completa de posiciones y probabilidades
  de cada zona (campeón, Champions, Europa, playoff, descenso…, según la competición).

### 9. Backtest *walk-forward*

- Cada partido terminado se predice **solo con la información disponible antes de jugarse** y se compara
  con lo que pasó: Elo previo al partido, Dixon-Coles re-ajustado cada semana con los partidos anteriores y, para
  cada competición, los parámetros de empate del Elo, el modelo Elo→goles y las medias de goles ajustados **solo
  con partidos anteriores al inicio de su temporada** (sin fuga de información). La única excepción es la liga
  doméstica asignada a cada equipo, que solo decide qué modelo de goles se usa.
- Resultado del 3 de noviembre de 2026 (3.666 partidos): RPS 0,2034, Brier 0,5907 y acierto 51,8 % (antes de
  recalibrar los pesos y el Elo inicial de los equipos de copa y de quitar la fuga de información: 0,2049, 0,5939 y
  51,2 %). El mercado de cierre, en los 2.629 partidos con cuotas, marca 0,1970.
- Métricas: **Brier** multiclase, **log-loss**, **RPS** (*Ranked Probability Score*, la métrica de
  referencia para 1X2 por respetar el orden local-empate-visitante) y porcentaje de acierto.
- Comparación contra Elo solo, Dixon-Coles solo, el **mercado** (cuotas de cierre sin margen) y una
  referencia ingenua (frecuencias de la liga).
- **Calibración** por tramos: cuando el modelo dice 40 %, ¿ocurre de verdad el 40 % de las veces?
- Brier y acierto de más/menos 2,5 y ambos marcan, y simulación de ROI a stake fijo de las apuestas de valor.

### 10. Apuestas de valor y Kelly fraccional

- Una selección es "de valor" cuando `EV ≥ 5 %`, la probabilidad del modelo es al menos del 12 % y la cuota
  no supera 8.
- El stake sugerido usa el **criterio de Kelly** `f = (p · cuota − 1) / (cuota − 1)` en versión
  **fraccional (¼ de Kelly)** y con tope del 5 % del bankroll, para reducir la varianza y el impacto de los
  errores del modelo.
- Cada selección lleva *edge* (`p − 1/cuota`), cuota justa y una confianza alta/media/baja.
- Como el ensamble da un 80 % de peso al mercado cuando hay cuotas, solo aparecen selecciones de valor cuando el
  modelo discrepa mucho de la casa; es normal que algunos días no haya ninguna. En el backtest frente a cuotas de
  cierre, apostar a esas selecciones habría perdido dinero: no son una recomendación.

### 11. Pronósticos de alta confianza

El 1X2 acierta en torno al **52 %** (el mercado de cierre, ~54 %): es lo normal en fútbol y **no se puede llevar al
80 % para todos los partidos**. Esta sección es otra cosa: entre muchas selecciones de cada partido, publica
**selecciones muy probables y de cuota baja** cuyo mercado ha acertado al menos el 80 % fuera de muestra. **No son una
ventaja frente a la casa**: casi todo su acierto es estructural (ver la línea base sin modelo). Motor:
[`pipeline/analytics/confidence.ts`](pipeline/analytics/confidence.ts); publicación:
[`pipeline/publish/confidence.ts`](pipeline/publish/confidence.ts) → `public/data/confidence.json`; informe:
`npx tsx scripts/eval-confidence.ts`.

**Procedimiento (sin fuga de datos):**

- **Candidatos:** hasta 23 familias por partido (gana el favorito, doble oportunidad, empate no apuesta, hándicap +1,5,
  más/menos goles, ambos marcan, goles por equipo, córners y tarjetas), como mucho una por familia, con probabilidad
  entre 0,50 y 0,93 (por encima es trivial).
- **Walk-forward:** cada partido terminado de la temporada se vuelve a predecir solo con datos anteriores a su inicio
  (Elo previo, Dixon-Coles re-ajustado, parámetros de pretemporada, proyecciones de córners/tarjetas con partidos
  anteriores y cuotas de cierre). Sin cuotas, resultado y goles exigen al menos 10 partidos previos de cada equipo;
  córners y tarjetas, 5 con ese dato.
- **Resolución a 90 minutos**, como las casas: con prórroga o penaltis, goles y resultado se reconstruyen con los eventos
  de gol hasta el minuto 90 (si no cuadran con el marcador, el partido se excluye) y córners y tarjetas se excluyen. Un
  total de 0 tarjetas cuenta como dato ausente.
- **Umbrales por familia y fuente** (con cuotas / sin cuotas): recalibración de Platt; el umbral parte de la
  probabilidad cuya versión recalibrada llega al 82 % y la cola debe acertar ≥ 82 % con n ≥ 80 y un límite inferior de
  Wilson (90 %) ≥ 78 %. **Solo se publica el nivel oro**: la franja que acierta ≥ 85 % en el histórico de su regla. Como
  mucho 2 pronósticos por partido, de temas distintos.
- **Validación por regla:** un walk-forward mensual repite todo el procedimiento cada mes con los partidos anteriores
  (desde el primer mes con ≥ 1.000 partidos previos). Una regla (familia y fuente) solo se publica con **≥ 30 picks y
  ≥ 80 % de acierto fuera de muestra** acumulados en los meses anteriores. «Más de 2,5 tarjetas» está **excluida de
  antemano** (74,4 % en el walk-forward de la revisión).
- **Calibración frente a holdout:** las reglas que se miden se ajustan solo con el 60 % más antiguo de los partidos y se
  validan solo con meses anteriores al holdout; después se aplican sin tocar nada al resto.
- **Producción:** el mismo procedimiento con todo el historial, validado con todo el walk-forward.

**Cifras reales (build del 18 de noviembre de 2026, datos hasta el 17 nov; se recalculan en cada actualización):**

| Tramo | Partidos | Pronósticos (aciertos / resueltos) | Acierto (Wilson 90 %) |
|---|---|---|---|
| **Holdout (17 sept – 17 nov), reglas ajustadas sin él** | **1.605** | **2.362 / 2.630** | **89,8 % (88,8–90,7 %)** |
| Tramo final del holdout (26 oct – 17 nov) | 610 | 921 / 1.031 | 89,3 % (87,6–90,8 %) |
| Walk-forward mensual (1 jun – 17 nov, reglas reajustadas y validadas cada mes) | 2.984 | 4.212 / 4.695 | 89,7 % (89,0–90,4 %) |
| Partidos posteriores a la revisión (15–17 nov), únicos limpios frente a las correcciones | 31 | 49 / 51 | 96,1 % (88,8–98,7 %), aún muy pocos |

**Contexto obligatorio (mismos partidos del holdout):**

| Referencia | Acierto |
|---|---|
| Estos pronósticos | 89,8 % (n = 2.630) |
| Cada pronóstico acertando como la tasa base de su familia (su selección natural, sin umbral, en todos los partidos) | 89,3 % → **lift +0,5 pp** |
| Estrategia fija SIN modelo: el visitante marca menos de 3 goles + más de 1,5 tarjetas, en todos los partidos | 88,4 % (2.761 / 3.125; 87,4–89,3 %) |

Por familia (holdout, acierto frente a tasa base): hándicap +1,5 88,6 % frente a 91,1 % (**−2,5 pp**); más de 1,5
tarjetas 92,3 % frente a 93,8 % (**−1,5 pp**); un equipo marca menos de 3 89,0 % frente a 89,3 % (−0,3 pp); más de
6,5 córners 89,4 % frente a 85,4 % (+4,0 pp); un equipo marca 91,7 % frente a 85,7 % (+5,9 pp); más de 1,5 goles
89,2 % frente a 80,9 % (+8,4 pp); menos de 4,5 goles 90,1 % frente a 80,1 % (+10,0 pp). Cuota justa media **1,13**.

**Advertencias:**

- **Alto acierto no es beneficio ni ventaja.** Son cuotas muy bajas. En el holdout ningún pick publicado tiene cuota
  de cierre (doble oportunidad y empate no apuesta solo se validaron después del corte); en el walk-forward, 139 de
  4.709 la tienen (casi todas sintéticas desde el 1X2): **ROI −0,9 %**. Para el resto ESPN no publica precio.
- **Cobertura casi total:** el 87 % de los partidos tiene pronóstico (unos 43 al día con partidos); 1 de cada 10 falla.
- **Transparencia:** las correcciones de la revisión adversarial del 18 nov (solo oro, sin «más de 2,5 tarjetas»,
  validación por regla, resolución a 90 minutos, 0 tarjetas = ausente) se decidieron **después de ver el holdout y el
  walk-forward**, así que el holdout ya no es del todo virgen para ellas. Antes de corregir, con datos hasta el 14 nov,
  el holdout acertaba 88,8 % (2.522/2.841; Wilson 87,8–89,7 %), con la plata en 79,9 %. Solo los partidos posteriores
  al 14 nov son limpios frente a estas decisiones (aún muy pocos).
- **Cuotas de cierre:** ESPN las entrega con la fecha del partido como marca de tiempo, así que esa marca no prueba que
  sean previas. Pruebas empíricas: el favorito de cierre acierta ~54 % con log-loss ~0,96 (valores típicos previos al
  partido); frente al último registro previo (n = 280) el cierre solo se mueve 0,37 pp hacia el resultado (ningún caso
  > 15 pp); con cuotas de APERTURA el holdout acertaba 88,9 % (con cierre, 88,8 %).
- **Fugas residuales mínimas:** la liga doméstica asignada y el Elo inicial usan información posterior (Δprob = 0 en 5
  días del holdout; máx. 0,0005 en días anteriores; ningún pick cambia); los pesos del ensamble se ajustaron con
  partidos que incluyen el holdout (con pesos alternativos, 88,9 %).
- **Validación limitada:** dos meses de holdout, casi sin picks sin cuotas fuera de muestra; Wilson supone picks
  independientes (con 2 por partido no lo son del todo; un bootstrap por día da intervalos casi iguales).
- «Resultados recientes» es lo que habría publicado el walk-forward mensual, no un registro de lo que se publicó.

### 12. Pronósticos del día

Respuesta a «¿qué podría apostar hoy?» en todos los mercados que el modelo sabe medir: resultado, goles, **tiros y tiros
a puerta**, córners, tarjetas, **faltas** y **jugadores**. Página `/hoy` y bloque en Inicio. Motor:
[`pipeline/analytics/daily.ts`](pipeline/analytics/daily.ts); publicación:
[`pipeline/publish/daily.ts`](pipeline/publish/daily.ts) → `public/data/daily.json` (y `home.json` → `daily`); informe:
`npx tsx scripts/eval-daily.ts`. `confidence.json` y `/confianza` **no cambian de alcance** (resultado, goles, córners y
tarjetas).

**Qué publica.** Hoy y los 3 días siguientes con partidos (zona Europe/Madrid). Por partido: todas las selecciones que
superan una regla validada fuera de muestra, como mucho **2 por categoría y 8 por partido**, sin redundancias (nunca
«más de 6,5» y «más de 7,5» de lo mismo, ni dos de resultado, ni dos del mismo jugador), ordenadas por una puntuación
0–100; los números esperados (goles, tiros, tiros a puerta, córners, tarjetas, faltas), 2–5 viñetas de lectura y una
frase por pronóstico con las cifras que lo sostienen. Además: «Top del día» (máx. 10, uno por partido y como mucho 3 del
mismo mercado) y hasta 3 combinadas. Los partidos de hoy ya terminados aparecen con sus pronósticos reconstruidos
walk-forward y resueltos (✓/✗); los que están en juego, con los calculados solo con información previa al saque. Ninguno
de los dos entra en el top ni en las combinadas.

**Familias propias del apartado (mismo procedimiento que la alta confianza).**

- Tiros a puerta totales (más de 6,5/7,5/8,5; menos de 11,5/12,5/13,5) y de un equipo (más de 2,5/3,5); tiros totales
  (más de 19,5/21,5/23,5; menos de 31,5/33,5/35,5); faltas (más de 17,5/19,5; menos de 27,5/29,5/31,5). Salen de las
  proyecciones binomial negativa calculadas con partidos de días anteriores.
- Jugadores: «1+ tiro», «2+ tiros», «1+ tiro a puerta» y «marca gol», con sus tasas por 90 minutos de líneas anteriores
  al partido, solo para quien tiene ≥ 60 minutos esperados, jugó alguno de los 2 últimos partidos de su equipo y suma
  ≥ 270 minutos. Si el jugador no juega, el pronóstico es **nulo** (como hacen las casas) y no cuenta ni como acierto ni
  como fallo.
- Recalibración de Platt por familia y fuente (con / sin cuotas), umbral, **solo la franja oro** (≥ 85 % en su histórico)
  y **validación fuera de muestra**: walk-forward mensual; una regla solo se publica con **≥ 30 picks y ≥ 80 %**
  acumulados en los meses anteriores. Resolución con las estadísticas del partido (sin dato no se evalúa; con prórroga
  o penaltis se excluye).
- **Publicadas en el build del 26-nov-2026 (21 reglas, acierto fuera de muestra):** tiros a puerta más de 6,5 (208/227),
  más de 7,5 (49/59), menos de 12,5 (786/896), menos de 13,5 (856/989; sin cuotas 29/36); un equipo más de 2,5 tiros a
  puerta (1.357/1.539; sin cuotas 48/53) y más de 3,5 (179/193); tiros más de 19,5 (1.862/2.010), más de 21,5
  (913/1.006), más de 23,5 (57/60), menos de 33,5 (1.077/1.250), menos de 35,5 (956/1.097); faltas más de 17,5
  (149/178), más de 19,5 (279/322; sin cuotas 32/37), menos de 27,5 (634/735), menos de 29,5 (881/1.002), menos de 31,5
  (813/910); jugador 1+ tiro (1.618/1.874, más 154 nulos) y 2+ tiros (26/30, muestra mínima).
- **No publicadas:** jugador 1+ tiro a puerta y marca gol (nunca llegan a la probabilidad exigida), más de 8,5 tiros a
  puerta (sin regla), menos de 11,5 tiros a puerta (validada, 42/50, pero sin franja oro) y casi todas las variantes «sin
  cuotas» (menos de 30 picks).

**Récord fuera de muestra de la regla diaria** (la misma selección —2 por categoría, 8 por partido— aplicada mes a mes
con reglas ajustadas y validadas solo con lo anterior; walk-forward del 1-jun al 25-nov-2026, 3.167 partidos; build del
26-nov-2026, se recalcula en cada actualización):

| Categoría | Aciertos / resueltos | Acierto (Wilson 90 %) | Tasa base de sus familias | Nulos |
|---|---|---|---|---|
| **Global** | **13.689 / 15.358** | **89,1 % (88,7–89,5 %)** | — | 117 |
| Resultado | 1.625 / 1.829 | 88,8 % (87,6–90,0 %) | 88,8 % | 36 |
| Goles | 3.240 / 3.626 | 89,4 % (88,5–90,2 %) | 85,8 % | 0 |
| Tiros y tiros a puerta | 3.805 / 4.182 | 91,0 % (90,2–91,7 %) | 87,8 % | 0 |
| Córners | 1.390 / 1.615 | 86,1 % (84,6–87,4 %) | 84,7 % | 0 |
| Tarjetas | 1.087 / 1.224 | 88,8 % (87,2–90,2 %) | 87,1 % | 0 |
| Faltas | 1.615 / 1.822 | 88,6 % (87,4–89,8 %) | 84,3 % | 0 |
| Jugadores | 927 / 1.060 | 87,5 % (85,7–89,0 %) | 87,9 % | 81 |
| *Estrategia fija SIN modelo (visitante menos de 3 goles + más de 1,5 tarjetas), mismos partidos* | *5.442 / 6.162* | *88,3 % (87,6–89,0 %)* | | |

| Combinada (patas de partidos distintos) | Días acertados | Acierto | Patas de media | Cuota justa media |
|---|---|---|---|---|
| Segura | 117 / 131 | 89,3 % | 2,0 | 1,12 |
| Equilibrada | 94 / 107 | 87,9 % | 3,0 | 1,19 |
| Atrevida | 85 / 104 | 81,7 % | 4,96 | 1,39 |

Comprobación independiente (26-nov-2026): re-resolviendo con los JSON crudos del `data-store` los picks fuera de muestra
de «más de 19,5 tiros», «un equipo más de 2,5 tiros a puerta» y «jugador 1+ tiro» salen exactamente las mismas cifras
(0 discrepancias), y un walk-forward propio y más simple (umbral sobre la probabilidad bruta, sin Platt) da 91,6 %,
85,3 %, 84,0 % (menos de 29,5 faltas) y 83,9 %: por debajo del motor, pero por encima del 80 %.

**Puntuación y combinadas.** Puntuación 0–100: 50 % probabilidad recalibrada, 30 % límite inferior de Wilson (90 %) del
récord fuera de muestra de su regla, 20 % lift sobre la tasa base de su familia, −8 puntos si el lift es ≤ 0. Las
combinadas toman la mejor pata de partidos distintos (primero las de lift positivo; como mucho 2 del mismo mercado):
segura 2 patas, equilibrada 3, atrevida 4–5; su probabilidad es el producto de las probabilidades recalibradas
(supone partidos independientes). La fórmula y los topes se fijaron a priori, sin optimizarlos.

**Advertencias:**

- **Alto acierto no es ventaja ni beneficio.** Son cuotas muy bajas (cuota justa mediana 1,13; entre 1,08 y 1,30) y la estrategia fija sin
  modelo acierta casi lo mismo (88,3 % frente a 89,1 %). «Resultado» no mejora su tasa base y «jugadores» queda 0,4 pp
  por debajo: su acierto es estructural, y la página lo dice en cada pronóstico («No mejora su tasa base»).
- **Sin cuotas para medir la rentabilidad** de tiros, faltas y jugadores (ESPN no las publica); las combinadas casi nunca
  llevan cuota de mercado. Cuando la llevan y es inferior a la justa, la página avisa de que a la larga pierde.
- **Jugadores:** dependen de la alineación, que no se conoce al calcularlos (81 nulos de 1.141 en el walk-forward).
- **Combinadas:** cada pata baja la probabilidad; la atrevida habría fallado el 18 % de los días.
- Wilson supone picks independientes (con varios por partido y por día no lo son del todo). Un partido terminado solo
  aparece resuelto el mismo día; no hay histórico de días anteriores en `daily.json`.
- Juego responsable: solo mayores de 18 años. Ver [Juego responsable](#juego-responsable-18).

### 13. Cambios del modelo (22-nov-2026)

Cada idea se probó en el banco de pruebas ([`pipeline/experiments/`](pipeline/experiments/README.md)) con las mismas
predicciones walk-forward que producción, en una ventana de ajuste y dos de comprobación (T1, T2), con intervalos
bootstrap por días y comprobación automática de fuga. Lo que pasó el protocolo se miró **una sola vez** en el holdout
(16-sep → 21-nov-2026, 1.713 partidos, resultado a 90 minutos; registro en `.cache/holdout-looks.log`) y se integró en el
núcleo (`MODEL` en [`pipeline/config.ts`](pipeline/config.ts) y `PRIOR_N` en
[`pipeline/analytics/projections.ts`](pipeline/analytics/projections.ts)).

| Holdout (22-nov-2026) | Antes | Después |
|---|---|---|
| Córners (Brier) | 0,2463 | **0,2400** |
| Tarjetas (Brier) | 0,2372 | **0,2295** |
| Más/menos 2,5 goles (Brier) | 0,2369 | 0,2368 |
| Ambos marcan (Brier) | 0,2476 | 0,2472 |
| 1X2 (RPS) | 0,1978 | 0,1980 (Δ +0,0002 [−0,0004; +0,0006], no significativo) |
| Acierto 1X2 | 55,2 % | 55,2 % |

- **Adoptado:** contracción del total de goles sin línea de mercado (`MODEL.totalShrink`, s = 0,5, salvo copas) y
  contracción más fuerte de córners y tarjetas (`PRIOR_N` 6 → 40).
- **Probado y revertido:** ventaja local del Elo por grupo de competiciones para el 1X2 (`MODEL.eloProbHomeAdv`, vacío):
  mejoraba en ajuste y T2 pero no se repitió en el holdout (+0,00015 de RPS, n.s.; peor en competiciones continentales,
  +0,00122 [+0,00046; +0,00221]).
- **Probado y no adoptado** (no superaron el protocolo): xG aproximado por tiros en el ajuste de Dixon-Coles, combinador
  aprendido en lugar del pool lineal (mejoraba poco en ajuste y T2, no en T1, y empeoraba en las ligas top) y factores
  de contexto (descanso, calendario, competición europea, ascenso, inicio de temporada, movimiento de cuotas).
- El holdout ya se ha mirado una vez para estas decisiones: deja de ser del todo virgen para ellas.

### Parámetros principales

| Parámetro | Valor | Significado |
|---|---|---|
| `dcXi` | 0,0019 | Decaimiento temporal diario de Dixon-Coles (vida media ≈ 365 días) |
| `dcWindowDays` | 540 | Ventana de partidos usada para ajustar Dixon-Coles |
| `eloK` / `eloHomeAdv` / `eloInit` | 20 / 65 / 1500 | Elo: factor K, ventaja de campo, rating inicial |
| `wDixonColes` / `wElo` / `wMarket` | 0,05 / 0,15 / 0,8 | Pesos del ensamble con cuotas |
| `wDixonColesNoMarket` / `wEloNoMarket` | 0,5 / 0,5 | Pesos del ensamble sin cuotas |
| `eloGoalWeightFactor` | 0,2 | Peso relativo de Elo→goles frente a Dixon-Coles |
| `lowDataGames` / `lowDataFloor` | 10 / 0 | Partidos Elo por debajo de los cuales el mercado gana peso |
| `cupOnlyTier` | 1 | Tier del Elo inicial de equipos que solo juegan copas |
| `totalShrink` | s 0,5 · 365 días · vida media 180 · 30 ficticios · 2,6 | Contracción del total de goles sin línea de mercado (salvo copas), desde el 22-nov-2026 |
| `eloProbHomeAdv` | vacío (65 en todo) | Ventaja local del Elo por grupo para el 1X2: probada y revertida el 22-nov-2026 |
| `minEv` / `minProb` / `maxOdds` | 0,05 / 0,12 / 8 | Filtros de apuestas de valor |
| `kellyFraction` / `kellyCap` | 0,25 / 0,05 | Kelly fraccional y tope por apuesta |
| `simIterations` | 10 000 | Iteraciones de la simulación de temporada |

Todos están en `MODEL` dentro de [`pipeline/config.ts`](pipeline/config.ts). La contracción de córners, tarjetas, tiros y
faltas (`PRIOR_N` = 40 partidos ficticios, vida media 150 días) está en
[`pipeline/analytics/projections.ts`](pipeline/analytics/projections.ts).

---

## Fuente de datos y limitaciones

**Fuente:** la API pública de ESPN (`site.api.espn.com`), sin clave y con CORS abierto: calendarios y
resultados, clasificaciones, estadísticas de equipo y de jugador por partido, eventos (goles, tarjetas,
cambios) y cuotas de DraftKings.

**Limitaciones que conviene conocer:**

- **No hay saques de banda ni saques de puerta**: ESPN no los publica, así que no se modelan. Los **saques
  de esquina (córners)** sí están cubiertos.
- **No hay xG real** (no hay coordenadas de tiro). Donde la app muestra "xG" se trata de los **goles
  esperados del modelo** (λ), un *proxy* razonable pero distinto del xG basado en ocasiones.
- **Cuotas limitadas:** solo un proveedor (DraftKings vía ESPN) y no para todos los partidos ni todas las
  ligas. Sin cuotas, el ensamble usa solo Dixon-Coles y Elo y no se calculan apuestas de valor.
- **Estadísticas de jugadores** solo de los partidos con resumen disponible (últimos 180 días); algunas
  competiciones (por ejemplo, la Nations League) no los tienen.
- **No se modelan** alineaciones confirmadas, lesiones, sanciones, rotaciones, clima ni motivación.
- La API de ESPN **no es oficial ni está documentada**: puede cambiar o fallar sin aviso. El pipeline
  tolera caídas parciales (una competición que falla no detiene las demás), descarta los registros que no
  entiende y reutiliza el almacén de la ejecución anterior (ver [Seguridad y robustez](#seguridad-y-robustez)).
- Los datos se recalculan **cada 3 horas**; solo los marcadores en vivo se refrescan en tiempo real
  desde el navegador.

---

## Actualización automática

El workflow [`.github/workflows/futstat-daily.yml`](../.github/workflows/futstat-daily.yml)
("FutStat Lab — actualización automática (cada 3 horas)") hace todo el trabajo:

```
cron cada 3 h (xx:17 UTC) ─────┐
ejecución manual ───────────────┼─▶ npm ci ─▶ restaurar data-store (caché) ─▶ data:fetch (ESPN)
push a main (futstat/**) ───────┘      ─▶ comprobar (sin recortes) y guardar data-store ─▶ data:build (modelos + JSON)
                                       ─▶ data:validate ─▶ npm test ─▶ npm run build ─▶ npm audit ─▶ GitHub Pages
pull request a main ───────────────▶ ci.yml: npm ci ─▶ npm audit ─▶ typecheck ─▶ tests ─▶ build (datos de prueba)
```

- **Horario:** cada 3 horas, a las 00:17, 03:17, 06:17, 09:17, 12:17, 15:17, 18:17 y 21:17 UTC (una hora más
  en Madrid en invierno, dos en verano). GitHub puede retrasar o descartar ejecuciones programadas en horas de mucha carga, por eso hay un segundo
  intento a los :47 de cada franja.
- **Almacén incremental:** `data-store/` se conserva entre ejecuciones con la caché de GitHub Actions, así
  que cada pasada solo descarga lo nuevo y mantiene el histórico de cuotas. La **primera ejecución** parte
  de cero y tarda bastante más (descarga hasta 180 días de resúmenes).
- **Seguridad de la publicación:** `data:build` genera los JSON en un directorio temporal y solo sustituye
  `public/data/` si pasan la validación (contrato + umbrales de cordura). Si fallan la validación de datos, los
  tests o la compilación, no se despliega nada y la web sigue mostrando la última versión buena. Si ESPN no
  responde, la descarga termina con un aviso y se compila con el almacén de la ejecución anterior: la web muestra la
  fecha **real** de los datos (`meta.dataUpdatedAt`, la última descarga correcta; el indicador pasa a ámbar a las
  30 h) y la validación **rechaza publicar si esa descarga tiene más de 72 h**, de modo que el job falla en rojo y
  la web conserva la última versión buena. Una vulnerabilidad alta o crítica en una dependencia de producción
  (`npm audit`, al final del job para no impedir la descarga de datos) también bloquea la publicación. Más detalles en
  [`.github/SECURITY.md`](../.github/SECURITY.md).
- **Copia de seguridad del almacén:** los lunes (pasada de las 00:17 UTC) y en cada ejecución manual se sube
  `data-store/` como artefacto `futstat-data-store-<id>` (90 días). Para usarlo: descárgalo desde la ejecución en la
  pestaña Actions y copia los `*.json` en `futstat/data-store/` (en local). Si la caché de CI se perdiera, la siguiente
  ejecución vuelve a descargar los últimos 180 días; el histórico de cuotas previas y los resúmenes más antiguos solo
  se conservan en estas copias.

### Cómo activarlo (una sola vez)

1. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Asegúrate de que el workflow está en la rama por defecto (`main`): **los cron solo se ejecutan en la
   rama por defecto**.
3. Lanza la primera ejecución a mano: **Actions → "FutStat Lab — actualización automática" → Run workflow**
   (o `gh workflow run futstat-daily.yml`).
4. Al terminar, la web queda en **https://denisjara.github.io/denisjara/**.

**Notas:**

- GitHub puede retrasar unos minutos las ejecuciones programadas en horas de mucha carga.
- En repositorios públicos, GitHub **desactiva los workflows programados tras 60 días sin actividad** en
  el repositorio. Si ocurre, vuelve a activarlo desde la pestaña Actions.
- El workflow solo despliega desde `main`; una ejecución manual en otra rama compila y valida, pero no
  publica.

---

## Uso local

Requisitos: **Node.js 22** (el mismo que usa CI; mínimo 20) y npm. `npm run dev` y `npm run preview` solo
escuchan en `127.0.0.1` (no se exponen a la red local).

```bash
cd futstat
npm install

# Descargar datos de ESPN y generar public/data/ (fetch + build)
npm run data:update

# Servidor de desarrollo de la app
npm run dev
```

### Comandos disponibles

| Comando | Qué hace |
|---|---|
| `npm run data:fetch` | Descarga/actualiza `data-store/` desde ESPN. |
| `npm run data:build` | Ajusta los modelos, valida y, solo si todo es correcto, sustituye `public/data/*.json`. |
| `npm run data:update` | `data:fetch` + `data:build`. |
| `npm run data:validate` | Comprueba que los JSON publicados cumplen el contrato y los umbrales de cordura. |
| `npm run data:mock` | Genera datos de ejemplo realistas en `public/mock-data/` (sin red). |
| `npx tsx scripts/eval-daily.ts` | Informe de los pronósticos del día con el `data-store` real (familias publicadas y descartadas, récord por categoría y combinadas), sin escribir en `public/`. |
| `npx tsx scripts/eval-confidence.ts` | Informe de los pronósticos de alta confianza (holdout, walk-forward, reglas). |
| `npm run dev` | Servidor de desarrollo de Vite. |
| `npm run build` | Typecheck de la app + compilación a `dist/`. |
| `npm run preview` | Sirve `dist/` localmente. |
| `npm test` | Todos los tests (Vitest). |
| `npm run typecheck` | Typecheck de la app y del pipeline. |

### Opciones de la descarga

```bash
# Solo algunas competiciones (ids de pipeline/config.ts)
npm run data:fetch -- --only=laliga,premier

# Sin resúmenes de partido (rápido, sin estadísticas de jugadores)
npm run data:fetch -- --no-summaries

# Limitar los resúmenes por competición, la concurrencia y el tiempo (por defecto 30 min)
npm run data:fetch -- --max-summaries=50 --concurrency=4 --budget-minutes=10
```

### Opciones del build y de la validación

```bash
npm run data:build -- --only=laliga,premier   # publicar solo algunas competiciones (desarrollo)
npm run data:build -- --no-sanity             # solo el contrato, sin umbrales de cordura (datos parciales)
npm run data:build -- --allow-stale           # publicar aunque la última descarga correcta tenga más de 72 h
npm run data:build -- --out=/tmp/futstat-out  # otra salida: debe no existir, estar vacía o ser una salida de FutStat
npm run data:validate -- --no-sanity          # ídem para la validación suelta (también admite --allow-stale)
```

### Desarrollar la interfaz sin red

```bash
npm run data:mock                    # escribe public/mock-data/
VITE_DATA_DIR=mock-data npm run dev  # la app lee de mock-data/ en lugar de data/
```

### Tests

```bash
npm test                        # todo
npx vitest run tests/models     # solo los modelos estadísticos
npx vitest run tests/espn       # solo la normalización de ESPN y el almacén
```

---

## Seguridad y robustez

Objetivo: que la web **nunca se quede en blanco ni se rompa** por datos malos, que la actualización automática **nunca
publique datos rotos ni dañe los datos guardados**, y que usar o desarrollar el proyecto no ponga en riesgo tu equipo.

### La web

- **Content Security Policy**: scripts solo del propio sitio, imágenes solo del propio sitio y del CDN de ESPN
  (`*.espncdn.com`), conexiones solo al propio sitio y al marcador público de ESPN, sin `object`/`embed`, sin
  formularios y con `upgrade-insecure-requests`. En producción (`npm run build`) el plugin `futstat:csp`
  (`scripts/csp.ts`) la endurece: sin `'unsafe-inline'`, con los `sha256` de los bloques en línea calculados en cada
  build y con **Trusted Types** (ningún texto puede acabar en `innerHTML`/`eval`). `index.html` conserva una CSP más
  permisiva solo para `npm run dev`.
- **Nunca en blanco**: `index.html` trae dentro de `#root` una pantalla de arranque estática; si el código de la app
  no llega a cargar (404 tras un despliegue, bloqueador, navegador antiguo), a los 8 s ofrece recargar.
- **Tipografías autoalojadas** (`src/assets/fonts`, licencia OFL): la web no contacta con Google Fonts (ni envía la
  IP del visitante a terceros); los únicos orígenes externos son el CDN de imágenes y el marcador de ESPN.
- **Datos anómalos**: la capa `src/app/lib/sanitize.ts` normaliza cada JSON (números no finitos → "—", listas
  acotadas, ids y enumerados válidos, mapas sin prototipo) y las tablas de etiquetas no resuelven claves como
  `__proto__`; los gráficos no pueden entrar en bucle con rangos degenerados.
- **ErrorBoundaries** en la aplicación, las rutas y los paneles: si una parte falla con datos inesperados se muestra un
  aviso en esa parte y el resto sigue funcionando.
- Los datos que lee la web se validan antes de publicarse (ver abajo) y la app los trata de forma defensiva.
- La web es 100 % estática (sin servidor, cuentas, cookies ni formularios). React escapa todo el texto que pinta; los
  enlaces externos se abren con `rel="noopener noreferrer"`.

### Los datos (pipeline)

- **Descarga defensiva** (`pipeline/espn/client.ts`): solo `https` a `*.espn.com` (también tras redirecciones),
  respuestas de 25 MB como máximo (se corta la lectura si se superan), tipo de contenido JSON, errores de JSON o de
  forma tipados, reintentos con espera exponencial y un **cortacircuitos**: si ESPN deja de responder, la descarga
  termina en segundos con un aviso en lugar de agotar el tiempo de CI.
- **Normalización que nunca lanza** (`pipeline/espn/normalize.ts`): cada partido, jugador y fila de clasificación se
  procesa por separado; un registro dañado se descarta y se cuenta en el resumen final. Los textos se limpian
  (caracteres de control y bidi, `<`/`>`, `javascript:`; máximo 120 caracteres), los ids deben ser tokens seguros
  (acaban en nombres de archivo), los logos solo se aceptan por `https` desde `*.espncdn.com` y los números
  imposibles (marcadores fuera de 0–30, porcentajes fuera de rango, NaN/Infinity) se descartan.
- **Escrituras atómicas con copia de seguridad** (`pipeline/store.ts`): cada `data-store/<competición>.json` se
  escribe en un temporal con `fsync` y se renombra; la versión válida anterior se guarda como `.json.bak`. Si un
  archivo aparece dañado al cargarlo, se recupera la copia (o se parte de cero) con un aviso: nunca un fallo. Una
  respuesta incompleta de ESPN no borra partidos guardados ni la clasificación, y por encima de 600 MB de almacén se
  dejan de descargar resúmenes.
- **Puerta de calidad antes de publicar** (`pipeline/build.ts` + `scripts/validate-data.ts`): los JSON se generan en
  `public/data.tmp`, se validan contra el contrato (`src/types/data.ts`), sin `null`/NaN, sin textos con `<script` ni
  `javascript:`, logos permitidos, nombres de archivo seguros, y contra **umbrales de cordura** (al menos 15
  competiciones con datos, 2.000 partidos analizados, algún partido próximo o reciente en la portada, tamaño
  razonable). Solo si todo pasa se sustituye `public/data` con renombrados atómicos (la versión anterior se conserva
  hasta el final); si no, el build sale con error y `public/data` queda intacto.
- **Almacén validado en profundidad al cargarlo**: cada partido, línea de jugador y fila de clasificación se comprueba
  campo a campo (nombres, fechas, estados, marcadores, estadísticas, eventos, cuotas); lo irreparable se descarta con
  un aviso en lugar de tumbar o bloquear el build. Cuotas con un margen imposible (fuera de −2 %…30 %) se descartan
  sin rechazar toda la publicación; partidos "en juego" de hace horas o "terminados" en el futuro se publican como
  pendientes; un partido terminado no pierde su marcador ni su resumen por un fallo puntual del scoreboard.
- En CI, además, el almacén se compara con el restaurado de la caché: si una competición desaparece o pierde más del
  25 % de sus datos, no se guarda en caché ni se publica. Se ejecutan los tests y se compila la web: cualquier fallo
  impide el despliegue.

### Cadena de suministro y CI

- Versiones exactas en `package.json`, `package-lock.json` versionado e instalación con `npm ci`.
- **Dependencias auditadas** en cada publicación y en cada pull request (`npm audit`): una vulnerabilidad alta o
  crítica en una dependencia de producción bloquea el despliegue. Hoy `npm audit` no informa de ninguna.
- **Pull requests** (incluidos los de Dependabot): `.github/workflows/ci.yml` ejecuta auditoría, typecheck, tests y
  compilación antes de fusionar (márcalo como check obligatorio en la protección de `main`).
- **Dependabot** propone las subidas cada semana (esperando 7 días desde cada versión nueva) y **CodeQL** analiza el
  código y los workflows en cada cambio y cada semana.
- Workflows con **mínimos privilegios**: sin permisos por defecto, actions fijadas por SHA y credenciales que no se
  guardan en el checkout. Política de avisos de seguridad en [`.github/SECURITY.md`](../.github/SECURITY.md).

### Tu Mac

- La web publicada se ejecuta dentro del **sandbox del navegador**: no puede leer tus archivos ni ejecutar nada en
  el sistema, y la CSP limita a dónde puede conectarse.
- En local, `npm run dev` y `npm run preview` escuchan **solo en `127.0.0.1`** (no se exponen a tu red Wi-Fi) y con
  un puerto fijo. El pipeline solo habla con la API pública de ESPN, sin claves ni credenciales, y solo escribe dentro
  de `futstat/` (`data-store/` y `public/data/`).
- `npm run data:build -- --out=<dir>` **nunca borra contenido ajeno**: solo acepta un directorio que no exista, esté
  vacío o contenga una salida anterior de FutStat (rechaza `.`, `src`, tu carpeta personal o cualquier carpeta con
  otros archivos). Un cerrojo impide lanzar dos builds o dos descargas a la vez sobre los mismos datos, y los
  temporales de un proceso interrumpido se limpian solos (y nunca se copian a `dist/`).
- No se necesita ningún secreto para usar o desarrollar el proyecto.

---

## Estructura del proyecto

```
.github/workflows/futstat-daily.yml   Actualización cada 3 horas y despliegue en GitHub Pages
.github/workflows/ci.yml              Comprobaciones de cada pull request (auditoría, typecheck, tests, build)
futstat/
├── ARCHITECTURE.md        Contrato entre módulos, fuente de datos y reglas de desarrollo
├── src/
│   ├── types/data.ts      CONTRATO de los JSON publicados (UI ⇄ pipeline). Fuente de verdad
│   ├── lib/models/        Matemática pura: estadística, Poisson, Dixon-Coles, Elo, binomial negativa,
│   │                      cuotas y margen, ensamble, mercados, Kelly y métricas de evaluación
│   └── app/               App React (HashRouter): páginas, componentes y gráficos
├── pipeline/
│   ├── config.ts          Competiciones, parámetros del modelo y rutas
│   ├── types.ts           Registros internos normalizados (partidos, jugadores, almacén)
│   ├── espn/              Cliente HTTP endurecido (límites, cortacircuitos) + normalización defensiva de ESPN
│   ├── store.ts           Almacén incremental en data-store/<competición>.json (escritura atómica + .bak)
│   ├── fetch.ts           CLI de descarga
│   ├── analytics/         Ratings, predicción, mercados, proyecciones, jugadores, simulación, backtest
│   └── build.ts           CLI: data-store → public/data/*.json
├── scripts/               Utilidades (datos de ejemplo, validación = puerta de calidad)
├── tests/                 Tests de Vitest (modelos, normalización y robustez ESPN, almacén, build) y fixtures reales
├── public/data/           JSON generados (no se versionan; los produce CI)
└── data-store/            Almacén incremental (no se versiona; se guarda en la caché de CI)
```

---

## Contrato de datos

La app solo lee estos ficheros, todos tipados en [`src/types/data.ts`](src/types/data.ts):

| Fichero | Contenido |
|---|---|
| `meta.json` | Competiciones, recuentos e índice de búsqueda de equipos |
| `home.json` | Partidos populares, hoy, mañana, recientes, mejores apuestas de valor, mejores pronósticos de alta confianza (72 h) con su acierto fuera de muestra, resumen de los pronósticos del día (`daily`) y jugadores en forma |
| `competitions/<id>.json` | Clasificación, partidos, estadísticas de equipos, ratings, simulación, jugadores, promedios de liga, backtest |
| `matches/<id>.json` | Análisis completo de un partido: modelo, mercados, proyecciones, forma, H2H, comparativa, *props*, valor |
| `teams/<id>.json` | Ficha de equipo |
| `players.json` | Ranking global de jugadores por forma |
| `value.json` | Todas las apuestas de valor |
| `model.json` | Metodología, parámetros y backtest global y por competición |
| `daily.json` | Pronósticos del día: hoy y los 3 días siguientes con partidos; por partido, pronósticos validados (máx. 2 por categoría y 8 por partido) con frase explicativa, números esperados y lectura; top del día, combinadas y récord fuera de muestra (global, por categoría y por combinada) |
| `confidence.json` | Pronósticos de alta confianza de los próximos 14 días, resueltos recientes, acierto fuera de muestra (holdout) por nivel, fuente y familia, cobertura, cuota justa media, ROI con cuotas de cierre y reglas de producción |

Convenciones: probabilidades en [0, 1], cuotas decimales, fechas ISO-8601 en UTC y textos en español.

---

## Juego responsable (+18)

- FutStat Lab es una herramienta **informativa y educativa** sobre estadística aplicada al fútbol. **No es
  una casa de apuestas**, no acepta dinero ni está afiliada a ningún operador.
- Las probabilidades son **estimaciones de un modelo** y pueden fallar. Un valor esperado positivo no
  garantiza ganancias: incluso con ventaja real se encadenan rachas perdedoras.
- Las apuestas están reservadas a **mayores de 18 años** (o la edad legal de tu país) y solo con
  operadores autorizados en tu jurisdicción.
- Apuesta únicamente lo que puedas permitirte perder, fija límites de tiempo y dinero y no persigas
  pérdidas.
- Si el juego deja de ser un entretenimiento, pide ayuda: en España, [jugarbien.es](https://www.jugarbien.es)
  (Dirección General de Ordenación del Juego); en otros países, los servicios de ayuda de tu regulador local.

---

Datos: ESPN (API pública). Proyecto personal sin ánimo de lucro, sin relación con ESPN, DraftKings ni
ninguna competición o club mencionados.
