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

Además de la web, cada actualización genera **`FutStat-Lab.html`**: un único archivo (~19 MB, con todos los escudos) con la app,
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
| **Cuota alta 6+** | `/cuota-alta` | Apuestas de cuota 6 o más (combinadas de 2–4 partidos, sorpresas 1X2, marcador exacto y goleador) de hoy y los 3 días siguientes con partidos, con probabilidad del modelo («1 de cada N»), cuota justa, cuota de la casa cuando existe y valor esperado; aviso fijo de que la mayoría pierden (+18), calculadora, historial fuera de muestra por tipo (aciertos con Wilson, esperado, ROI con cuotas de cierre, racha sin acertar) y calibración en la banda baja. Filtros `?dia=&tipo=`. |
| **Combinada cuota 6** | `/combinada-6` | Una combinada al día de mercados mezclados (ganador de un partido, goles de otro, córners, tiros a puerta, tiros, tarjetas o faltas de otros), una pata por partido, con cuota total de la casa entre 6 y 8 y la **mayor probabilidad combinada posible** (patas validadas fuera de muestra con probabilidad recalibrada del 70–88 %). Por pata: partido, selección, probabilidad, cuota y su origen (casa, derivada o estimada); total: probabilidad («1 de cada N»), cuota justa, cuota y valor esperado. Hoy y los días siguientes con partidos, combinadas por competición continental (Champions, Europa League…) e historial fuera de muestra con Wilson, acierto por categoría y racha de fallos. Se recalcula en cada build (cada 3 horas). |
| **Calendario** | `/partidos` | Todos los partidos por día y competición, con probabilidades 1X2, goles esperados, marcador más probable y cuotas cuando existen. |
| **Alta confianza** | `/confianza` | Selecciones muy probables y de cuota baja cuyo mercado ha acertado al menos el 80 % fuera de muestra. Cabecera con el acierto real del holdout (n e intervalo de Wilson) junto a la línea base sin modelo, la tasa base y el lift; qué es y qué no es; picks de los próximos 14 días por día (probabilidad, cuota justa y de mercado, validación de su regla); acierto por mercado frente a su tasa base y resultados recientes con ✓/✗. |
| **Ligas** | `/c/<liga>` | Una sección propia por cada liga (LaLiga, Premier League, Serie A, Bundesliga…) con pestañas: clasificación (con xPts y Elo), próximos partidos, resultados, estadísticas de equipos (goles, córners, tarjetas, tiros, posesión, over/BTTS, porterías a cero, goles por tramo de minutos), ratings, simulación de temporada, jugadores y backtest de esa liga. |
| **Competiciones** | `/c/<competición>` | Champions, Europa League, Conference, Libertadores, Sudamericana, Nations League y copas nacionales, con la misma estructura (tabla de fase de liga cuando existe). |
| **Análisis de partido** | `/m/<id>` | Ficha completa al estilo de una casa de apuestas: más de 20 familias de mercados (1X2, doble oportunidad, empate no apuesta, más/menos goles, ambos marcan, hándicap asiático y europeo, marcador exacto, mitades, descanso/final, goles por equipo, córners, tarjetas, tiros, faltas…) con probabilidad del modelo, cuota justa, cuota de mercado y valor esperado; matriz de marcadores; desglose del modelo (Dixon-Coles, Elo, mercado y ensamble) con explicación en lenguaje natural; forma reciente de ambos equipos; cara a cara; comparativa estadística; proyecciones de córners, tarjetas, tiros, tiros a puerta, faltas y fueras de juego; *props* de jugadores; panel **«Factores del partido»** (pestaña Análisis: árbitro y su rigor con las tarjetas, bajas probables y sancionados, forma reciente con xG aproximado, local/visita, estado de la eliminatoria, lo que se juega cada equipo y jugadores en forma, cada pieza marcada «Usado en el modelo» o «Informativo»); y, en partidos terminados, estadísticas reales y eventos. |
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
  donde 3,25, hubo 2,85). Ver [Cambios del modelo](#15-cambios-del-modelo-22-nov-2026).
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
- **Árbitro designado** (desde el 26-nov-2026, `MODEL.referee`,
  [`pipeline/analytics/referee.ts`](pipeline/analytics/referee.ts)): si se conoce antes del partido, las medias de
  tarjetas y faltas de los dos equipos se multiplican por su severidad, `R = (observado + k·ē) / (esperado + k·ē)` en sus
  partidos terminados **anteriores** (todas las competiciones; esperado = media de la competición y temporada de cada
  uno), contraída hacia 1 con k = 30 partidos ficticios. El 90 % central va de 0,90 a 1,10 en tarjetas y de 0,95 a
  1,045 en faltas. **Hoy ESPN no publica el árbitro antes del partido**, así que en los partidos próximos el
  multiplicador es 1 (ver [Fuente de datos](#fuente-de-datos-y-limitaciones)).
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
- **Factores del rival** (desde el 26-nov-2026, `MODEL.propsOppShrink`): en las props de tiros, tiros a puerta y tarjeta
  el nivel «a favor» del propio equipo se contrae con 6 partidos ficticios y lo que concede el rival con 40. Las tasas
  del jugador ya llevan el nivel de su equipo: con 40 en los dos lados se contraía dos veces y las props empeoraron tras
  el cambio del 22-nov. Las proyecciones de equipo publicadas no cambian.
- **Bajas probables** (desde el 26-nov-2026, `MODEL.availability`,
  [`pipeline/analytics/availability.ts`](pipeline/analytics/availability.ts)), solo con partidos y líneas anteriores
  (sin alineaciones ni partes médicos): expulsado en el último partido de su equipo en la **misma** competición ⇒
  sancionado, no se publica en las props; habitual (≥ 60 % de los minutos en los 5 últimos partidos) que no jugó los 2
  últimos ⇒ minutos esperados × 0,65; que solo faltó al último, de la misma competición ⇒ × 0,9 (de otra competición
  se trata como rotación: sin cambio). Factores fijados con una exploración descriptiva de T1 (jun–jul 2026): un
  expulsado jugó el partido siguiente 0 de 35 veces; un habitual que faltó a los 2 últimos jugó el 23,5 % (n = 34).

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

### 13. Cuota alta 6+

Respuesta a «quiero algo con cuota de 6 o más». Página `/cuota-alta` y tarjeta en Inicio. Motor:
[`pipeline/analytics/longshots.ts`](pipeline/analytics/longshots.ts); publicación:
[`pipeline/publish/longshots.ts`](pipeline/publish/longshots.ts) → `public/data/longshots.json` (y `home.json` →
`longshot`); informe: `npx tsx scripts/eval-longshots.ts`. Reutiliza la predicción de cada partido (1X2 del ensamble,
matriz de marcadores, *props* de jugadores) y el mismo historial *walk-forward* que los pronósticos del día (se recoge
en la misma pasada): `confidence.json` y `daily.json` **no cambian** (comprobado generando los datos con y sin este
apartado: idénticos byte a byte).

**Qué es y qué no es.** Una cuota 6 significa acertar, como mucho, **1 de cada 6** veces. Solo se gana a la larga si la
probabilidad real supera la implícita en la cuota (valor esperado positivo), y en el historial **no ha sido así**. El
apartado no promete nada: enseña la probabilidad, la cuota justa (1/p), la cuota de la casa cuando ESPN la publica
(DraftKings: solo 1X2, más/menos y hándicap principales) y el valor esperado (p · cuota − 1).

**Cómo se elige.**

- Candidatos por partido (cuota de la casa si existe; si no, la justa): **sorpresas** 1X2 con cuota entre 6 y 15;
  los 2 **marcadores exactos** más probables con cuota justa ≥ 6; **goleadores** con probabilidad de marcar entre 0,10 y
  1/6 y ≥ 60' esperados (los mismos jugadores elegibles que en los pronósticos del día); **combinadas** de 2–4 patas de
  partidos distintos, cada pata con cuota de la casa entre 1,30 y 3,50 y probabilidad ≥ 25 % (la de mayor valor
  esperado de cada partido), producto de cuotas entre 6 y 12; probabilidad = producto de las patas.
- Puntuación 0–100: 40 % probabilidad (respecto a la de cuota 6), 40 % valor esperado (sin cuota de la casa se asume
  −20 %) y 20 % prestigio de la competición. Por día: como mucho 4 por tipo, sin repetir partido dentro de un tipo, y 12
  en total. Hoy y los 3 días siguientes con partidos (Europe/Madrid); los de hoy ya jugados salen con ✓/✗.
- Probabilidades recalibradas con Platt por grupo, reajustado cada mes solo con días anteriores (sobre todo baja la de
  los goleadores, que el modelo inflaba). Un tipo deja de publicarse si tiene < 30 apuestas resueltas o su acierto real
  (Wilson alto) no llega al 70 % de lo que prometía el modelo.

**Historial real fuera de muestra (build del 26-nov-2026; 1-jun → 25-nov, 152 días).** La misma regla aplicada a
cada día pasado con predicciones que solo usan datos anteriores a cada partido, resuelta a 90'. ROI: 1 unidad a cada
apuesta que tenía cuota de cierre en todas sus patas.

| Tipo | Aciertos | % (Wilson 90 %) | Esperado | Cuota media | ROI con cierre | Racha sin acertar |
|---|---|---|---|---|---|---|
| Combinadas | 51 / 403 | 12,7 % (10,2–15,6) | 15,6 % | 6,51 | −18,9 % (n = 403) | 39 |
| Sorpresas (1X2) | 36 / 311 | 11,6 % (8,9–14,9) | 15,0 % | 6,82 | −20,9 % (n = 306) | 29 |
| Marcador exacto | 46 / 355 | 13,0 % (10,3–16,2) | 13,5 % | 7,54 | no medible (sin cuota) | 39 |
| Goleador | 52 / 385 (+42 nulas) | 13,5 % (10,9–16,6) | 15,3 % | 6,62 | no medible (sin cuota) | 38 |
| **Total** | **185 / 1.454** | **12,7 %** (1 de cada 8) | 14,8 % | 6,85 | **−19,8 % (n = 709, −140,3 u)** | 65 (todas juntas) |

- **Las de valor esperado positivo según el modelo perdieron más**: 337 apuestas, 34 aciertos, ROI −33,0 %; el resto,
  −7,8 % (n = 372). El valor esperado del modelo no gana a la casa en este rango de cuotas.
- **El modelo es optimista con lo que elige**: esperaba 14,8 % y se acertó 12,7 %. En las sorpresas, su probabilidad
  media (14,95 %) era casi la implícita en la cuota de cierre con margen (14,93 %) y se acertó un 11,6 %: las cuotas altas
  pagan menos de lo que valen. La calibración global en la banda 0,05–0,25 (27.883 selecciones evaluadas, no solo las
  elegidas) sí cuadra: 7,9 → 7,5 %, 12,2 → 11,6 %, 17,3 → 17,3 %, 22,5 → 22,8 % (predicho → observado).
- **Mucha varianza**: junio 0 de 65 (casi solo liga y copa chilenas por el parón del Mundial); por meses el ROI fue de −49 % (agosto) a
  +8,8 % (noviembre). Un mes bueno no indica nada.
- **Recálculo independiente** (26-nov): las selecciones, la recalibración, la regla diaria, la resolución y el ROI de
  sorpresas y combinadas reimplementados aparte dieron exactamente las mismas cifras.

**Advertencias:**

- **La mayoría de estas apuestas pierden.** Hubo rachas de hasta 39 fallos seguidos dentro de un tipo (65 contando
  todas): con cuotas así son normales.
- **Cuotas del historial = cuotas de cierre.** Para los partidos pasados la fuente solo guarda la última cuota antes del
  saque, y el historial la usa como entrada del modelo, para elegir las patas de las combinadas y el rango de las
  sorpresas, y para el ROI. Es información anterior al partido, pero en producción las apuestas se publican con la cuota
  del momento (a veces días antes) y cada cual apostará a la cuota que encuentre.
- **Marcador exacto y goleador no tienen cuota de la casa** en la fuente: su valor esperado no se puede medir y en la
  realidad esos mercados llevan márgenes grandes. Goleador: si el jugador no juega, la casa suele anular la apuesta; en
  el historial solo se evalúan partidos con alineaciones publicadas.
- **Combinadas**: el margen de la casa se multiplica en cada pata, y las patas de un mismo día no son del todo
  independientes (Wilson tampoco lo considera).
- Juego responsable: solo mayores de 18 años y solo dinero que puedas permitirte perder. Ver
  [Juego responsable](#juego-responsable-18).

### 14. Combinada cuota 6 (mercados mezclados)

Respuesta a «fórmame una cuota 6 entre varios partidos: de uno los goles, de otro los córners, de otro el ganador…, con
lo más probable». Motor: [`pipeline/analytics/combo6.ts`](pipeline/analytics/combo6.ts) (constantes documentadas en la
cabecera); publicación: [`pipeline/publish/combo6.ts`](pipeline/publish/combo6.ts) → `public/data/combo6.json` (y
`home.json` → `combo6`, la de hoy). Usa los mismos candidatos, requisitos de datos y calibraciones que los pronósticos
del día; no cambia ningún otro archivo.

**Regla.**

- **Patas**: solo familias con regla **validada** fuera de muestra en el apartado del día; probabilidad = la recalibrada
  (Platt) de esa regla, entre **0,70 y 0,88**. Una pata por partido (partidos distintos ⇒ independientes), de 4 a 9
  patas, al menos 4 categorías (ganador, goles, córners, tiros a puerta, tiros, tarjetas, faltas) y como mucho 2 por
  categoría. Por partido y categoría, solo la pata más eficiente (menor −ln p / ln cuota).
- **Jugadores fuera**: su única regla validada («1+ tiro») acierta 86,8 % frente a una tasa base de 88,2 %, un 7,8 % se
  anulan y dependen de la alineación.
- **Cuota de cada pata**: `casa` (DraftKings vía ESPN: 1X2, línea principal de goles, hándicap), `derivada` (doble
  oportunidad y empate no apuesta calculadas desde el 1X2, con su margen) o `estimada` = cuota justa / (1 + margen), con
  márgenes **supuestos**: 5 % ganador y goles; 7 % córners, tarjetas, tiros, tiros a puerta, faltas y goles de un
  equipo. La fuente no publica precios de esos mercados, así que son estimaciones: la cuota real puede quedar por
  debajo de 6. Las derivadas y estimadas se marcan en la página.
- **Objetivo**: producto de cuotas entre **6 y 8** y, entre todas las que cumplen, la de **mayor probabilidad
  combinada**. Búsqueda por ramificación y poda sobre las 12 patas más eficientes de cada categoría, con tolerancia de
  0,001 en ln p (como mucho un 0,1 % relativo peor que la óptima) y un máximo de 500.000 nodos; en modo exacto coincide
  con la fuerza bruta en los tests.
- **Por competición**: para Champions, Europa League, Conference, Libertadores y Sudamericana, la misma regla limitada a
  esa competición cuando tiene ≥ 5 partidos con patas ese día.
- Hoy solo usa partidos sin empezar; las patas nulas se quitan (como hacen las casas); resultado a 90'.

**Por qué pocas patas moderadas y no muchas muy seguras.** Con cuota por pata c = 1 / (p · (1 + m)), la cuota total es
1 / (P · Π(1 + m)): para una cuota fija de 6, cada pata añadida vuelve a pagar el margen y baja la probabilidad P que
se puede conseguir. Con patas muy seguras (≈ 0,94) harían falta unas 20–26 para llegar a 6, y en el historial esas
combinadas acertaban solo un 6–11 % de los días. El suelo de 0,70 por pata evita que la búsqueda meta patas poco
probables. Resultado típico: ~7 patas de un 70–80 % y una probabilidad del 11–12 % (1 de cada 8–9), por debajo del 1/6
que pagaría la cuota: **valor esperado negativo**.

**Historial fuera de muestra (build del 26-nov-2026; 1-jun → 25-nov).** La misma regla en cada día pasado con
predicciones, reglas y Platt ajustados solo con datos anteriores (tramos mensuales), cuotas de cierre y resultado a 90'.
Sin ROI: la mayoría de las patas no tienen cuota real.

- 152 días con partidos, **81 combinadas** (71 días sin combinada: en junio y julio casi no había reglas validadas, o
  había menos de 4 partidos).
- **6 acertadas de 81 = 7,4 %** (Wilson 90 %: 3,9–13,7 %) frente a un **11,1 % previsto**. 7,05 patas de media, cuota
  media 6,01 (justa 9,02). Racha de fallos más larga: 29.
- **Frágil**: una primera versión daba 8 de 82, pero 2 de esos aciertos eran días 1 de mes en los que el día local
  (Madrid) empieza antes del inicio UTC del tramo y las reglas del tramo nuevo ya incluían partidos de ese mismo día
  (fuga). Corregido: todo el día usa las reglas del tramo de su primer partido.

| Categoría (patas) | Acierto real | Previsto |
|---|---|---|
| Ganador (115) | 77,4 % | 75,5 % |
| Goles (150) | 67,3 % | 71,9 % |
| Córners (22) | 81,8 % | 80,7 % |
| Tiros a puerta (104) | 70,2 % | 71,6 % |
| Tiros (76) | 86,8 % | 73,1 % |
| Tarjetas (28) | 64,3 % | 72,1 % |
| Faltas (64) | 67,2 % | 72,4 % |

En todas las patas candidatas de la franja 0,70–0,80, tarjetas, empate no apuesta y «equipo: más de 2,5 tiros a puerta»
salen 4–7 puntos optimistas y goles unos 2: la probabilidad publicada tiende a ser algo alta. Aviso automático en la
página si, con ≥ 20 combinadas resueltas, el Wilson alto queda por debajo del 70 % de lo previsto (hoy no salta).

**Advertencias:** ganar la combinada es lo raro (≈ 1 de cada 9 previsto; 1 de cada 13-14 en el historial) y a la larga se pierde; las cuotas estimadas pueden
no existir a ese precio en tu casa. Solo mayores de 18 años y con dinero que puedas permitirte perder. Ver
[Juego responsable](#juego-responsable-18).

### 15. Cambios del modelo (22-nov-2026)

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

### 16. Cambios del modelo (26-nov-2026): factores del partido

**Protocolo.** La regla de adopción se escribió el 26-nov-2026 **antes** de calcular ningún resultado de los factores
(pre-registro en [`pipeline/experiments/README.md`](pipeline/experiments/README.md)). Ventanas: **T1** (1-jun → 31-jul-2026,
215 partidos), **T2** (1-ago → 15-sep, 1.142) y **prev** (temporadas pasadas, 1-ene → 31-may-2026, 2.636 partidos nunca
evaluados antes: recta final de las ligas europeas, eliminatorias UEFA, árbitros europeos). Un factor se adopta si
mejora sus métricas objetivo en T2 y en prev, alguna con IC bootstrap por días que excluye el 0, no empeora de forma
significativa nada en T1 ni ninguna métrica principal, y pasa la comprobación de fuga. Siempre contra la producción del
momento.

**Volumen.** 6 factores × 4 configuraciones declaradas de antemano = **24 configuraciones**, todas evaluadas y
publicadas. Cada factor que pasó tuvo **dos revisiones adversariales** independientes (fugas, sobreajuste, robustez por
competición): las seis aceptaron, sin fugas.

| Factor (configs) | Decisión | Por qué |
|---|---|---|
| Árbitro (4) | **Adoptado**: `referee-fouls-k30` | Tarjetas y faltas mejoran en T2 y prev (abajo). Faltas, frágil: en T2 casi la mitad de la ganancia es de la MLS y en prev, sin LaLiga 2, deja de ser significativa. Hoy no actúa: ESPN no publica árbitros antes del partido |
| Bajas de jugadores (4) | **Adoptado**: `availability-props` | Props de tiros, tiros a puerta y tarjeta mejoran en T2. Factores fijados mirando T1 (T1 dentro de muestra). El ajuste por equipo (goles, tiros) no pasó: los equipos con bajas no tiran menos (tiros significativamente peor en T2) |
| Forma de jugadores (4) | **Adoptado**: `playerform-fac6x40` (factores del rival 6/40) | Sobre todo **deshace** el empeoramiento de las props del 22-nov (frente al modelo anterior queda ≈ 0). Las tasas ponderadas por recencia y el multiplicador de los 5 últimos partidos **no pasaron** (≥ 2 tiros significativamente peor) |
| Forma del equipo (4) | No adoptado, informativo | La de goles empeora el 1X2 en T2 (estimación puntual); la de estadísticas, córners en prev. Solo hay señal **sin cuotas** (xG aproximado por tiros: coeficientes +0,23 / +0,30); con cuotas ≈ 0: **el mercado ya la descuenta**, y desde junio solo el 3–12 % de los partidos no tiene cuotas |
| Local/visitante por equipo (4) | No adoptado, informativo | La varianza de la ventaja local entre equipos, estimada cada semana, sale **0** desde febrero de 2026: indistinguible del ruido (variante = producción). Separar más o menos casa/fuera en córners, tarjetas y tiros empeora en prev |
| Eliminatorias y recta final (4) | No adoptado, informativo | Sin ganancia consistente: en las vueltas mejora más/menos (prev −0,0058, n = 83) pero empeoran los goles por equipo; en la recta final 1X2 y goles no cambian |

**Ganancia medida** de lo adoptado (los tres juntos frente a la producción anterior; Δ Brier, * = IC 95 % que excluye 0):

| Métrica | T2 (1.142 partidos) | prev (2.636) |
|---|---|---|
| Tarjetas (total) | −0,0039* | −0,0029* |
| Tarjetas por equipo | −0,0023* | −0,0015* |
| Faltas | −0,0037* | −0,0015* |
| ≥ 1 tiro a puerta (jugador) | −0,00073* | −0,00010 |
| ≥ 2 tiros (jugador) | −0,00069* | −0,00024 |
| Tarjeta (jugador) | −0,00032* | −0,00013* |
| Goleador | −0,00003* | 0 |

1X2, más/menos, ambos marcan, goles por equipo, córners, tiros y tiros a puerta: Δ = 0. En T1 todo va en la misma
dirección sin significación. Las props mejoran poco (0,3–0,5 % de su Brier) y prev casi no tiene líneas de jugador
(empiezan el 7-may: 192 partidos).

**Holdout: SEGUNDA mirada en total** (26-nov-2026, una vez, la combinación de los tres; 16-sep en adelante, 1.812
partidos en 71 días, 42.400 pares de jugador, sin fuga). Ninguna métrica objetivo empeora (estimación puntual):

| Holdout (26-nov-2026) | Referencia | Combinación | Δ [IC 95 %] |
|---|---|---|---|
| Tarjetas | 0,2369 | 0,2297 | −0,0073 [−0,0104; −0,0047] |
| Tarjetas por equipo | 0,2286 | 0,2229 | −0,0058 [−0,0077; −0,0040] |
| Faltas | 0,2118 | 0,2098 | −0,0020 [−0,0047; +0,0009] |
| ≥ 1 tiro a puerta | 0,1603 | 0,1600 | −0,00028 [−0,00049; −0,00009] |
| ≥ 2 tiros | 0,1553 | 0,1551 | −0,00018 [−0,00040; +0,00004] |
| Tarjeta (jugador) | 0,1025 | 0,1025 | −0,00003 [−0,00010; +0,00004] |
| Goleador | 0,0738 | 0,0738 | −0,00002 [−0,00004; +0,00000] |

Advertencias de esa mirada:
- La **referencia** de la herramienta es el modelo de **antes del 22-nov**: buena parte de la mejora en tarjetas viene
  de aquel cambio, no de estos factores. La comparación contra la producción vigente en el holdout **no se midió**
  (habría sido otra mirada).
- Solo **250 de 1.812** partidos del holdout tienen árbitro conocido. Ahí tarjetas mejora (−0,0085 [−0,0167; −0,0021])
  pero faltas empeora un poco (+0,0008 [−0,0067; +0,0069], n = 244): **el árbitro no queda confirmado** en el holdout.
- Las dos partes de las props no se pueden separar. En el holdout los sancionados llevaban ×0,03 para poder puntuarlos;
  en producción no se publican (factor 0).
- Los tiros por equipo empeoran +0,0025 [−0,0002; +0,0052] frente a la referencia: efecto del cambio del 22-nov (estos
  factores no los tocan), que en muestra iba en sentido contrario. Queda vigilado.
- El holdout se ha mirado ya **dos veces** (22-nov y 26-nov); no se ha hecho ningún ajuste posterior con él.

**Lo prometedor que no se adopta:** bajar tarjetas y faltas de un equipo que ya no se juega nada en la recta final
mejoró ese segmento en prev (tarjetas −0,0021 a −0,0033, faltas −0,0030 a −0,0035, IC que excluyen 0). No era una
métrica objetivo pre-registrada por sí sola y el tramo de ajuste no tiene recta final de liga: necesita su propio
pre-registro y confirmarse en la **recta final de la primavera de 2027**. Igual con la forma en faltas y tiros (mejora
en las tres ventanas, pero restringirla a esas estadísticas sería una elección a posteriori).

#### Factores del partido en la ficha

Cada `matches/<id>.json` lleva un bloque `factors` («Factores del partido», validado por `scripts/validate-data.ts`)
calculado **solo con información anterior al inicio**, también en partidos ya jugados: árbitro, bajas probables,
rendimiento casa/fuera, forma reciente, estado de la eliminatoria, lo que se juega cada equipo y jugadores en forma.
Cada apartado dice si es **«usado en el modelo»** (`usedInModel`: cambia de verdad las probabilidades publicadas de ese
partido) o **«informativo»** (solo contexto):

- **Usado en el modelo:** el árbitro, solo si ESPN lo ha publicado y tiene partidos previos con datos (si no, aparece
  «no publicado» y no ajusta nada); cada baja probable que recorta minutos de las props (`minutesFactor` ≠ 1); y el
  rendimiento casa/fuera en córners, tarjetas y tiros, que ya formaba parte de las proyecciones.
- **Informativo:** forma reciente (xG aproximado por tiros frente a lo esperado por el Elo), casa/fuera en goles,
  estado de la eliminatoria (solo si la ida está en los datos), lo que se juega cada equipo (ligas a doble vuelta sin
  Argentina, Liga MX ni MLS, con ≥ 75 % de la fase regular jugada; rangos matemáticos, así que un equipo ya descendido
  figura «sin nada en juego») y jugadores en forma.
- Unas notas en español resumen qué usa el modelo y qué no. A 26-nov-2026 el árbitro figura «no publicado» en todos los
  partidos próximos.

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
| `referee` | kCards 30 · kFouls 30 · minCompN 20 · minCompNAll 10 | Severidad del árbitro en tarjetas y faltas (contracción y mínimos de la media de competición), desde el 26-nov-2026 |
| `availability` | habitual ≥ 0,6 de los minutos en 5 partidos · líneas de 365 días · sancionado 0 · faltó 2: 0,65 · faltó 1 (misma comp.): 0,9 · (otra): 1 | Bajas probables en las props, desde el 26-nov-2026 |
| `propsOppShrink` | forN 6 · agN 40 | Partidos ficticios del «a favor» propio y del «en contra» del rival en las props, desde el 26-nov-2026 |
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
cambios), árbitro principal y cuotas de DraftKings.

**Árbitros** (desde el 26-nov-2026): del resumen del partido (`gameInfo.officials`) y del endpoint core `/officials`
(circuito propio: si falla, solo se aplaza ese paso). A 26-nov-2026 hay árbitro en 12.715 de los 17.294 partidos del
almacén (740 árbitros), casi todos los terminados de enero de 2025 al 20 de septiembre de 2026; desde octubre ESPN
prácticamente no lo publica (2 de 925 partidos en octubre, ninguno en noviembre) y **nunca antes del partido** en los
programados. Cada descarga vuelve a consultar los partidos de las próximas 72 horas; mientras no aparezca, el ajuste
por árbitro no actúa.

**Limitaciones que conviene conocer:**

- **No hay saques de banda ni saques de puerta**: ESPN no los publica, así que no se modelan. Los **saques
  de esquina (córners)** sí están cubiertos.
- **No hay xG real** (no hay coordenadas de tiro). Donde la app muestra "xG" se trata de los **goles
  esperados del modelo** (λ), un *proxy* razonable pero distinto del xG basado en ocasiones.
- **Cuotas limitadas:** solo un proveedor (DraftKings vía ESPN) y no para todos los partidos ni todas las
  ligas. Sin cuotas, el ensamble usa solo Dixon-Coles y Elo y no se calculan apuestas de valor.
- **Estadísticas de jugadores** solo de los partidos con resumen disponible (últimos 180 días); algunas
  competiciones (por ejemplo, la Nations League) no los tienen.
- **No se modelan** alineaciones confirmadas, lesiones, rotaciones, clima ni motivación. Las sanciones, solo de forma
  aproximada (roja en el último partido de la misma competición; sin recursos ni ciclos de amarillas). El árbitro, solo
  cuando ESPN lo publica antes del partido (hoy no lo hace).
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
| `npx tsx scripts/eval-longshots.ts` | Informe de «Cuota alta 6+» con el `data-store` real: historial fuera de muestra por tipo, sin y con recalibración, calibración y apuestas de hoy, sin escribir en `public/`. |
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
| `home.json` | Partidos populares, hoy, mañana, recientes, mejores apuestas de valor, mejores pronósticos de alta confianza (72 h) con su acierto fuera de muestra, resumen de los pronósticos del día (`daily`), la mejor apuesta de cuota alta aún abierta (`longshot`), la combinada cuota 6 de hoy (`combo6`) y jugadores en forma |
| `competitions/<id>.json` | Clasificación, partidos, estadísticas de equipos, ratings, simulación, jugadores, promedios de liga, backtest |
| `matches/<id>.json` | Análisis completo de un partido: modelo, mercados, proyecciones, forma, H2H, comparativa, *props*, valor y factores del partido (`factors`: árbitro, bajas, forma, casa/fuera, eliminatoria, lo que se juega, jugadores en forma; cada uno «usado en el modelo» o «informativo») |
| `teams/<id>.json` | Ficha de equipo |
| `players.json` | Ranking global de jugadores por forma |
| `value.json` | Todas las apuestas de valor |
| `model.json` | Metodología, parámetros y backtest global y por competición |
| `daily.json` | Pronósticos del día: hoy y los 3 días siguientes con partidos; por partido, pronósticos validados (máx. 2 por categoría y 8 por partido) con frase explicativa, números esperados y lectura; top del día, combinadas y récord fuera de muestra (global, por categoría y por combinada) |
| `longshots.json` | Cuota alta 6+: apuestas de cuota ≥ 6 de hoy y los 3 días siguientes con partidos (patas, probabilidad, cuota justa y de la casa, valor esperado, frase con cifras, resultado de las ya jugadas), historial fuera de muestra por tipo, calibración en la banda baja y aviso +18 |
| `combo6.json` | Combinada cuota 6 de mercados mezclados: regla (`rule`: cuota objetivo, banda de probabilidad por pata, patas, categorías, márgenes estimados), por día (hoy y siguientes) la combinada general (`main`, o `reason` si no hay) y las de cada competición continental (`byCompetition`), con cada pata (partido, categoría, mercado, selección, probabilidad, cuota justa y de la casa, origen `casa`/`derivada`/`estimada`, resultado), historial fuera de muestra (`history`: aciertos con Wilson, previsto, por categoría, racha, últimas 14) y nota |
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
