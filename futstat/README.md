# FutStat Lab

[![Actualización diaria](https://github.com/denisjara/denisjara/actions/workflows/futstat-daily.yml/badge.svg)](https://github.com/denisjara/denisjara/actions/workflows/futstat-daily.yml)

**Dashboard de analítica y predicción de fútbol que se actualiza solo, tres veces al día.**

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
8. [Estructura del proyecto](#estructura-del-proyecto)
9. [Contrato de datos](#contrato-de-datos)
10. [Juego responsable (+18)](#juego-responsable-18)

---

## Qué es FutStat Lab

FutStat Lab tiene dos piezas:

1. **Un pipeline de datos en Node/TypeScript** (`pipeline/`) que descarga datos públicos de ESPN,
   guarda un almacén incremental (`data-store/`), ajusta todos los modelos y publica ficheros JSON
   estáticos en `public/data/`.
2. **Una app web en React + Vite + TypeScript + Tailwind** (`src/app/`) que lee esos JSON y los presenta
   como un dashboard deportivo: partidos populares, una sección por liga y por competición, análisis
   completo de cada partido, jugadores, apuestas de valor y la metodología con su backtest.

Un workflow de GitHub Actions ejecuta el pipeline **tres veces al día**, compila la web y la despliega en
GitHub Pages. No hay servidor ni base de datos: todo es estático, rápido y gratuito de alojar.

Durante los partidos, la propia web consulta el marcador del día de ESPN cada 60 segundos para mostrar
resultados en vivo sin esperar a la siguiente actualización.

---

## Secciones de la app

| Sección | Ruta | Qué muestra |
|---|---|---|
| **Inicio / Partidos populares** | `/` | Los partidos más relevantes de las próximas 72 h (ranking de popularidad), partidos de hoy y de mañana, resultados recientes con acierto del modelo, mejores apuestas de valor, jugadores en mejor forma y titulares del día. |
| **Calendario** | `/partidos` | Todos los partidos por día y competición, con probabilidades 1X2, goles esperados, marcador más probable y cuotas cuando existen. |
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
- Los equipos nuevos arrancan en `1500 + (tier − 5) · 30` según el prestigio de su competición.
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

- La probabilidad final 1X2 es un **pool lineal** de las tres fuentes: Dixon-Coles (50 %), Elo (20 %) y
  mercado sin margen (30 %). Si una fuente falta (por ejemplo, partido sin cuotas) los pesos se
  renormalizan.
- Después se **recalibran los goles esperados**: se buscan los `(λ_local, λ_visitante)` cuya matriz de
  Dixon-Coles reproduce el 1X2 del ensamble (y la línea de 2,5 goles cuando existe). Así **todos** los
  mercados derivados son coherentes con la probabilidad final y no solo el 1X2.
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
  cruzando lo que genera con lo que concede su rival, con *shrinkage* hacia la media de la liga.
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

- Se simulan **10 000 veces** los partidos que quedan con los goles esperados del modelo.
- Resultado: puntos esperados, posición esperada, distribución completa de posiciones y probabilidades
  de cada zona (campeón, Champions, Europa, playoff, descenso…, según la competición).

### 9. Backtest *walk-forward*

- Cada partido terminado se predice **solo con la información disponible antes de jugarse** y se compara
  con lo que pasó.
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

### Parámetros principales

| Parámetro | Valor | Significado |
|---|---|---|
| `dcXi` | 0,0019 | Decaimiento temporal diario de Dixon-Coles (vida media ≈ 365 días) |
| `dcWindowDays` | 540 | Ventana de partidos usada para ajustar Dixon-Coles |
| `eloK` / `eloHomeAdv` / `eloInit` | 20 / 65 / 1500 | Elo: factor K, ventaja de campo, rating inicial |
| `wDixonColes` / `wElo` / `wMarket` | 0,5 / 0,2 / 0,3 | Pesos del ensamble |
| `minEv` / `minProb` / `maxOdds` | 0,05 / 0,12 / 8 | Filtros de apuestas de valor |
| `kellyFraction` / `kellyCap` | 0,25 / 0,05 | Kelly fraccional y tope por apuesta |
| `simIterations` | 10 000 | Iteraciones de la simulación de temporada |

Todos están en `MODEL` dentro de [`pipeline/config.ts`](pipeline/config.ts).

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
  tolera caídas parciales (una competición que falla no detiene las demás) y reutiliza el almacén de la
  ejecución anterior.
- Los datos se recalculan **tres veces al día**; solo los marcadores en vivo se refrescan en tiempo real
  desde el navegador.

---

## Actualización automática

El workflow [`.github/workflows/futstat-daily.yml`](../.github/workflows/futstat-daily.yml)
("FutStat Lab — actualización diaria") hace todo el trabajo:

```
cron 05:17 / 12:17 / 18:17 UTC ─┐
ejecución manual ───────────────┼─▶ npm ci ─▶ restaurar data-store (caché) ─▶ data:fetch (ESPN)
push a main (futstat/**) ───────┘      ─▶ guardar data-store ─▶ data:build (modelos + JSON) ─▶ data:validate
                                       ─▶ npm test ─▶ npm run build ─▶ GitHub Pages
```

- **Horario:** 05:17, 12:17 y 18:17 UTC (06:17, 13:17 y 19:17 en Madrid en horario de invierno; una hora
  más en verano).
- **Almacén incremental:** `data-store/` se conserva entre ejecuciones con la caché de GitHub Actions, así
  que cada pasada solo descarga lo nuevo y mantiene el histórico de cuotas. La **primera ejecución** parte
  de cero y tarda bastante más (descarga hasta 180 días de resúmenes).
- **Seguridad de la publicación:** si fallan la validación de datos, los tests o la compilación, no se
  despliega nada y la web sigue mostrando la última versión buena.

### Cómo activarlo (una sola vez)

1. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Asegúrate de que el workflow está en la rama por defecto (`main`): **los cron solo se ejecutan en la
   rama por defecto**.
3. Lanza la primera ejecución a mano: **Actions → "FutStat Lab — actualización diaria" → Run workflow**
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

Requisitos: **Node.js 22** (el mismo que usa CI) y npm.

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
| `npm run data:build` | Ajusta los modelos y escribe `public/data/*.json`. |
| `npm run data:update` | `data:fetch` + `data:build`. |
| `npm run data:validate` | Comprueba que los JSON generados cumplen el contrato de datos. |
| `npm run data:mock` | Genera datos de ejemplo realistas en `public/mock-data/` (sin red). |
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

# Limitar los resúmenes por competición y la concurrencia
npm run data:fetch -- --max-summaries=50 --concurrency=4
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

## Estructura del proyecto

```
.github/workflows/futstat-daily.yml   Actualización 3 veces al día y despliegue en GitHub Pages
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
│   ├── espn/              Cliente HTTP con reintentos + normalización de las respuestas de ESPN
│   ├── store.ts           Almacén incremental en data-store/<competición>.json (escritura atómica)
│   ├── fetch.ts           CLI de descarga
│   ├── analytics/         Ratings, predicción, mercados, proyecciones, jugadores, simulación, backtest
│   └── build.ts           CLI: data-store → public/data/*.json
├── scripts/               Utilidades (datos de ejemplo, validación)
├── tests/                 Tests de Vitest (modelos, normalización ESPN, almacén) y fixtures reales
├── public/data/           JSON generados (no se versionan; los produce CI)
└── data-store/            Almacén incremental (no se versiona; se guarda en la caché de CI)
```

---

## Contrato de datos

La app solo lee estos ficheros, todos tipados en [`src/types/data.ts`](src/types/data.ts):

| Fichero | Contenido |
|---|---|
| `meta.json` | Competiciones, recuentos e índice de búsqueda de equipos |
| `home.json` | Partidos populares, hoy, mañana, recientes, mejores apuestas de valor y jugadores en forma |
| `competitions/<id>.json` | Clasificación, partidos, estadísticas de equipos, ratings, simulación, jugadores, promedios de liga, backtest |
| `matches/<id>.json` | Análisis completo de un partido: modelo, mercados, proyecciones, forma, H2H, comparativa, *props*, valor |
| `teams/<id>.json` | Ficha de equipo |
| `players.json` | Ranking global de jugadores por forma |
| `value.json` | Todas las apuestas de valor |
| `model.json` | Metodología, parámetros y backtest global y por competición |

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
