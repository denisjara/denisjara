# FutStat Lab — Arquitectura (contrato de módulos)

Dashboard de analítica y predicción de fútbol. Un **pipeline Node** descarga cada día datos
públicos de ESPN, ajusta modelos estadísticos y publica JSON estático en `public/data/`.
Una **app React** (Vite + TypeScript + Tailwind) lee esos JSON. Un workflow de GitHub Actions
ejecuta el pipeline a diario y despliega en GitHub Pages.

```
futstat/
  src/types/data.ts          CONTRATO de los JSON publicados (UI ⇄ pipeline). Fuente de verdad.
  src/lib/models/            Matemática pura (sin I/O), usable en Node y navegador
  pipeline/config.ts         Competiciones, parámetros del modelo, rutas
  pipeline/types.ts          Registros internos normalizados (MatchRecord, PlayerLine, CompetitionStore)
  pipeline/espn/             Cliente HTTP + normalización de ESPN
  pipeline/store.ts          Persistencia incremental en data-store/<compId>.json
  pipeline/fetch.ts          CLI: descarga/actualiza data-store
  pipeline/analytics/        Modelos de alto nivel (ratings, predicción, mercados, proyecciones, jugadores, simulación, backtest)
  pipeline/build.ts          CLI: data-store → public/data/*.json
  scripts/mock-data.ts       Genera JSON falsos (pero realistas) en public/mock-data/ para desarrollar la UI
  src/app/ ...               App React
  tests/                     Vitest
```

## Reglas para todos los agentes

- **No hagas commits ni push.** El orquestador hace commit al final.
- Edita **solo** los archivos/directorios que te asignaron. Puedes leer todo.
- No añadas dependencias npm salvo que tu tarea lo diga explícitamente. Ya instaladas:
  react 18.3, react-dom, react-router-dom 6.28, lucide-react, tailwindcss 3.4, vite 5.4, vitest 2.1, tsx, typescript 5.6.
- TypeScript estricto. Código Node se ejecuta con `npx tsx`. Imports relativos SIN extensión `.ts`.
- Typecheck: `npx tsc -p tsconfig.node.json --noEmit` (pipeline, models, tests) y
  `npx tsc -p tsconfig.app.json --noEmit` (app). Otros agentes trabajan en paralelo: si ves errores en
  archivos que no son tuyos, ignóralos; los tuyos deben quedar limpios.
- Tests: `npx vitest run <ruta>`.
- Textos visibles para el usuario: **español**. Probabilidades en [0,1], cuotas decimales.
- Servidores de desarrollo: cada agente de UI usa su propio puerto (se indica en su tarea).

## Fuente de datos: ESPN (API pública, sin clave, CORS `*`)

- Scoreboard por año: `https://site.api.espn.com/apis/site/v2/sports/soccer/<slug>/scoreboard?dates=2026&limit=1000`
  (rangos `YYYYMMDD-YYYYMMDD` NO funcionan; `dates=YYYYMM` y `dates=YYYY` sí; `dates=YYYYMMDD` un día).
  - `leagues[0].season` = temporada actual (`year`, `displayName`, `startDate`, `endDate`); `leagues[0].logos`.
  - `events[].season.year` = temporada del partido.
  - `competitions[0].status.type.state`: `pre` | `in` | `post`; `name`: `STATUS_SCHEDULED`, `STATUS_FULL_TIME`,
    `STATUS_POSTPONED`, `STATUS_CANCELED`, `STATUS_FINAL_AET`, `STATUS_FINAL_PEN`, `STATUS_HALFTIME`, ...
  - `competitors[]` (`homeAway`, `score`, `form` "LWWLD", `team{id,displayName,shortDisplayName,abbreviation,logo,color}`,
    `statistics[]` con `name`: `foulsCommitted, wonCorners, possessionPct, shotsOnTarget, totalShots, totalGoals, goalAssists, shotAssists`).
  - `competitions[0].details[]`: goles y tarjetas (`scoringPlay, yellowCard, redCard, penaltyKick, ownGoal, clock.displayValue,
    team.id, athletesInvolved[]`).
  - `competitions[0].odds[]`: **solo en partidos próximos** (DraftKings). `moneyline.home/away/draw.{open,close}.odds` (americanas, string "+105"),
    `total.over/under.{open,close}.{line:"o2.5",odds}`, `pointSpread.home/away.{open,close}.{line,odds}`, `overUnder`, `drawOdds.moneyLine`.
    Puede venir `[null]`.
- Resumen de partido: `https://site.api.espn.com/apis/site/v2/sports/soccer/<slug>/summary?event=<id>`
  - `boxscore.teams[].statistics[]` (`foulsCommitted, yellowCards, redCards, offsides, wonCorners, saves, possessionPct, totalShots,
    shotsOnTarget, accuratePasses, totalPasses, passPct, totalCrosses, totalTackles, interceptions, totalClearance, blockedShots`).
  - `rosters[].roster[]`: jugador (`athlete.id, displayName, shortName`, `position.abbreviation` G/D/M/F, `starter`, `subbedIn`, `subbedOut`,
    `plays[]` con `clock.displayValue` y `substitution: true`), `stats[]` (`totalGoals, goalAssists, totalShots, shotsOnTarget, yellowCards,
    redCards, foulsCommitted, foulsSuffered, offsides, ownGoals, saves, goalsConceded`).
  - `keyEvents[]` (goles, tarjetas, cambios con `participants[]`), `pickcenter[]`/`odds[]` = **cuotas de cierre** también para partidos terminados
    (`homeTeamOdds.moneyLine`, `awayTeamOdds.moneyLine`, `drawOdds.moneyLine`, `overUnder`, `overOdds`, `underOdds`).
- Clasificación: `https://site.api.espn.com/apis/v2/sports/soccer/<slug>/standings` → `children[].standings.entries[]`
  (`team`, `stats[]` con `gamesPlayed, wins, ties, losses, pointsFor, pointsAgainst, pointDifferential, points, rank`, `note{color,description}`).

## API de `src/lib/models/` (firmas FIJAS — otros módulos dependen de ellas)

Todos los módulos re-exportados desde `src/lib/models/index.ts`. Se pueden añadir exports, no cambiar estos.

```ts
// stats.ts
mean(xs: number[]): number; variance(xs: number[]): number;           // varianza muestral (n-1); 0 si n<2
clamp(x: number, lo: number, hi: number): number;
round(x: number, digits?: number): number;                             // default 3
ewma(xs: number[], alpha: number): number;                             // xs cronológico, más reciente al final
shrink(sampleMean: number, n: number, priorMean: number, priorN: number): number; // (sampleMean*n + priorMean*priorN)/(n+priorN)

// poisson.ts
poissonPmf(k: number, lambda: number): number;
poissonPmfArray(lambda: number, maxK: number): number[];               // longitud maxK+1 (sin plegar cola)
poissonCdf(k: number, lambda: number): number;
dcTau(i: number, j: number, lambdaHome: number, lambdaAway: number, rho: number): number;
scoreMatrix(lambdaHome: number, lambdaAway: number, rho?: number, maxGoals?: number): number[][]; // [i][j]=P(local=i,visit=j), normalizada a 1, default rho=0,maxGoals=10
outcomeProbs(matrix: number[][]): Prob1X2;

// markets.ts
interface MarketContext { lambdaHome: number; lambdaAway: number; rho: number; homeName: string; awayName: string; odds?: OddsSnapshot }
overUnder(matrix: number[][], line: number): { over: number; under: number; push: number };
asianHandicap(matrix: number[][], line: number, side: 'home' | 'away'): { win: number; halfWin: number; push: number; halfLoss: number; loss: number; fairOdds: number };
buildGoalMarkets(ctx: MarketContext): Market[];
  // 1X2, doble oportunidad, empate no apuesta, O/U 0.5–5.5, ambos marcan, ambos marcan+resultado, goles por equipo (O/U 0.5–2.5),
  // hándicap asiático (líneas -2.5..+2.5 cada 0.25), hándicap europeo (-1,+1), marcador exacto (top 15 + "Otro"),
  // goles totales exactos (0..5, 6+), par/impar, margen de victoria, portería a cero, gana sin encajar, primer equipo en marcar,
  // descanso 1X2, descanso O/U 0.5/1.5, descanso/final (9 combinaciones), 2ª parte O/U 1.5.
  // Mitades: λ primera parte = 0.45·λ, segunda = 0.55·λ (independientes, Poisson).
  // Añade marketOdds/ev a las selecciones 1X2 y O/U de la línea del bookmaker cuando ctx.odds existe.

// dixonColes.ts
interface DCMatch { home: string; away: string; hg: number; ag: number; date: string; neutral?: boolean; weight?: number }
interface DCModel { teams: string[]; attack: Record<string, number>; defence: Record<string, number>; base: number; homeAdv: number; rho: number; nMatches: number; logLik: number; matchesByTeam: Record<string, number> }
  // λ_local = base·attack[h]·defence[a]·homeAdv ; λ_visit = base·attack[a]·defence[h]
  // attack/defence multiplicativos con media geométrica 1 (defence > 1 = concede más). Neutral: homeAdv = 1.
fitDixonColes(matches: DCMatch[], opts: { refDate: string; xi: number; maxIter?: number; tol?: number; priorWeight?: number }): DCModel;
  // ponderación temporal w = exp(-xi·días) · weight; regularización (priorWeight) hacia 1 para equipos con pocos partidos; rho por búsqueda 1D en [-0.2, 0.2].
predictDC(model: DCModel, home: string, away: string, neutral?: boolean): { lambdaHome: number; lambdaAway: number } | null; // null si falta algún equipo

// elo.ts
interface EloOptions { k: number; homeAdv: number; init: number }
interface EloMatch { id: string; date: string; home: string; away: string; hg: number; ag: number; neutral?: boolean; initHome?: number; initAway?: number; kMultiplier?: number }
class Elo {
  constructor(opts: EloOptions);
  get(team: string): number; has(team: string): boolean; set(team: string, rating: number): void;
  diff(home: string, away: string, neutral?: boolean): number;         // r_h + homeAdv(si no neutral) - r_a
  update(m: EloMatch): { preHome: number; preAway: number; postHome: number; postAway: number };
  // estilo World Football Elo: K·G·(W - We), G = 1 | 1.5 (gd=2) | (11+gd)/8 (gd>=3)
  history(team: string): { date: string; elo: number }[];
  ratings(): Record<string, number>;
}
goalMultiplier(goalDiff: number): number;
eloProbs(diff: number, params?: { drawBase?: number; drawScale?: number }): Prob1X2;
  // We = 1/(1+10^(-diff/400)); pDraw = drawBase·exp(-(diff/drawScale)^2); pHome = We - pDraw/2; pAway = 1 - pHome - pDraw (recortado a >= 0.01, renormalizado)
fitEloDrawParams(samples: { diff: number; outcome: 0 | 1 | 2 }[]): { drawBase: number; drawScale: number }; // 0=local,1=empate,2=visitante; MLE por rejilla

// negbin.ts
nbPmf(k: number, mean: number, dispersion: number): number;           // var = mean + mean²/dispersion; dispersion=Infinity → Poisson
nbPmfArray(mean: number, dispersion: number, maxK: number): number[];  // longitud maxK+1, cola plegada en el último índice (suma 1)
convolve(a: number[], b: number[], maxK?: number): number[];
overUnderFromDist(dist: number[], line: number): { over: number; under: number; push: number };
compareDists(a: number[], b: number[]): Prob1X2;                       // home=P(a>b), draw=P(a=b), away=P(a<b)
estimateDispersion(values: number[]): number;                          // método de momentos; Infinity si var<=mean

// odds.ts
americanToDecimal(ml: number | string | undefined | null): number | undefined; // "+105"→2.05, "-140"→1.714, "EVEN"→2
impliedProb(decimalOdds: number): number;
overround(decimalOdds: number[]): number;                              // Σ(1/o) - 1
devig(decimalOdds: number[], method?: 'multiplicative' | 'power' | 'shin'): number[]; // default 'shin'
fairOdds(p: number): number;                                           // 1/p, máximo 1000

// ensemble.ts
blend(sources: { probs: Prob1X2; weight: number }[]): Prob1X2;         // pool lineal, pesos renormalizados, ignora weight<=0
fitLambdas(target: { home: number; draw: number; away: number; over25?: number }, rho: number, init: { lambdaHome: number; lambdaAway: number }): { lambdaHome: number; lambdaAway: number };
  // busca (λh, λa) cuya matriz DC reproduzca el objetivo (mínimos cuadrados, Nelder-Mead o Newton amortiguado), λ en [0.05, 6]

// kelly.ts
expectedValue(p: number, odds: number): number;                        // p·odds - 1
kelly(p: number, odds: number, fraction?: number, cap?: number): number; // max(0, (p·odds-1)/(odds-1))·fraction, recortado a cap. default 0.25, 0.05

// metrics.ts
brier3(p: Prob1X2, outcome: 0 | 1 | 2): number;
logLoss3(p: Prob1X2, outcome: 0 | 1 | 2): number;                     // con epsilon 1e-12
rps3(p: Prob1X2, outcome: 0 | 1 | 2): number;
brierBinary(p: number, y: 0 | 1): number;
calibration(preds: { p: number; y: 0 | 1 }[], bins?: number): CalibrationBin[]; // bins vacíos se omiten
scoreSet(items: { p: Prob1X2; outcome: 0 | 1 | 2 }[]): ScoreSet;
```

## Pipeline

1. `pipeline/fetch.ts` (CLI): para cada competición → scoreboard de los años necesarios (año-1, año, año+1 si diciembre) →
   `normalize` → `store.merge` (conserva `summaryFetched`, jugadores y `oddsHistory`) → standings → resúmenes de partidos
   terminados sin `summaryFetched` dentro de `SUMMARY_LOOKBACK_DAYS` → guarda `data-store/<compId>.json`.
   Flags: `--only=laliga,premier`, `--no-summaries`, `--max-summaries=N`.
2. `pipeline/build.ts` (CLI): carga todos los stores → Elo global cronológico (todas las competiciones) → Dixon-Coles por
   competición (ligas; copas/continentales usan Elo→goles y DC de liga doméstica de cada equipo cuando existe) →
   predicciones de próximos partidos (ensamble DC + Elo + mercado sin margen) → mercados, proyecciones (córners, tarjetas,
   tiros, tiros a puerta, faltas, fueras de juego; binomial negativa con shrinkage) → jugadores (forma + props) → simulación
   Monte Carlo de temporada → backtest walk-forward → popularidad → escribe `public/data/*` según `src/types/data.ts`.

## App (src/app)

HashRouter. Rutas: `/` (Inicio), `/partidos` (calendario), `/c/:compId` (liga/competición con pestañas),
`/m/:matchId` (análisis de partido), `/t/:teamId` (equipo), `/jugadores`, `/valor` (apuestas de valor), `/modelo` (metodología + backtest).
Datos: `fetch(`${import.meta.env.BASE_URL}${import.meta.env.VITE_DATA_DIR ?? 'data'}/<archivo>.json`)`.
En vivo: la app consulta directamente el scoreboard de ESPN del día (CORS abierto) cada 60 s para actualizar marcadores.
