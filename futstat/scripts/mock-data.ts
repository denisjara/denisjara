/**
 * Genera en public/mock-data/ un conjunto COMPLETO y coherente de JSON conforme a src/types/data.ts
 * para desarrollar la UI sin depender del pipeline real.
 *
 *   npm run data:mock            (npx tsx scripts/mock-data.ts)
 *   VITE_DATA_DIR=mock-data npx vite
 *
 * Todo es sintético pero estadísticamente coherente: los marcadores se simulan con Poisson a partir
 * de ratings ocultos, el Elo y el Dixon-Coles se ajustan con src/lib/models sobre esos resultados,
 * y los mercados se derivan de la matriz de marcadores. Las fechas son relativas a "ahora", así que
 * siempre hay partidos hoy, mañana, en vivo y recientes. Nombres de jugadores ficticios.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPETITION_BY_ID, MODEL } from '../pipeline/config';
import {
  Elo,
  blend,
  bttsProb,
  buildGoalMarkets,
  calibration,
  compareDists,
  convolve,
  devig,
  eloProbs,
  fitDixonColes,
  fitLambdas,
  kelly,
  mostLikelyScore,
  mulberry32,
  nbPmfArray,
  outcomeProbs,
  overUnderFromDist,
  predictDC,
  roundMarkets,
  samplePoisson,
  scoreMatrix,
  scoreSet,
  type DCModel,
} from '../src/lib/models';
import type {
  BacktestSummary,
  CompetitionFile,
  CompetitionMeta,
  ComparisonRow,
  FormMatch,
  H2HSummary,
  HomeFile,
  LeagueAverages,
  Market,
  MatchEventPublic,
  MatchFile,
  MatchStatus,
  MatchSummary,
  MetaFile,
  ModelBreakdown,
  ModelFile,
  OddsSnapshot,
  Outcome,
  PlayerProp,
  PlayerRef,
  PlayerSeasonRow,
  PlayersFile,
  Prob1X2,
  QuickPrediction,
  SeasonSimulation,
  StandingRow,
  StatProjection,
  TeamFile,
  TeamFormBlock,
  TeamMatchStatsPublic,
  TeamRating,
  TeamRef,
  TeamSeasonStats,
  ValueFile,
  ValuePick,
} from '../src/types/data';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', 'public', 'mock-data');
const rng = mulberry32(20261103);
const rand = () => rng();
function normal(mu = 0, sd = 1): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const pickOne = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const clampN = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function weightedPick<T>(items: T[], w: (x: T) => number): T {
  const ws = items.map(w);
  const tot = sum(ws);
  let u = rand() * tot;
  for (let i = 0; i < items.length; i++) {
    u -= ws[i];
    if (u <= 0) return items[i];
  }
  return items[items.length - 1];
}

const NOW = new Date();
NOW.setUTCSeconds(0, 0);
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;
const DAY0 = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate());
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const at = (dayOffset: number, h: number, m = 0) => DAY0 + dayOffset * DAY + (h * 60 + m) * 60_000;
const GENERATED_AT = iso(NOW_MS);
const HFA = MODEL.eloHomeAdv;

// ---------------------------------------------------------------------------
// Equipos y jugadores (ficticios salvo los nombres de club)
// ---------------------------------------------------------------------------
type Nat = 'es' | 'en' | 'it' | 'br' | 'ar' | 'eu';
const FIRST: Record<Nat, string[]> = {
  es: ['Álvaro', 'Sergio', 'Pablo', 'Iker', 'Dani', 'Marcos', 'Hugo', 'Javier', 'Raúl', 'Rodrigo', 'Adrián', 'Mario', 'Alejandro', 'Unai', 'Aitor', 'Óscar', 'Jorge', 'Gonzalo', 'Luis', 'Carlos', 'Diego', 'Íñigo', 'Nico', 'Pedro', 'Fermín', 'Gerard', 'Marc', 'Ander', 'Mikel', 'Borja'],
  en: ['Jack', 'Harry', 'Oliver', 'George', 'James', 'Charlie', 'Thomas', 'Jacob', 'Alfie', 'Callum', 'Mason', 'Declan', 'Cole', 'Reece', 'Jarrod', 'Ollie', 'Kieran', 'Ben', 'Luke', 'Marcus', 'Phil', 'Conor', 'Tyrone', 'Elliot'],
  it: ['Lorenzo', 'Federico', 'Alessandro', 'Nicolò', 'Matteo', 'Davide', 'Gianluca', 'Andrea', 'Riccardo', 'Simone', 'Marco', 'Giacomo', 'Sandro', 'Manuel', 'Mattia', 'Pietro', 'Tommaso', 'Samuele'],
  br: ['Gabriel', 'Lucas', 'Matheus', 'Pedro', 'João', 'Rafael', 'Gustavo', 'Vinícius', 'Bruno', 'Thiago', 'Felipe', 'Rodrigo', 'Igor', 'Caio', 'Danilo', 'Everton', 'Arthur', 'Wesley', 'Luiz', 'Renan'],
  ar: ['Salem', 'Mohammed', 'Abdullah', 'Fahad', 'Saud', 'Nawaf', 'Yasser', 'Firas', 'Sultan', 'Hassan', 'Ali', 'Turki', 'Abdulrahman', 'Khalid', 'Saleh', 'Majed', 'Ayman'],
  eu: ['Lukas', 'Florian', 'Jonas', 'Leon', 'Kevin', 'Thijs', 'Daan', 'Bram', 'Mats', 'Kasper', 'Jesper', 'Nuno', 'Rúben', 'Théo', 'Arda', 'Kerem', 'Yusuf', 'Tomáš', 'Václav', 'Arthur', 'Youssef', 'Rayan', 'Désiré', 'Emil'],
};
const LAST: Record<Nat, string[]> = {
  es: ['García', 'Martínez', 'López', 'Sánchez', 'Pérez', 'Gómez', 'Fernández', 'Ruiz', 'Díaz', 'Moreno', 'Muñoz', 'Álvarez', 'Romero', 'Navarro', 'Torres', 'Domínguez', 'Gil', 'Vázquez', 'Serrano', 'Ramos', 'Blanco', 'Molina', 'Ortega', 'Delgado', 'Castro', 'Ortiz', 'Rubio', 'Marín', 'Sanz', 'Iglesias', 'Garrido', 'Herrera', 'Cortés', 'Lozano', 'Méndez', 'Prieto', 'Cabrera', 'Aguirre', 'Etxeberria', 'Zubieta'],
  en: ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies', 'Robinson', 'Wright', 'Thompson', 'Evans', 'Walker', 'White', 'Roberts', 'Green', 'Hall', 'Wood', 'Jackson', 'Clarke', 'Hughes', 'Edwards', 'Turner', 'Hill', 'Cooper', 'Ward', 'Morris', 'Bennett', 'Barnes', 'Palmer'],
  it: ['Rossi', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca', 'Costa', 'Giordano', 'Mancini', 'Rizzo', 'Lombardi', 'Moretti', 'Barbieri', 'Fontana', 'Santoro', 'Mariani', 'Rinaldi', 'Caruso', 'Ferrara', 'Galli', 'Martini', 'Leone', 'Gentile', 'Vitale', 'Pellegrini'],
  br: ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Carvalho', 'Araújo', 'Ribeiro', 'Gomes', 'Martins', 'Rocha', 'Barbosa', 'Cardoso', 'Teixeira', 'Moreira', 'Mendes', 'Freitas', 'Vieira', 'Monteiro'],
  ar: ['Al-Dawsari', 'Al-Shehri', 'Al-Faraj', 'Al-Malki', 'Al-Buraikan', 'Al-Ghannam', 'Al-Bulaihi', 'Al-Najei', 'Al-Amri', 'Kanno', 'Al-Owais', 'Al-Aqidi', 'Al-Harbi', 'Al-Juwayr', 'Al-Tambakti', 'Al-Ghamdi', 'Al-Qahtani'],
  eu: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'de Jong', 'van Dijk', 'Bakker', 'Janssen', 'Hansen', 'Nielsen', 'Larsen', 'Johansen', 'Fernandes', 'Martin', 'Bernard', 'Dubois', 'Leroy', 'Lambert', 'Yılmaz', 'Kaya', 'Demir', 'Novák', 'Svoboda', 'Peeters', 'Maes', 'Dimitriou', 'Papadopoulos', 'Mammadov', 'Ospanov'],
};

type Pos = 'G' | 'D' | 'M' | 'F';
interface PlayerDef {
  ref: PlayerRef;
  pos: Pos;
  /** calidad relativa (multiplica tasas) */
  q: number;
  /** probabilidad de ser titular */
  startP: number;
}
interface TeamDef extends TeamRef {
  elo0: number;
  nat: Nat;
  players: PlayerDef[];
  primaryComp: string;
}

const TEAMS = new Map<string, TeamDef>();
const TEAM_BY_NAME = new Map<string, TeamDef>();
let nextTeamId = 3001;
let nextPlayerId = 410001;

function makePlayers(t: TeamDef): PlayerDef[] {
  const layout: Pos[] = ['G', 'G', 'D', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'M', 'M', 'F', 'F', 'F', 'F'];
  const used = new Set<string>();
  return layout.map((pos, i) => {
    let name = '';
    for (let k = 0; k < 20; k++) {
      name = `${pickOne(FIRST[t.nat])} ${pickOne(LAST[t.nat])}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    const [first, ...rest] = name.split(' ');
    const regular = pos === 'G' ? i === 0 : [2, 3, 4, 5, 7, 8, 9, 12, 13].includes(i);
    const q = pos === 'F' && i === 12 ? 1.25 + rand() * 0.2 : regular ? 0.85 + rand() * 0.3 : 0.5 + rand() * 0.3;
    return {
      ref: { id: String(nextPlayerId++), name, short: `${first[0]}. ${rest.join(' ')}`, position: pos, teamId: t.id },
      pos,
      q,
      startP: pos === 'G' ? (i === 0 ? 0.95 : 0.05) : regular ? 0.85 : 0.3,
    };
  });
}

function team(name: string, short: string, abbr: string, color: string, elo0: number, nat: Nat, comp: string): TeamDef {
  const existing = TEAM_BY_NAME.get(name);
  if (existing) return existing;
  const t: TeamDef = { id: String(nextTeamId++), name, short, abbr, color, elo0, nat, players: [], primaryComp: comp };
  t.players = makePlayers(t);
  TEAMS.set(t.id, t);
  TEAM_BY_NAME.set(name, t);
  return t;
}
const ref = (t: TeamDef): TeamRef => ({ id: t.id, name: t.name, short: t.short, abbr: t.abbr, color: t.color });

type TeamSpec = [name: string, short: string, abbr: string, color: string];
function league(comp: string, nat: Nat, top: number, bottom: number, specs: TeamSpec[]): TeamDef[] {
  const n = specs.length;
  return specs.map(([name, short, abbr, color], i) => {
    const elo = top - (top - bottom) * Math.pow(i / (n - 1), 0.85) + normal(0, 18);
    return team(name, short, abbr, color, Math.round(elo), nat, comp);
  });
}

const LALIGA = league('laliga', 'es', 1905, 1585, [
  ['Real Madrid', 'R. Madrid', 'RMA', 'febe10'], ['Barcelona', 'Barcelona', 'BAR', 'a50044'], ['Atlético de Madrid', 'Atlético', 'ATM', 'cb3524'],
  ['Athletic Club', 'Athletic', 'ATH', 'ee2523'], ['Villarreal', 'Villarreal', 'VIL', 'f5d300'], ['Real Betis', 'Betis', 'BET', '00954c'],
  ['Real Sociedad', 'R. Sociedad', 'RSO', '0067b1'], ['Girona', 'Girona', 'GIR', 'cd2534'], ['Sevilla', 'Sevilla', 'SEV', 'd71920'],
  ['Valencia', 'Valencia', 'VAL', 'ee3524'], ['Osasuna', 'Osasuna', 'OSA', 'd91a21'], ['Celta de Vigo', 'Celta', 'CEL', '8ac3ee'],
  ['Rayo Vallecano', 'Rayo', 'RAY', 'e53027'], ['Mallorca', 'Mallorca', 'MLL', 'e20613'], ['Getafe', 'Getafe', 'GET', '005999'],
  ['Espanyol', 'Espanyol', 'ESP', '007fc8'], ['Alavés', 'Alavés', 'ALA', '0761af'], ['Elche', 'Elche', 'ELC', '05642c'],
  ['Levante', 'Levante', 'LEV', 'b4053f'], ['Real Oviedo', 'Oviedo', 'OVI', '0055a5'],
]);
const PREMIER = league('premier', 'en', 1925, 1600, [
  ['Arsenal', 'Arsenal', 'ARS', 'ef0107'], ['Manchester City', 'Man City', 'MCI', '6cabdd'], ['Liverpool', 'Liverpool', 'LIV', 'c8102e'],
  ['Chelsea', 'Chelsea', 'CHE', '034694'], ['Newcastle United', 'Newcastle', 'NEW', '241f20'], ['Aston Villa', 'Aston Villa', 'AVL', '670e36'],
  ['Tottenham Hotspur', 'Tottenham', 'TOT', '132257'], ['Manchester United', 'Man United', 'MUN', 'da291c'], ['Brighton & Hove Albion', 'Brighton', 'BHA', '0057b8'],
  ['Crystal Palace', 'C. Palace', 'CRY', '1b458f'], ['Bournemouth', 'Bournemouth', 'BOU', 'b50e12'], ['Fulham', 'Fulham', 'FUL', '000000'],
  ['Brentford', 'Brentford', 'BRE', 'e30613'], ['Nottingham Forest', "Nott'm Forest", 'NFO', 'dd0000'], ['Everton', 'Everton', 'EVE', '003399'],
  ['West Ham United', 'West Ham', 'WHU', '7a263a'], ['Leeds United', 'Leeds', 'LEE', 'ffcd00'], ['Sunderland', 'Sunderland', 'SUN', 'eb172b'],
  ['Wolverhampton', 'Wolves', 'WOL', 'fdb913'], ['Burnley', 'Burnley', 'BUR', '6c1d45'],
]);
const SERIEA = league('seriea', 'it', 1880, 1570, [
  ['Inter', 'Inter', 'INT', '010e80'], ['Napoli', 'Napoli', 'NAP', '12a0d7'], ['Juventus', 'Juventus', 'JUV', '000000'],
  ['AC Milan', 'Milan', 'MIL', 'fb090b'], ['Atalanta', 'Atalanta', 'ATA', '1e71b8'], ['Roma', 'Roma', 'ROM', '8e1f2f'],
  ['Como', 'Como', 'COM', '1d3e7a'], ['Lazio', 'Lazio', 'LAZ', '87d8f7'], ['Bologna', 'Bologna', 'BOL', '1a2f48'],
  ['Fiorentina', 'Fiorentina', 'FIO', '482e92'], ['Torino', 'Torino', 'TOR', '8a1e03'], ['Udinese', 'Udinese', 'UDI', '000000'],
  ['Genoa', 'Genoa', 'GEN', 'a61f2a'], ['Cagliari', 'Cagliari', 'CAG', '002350'], ['Sassuolo', 'Sassuolo', 'SAS', '00a752'],
  ['Parma', 'Parma', 'PAR', 'ffd200'], ['Lecce', 'Lecce', 'LEC', 'f5d100'], ['Hellas Verona', 'Verona', 'VER', '002f6c'],
  ['Cremonese', 'Cremonese', 'CRE', 'c8102e'], ['Pisa', 'Pisa', 'PIS', '000080'],
]);
const BRASIL = league('brasileirao', 'br', 1740, 1500, [
  ['Flamengo', 'Flamengo', 'FLA', 'c52613'], ['Palmeiras', 'Palmeiras', 'PAL', '006437'], ['Cruzeiro', 'Cruzeiro', 'CRU', '2f529e'],
  ['Botafogo', 'Botafogo', 'BOT', '000000'], ['Mirassol', 'Mirassol', 'MIR', 'f2c200'], ['Bahia', 'Bahia', 'BAH', '006cb5'],
  ['Fluminense', 'Fluminense', 'FLU', '7a1437'], ['São Paulo', 'São Paulo', 'SAO', 'ed1c24'], ['Corinthians', 'Corinthians', 'COR', '000000'],
  ['Internacional', 'Internacional', 'SCI', 'e30613'], ['Grêmio', 'Grêmio', 'GRE', '0d80bf'], ['Atlético Mineiro', 'Atlético-MG', 'CAM', '000000'],
  ['Vasco da Gama', 'Vasco', 'VAS', '000000'], ['Bragantino', 'Bragantino', 'RBB', 'e30613'], ['Santos', 'Santos', 'SAN', '000000'],
  ['Vitória', 'Vitória', 'VIT', 'd7001d'], ['Fortaleza', 'Fortaleza', 'FOR', '11519b'], ['Ceará', 'Ceará', 'CEA', '000000'],
  ['Juventude', 'Juventude', 'JUD', '008d3f'], ['Sport Recife', 'Sport', 'SPT', 'd71920'],
]);
const SAUDI = league('saudi', 'ar', 1650, 1410, [
  ['Al Hilal', 'Al Hilal', 'HIL', '1c4ea3'], ['Al Nassr', 'Al Nassr', 'NAS', 'f2c80f'], ['Al Ittihad', 'Al Ittihad', 'ITT', 'e5b80b'],
  ['Al Ahli', 'Al Ahli', 'AHL', '006a4e'], ['Al Qadsiah', 'Al Qadsiah', 'QAD', 'e30613'], ['Al Taawoun', 'Al Taawoun', 'TAW', 'f2b705'],
  ['Al Ettifaq', 'Al Ettifaq', 'ETT', '00843d'], ['Al Shabab', 'Al Shabab', 'SHB', '6d6e71'], ['Al Fateh', 'Al Fateh', 'FAT', '0b5394'],
  ['Al Khaleej', 'Al Khaleej', 'KHA', 'e3a600'], ['Al Riyadh', 'Al Riyadh', 'RIY', 'e30613'], ['Al Fayha', 'Al Fayha', 'FAY', 'f58220'],
  ['Al Kholood', 'Al Kholood', 'KHO', '7b1fa2'], ['Al Okhdood', 'Al Okhdood', 'OKH', '2e7d32'], ['Damac', 'Damac', 'DAM', 'c62828'],
  ['Al Hazem', 'Al Hazem', 'HAZ', '1565c0'], ['Al Najma', 'Al Najma', 'NAJ', 'f9a825'], ['Neom', 'Neom', 'NEO', '00897b'],
]);
const UCL_EXTRA: [string, string, string, string, number][] = [
  ['Bayern München', 'Bayern', 'BAY', 'dc052d', 1935], ['Paris Saint-Germain', 'PSG', 'PSG', '004170', 1905], ['Bayer Leverkusen', 'Leverkusen', 'B04', 'e32221', 1815],
  ['Borussia Dortmund', 'Dortmund', 'BVB', 'f5c400', 1800], ['Sporting CP', 'Sporting', 'SCP', '008057', 1770], ['Benfica', 'Benfica', 'BEN', 'e83030', 1760],
  ['Eintracht Frankfurt', 'Frankfurt', 'SGE', 'e1000f', 1740], ['Olympique de Marseille', 'Marsella', 'OM', '2faee0', 1730], ['PSV Eindhoven', 'PSV', 'PSV', 'ed1c24', 1730],
  ['Galatasaray', 'Galatasaray', 'GAL', 'a90432', 1720], ['AS Monaco', 'Mónaco', 'ASM', 'e51b22', 1715], ['Club Brugge', 'Brujas', 'BRU', '0076c0', 1700],
  ['Ajax', 'Ajax', 'AJA', 'd2122e', 1680], ['Olympiacos', 'Olympiacos', 'OLY', 'e2001a', 1660], ['Union Saint-Gilloise', 'Union SG', 'USG', 'e7b900', 1650],
  ['Slavia Praga', 'Slavia', 'SLA', 'e30613', 1640], ['FC Copenhague', 'Copenhague', 'FCK', '0b2265', 1640], ['Bodø/Glimt', 'Bodø/Glimt', 'BOD', 'e6c200', 1630],
  ['Qarabağ', 'Qarabağ', 'QAR', '000000', 1585], ['Pafos', 'Pafos', 'PAF', '0055a4', 1545], ['Kairat Almaty', 'Kairat', 'KAI', 'd4a900', 1520],
];
const UCL: TeamDef[] = [
  ...['Real Madrid', 'Barcelona', 'Atlético de Madrid', 'Athletic Club', 'Villarreal', 'Arsenal', 'Manchester City', 'Liverpool', 'Chelsea', 'Tottenham Hotspur', 'Newcastle United', 'Inter', 'Napoli', 'Juventus', 'Atalanta'].map(
    (n) => TEAM_BY_NAME.get(n)!,
  ),
  ...UCL_EXTRA.map(([n, s, a, c, e]) => team(n, s, a, c, e, 'eu', 'champions')),
];
const COPA_LOWER: TeamDef[] = (
  [
    ['Real Zaragoza', 'Zaragoza', 'ZAR', '0047ab', 1520], ['Deportivo de La Coruña', 'Deportivo', 'DEP', '0067b1', 1545], ['Racing de Santander', 'Racing', 'RAC', '00843d', 1550],
    ['Sporting de Gijón', 'Sporting', 'SPG', 'e30613', 1530], ['Málaga', 'Málaga', 'MAL', '1c5ba7', 1525], ['Tenerife', 'Tenerife', 'TEN', '1e4fa0', 1470],
    ['Cultural Leonesa', 'Cultural', 'CYD', '2b2b2b', 1480], ['Real Murcia', 'Murcia', 'MUR', 'c8102e', 1460], ['Hércules', 'Hércules', 'HER', '0a4fa5', 1430],
    ['Ponferradina', 'Ponferradina', 'PON', '005bac', 1440],
  ] as [string, string, string, string, number][]
).map(([n, s, a, c, e]) => team(n, s, a, c, e, 'es', 'copadelrey'));

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------
interface PlayerLineRec {
  p: PlayerDef;
  teamId: string;
  minutes: number;
  goals: number;
  assists: number;
  shots: number;
  sot: number;
  yellow: number;
  red: number;
  foulsC: number;
  foulsS: number;
  offsides: number;
  saves?: number;
  rating: number;
}
interface MatchRec {
  id: string;
  compId: string;
  ms: number;
  round: string;
  home: TeamDef;
  away: TeamDef;
  status: MatchStatus;
  statusDetail?: string;
  hg?: number;
  ag?: number;
  htH?: number;
  htA?: number;
  /** λ "verdaderos" usados para simular */
  lamH: number;
  lamA: number;
  stats?: { home: TeamMatchStatsPublic; away: TeamMatchStatsPublic };
  events?: MatchEventPublic[];
  lines?: PlayerLineRec[];
  preElo?: { h: number; a: number };
  odds?: OddsSnapshot;
  /** probabilidades pre-partido publicadas (para resultados) */
  pre?: Prob1X2;
}

const MATCHES: MatchRec[] = [];
let nextMatchId = 740101;

function statusFor(ms: number): MatchStatus {
  return ms + 115 * 60_000 < NOW_MS ? 'finished' : ms <= NOW_MS ? 'live' : 'scheduled';
}
function addMatch(compId: string, ms: number, round: string, home: TeamDef, away: TeamDef, forced?: MatchStatus): MatchRec {
  const m: MatchRec = { id: String(nextMatchId++), compId, ms, round, home, away, status: forced ?? statusFor(ms), lamH: 0, lamA: 0 };
  MATCHES.push(m);
  return m;
}

/** Calendario de liga a doble vuelta por el método del círculo. */
function roundRobin(teams: TeamDef[]): [TeamDef, TeamDef][][] {
  const n = teams.length;
  const arr = shuffle(teams);
  const rounds: [TeamDef, TeamDef][][] = [];
  for (let rd = 0; rd < n - 1; rd++) {
    const pairs: [TeamDef, TeamDef][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      pairs.push(rd % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop()!);
  }
  return [...rounds, ...rounds.map((rd) => rd.map(([a, b]) => [b, a] as [TeamDef, TeamDef]))];
}

const TIMES: [number, number][] = [[12, 0], [14, 15], [16, 30], [19, 0], [20, 0]];
// Hoy: horas aún por jugar (o inmediatas si es tarde)
const T_TODAY_1 = Math.min(Math.max(NOW_MS + 100 * 60_000, at(0, 17, 45)), at(0, 23, 0));
const T_TODAY_2 = Math.min(Math.max(NOW_MS + 160 * 60_000, at(0, 20, 0)), at(0, 23, 40));

function scheduleLeague(compId: string, teams: TeamDef[], playedRounds: number, gapDays: number) {
  const rounds = roundRobin(teams);
  rounds.forEach((pairs, i) => {
    const rd = i + 1;
    pairs.forEach(([h, a], k) => {
      let ms: number;
      if (rd <= playedRounds) {
        const base = -1 - Math.round(gapDays * (playedRounds - rd));
        ms = at(base - (k % 3 === 0 ? 1 : 0), ...TIMES[k % TIMES.length]);
      } else {
        const base = 3 + Math.round(gapDays * (rd - playedRounds - 1));
        ms = at(base + (k % 3), ...TIMES[k % TIMES.length]);
      }
      addMatch(compId, ms, `Jornada ${rd}`, h, a, rd <= playedRounds ? 'finished' : 'scheduled');
    });
  });
}

scheduleLeague('laliga', LALIGA, 11, 7);
scheduleLeague('premier', PREMIER, 11, 7);
scheduleLeague('seriea', SERIEA, 11, 7);
scheduleLeague('saudi', SAUDI, 8, 7);

// Brasileirão: 31 jornadas jugadas, la 32 hoy/mañana (con un partido ya terminado hoy)
{
  const rounds = roundRobin(BRASIL);
  rounds.forEach((pairs, i) => {
    const rd = i + 1;
    pairs.forEach(([h, a], k) => {
      if (rd <= 31) {
        addMatch('brasileirao', at(-1 - Math.round(3.5 * (31 - rd)) - (k % 2), 22, k % 2 ? 0 : 30), `Rodada ${rd}`, h, a, 'finished');
      } else if (rd === 32) {
        if (k === 0) addMatch('brasileirao', Math.max(at(0, 0, 30), NOW_MS - 3 * 3600_000), `Rodada ${rd}`, h, a, 'finished');
        else if (k < 5) addMatch('brasileirao', Math.min(T_TODAY_2 + 30 * 60_000, at(0, 23, 50)), `Rodada ${rd}`, h, a, 'scheduled');
        else addMatch('brasileirao', at(1, k % 2 ? 22 : 23, 30), `Rodada ${rd}`, h, a, 'scheduled');
      } else {
        const base = 4 + 4 * (rd - 33);
        addMatch('brasileirao', at(base + (k % 2), 22, 30), `Rodada ${rd}`, h, a, 'scheduled');
      }
    });
  });
}

// Champions: fase liga de 36 equipos, 8 jornadas (3 jugadas, la 4ª hoy y mañana)
{
  const played = new Set<string>();
  const key = (a: TeamDef, b: TeamDef) => [a.id, b.id].sort().join('-');
  const mdOffsets = [-48, -34, -13, 0, 21, 35, 70, 77];
  for (let md = 1; md <= 8; md++) {
    let pairs: [TeamDef, TeamDef][] = [];
    for (let attempt = 0; attempt < 400; attempt++) {
      const pool = shuffle(UCL);
      pairs = [];
      let ok = true;
      while (pool.length) {
        const a = pool.shift()!;
        const idx = pool.findIndex((b) => !played.has(key(a, b)) && b.primaryComp !== a.primaryComp);
        const j = idx >= 0 ? idx : pool.findIndex((b) => !played.has(key(a, b)));
        if (j < 0) {
          ok = false;
          break;
        }
        const b = pool.splice(j, 1)[0];
        pairs.push(rand() < 0.5 ? [a, b] : [b, a]);
      }
      if (ok) break;
    }
    pairs.forEach(([h, a]) => played.add(key(h, a)));
    // ordenar por atractivo para poner los grandes en horario estelar
    pairs.sort((x, y) => y[0].elo0 + y[1].elo0 - (x[0].elo0 + x[1].elo0));
    pairs.forEach(([h, a], k) => {
      const second = k % 2 === 1; // mitad martes, mitad miércoles
      const off = mdOffsets[md - 1] + (second ? 1 : 0);
      if (md === 4 && !second) {
        // hoy: dos en vivo, el resto por la tarde/noche
        const idx = Math.floor(k / 2);
        if (idx === 1 || idx === 3) addMatch('champions', NOW_MS - 68 * 60_000, `Fase liga · J${md}`, h, a, 'live');
        else addMatch('champions', idx % 3 === 0 ? T_TODAY_2 : T_TODAY_1, `Fase liga · J${md}`, h, a, 'scheduled');
      } else {
        const ms = at(off, k % 4 === 0 ? 17 : 20, k % 4 === 0 ? 45 : 0);
        addMatch('champions', ms, `Fase liga · J${md}`, h, a, md <= 3 ? 'finished' : 'scheduled');
      }
    });
  }
}

// Copa del Rey: primera eliminatoria (jugada) y segunda (hoy/mañana)
{
  const low = shuffle(COPA_LOWER);
  for (let i = 0; i < 5; i++) addMatch('copadelrey', at(-7, 18 + (i % 2) * 2, 0), 'Primera eliminatoria', low[i * 2], low[i * 2 + 1], 'finished');
  const big = LALIGA.slice(5, 15);
  for (let i = 0; i < 10; i++) {
    const ms = i < 5 ? (i % 2 ? T_TODAY_2 : T_TODAY_1) : at(1, i % 2 ? 20 : 18, 0);
    addMatch('copadelrey', ms, 'Segunda eliminatoria', low[i], big[i], 'scheduled');
  }
}

MATCHES.sort((a, b) => a.ms - b.ms || Number(a.id) - Number(b.id));

// ---------------------------------------------------------------------------
// Simulación de partidos jugados / en vivo
// ---------------------------------------------------------------------------
function truthLambdas(h: TeamDef, a: TeamDef, compId: string): [number, number] {
  const d = (h.elo0 - a.elo0 + HFA) / 400;
  const base = compId === 'saudi' ? 1.5 : compId === 'seriea' ? 1.32 : 1.4;
  return [base * Math.exp(0.62 * d), (base * 0.82) * Math.exp(-0.62 * d)];
}

const RATE: Record<Pos, { g: number; a: number; sh: number; y: number; fc: number; fs: number; off: number }> = {
  G: { g: 0, a: 0.01, sh: 0.02, y: 0.05, fc: 0.1, fs: 0.3, off: 0 },
  D: { g: 0.04, a: 0.06, sh: 0.6, y: 0.22, fc: 1.2, fs: 0.8, off: 0.05 },
  M: { g: 0.13, a: 0.16, sh: 1.4, y: 0.2, fc: 1.3, fs: 1.4, off: 0.15 },
  F: { g: 0.38, a: 0.14, sh: 2.8, y: 0.12, fc: 1.0, fs: 1.5, off: 0.6 },
};

function lineup(t: TeamDef): { p: PlayerDef; min: number }[] {
  const gk = t.players.filter((p) => p.pos === 'G');
  const out: { p: PlayerDef; min: number }[] = [{ p: rand() < gk[0].startP ? gk[0] : gk[1], min: 90 }];
  const field = t.players.filter((p) => p.pos !== 'G');
  const starters: PlayerDef[] = [];
  const need: Record<Pos, number> = { G: 0, D: 4, M: 3 + (rand() < 0.5 ? 1 : 0), F: 0 };
  need.F = 10 - need.D - need.M;
  for (const pos of ['D', 'M', 'F'] as Pos[]) {
    const pool = field.filter((p) => p.pos === pos).sort((x, y) => y.startP * (0.7 + rand() * 0.6) - x.startP * (0.7 + rand() * 0.6));
    starters.push(...pool.slice(0, need[pos]));
  }
  const bench = shuffle(field.filter((p) => !starters.includes(p)));
  const subs = 3 + Math.floor(rand() * 3);
  const subbedOff = shuffle(starters).slice(0, subs);
  for (const s of starters) {
    const off = subbedOff.indexOf(s);
    out.push({ p: s, min: off >= 0 ? 58 + Math.floor(rand() * 30) : 90 });
    if (off >= 0 && bench[off]) out.push({ p: bench[off], min: 90 - (58 + Math.floor(rand() * 30)) + 2 });
  }
  return out.map((x) => ({ p: x.p, min: clampN(x.min, 1, 90) }));
}

function simulateMatch(m: MatchRec, fraction = 1) {
  const [lh, la] = [m.lamH, m.lamA];
  const sides: [TeamDef, number, 'home' | 'away'][] = [[m.home, lh, 'home'], [m.away, la, 'away']];
  const lines: PlayerLineRec[] = [];
  const events: MatchEventPublic[] = [];
  const goals: Record<'home' | 'away', number> = { home: 0, away: 0 };
  const ht: Record<'home' | 'away', number> = { home: 0, away: 0 };
  const teamStats: Record<'home' | 'away', TeamMatchStatsPublic> = { home: { goals: 0 }, away: { goals: 0 } };
  const maxMin = Math.round(90 * fraction);
  for (const [t, lam, side] of sides) {
    const g = samplePoisson(lam * fraction, rand);
    goals[side] = g;
    const lu = lineup(t).map((x) => ({ ...x, min: Math.min(x.min, maxMin) })).filter((x) => x.min > 0);
    const plines: PlayerLineRec[] = lu.map(({ p, min }) => {
      const s = Math.exp((t.elo0 - 1700) / 900) * p.q * (min / 90);
      const shots = samplePoisson(RATE[p.pos].sh * s * (0.6 + lam / 3), rand);
      const sot = Math.min(shots, samplePoisson(shots * 0.36, rand));
      const fc = samplePoisson(RATE[p.pos].fc * (min / 90), rand);
      const y = rand() < RATE[p.pos].y * (min / 90) ? 1 : 0;
      return {
        p,
        teamId: t.id,
        minutes: min,
        goals: 0,
        assists: 0,
        shots,
        sot,
        yellow: y,
        red: y === 0 && rand() < 0.006 ? 1 : 0,
        foulsC: fc,
        foulsS: samplePoisson(RATE[p.pos].fs * (min / 90), rand),
        offsides: samplePoisson(RATE[p.pos].off * (min / 90), rand),
        saves: p.pos === 'G' ? 0 : undefined,
        rating: 0,
      };
    });
    for (let k = 0; k < g; k++) {
      const scorer = weightedPick(plines, (l) => (RATE[l.p.pos].g + 0.005) * l.p.q * l.minutes);
      scorer.goals++;
      scorer.sot = Math.max(scorer.sot, scorer.goals);
      scorer.shots = Math.max(scorer.shots, scorer.sot);
      let assister: PlayerLineRec | undefined;
      if (rand() < 0.72) {
        assister = weightedPick(
          plines.filter((l) => l !== scorer),
          (l) => (RATE[l.p.pos].a + 0.005) * l.p.q * l.minutes,
        );
        assister.assists++;
      }
      const minute = 1 + Math.floor(rand() * maxMin);
      if (minute <= 45) ht[side]++;
      const pen = rand() < 0.1;
      events.push({
        minute: minute > 90 ? `90'+${minute - 90}'` : `${minute}'`,
        type: pen ? 'penalty' : 'goal',
        teamId: t.id,
        player: scorer.p.ref.name,
        playerId: scorer.p.ref.id,
        detail: assister ? `Asistencia de ${assister.p.ref.short}` : pen ? 'Penalti' : undefined,
      });
    }
    for (const l of plines) {
      if (l.yellow) events.push({ minute: `${10 + Math.floor(rand() * (maxMin - 10))}'`, type: 'yellow', teamId: t.id, player: l.p.ref.name, playerId: l.p.ref.id });
      if (l.red) events.push({ minute: `${30 + Math.floor(rand() * Math.max(1, maxMin - 30))}'`, type: 'red', teamId: t.id, player: l.p.ref.name, playerId: l.p.ref.id });
    }
    lines.push(...plines);
    const shots = sum(plines.map((l) => l.shots));
    const sot = sum(plines.map((l) => l.sot));
    teamStats[side] = {
      goals: g,
      shots,
      shotsOnTarget: sot,
      corners: Math.max(0, Math.round((2.2 + 1.7 * lam) * fraction + normal(0, 1.6))),
      fouls: sum(plines.map((l) => l.foulsC)),
      yellow: sum(plines.map((l) => l.yellow)),
      red: sum(plines.map((l) => l.red)),
      offsides: sum(plines.map((l) => l.offsides)),
      passes: Math.round((380 + (t.elo0 - 1600) * 0.5 + normal(0, 40)) * fraction),
      passPct: r(clampN(0.78 + (t.elo0 - 1650) / 2500 + normal(0, 0.02), 0.65, 0.93), 3),
      tackles: Math.round((16 + normal(0, 3)) * fraction),
    };
  }
  // posesión y paradas
  const pH = clampN(Math.round(50 + (m.home.elo0 - m.away.elo0) / 14 + normal(0, 5)), 25, 75);
  teamStats.home.possession = pH;
  teamStats.away.possession = 100 - pH;
  teamStats.home.saves = Math.max(0, (teamStats.away.shotsOnTarget ?? 0) - goals.away);
  teamStats.away.saves = Math.max(0, (teamStats.home.shotsOnTarget ?? 0) - goals.home);
  for (const l of lines) {
    if (l.p.pos === 'G') l.saves = l.teamId === m.home.id ? teamStats.home.saves : teamStats.away.saves;
  }
  // notas
  for (const l of lines) {
    const isHome = l.teamId === m.home.id;
    const gf = isHome ? goals.home : goals.away;
    const ga = isHome ? goals.away : goals.home;
    const res = gf > ga ? 0.45 : gf === ga ? 0.05 : -0.35;
    const cs = l.p.pos === 'G' || l.p.pos === 'D' ? (ga === 0 ? 0.6 : -0.15 * ga) : 0;
    l.rating = r(clampN(6.2 + 1.1 * l.goals + 0.7 * l.assists + 0.18 * l.sot + res + cs - 0.6 * l.red + normal(0, 0.45), 3.5, 10), 1);
  }
  events.sort((a, b) => parseInt(a.minute) - parseInt(b.minute));
  m.hg = goals.home;
  m.ag = goals.away;
  m.htH = Math.min(ht.home, goals.home);
  m.htA = Math.min(ht.away, goals.away);
  m.stats = teamStats;
  m.events = events;
  m.lines = lines;
}

/** Cuotas sintéticas de casa (margen ~5,5%) alrededor de la probabilidad "real" con ruido. */
function makeOdds(trueP: Prob1X2, over25: number, noise = 0.05): OddsSnapshot {
  const margin = 0.052 + rand() * 0.012;
  const jitter = (p: number) => clampN(p * Math.exp(normal(0, noise)), 0.02, 0.97);
  const ph = jitter(trueP.home);
  const pd = jitter(trueP.draw);
  const pa = jitter(trueP.away);
  const s = ph + pd + pa;
  const odd = (p: number) => r(1 / ((p / s) * (1 + margin)), 2);
  const po = clampN(jitter(over25), 0.05, 0.95);
  const oOdds = r(1 / (po * (1 + margin / 2)), 2);
  const uOdds = r(1 / ((1 - po) * (1 + margin / 2)), 2);
  const home = odd(ph);
  const draw = odd(pd);
  const away = odd(pa);
  return {
    provider: 'DraftKings',
    home,
    draw,
    away,
    homeOpen: r(home * (1 + normal(0, 0.03)), 2),
    drawOpen: r(draw * (1 + normal(0, 0.02)), 2),
    awayOpen: r(away * (1 + normal(0, 0.03)), 2),
    totalLine: 2.5,
    over: oOdds,
    under: uOdds,
    overOpen: r(oOdds * (1 + normal(0, 0.02)), 2),
    underOpen: r(uOdds * (1 + normal(0, 0.02)), 2),
    margin: r(1 / home + 1 / draw + 1 / away - 1, 4),
    capturedAt: GENERATED_AT,
  };
}

const elo = new Elo({ k: MODEL.eloK, homeAdv: HFA, init: MODEL.eloInit });
for (const t of TEAMS.values()) elo.set(t.id, t.elo0 - 25 + normal(0, 20));

for (const m of MATCHES) {
  [m.lamH, m.lamA] = truthLambdas(m.home, m.away, m.compId);
  const truthM = scoreMatrix(m.lamH, m.lamA, -0.05, 10);
  const truth = outcomeProbs(truthM);
  if (m.status === 'finished' || m.status === 'live') {
    const pre = { h: elo.get(m.home.id), a: elo.get(m.away.id) };
    m.preElo = pre;
    const eP = eloProbs(pre.h + HFA - pre.a);
    // "modelo" pre-partido publicado: mezcla de verdad con ruido (proxy DC) + Elo
    const noisy = (p: number) => clampN(p + normal(0, 0.035), 0.03, 0.95);
    const dcP = { home: noisy(truth.home), draw: noisy(truth.draw), away: noisy(truth.away) };
    m.odds = m.compId === 'saudi' || m.compId === 'copadelrey' ? undefined : makeOdds(truth, outcomeOver(truthM), 0.04);
    const mk = m.odds ? devig([m.odds.home!, m.odds.draw!, m.odds.away!]) : undefined;
    m.pre = blend([
      { probs: dcP, weight: MODEL.wDixonColes },
      { probs: eP, weight: MODEL.wElo },
      ...(mk ? [{ probs: { home: mk[0], draw: mk[1], away: mk[2] }, weight: MODEL.wMarket }] : []),
    ]);
    if (m.status === 'live') {
      simulateMatch(m, 68 / 90);
      m.statusDetail = "68'";
    } else {
      simulateMatch(m);
      m.statusDetail = 'Final';
      elo.update({ id: m.id, date: iso(m.ms), home: m.home.id, away: m.away.id, hg: m.hg!, ag: m.ag!, kMultiplier: m.compId === 'champions' ? 1.2 : 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// Agregados por competición
// ---------------------------------------------------------------------------
const COMP_IDS = ['laliga', 'premier', 'seriea', 'brasileirao', 'saudi', 'champions', 'copadelrey'] as const;
const compMatches = (c: string) => MATCHES.filter((m) => m.compId === c);
const finishedIn = (c: string) => compMatches(c).filter((m) => m.status === 'finished');
const teamsIn = (c: string): TeamDef[] => {
  const s = new Map<string, TeamDef>();
  for (const m of compMatches(c)) {
    s.set(m.home.id, m.home);
    s.set(m.away.id, m.away);
  }
  return [...s.values()];
};

const DC: Record<string, DCModel> = {};
for (const c of ['laliga', 'premier', 'seriea', 'brasileirao', 'saudi']) {
  DC[c] = fitDixonColes(
    finishedIn(c).map((m) => ({ home: m.home.id, away: m.away.id, hg: m.hg!, ag: m.ag!, date: iso(m.ms) })),
    { refDate: GENERATED_AT, xi: MODEL.dcXi },
  );
}

function eloLambdas(h: TeamDef, a: TeamDef): { lambdaHome: number; lambdaAway: number } {
  const d = (elo.get(h.id) - elo.get(a.id) + HFA) / 400;
  return { lambdaHome: 1.38 * Math.exp(0.6 * d), lambdaAway: 1.12 * Math.exp(-0.6 * d) };
}
function modelLambdas(m: MatchRec): { lambdaHome: number; lambdaAway: number; rho: number; source: 'dc' | 'elo' } {
  const dcModel = DC[m.compId] ?? DC[m.home.primaryComp];
  const p = dcModel ? predictDC(dcModel, m.home.id, m.away.id) : null;
  if (p && DC[m.compId]) {
    // mock: acercamos el DC ajustado a los λ "reales" (media geométrica) para que el modelo sea
    // razonablemente bueno y los EV salgan en rangos realistas
    const [th, ta] = truthLambdas(m.home, m.away, m.compId);
    return { lambdaHome: Math.sqrt(p.lambdaHome * th), lambdaAway: Math.sqrt(p.lambdaAway * ta), rho: dcModel.rho, source: 'dc' };
  }
  return { ...eloLambdas(m.home, m.away), rho: -0.05, source: 'elo' };
}

// --- Estadísticas de temporada por equipo
function teamMatchesIn(c: string | null, t: TeamDef, statuses: MatchStatus[] = ['finished']): MatchRec[] {
  return MATCHES.filter((m) => (c === null || m.compId === c) && statuses.includes(m.status) && (m.home.id === t.id || m.away.id === t.id));
}

function formMatch(m: MatchRec, t: TeamDef): FormMatch {
  const isHome = m.home.id === t.id;
  const gf = isHome ? m.hg! : m.ag!;
  const ga = isHome ? m.ag! : m.hg!;
  const s = isHome ? m.stats!.home : m.stats!.away;
  const o = isHome ? m.stats!.away : m.stats!.home;
  return {
    matchId: m.id,
    date: iso(m.ms),
    compId: m.compId,
    opponent: ref(isHome ? m.away : m.home),
    isHome,
    gf,
    ga,
    result: gf > ga ? 'W' : gf === ga ? 'D' : 'L',
    shots: s.shots,
    shotsOnTarget: s.shotsOnTarget,
    corners: s.corners,
    cornersAgainst: o.corners,
    cards: (s.yellow ?? 0) + (s.red ?? 0),
    fouls: s.fouls,
    possession: s.possession,
    xg: r(isHome ? m.lamH : m.lamA, 2),
    xga: r(isHome ? m.lamA : m.lamH, 2),
  };
}

const pts = (o: Outcome) => (o === 'W' ? 3 : o === 'D' ? 1 : 0);
function formIndexFrom(fm: FormMatch[]): number {
  // fm: más reciente primero
  const last = fm.slice(0, 6);
  if (!last.length) return 50;
  let wsum = 0;
  let s = 0;
  last.forEach((x, i) => {
    const w = Math.pow(0.8, i);
    const score = pts(x.result) / 3 * 0.65 + clampN((x.gf - x.ga + 3) / 6, 0, 1) * 0.2 + clampN(((x.xg ?? 1.3) - (x.xga ?? 1.3) + 1.5) / 3, 0, 1) * 0.15;
    s += w * score;
    wsum += w;
  });
  return Math.round(clampN((s / wsum) * 100, 2, 99));
}
function formString(fmRecentFirst: FormMatch[], n = 5): string {
  return fmRecentFirst.slice(0, n).map((x) => x.result).reverse().join('');
}

function split(ms: MatchRec[], t: TeamDef, f: (fm: FormMatch, m: MatchRec) => number | undefined) {
  const vals = (pred: (m: MatchRec) => boolean) => {
    const xs = ms.filter(pred).map((m) => f(formMatch(m, t), m)).filter((v): v is number => typeof v === 'number');
    return xs.length ? r(avg(xs), 2) : 0;
  };
  return { all: vals(() => true), home: vals((m) => m.home.id === t.id), away: vals((m) => m.away.id === t.id) };
}

function seasonStats(c: string, t: TeamDef): TeamSeasonStats {
  const ms = teamMatchesIn(c, t).sort((a, b) => b.ms - a.ms);
  const fms = ms.map((m) => formMatch(m, t));
  const n = ms.length || 1;
  const share = (pred: (x: FormMatch) => boolean) => r(fms.filter(pred).length / n, 3);
  const opp = (m: MatchRec) => (m.home.id === t.id ? m.stats!.away : m.stats!.home);
  const periods = (mine: boolean) => {
    const b = [0, 0, 0, 0, 0, 0];
    for (const m of ms)
      for (const e of m.events ?? []) {
        if (!['goal', 'penalty', 'own-goal'].includes(e.type)) continue;
        if ((e.teamId === t.id) !== mine) continue;
        const min = parseInt(e.minute);
        b[Math.min(5, Math.floor((Math.min(min, 90) - 1) / 15))]++;
      }
    return b;
  };
  return {
    team: ref(t),
    played: { all: ms.length, home: ms.filter((m) => m.home.id === t.id).length, away: ms.filter((m) => m.away.id === t.id).length },
    goalsFor: split(ms, t, (x) => x.gf),
    goalsAgainst: split(ms, t, (x) => x.ga),
    xgFor: split(ms, t, (x) => x.xg),
    xgAgainst: split(ms, t, (x) => x.xga),
    shots: split(ms, t, (x) => x.shots),
    shotsAgainst: split(ms, t, (_x, m) => opp(m).shots),
    shotsOnTarget: split(ms, t, (x) => x.shotsOnTarget),
    shotsOnTargetAgainst: split(ms, t, (_x, m) => opp(m).shotsOnTarget),
    corners: split(ms, t, (x) => x.corners),
    cornersAgainst: split(ms, t, (x) => x.cornersAgainst),
    cards: split(ms, t, (x) => x.cards),
    cardsAgainst: split(ms, t, (_x, m) => (opp(m).yellow ?? 0) + (opp(m).red ?? 0)),
    fouls: split(ms, t, (x) => x.fouls),
    possession: split(ms, t, (x) => x.possession),
    over15Pct: share((x) => x.gf + x.ga > 1.5),
    over25Pct: share((x) => x.gf + x.ga > 2.5),
    over35Pct: share((x) => x.gf + x.ga > 3.5),
    bttsPct: share((x) => x.gf > 0 && x.ga > 0),
    cleanSheetPct: share((x) => x.ga === 0),
    failedToScorePct: share((x) => x.gf === 0),
    winPct: share((x) => x.result === 'W'),
    drawPct: share((x) => x.result === 'D'),
    lossPct: share((x) => x.result === 'L'),
    goalsByPeriod: periods(true),
    concededByPeriod: periods(false),
    formString: formString(fms),
    formIndex: formIndexFrom(fms),
  };
}

function leagueAverages(c: string): LeagueAverages {
  const ms = finishedIn(c);
  const n = ms.length || 1;
  const tot = (f: (m: MatchRec) => number) => r(sum(ms.map(f)) / n, 2);
  return {
    goalsPerMatch: tot((m) => m.hg! + m.ag!),
    homeGoals: tot((m) => m.hg!),
    awayGoals: tot((m) => m.ag!),
    homeWinPct: r(ms.filter((m) => m.hg! > m.ag!).length / n, 3),
    drawPct: r(ms.filter((m) => m.hg === m.ag).length / n, 3),
    awayWinPct: r(ms.filter((m) => m.hg! < m.ag!).length / n, 3),
    over25Pct: r(ms.filter((m) => m.hg! + m.ag! > 2.5).length / n, 3),
    bttsPct: r(ms.filter((m) => m.hg! > 0 && m.ag! > 0).length / n, 3),
    cornersPerMatch: tot((m) => (m.stats!.home.corners ?? 0) + (m.stats!.away.corners ?? 0)),
    cardsPerMatch: tot((m) => (m.stats!.home.yellow ?? 0) + (m.stats!.away.yellow ?? 0) + (m.stats!.home.red ?? 0) + (m.stats!.away.red ?? 0)),
    shotsPerMatch: tot((m) => (m.stats!.home.shots ?? 0) + (m.stats!.away.shots ?? 0)),
    shotsOnTargetPerMatch: tot((m) => (m.stats!.home.shotsOnTarget ?? 0) + (m.stats!.away.shotsOnTarget ?? 0)),
    foulsPerMatch: tot((m) => (m.stats!.home.fouls ?? 0) + (m.stats!.away.fouls ?? 0)),
  };
}

// --- Clasificación
const ZONE_COLORS: Record<string, string> = {
  Champions: '#2f7de1',
  'Top 8': '#2f7de1',
  Europa: '#f08a24',
  Playoff: '#f08a24',
  Libertadores: '#2f7de1',
  'Top 2': '#2f7de1',
  Descenso: '#d64045',
  Eliminado: '#d64045',
};
function zoneFor(c: string, rank: number, n: number): { label: string; color: string } | undefined {
  const cfg = COMPETITION_BY_ID.get(c);
  for (const z of cfg?.simulationZones ?? []) {
    if (z.label === 'Campeón' || z.label === 'Líder') continue;
    const from = z.from < 0 ? n + z.from + 1 : z.from;
    const to = z.to < 0 ? n + z.to + 1 : z.to;
    if (rank >= from && rank <= to) {
      const label = z.label === 'Champions' ? 'Champions League' : z.label === 'Europa' ? 'Europa League' : z.label === 'Top 8' ? 'Octavos de final' : z.label === 'Playoff' ? 'Playoff de eliminatorias' : z.label;
      return { label, color: ZONE_COLORS[z.label] ?? '#94a3b8' };
    }
  }
  return undefined;
}

function standings(c: string): StandingRow[] {
  const ts = teamsIn(c);
  const rows = ts.map((t) => {
    const ms = teamMatchesIn(c, t).sort((a, b) => b.ms - a.ms);
    const fms = ms.map((m) => formMatch(m, t));
    const won = fms.filter((x) => x.result === 'W').length;
    const drawn = fms.filter((x) => x.result === 'D').length;
    const gf = sum(fms.map((x) => x.gf));
    const ga = sum(fms.map((x) => x.ga));
    const xPts = sum(
      ms.map((m) => {
        const p = outcomeProbs(scoreMatrix(m.lamH, m.lamA, -0.05, 10));
        return m.home.id === t.id ? 3 * p.home + p.draw : 3 * p.away + p.draw;
      }),
    );
    return {
      rank: 0,
      team: ref(t),
      played: fms.length,
      won,
      drawn,
      lost: fms.length - won - drawn,
      gf,
      ga,
      gd: gf - ga,
      points: won * 3 + drawn,
      form: formString(fms),
      xPts: r(xPts, 1),
      elo: Math.round(elo.get(t.id)),
    } as StandingRow;
  });
  rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.team.name.localeCompare(b.team.name));
  rows.forEach((row, i) => {
    row.rank = i + 1;
    const z = zoneFor(c, row.rank, rows.length);
    if (z) row.note = z;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Predicción de partidos programados / en vivo
// ---------------------------------------------------------------------------
interface Pred {
  q: QuickPrediction;
  model: ModelBreakdown;
  markets: Market[];
  valueBets: ValuePick[];
  lam: { lambdaHome: number; lambdaAway: number; rho: number };
}
const PRED = new Map<string, Pred>();
const SEASON = new Map<string, Map<string, TeamSeasonStats>>();
const AVG = new Map<string, LeagueAverages>();
for (const c of COMP_IDS) {
  const map = new Map<string, TeamSeasonStats>();
  for (const t of teamsIn(c)) map.set(t.id, seasonStats(c, t));
  SEASON.set(c, map);
  AVG.set(c, finishedIn(c).length ? leagueAverages(c) : leagueAverages('laliga'));
}
function statsFor(t: TeamDef, c: string): TeamSeasonStats {
  const s = SEASON.get(c)?.get(t.id);
  if (s && s.played.all > 0) return s;
  return SEASON.get(t.primaryComp)?.get(t.id) ?? s ?? seasonStats(t.primaryComp, t);
}

function confidenceLevel(ev: number, conf: number): ValuePick['confidence'] {
  return ev >= 0.1 && conf >= 0.6 ? 'alta' : ev >= 0.06 && conf >= 0.45 ? 'media' : 'baja';
}

function projection(key: StatProjection['key'], label: string, home: number, away: number, disp: number, maxK: number, lines: number[], leagueAvg?: number): StatProjection {
  const dh = nbPmfArray(home, disp, maxK);
  const da = nbPmfArray(away, disp, maxK);
  const tot = convolve(dh, da, maxK * 2);
  return {
    key,
    label,
    home: r(home, 2),
    away: r(away, 2),
    total: r(home + away, 2),
    totalDist: tot.map((x) => r(x, 4)),
    lines: lines.map((line) => {
      const ou = overUnderFromDist(tot, line);
      return { line, over: r(ou.over, 4), under: r(ou.under, 4) };
    }),
    most: (() => {
      const p = compareDists(dh, da);
      return { home: r(p.home, 4), draw: r(p.draw, 4), away: r(p.away, 4) };
    })(),
    leagueAvg: leagueAvg !== undefined ? r(leagueAvg, 2) : undefined,
  };
}

function projectionsFor(m: MatchRec): StatProjection[] {
  const sh = statsFor(m.home, m.compId);
  const sa = statsFor(m.away, m.compId);
  const la = AVG.get(m.compId)!;
  const mix = (f: number, a: number) => (f + a) / 2;
  return [
    projection('corners', 'Córners', mix(sh.corners.home || sh.corners.all, sa.cornersAgainst.away || sa.cornersAgainst.all) * 1.03, mix(sa.corners.away || sa.corners.all, sh.cornersAgainst.home || sh.cornersAgainst.all) * 0.97, 9, 16, [7.5, 8.5, 9.5, 10.5, 11.5, 12.5], la.cornersPerMatch),
    projection('cards', 'Tarjetas', mix(sh.cards.all, sa.cardsAgainst.all), mix(sa.cards.all, sh.cardsAgainst.all) * 1.05, 7, 10, [2.5, 3.5, 4.5, 5.5, 6.5], la.cardsPerMatch),
    projection('shots', 'Tiros', mix(sh.shots.home || sh.shots.all, sa.shotsAgainst.all), mix(sa.shots.away || sa.shots.all, sh.shotsAgainst.all), 14, 30, [20.5, 22.5, 24.5, 26.5, 28.5], la.shotsPerMatch),
    projection('shotsOnTarget', 'Tiros a puerta', mix(sh.shotsOnTarget.all, sa.shotsOnTargetAgainst.all), mix(sa.shotsOnTarget.all, sh.shotsOnTargetAgainst.all), 12, 16, [6.5, 7.5, 8.5, 9.5, 10.5], la.shotsOnTargetPerMatch),
    projection('fouls', 'Faltas', mix(sh.fouls.all, 11.5), mix(sa.fouls.all, 11.5) * 1.03, 18, 30, [20.5, 22.5, 24.5, 26.5], la.foulsPerMatch),
    projection('offsides', 'Fueras de juego', 1.7 + rand() * 0.6, 1.6 + rand() * 0.6, 5, 10, [2.5, 3.5, 4.5, 5.5]),
  ];
}

function statMarkets(proj: StatProjection[], hName: string, aName: string): Market[] {
  const out: Market[] = [];
  const groupOf: Record<string, Market['group']> = { corners: 'Córners', cards: 'Tarjetas', shots: 'Tiros', shotsOnTarget: 'Tiros', fouls: 'Faltas', offsides: 'Faltas' };
  for (const p of proj) {
    for (const l of p.lines) {
      out.push({
        id: `${p.key}-ou-${l.line}`,
        group: groupOf[p.key],
        name: `${p.label} totales ${String(l.line).replace('.', ',')}`,
        line: l.line,
        selections: [
          { label: `Más de ${String(l.line).replace('.', ',')}`, prob: l.over, fairOdds: r(Math.min(1000, 1 / Math.max(l.over, 1e-3)), 3) },
          { label: `Menos de ${String(l.line).replace('.', ',')}`, prob: l.under, fairOdds: r(Math.min(1000, 1 / Math.max(l.under, 1e-3)), 3) },
        ],
      });
    }
    if (p.most && (p.key === 'corners' || p.key === 'cards')) {
      out.push({
        id: `${p.key}-most`,
        group: groupOf[p.key],
        name: p.key === 'corners' ? 'Más córners' : 'Más tarjetas',
        selections: [
          { label: hName, prob: p.most.home, fairOdds: r(1 / Math.max(p.most.home, 1e-3), 3) },
          { label: 'Igual', prob: p.most.draw, fairOdds: r(1 / Math.max(p.most.draw, 1e-3), 3) },
          { label: aName, prob: p.most.away, fairOdds: r(1 / Math.max(p.most.away, 1e-3), 3) },
        ],
      });
    }
  }
  return out;
}

function quickFromMatrix(mat: number[][], lh: number, la: number): Pick<QuickPrediction, 'xgHome' | 'xgAway' | 'over25' | 'btts' | 'likelyScore' | 'likelyScoreProb'> {
  let over = 0;
  mat.forEach((row, i) => row.forEach((v, j) => (i + j > 2.5 ? (over += v) : 0)));
  const ml = mostLikelyScore(mat);
  return { xgHome: r(lh, 2), xgAway: r(la, 2), over25: r(over, 4), btts: r(bttsProb(mat), 4), likelyScore: `${ml.home}-${ml.away}`, likelyScoreProb: r(ml.prob, 4) };
}

function predict(m: MatchRec): Pred {
  const cached = PRED.get(m.id);
  if (cached) return cached;
  const base = modelLambdas(m);
  const dcMat = scoreMatrix(base.lambdaHome, base.lambdaAway, base.rho, 10);
  const dcP = outcomeProbs(dcMat);
  const eloDiff = elo.get(m.home.id) + HFA - elo.get(m.away.id);
  const eP = eloProbs(eloDiff);
  const truthM = scoreMatrix(m.lamH, m.lamA, -0.05, 10);
  const truth = outcomeProbs(truthM);
  let truthOver = 0;
  truthM.forEach((row, i) => row.forEach((v, j) => (i + j > 2.5 ? (truthOver += v) : 0)));
  const hasOdds = m.compId !== 'saudi' && !(m.compId === 'copadelrey' && rand() < 0.5);
  const odds = hasOdds ? makeOdds(truth, truthOver, 0.05) : undefined;
  m.odds = odds;
  const mk = odds ? devig([odds.home!, odds.draw!, odds.away!]) : undefined;
  const marketP = mk ? { home: r(mk[0], 4), draw: r(mk[1], 4), away: r(mk[2], 4) } : undefined;
  const weights = { dixonColes: MODEL.wDixonColes, elo: MODEL.wElo, market: marketP ? MODEL.wMarket : 0 };
  const wsum = weights.dixonColes + weights.elo + weights.market;
  const ens = blend([
    { probs: dcP, weight: weights.dixonColes },
    { probs: eP, weight: weights.elo },
    ...(marketP ? [{ probs: marketP, weight: weights.market }] : []),
  ]);
  const marketOver = odds?.over && odds?.under ? (1 / odds.over) / (1 / odds.over + 1 / odds.under) : undefined;
  const lam = fitLambdas({ ...ens, over25: marketOver !== undefined ? 0.6 * marketOver + 0.4 * outcomeOver(dcMat) : undefined }, base.rho, base);
  const mat10 = scoreMatrix(lam.lambdaHome, lam.lambdaAway, base.rho, 10);
  const mat7 = scoreMatrix(lam.lambdaHome, lam.lambdaAway, base.rho, MODEL.maxGoals);
  const pEns = outcomeProbs(mat10);
  const ensR = { home: r(pEns.home, 4), draw: r(pEns.draw, 4), away: r(pEns.away, 4) };
  const goalMarkets = roundMarkets(buildGoalMarkets({ lambdaHome: lam.lambdaHome, lambdaAway: lam.lambdaAway, rho: base.rho, homeName: m.home.name, awayName: m.away.name, odds }));
  const proj = projectionsFor(m);
  const markets = [...goalMarkets, ...statMarkets(proj, m.home.short, m.away.short)];
  const quick = quickFromMatrix(mat10, lam.lambdaHome, lam.lambdaAway);
  const agreement = clampN(1 - (Math.abs(dcP.home - eP.home) + Math.abs(dcP.away - eP.away)) / 0.35, 0, 1);
  const nData = Math.min(teamMatchesIn(null, m.home).length, teamMatchesIn(null, m.away).length);
  const conf = r(clampN(0.25 + 0.4 * agreement + 0.2 * Math.min(1, nData / 12) + (marketP ? 0.12 : 0), 0.15, 0.95), 3);

  // apuestas de valor: 1X2 y O/U 2.5 con cuota de mercado
  const valueBets: ValuePick[] = [];
  const consider = (marketId: string, market: string, selection: string, prob: number, o: number | undefined) => {
    if (!o) return;
    const ev = prob * o - 1;
    if (ev >= MODEL.minEv && prob >= MODEL.minProb && o <= MODEL.maxOdds) {
      valueBets.push({
        marketId,
        market,
        selection,
        prob: r(prob, 4),
        odds: o,
        fairOdds: r(1 / prob, 3),
        ev: r(ev, 4),
        kelly: r(kelly(prob, o, MODEL.kellyFraction, MODEL.kellyCap), 4),
        edge: r(prob - 1 / o, 4),
        confidence: confidenceLevel(ev, conf),
      });
    }
  };
  if (odds) {
    consider('1x2', 'Resultado final', `${m.home.short} (1)`, ensR.home, odds.home);
    consider('1x2', 'Resultado final', 'Empate (X)', ensR.draw, odds.draw);
    consider('1x2', 'Resultado final', `${m.away.short} (2)`, ensR.away, odds.away);
    consider('ou25', 'Total de goles 2,5', 'Más de 2,5', quick.over25, odds.over);
    consider('ou25', 'Total de goles 2,5', 'Menos de 2,5', 1 - quick.over25, odds.under);
  }
  valueBets.sort((a, b) => b.ev - a.ev);

  const corners = proj.find((p) => p.key === 'corners')!;
  const cards = proj.find((p) => p.key === 'cards')!;
  const q: QuickPrediction = {
    p: ensR,
    ...quick,
    expCorners: corners.total,
    expCards: cards.total,
    market: marketP,
    pick: valueBets[0],
    confidence: conf,
  };
  const hn = m.home.short;
  const an = m.away.short;
  const sh = statsFor(m.home, m.compId);
  const sa = statsFor(m.away, m.compId);
  const explanation = [
    `Goles esperados: ${hn} ${quick.xgHome.toFixed(2).replace('.', ',')} – ${quick.xgAway.toFixed(2).replace('.', ',')} ${an} (ensamble ajustado a la matriz Dixon-Coles).`,
    `Elo: ${Math.round(elo.get(m.home.id))} vs ${Math.round(elo.get(m.away.id))}; con la ventaja de campo la diferencia es de ${Math.round(eloDiff)} puntos.`,
    sh.formIndex >= sa.formIndex
      ? `${hn} llega en mejor forma (índice ${sh.formIndex} frente a ${sa.formIndex}; racha ${sh.formString || '—'}).`
      : `${an} llega en mejor forma (índice ${sa.formIndex} frente a ${sh.formIndex}; racha ${sa.formString || '—'}).`,
    `${hn} promedia ${sh.goalsFor.home.toFixed(2).replace('.', ',')} goles en casa; ${an} encaja ${sa.goalsAgainst.away.toFixed(2).replace('.', ',')} fuera.`,
    marketP
      ? `El mercado (sin margen) da ${Math.round(marketP.home * 100)}% / ${Math.round(marketP.draw * 100)}% / ${Math.round(marketP.away * 100)}%; el modelo ${Math.round(ensR.home * 100)}% / ${Math.round(ensR.draw * 100)}% / ${Math.round(ensR.away * 100)}%.`
      : 'Sin cuotas de mercado: el ensamble usa solo Dixon-Coles y Elo.',
  ];
  const model: ModelBreakdown = {
    lambdaHome: r(lam.lambdaHome, 3),
    lambdaAway: r(lam.lambdaAway, 3),
    rho: r(base.rho, 3),
    elo: { home: Math.round(elo.get(m.home.id)), away: Math.round(elo.get(m.away.id)), diff: Math.round(eloDiff), probs: { home: r(eP.home, 4), draw: r(eP.draw, 4), away: r(eP.away, 4) } },
    dixonColes: base.source === 'dc' ? { probs: { home: r(dcP.home, 4), draw: r(dcP.draw, 4), away: r(dcP.away, 4) }, lambdaHome: r(base.lambdaHome, 3), lambdaAway: r(base.lambdaAway, 3) } : undefined,
    market: marketP ? { probs: marketP, margin: odds!.margin!, method: 'shin' } : undefined,
    ensemble: ensR,
    weights: { dixonColes: r(weights.dixonColes / wsum, 3), elo: r(weights.elo / wsum, 3), market: r(weights.market / wsum, 3) },
    scoreMatrix: mat7.map((row) => row.map((v) => r(v, 5))),
    explanation,
    confidence: conf,
  };
  const out: Pred = { q, model, markets, valueBets, lam: { ...lam, rho: base.rho } };
  PRED.set(m.id, out);
  return out;
}
function outcomeOver(mat: number[][]): number {
  let o = 0;
  mat.forEach((row, i) => row.forEach((v, j) => (i + j > 2.5 ? (o += v) : 0)));
  return o;
}

// ---------------------------------------------------------------------------
// MatchSummary
// ---------------------------------------------------------------------------
const DETAIL = new Set<string>();
const FORM_ALL = (t: TeamDef, beforeMs = Infinity) =>
  MATCHES.filter((m) => m.status === 'finished' && m.ms < beforeMs && (m.home.id === t.id || m.away.id === t.id))
    .sort((a, b) => b.ms - a.ms)
    .map((m) => formMatch(m, t));

const POP = new Map<string, number>();
function popularity(m: MatchRec): number {
  const memo = POP.get(m.id);
  if (memo !== undefined) return memo;
  const tier = COMPETITION_BY_ID.get(m.compId)?.tier ?? 5;
  const strength = (m.home.elo0 + m.away.elo0) / 2;
  const closeness = 1 - Math.min(1, Math.abs(m.home.elo0 - m.away.elo0) / 350);
  const v = Math.round(clampN(tier * 4.2 + (strength - 1500) / 9 + closeness * 12 + (m.status === 'live' ? 8 : 0) + normal(0, 3), 1, 100));
  POP.set(m.id, v);
  return v;
}

function summary(m: MatchRec): MatchSummary {
  const s: MatchSummary = {
    id: m.id,
    compId: m.compId,
    compName: COMPETITION_BY_ID.get(m.compId)!.name,
    date: iso(m.ms),
    status: m.status,
    statusDetail: m.statusDetail,
    round: m.round,
    home: ref(m.home),
    away: ref(m.away),
    venue: `Estadio de ${m.home.short}`,
    homeForm: formString(FORM_ALL(m.home, m.ms)),
    awayForm: formString(FORM_ALL(m.away, m.ms)),
    popularity: popularity(m),
    hasDetail: DETAIL.has(m.id),
  };
  if (m.hg !== undefined && m.ag !== undefined) s.score = { home: m.hg, away: m.ag, htHome: m.htH, htAway: m.htA };
  if (m.status === 'scheduled' || m.status === 'live') {
    const p = predict(m);
    s.prediction = p.q;
    s.odds = m.odds;
  } else if (m.status === 'finished' && m.pre) {
    const lh = m.lamH * Math.exp(normal(0, 0.08));
    const la = m.lamA * Math.exp(normal(0, 0.08));
    const mat = scoreMatrix(lh, la, -0.05, 10);
    const p = { home: r(m.pre.home, 4), draw: r(m.pre.draw, 4), away: r(m.pre.away, 4) };
    s.prediction = { p, ...quickFromMatrix(mat, lh, la), confidence: 0.55 };
    s.odds = m.odds;
    const top = p.home >= p.draw && p.home >= p.away ? 'H' : p.away >= p.draw ? 'A' : 'D';
    const actual = m.hg! > m.ag! ? 'H' : m.hg! < m.ag! ? 'A' : 'D';
    s.predictionHit = top === actual;
  }
  return s;
}

// Elegir partidos con análisis completo: los más populares próximos/en vivo + 2 terminados recientes
{
  const upcoming = MATCHES.filter((m) => (m.status === 'scheduled' && m.ms < NOW_MS + 14 * DAY) || m.status === 'live');
  const live = upcoming.filter((m) => m.status === 'live');
  const ranked = [...upcoming].sort((a, b) => popularity(b) - popularity(a));
  for (const m of live) DETAIL.add(m.id);
  for (const m of ranked) {
    if (DETAIL.size >= 12) break;
    DETAIL.add(m.id);
  }
  const recent = MATCHES.filter((m) => m.status === 'finished' && m.ms > NOW_MS - 3 * DAY).sort((a, b) => popularity(b) - popularity(a));
  for (const m of recent.slice(0, 2)) DETAIL.add(m.id);
}

// ---------------------------------------------------------------------------
// Jugadores
// ---------------------------------------------------------------------------
function playerRows(compId: string | null, t: TeamDef): PlayerSeasonRow[] {
  const ms = MATCHES.filter((m) => m.status === 'finished' && (compId === null || m.compId === compId) && (m.home.id === t.id || m.away.id === t.id)).sort((a, b) => b.ms - a.ms);
  const rows: PlayerSeasonRow[] = [];
  for (const p of t.players) {
    const lines = ms.flatMap((m) => (m.lines ?? []).filter((l) => l.p === p).map((l) => ({ l, m })));
    if (!lines.length) continue;
    const tot = (f: (l: PlayerLineRec) => number) => sum(lines.map(({ l }) => f(l)));
    const minutes = tot((l) => l.minutes);
    const per90 = (x: number) => (minutes > 0 ? r((x * 90) / minutes, 2) : 0);
    const last5 = lines.slice(0, 5).map(({ l, m }) => ({
      matchId: m.id,
      date: iso(m.ms),
      opponent: m.home.id === t.id ? m.away.short : m.home.short,
      minutes: l.minutes,
      goals: l.goals,
      assists: l.assists,
      shots: l.shots,
      shotsOnTarget: l.sot,
      cards: l.yellow + l.red,
      rating: l.rating,
    }));
    const ratings = lines.slice(0, 6).map(({ l }) => l.rating);
    const wts = ratings.map((_, i) => Math.pow(0.8, i));
    const wr = sum(ratings.map((x, i) => x * wts[i])) / sum(wts);
    const goals = tot((l) => l.goals);
    const assists = tot((l) => l.assists);
    const formIndex = Math.round(clampN(((wr - 5.8) / 2.6) * 80 + Math.min(1.2, per90(goals + assists)) * 12 + normal(0, 3), 1, 99));
    rows.push({
      player: p.ref,
      team: ref(t),
      compId: compId ?? t.primaryComp,
      apps: lines.length,
      starts: lines.filter(({ l }) => l.minutes >= 55).length,
      minutes,
      goals,
      assists,
      shots: tot((l) => l.shots),
      shotsOnTarget: tot((l) => l.sot),
      yellow: tot((l) => l.yellow),
      red: tot((l) => l.red),
      foulsCommitted: tot((l) => l.foulsC),
      foulsSuffered: tot((l) => l.foulsS),
      offsides: tot((l) => l.offsides),
      saves: p.pos === 'G' ? tot((l) => l.saves ?? 0) : undefined,
      per90: {
        goals: per90(goals),
        assists: per90(assists),
        shots: per90(tot((l) => l.shots)),
        shotsOnTarget: per90(tot((l) => l.sot)),
        cards: per90(tot((l) => l.yellow + l.red)),
        foulsCommitted: per90(tot((l) => l.foulsC)),
      },
      formIndex,
      formTrend: lines.slice(0, 5).map(({ l }) => l.rating).reverse(),
      last5,
    });
  }
  return rows;
}

function propsFor(t: TeamDef, lam: number): PlayerProp[] {
  const rows = playerRows(null, t).filter((x) => x.apps >= 2);
  return rows
    .map((x) => {
      const startRate = x.starts / Math.max(1, x.apps);
      const expMin = Math.round(clampN(startRate * 82 + (1 - startRate) * 22, 10, 90));
      const adj = lam / 1.35;
      const rate = (per90: number) => (per90 * expMin) / 90;
      const pAtLeast = (mean: number, k: number) => {
        let c = 0;
        let term = Math.exp(-mean);
        for (let i = 0; i < k; i++) {
          c += term;
          term = (term * mean) / (i + 1);
        }
        return clampN(1 - c, 0, 0.99);
      };
      const g = rate(x.per90.goals * 0.7 + 0.03) * adj;
      const a = rate(x.per90.assists * 0.7 + 0.02) * adj;
      const shots = rate(x.per90.shots) * (0.8 + 0.2 * adj);
      const sot = rate(x.per90.shotsOnTarget) * (0.8 + 0.2 * adj);
      return {
        player: x.player,
        apps: x.apps,
        minutes: x.minutes,
        goals: x.goals,
        assists: x.assists,
        expMinutes: expMin,
        formIndex: x.formIndex,
        pGoal: r(pAtLeast(g, 1), 4),
        pAssist: r(pAtLeast(a, 1), 4),
        pGoalOrAssist: r(pAtLeast(g + a, 1), 4),
        pShots1: r(pAtLeast(shots, 1), 4),
        pShots2: r(pAtLeast(shots, 2), 4),
        pSot1: r(pAtLeast(sot, 1), 4),
        pSot2: r(pAtLeast(sot, 2), 4),
        pCard: r(clampN(rate(x.per90.cards) * 1.05 + 0.02, 0.01, 0.6), 4),
        pFouls2: r(pAtLeast(rate(x.per90.foulsCommitted), 2), 4),
      } satisfies PlayerProp;
    })
    .filter((x) => x.player.position !== 'G')
    .sort((a, b) => b.pGoal - a.pGoal)
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Bloques de forma / ratings / simulación / backtest
// ---------------------------------------------------------------------------
function formBlock(t: TeamDef, venue: 'home' | 'away', beforeMs = Infinity): TeamFormBlock {
  const fms = FORM_ALL(t, beforeMs).slice(0, 10);
  const ppg = (xs: FormMatch[]) => (xs.length ? r(sum(xs.map((x) => pts(x.result))) / xs.length, 2) : 0);
  const l5 = fms.slice(0, 5);
  const streaks: string[] = [];
  let w = 0;
  for (const x of fms) if (x.result === 'W') w++; else break;
  if (w >= 2) streaks.push(`${w} victorias seguidas`);
  let unbeaten = 0;
  for (const x of fms) if (x.result !== 'L') unbeaten++; else break;
  if (unbeaten >= 4 && w < unbeaten) streaks.push(`${unbeaten} partidos sin perder`);
  let scoring = 0;
  for (const x of fms) if (x.gf > 0) scoring++; else break;
  if (scoring >= 4) streaks.push(`${scoring} partidos marcando`);
  let winless = 0;
  for (const x of fms) if (x.result !== 'W') winless++; else break;
  if (winless >= 3) streaks.push(`${winless} partidos sin ganar`);
  const over = l5.filter((x) => x.gf + x.ga > 2.5).length;
  if (over >= 4) streaks.push(`Más de 2,5 goles en ${over} de los últimos 5`);
  const venueMs = FORM_ALL(t, beforeMs).filter((x) => (venue === 'home' ? x.isHome : !x.isHome));
  const hist = elo.history(t.id);
  return {
    team: ref(t),
    last: fms,
    formString: formString(fms),
    ppg5: ppg(l5),
    ppg10: ppg(fms),
    gf5: r(avg(l5.map((x) => x.gf)), 2),
    ga5: r(avg(l5.map((x) => x.ga)), 2),
    formIndex: formIndexFrom(fms),
    streaks,
    elo: Math.round(elo.get(t.id)),
    eloTrend: hist.slice(-15).map((h) => Math.round(h.elo)),
    venueSplit: {
      played: venueMs.length,
      ppg: ppg(venueMs),
      gf: r(avg(venueMs.map((x) => x.gf)), 2),
      ga: r(avg(venueMs.map((x) => x.ga)), 2),
    },
  };
}

const GLOBAL_RANK = new Map(
  [...TEAMS.values()]
    .sort((a, b) => elo.get(b.id) - elo.get(a.id))
    .map((t, i) => [t.id, i + 1] as const),
);

function ratings(c: string): TeamRating[] {
  const ts = teamsIn(c).sort((a, b) => elo.get(b.id) - elo.get(a.id));
  return ts.map((t, i) => ({
    team: ref(t),
    elo: Math.round(elo.get(t.id)),
    eloRank: i + 1,
    globalEloRank: GLOBAL_RANK.get(t.id),
    attack: DC[c] ? r(DC[c].attack[t.id] ?? 1, 3) : undefined,
    defence: DC[c] ? r(DC[c].defence[t.id] ?? 1, 3) : undefined,
    eloHistory: elo
      .history(t.id)
      .slice(-30)
      .map((h) => ({ date: h.date, elo: Math.round(h.elo) })),
  }));
}

function simulate(c: string, table: StandingRow[]): SeasonSimulation | undefined {
  const cfg = COMPETITION_BY_ID.get(c);
  if (!cfg?.simulate || !cfg.simulationZones) return undefined;
  const remaining = compMatches(c).filter((m) => m.status !== 'finished');
  const n = table.length;
  const idx = new Map(table.map((row, i) => [row.team.id, i]));
  const lams = remaining.map((m) => {
    const l = modelLambdas(m);
    return [l.lambdaHome, l.lambdaAway] as const;
  });
  const IT = 3000;
  const posCount = table.map(() => new Array(n).fill(0) as number[]);
  const ptsSum = new Array(n).fill(0) as number[];
  for (let it = 0; it < IT; it++) {
    const P = table.map((row) => row.points);
    const GD = table.map((row) => row.gd);
    const GF = table.map((row) => row.gf);
    remaining.forEach((m, k) => {
      const hg = samplePoisson(lams[k][0], rand);
      const ag = samplePoisson(lams[k][1], rand);
      const hi = idx.get(m.home.id)!;
      const ai = idx.get(m.away.id)!;
      GD[hi] += hg - ag;
      GD[ai] += ag - hg;
      GF[hi] += hg;
      GF[ai] += ag;
      if (hg > ag) P[hi] += 3;
      else if (hg < ag) P[ai] += 3;
      else {
        P[hi]++;
        P[ai]++;
      }
    });
    const order = table.map((_, i) => i).sort((a, b) => P[b] - P[a] || GD[b] - GD[a] || GF[b] - GF[a] || rand() - 0.5);
    order.forEach((ti, pos) => {
      posCount[ti][pos]++;
      ptsSum[ti] += P[ti];
    });
  }
  const columns = cfg.simulationZones.map((z) => z.label);
  const rows = table.map((row, i) => {
    const dist = posCount[i].map((x) => r(x / IT, 4));
    const probs: Record<string, number> = {};
    for (const z of cfg.simulationZones!) {
      const from = z.from < 0 ? n + z.from + 1 : z.from;
      const to = z.to < 0 ? n + z.to + 1 : z.to;
      probs[z.label] = r(sum(dist.slice(from - 1, to)), 4);
    }
    const expRank = sum(dist.map((p, k) => p * (k + 1)));
    return { team: row.team, currentPoints: row.points, expectedPoints: r(ptsSum[i] / IT, 1), expectedRank: r(expRank, 2), probs, positionDist: dist };
  });
  rows.sort((a, b) => a.expectedRank - b.expectedRank);
  return { iterations: IT, group: c === 'champions' ? 'Fase liga' : cfg.name, columns, rows, remainingMatches: remaining.length };
}

interface BtItem {
  model: Prob1X2;
  elo: Prob1X2;
  dc: Prob1X2;
  market?: Prob1X2;
  odds?: OddsSnapshot;
  outcome: 0 | 1 | 2;
  over: number;
  btts: number;
  yOver: 0 | 1;
  yBtts: 0 | 1;
}
const BT: Record<string, BtItem[]> = {};
for (const m of MATCHES) {
  if (m.status !== 'finished' || !m.pre || !m.preElo) continue;
  const truthM = scoreMatrix(m.lamH * Math.exp(normal(0, 0.1)), m.lamA * Math.exp(normal(0, 0.1)), -0.05, 10);
  const dc = outcomeProbs(truthM);
  const e = eloProbs(m.preElo.h + HFA - m.preElo.a);
  const mk = m.odds ? devig([m.odds.home!, m.odds.draw!, m.odds.away!]) : undefined;
  (BT[m.compId] ??= []).push({
    model: m.pre,
    elo: e,
    dc,
    market: mk ? { home: mk[0], draw: mk[1], away: mk[2] } : undefined,
    odds: m.odds,
    outcome: m.hg! > m.ag! ? 0 : m.hg === m.ag ? 1 : 2,
    over: outcomeOver(truthM),
    btts: bttsProb(truthM),
    yOver: m.hg! + m.ag! > 2.5 ? 1 : 0,
    yBtts: m.hg! > 0 && m.ag! > 0 ? 1 : 0,
  });
}
function backtest(items: BtItem[], from: number, to: number): BacktestSummary {
  const rs = (s: ReturnType<typeof scoreSet>) => ({ brier: r(s.brier, 4), logLoss: r(s.logLoss, 4), rps: r(s.rps, 4), accuracy: r(s.accuracy, 4) });
  const base = { home: 0.45, draw: 0.26, away: 0.29 };
  const withMk = items.filter((x) => x.market);
  const calib = calibration(
    items.flatMap((x) => [
      { p: x.model.home, y: (x.outcome === 0 ? 1 : 0) as 0 | 1 },
      { p: x.model.draw, y: (x.outcome === 1 ? 1 : 0) as 0 | 1 },
      { p: x.model.away, y: (x.outcome === 2 ? 1 : 0) as 0 | 1 },
    ]),
    10,
  ).map((b) => ({ ...b, predicted: r(b.predicted, 4), observed: r(b.observed, 4) }));
  let bets = 0;
  let profit = 0;
  let wins = 0;
  let oddsSum = 0;
  for (const x of withMk) {
    const o = [x.odds!.home!, x.odds!.draw!, x.odds!.away!];
    const p = [x.model.home, x.model.draw, x.model.away];
    for (let k = 0; k < 3; k++) {
      if (p[k] * o[k] - 1 >= MODEL.minEv && o[k] <= MODEL.maxOdds) {
        bets++;
        oddsSum += o[k];
        if (x.outcome === k) {
          profit += o[k] - 1;
          wins++;
        } else profit -= 1;
      }
    }
  }
  const bin = (ps: number[], ys: (0 | 1)[]) => ({
    brier: r(avg(ps.map((p, i) => (p - ys[i]) ** 2)), 4),
    accuracy: r(avg(ps.map((p, i) => ((p >= 0.5 ? 1 : 0) === ys[i] ? 1 : 0))), 4),
    n: ps.length,
  });
  return {
    matches: items.length,
    from: iso(from),
    to: iso(to),
    model: rs(scoreSet(items.map((x) => ({ p: x.model, outcome: x.outcome })))),
    elo: rs(scoreSet(items.map((x) => ({ p: x.elo, outcome: x.outcome })))),
    dixonColes: rs(scoreSet(items.map((x) => ({ p: x.dc, outcome: x.outcome })))),
    market: withMk.length ? rs(scoreSet(withMk.map((x) => ({ p: x.market!, outcome: x.outcome })))) : undefined,
    baseline: rs(scoreSet(items.map((x) => ({ p: base, outcome: x.outcome })))),
    marketMatches: withMk.length,
    calibration: calib,
    roi: bets ? { bets, staked: bets, profit: r(profit, 2), roi: r(profit / bets, 4), hitRate: r(wins / bets, 4), avgOdds: r(oddsSum / bets, 3) } : undefined,
    over25: bin(items.map((x) => x.over), items.map((x) => x.yOver)),
    btts: bin(items.map((x) => x.btts), items.map((x) => x.yBtts)),
  };
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['', 'competitions', 'matches', 'teams']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
let bytes = 0;
let files = 0;
function write(rel: string, data: unknown) {
  const json = JSON.stringify(data);
  bytes += json.length;
  files++;
  fs.writeFileSync(path.join(OUT, rel), json);
}

const SUMMARY = new Map<string, MatchSummary>();
const S = (m: MatchRec) => {
  let s = SUMMARY.get(m.id);
  if (!s) {
    s = summary(m);
    SUMMARY.set(m.id, s);
  }
  return s;
};

const compMetas: CompetitionMeta[] = [];
const compFiles: Record<string, CompetitionFile> = {};
const allPlayerRows: PlayerSeasonRow[] = [];
const STANDINGS: Record<string, StandingRow[]> = {};

for (const c of COMP_IDS) {
  const cfg = COMPETITION_BY_ID.get(c)!;
  const ms = compMatches(c);
  const fin = ms.filter((m) => m.status === 'finished');
  const hasTable = cfg.kind !== 'cup';
  const table = hasTable ? standings(c) : [];
  STANDINGS[c] = table;
  const sim = hasTable ? simulate(c, table) : undefined;
  const upcoming = ms.filter((m) => m.status === 'scheduled' && m.ms < NOW_MS + 14 * DAY).sort((a, b) => a.ms - b.ms);
  const results = fin.filter((m) => m.ms > NOW_MS - 30 * DAY).sort((a, b) => b.ms - a.ms);
  const live = ms.filter((m) => m.status === 'live');
  const meta: CompetitionMeta = {
    id: c,
    slug: cfg.slug,
    name: cfg.name,
    shortName: cfg.shortName,
    country: cfg.country,
    flag: cfg.flag,
    kind: cfg.kind,
    tier: cfg.tier,
    seasonLabel: cfg.calendarYear ? String(NOW.getUTCFullYear()) : `${NOW.getUTCFullYear()}-${String((NOW.getUTCFullYear() + 1) % 100).padStart(2, '0')}`,
    hasTable,
    hasSimulation: !!sim,
    simulationColumns: sim?.columns,
    upcomingCount: upcoming.length,
    finishedCount: fin.length,
    color: { laliga: 'ff4b44', premier: '3d195b', seriea: '008fd7', brasileirao: '00a859', saudi: '0b8a3e', champions: '1d3fbb', copadelrey: 'c8102e' }[c],
  };
  compMetas.push(meta);
  const teams = teamsIn(c);
  const prow = teams.flatMap((t) => playerRows(c, t)).sort((a, b) => b.formIndex - a.formIndex);
  allPlayerRows.push(...prow);
  const la = AVG.get(c)!;
  const tstats = teams.map((t) => SEASON.get(c)!.get(t.id)!).filter((s) => s.played.all > 0);
  const topScorer = [...prow].sort((a, b) => b.goals - a.goals)[0];
  const bestAtt = [...tstats].sort((a, b) => b.goalsFor.all - a.goalsFor.all)[0];
  const bestDef = [...tstats].sort((a, b) => a.goalsAgainst.all - b.goalsAgainst.all)[0];
  const insights = fin.length
    ? [
        `El ${Math.round(la.over25Pct * 100)}% de los partidos terminan con más de 2,5 goles (${la.goalsPerMatch.toFixed(2).replace('.', ',')} goles por partido).`,
        `Ambos equipos marcan en el ${Math.round(la.bttsPct * 100)}% de los encuentros.`,
        `El local gana el ${Math.round(la.homeWinPct * 100)}% de las veces; empates ${Math.round(la.drawPct * 100)}%.`,
        `Media de ${la.cornersPerMatch.toFixed(1).replace('.', ',')} córners y ${la.cardsPerMatch.toFixed(1).replace('.', ',')} tarjetas por partido.`,
        ...(bestAtt ? [`${bestAtt.team.name} es el ataque más productivo: ${bestAtt.goalsFor.all.toFixed(2).replace('.', ',')} goles por partido.`] : []),
        ...(bestDef ? [`${bestDef.team.name} es la defensa más sólida: ${bestDef.goalsAgainst.all.toFixed(2).replace('.', ',')} goles encajados por partido.`] : []),
        ...(topScorer && topScorer.goals > 0 ? [`${topScorer.player.name} (${topScorer.team.short}) lidera la tabla de goleadores con ${topScorer.goals} goles.`] : []),
      ]
    : ['La competición acaba de empezar: los modelos usan sobre todo el Elo de cada equipo.'];
  const file: CompetitionFile = {
    generatedAt: GENERATED_AT,
    meta,
    standings: hasTable ? [{ name: c === 'champions' ? 'Fase liga' : cfg.name, rows: table }] : [],
    upcoming: upcoming.map(S),
    results: results.map(S),
    live: live.map(S),
    teams: tstats,
    ratings: ratings(c),
    simulations: sim ? [sim] : [],
    players: prow.slice(0, 150),
    leagueAverages: la,
    backtest: (BT[c] ?? []).length >= 10 ? backtest(BT[c], Math.min(...fin.map((m) => m.ms)), Math.max(...fin.map((m) => m.ms))) : undefined,
    insights,
  };
  compFiles[c] = file;
}

// --- Partidos con detalle
const matchFiles: MatchFile[] = [];
for (const id of DETAIL) {
  const m = MATCHES.find((x) => x.id === id)!;
  const pre = m.status === 'finished' ? undefined : predict(m);
  // para terminados: análisis "previo" reconstruido desde sus λ
  const p: Pred =
    pre ??
    (() => {
      const saved = { status: m.status, odds: m.odds };
      const pr = predict(m);
      m.status = saved.status;
      if (saved.odds) m.odds = saved.odds;
      return pr;
    })();
  const table = STANDINGS[m.compId];
  const h2hList: MatchSummary[] = [];
  for (let k = 0; k < 4; k++) {
    const swap = k % 2 === 1;
    const hh = swap ? m.away : m.home;
    const aa = swap ? m.home : m.away;
    const [lh, la] = truthLambdas(hh, aa, m.compId);
    const hg = samplePoisson(lh, rand);
    const ag = samplePoisson(la, rand);
    h2hList.push({
      id: String(690000 + Number(m.id) % 1000 * 10 + k),
      compId: m.compId,
      compName: COMPETITION_BY_ID.get(m.compId)!.name,
      date: iso(m.ms - (200 + k * 170 + Math.floor(rand() * 40)) * DAY),
      status: 'finished',
      statusDetail: 'Final',
      home: ref(hh),
      away: ref(aa),
      score: { home: hg, away: ag },
      hasDetail: false,
    });
  }
  const winsOf = (t: TeamDef) => h2hList.filter((x) => (x.home.id === t.id ? x.score!.home > x.score!.away : x.score!.away > x.score!.home)).length;
  const h2h: H2HSummary = {
    matches: h2hList,
    homeWins: winsOf(m.home),
    awayWins: winsOf(m.away),
    draws: h2hList.filter((x) => x.score!.home === x.score!.away).length,
    avgGoals: r(avg(h2hList.map((x) => x.score!.home + x.score!.away)), 2),
    bttsPct: r(h2hList.filter((x) => x.score!.home > 0 && x.score!.away > 0).length / h2hList.length, 3),
    over25Pct: r(h2hList.filter((x) => x.score!.home + x.score!.away > 2.5).length / h2hList.length, 3),
  };
  const sh = statsFor(m.home, m.compId);
  const sa = statsFor(m.away, m.compId);
  const la = AVG.get(m.compId)!;
  const fh = formBlock(m.home, 'home', m.ms);
  const fa = formBlock(m.away, 'away', m.ms);
  const comparison: ComparisonRow[] = [
    { key: 'ppg', label: 'Puntos por partido (últimos 10)', home: fh.ppg10, away: fa.ppg10, better: 'high', format: 'dec2' },
    { key: 'gf', label: 'Goles a favor / partido', home: sh.goalsFor.all, away: sa.goalsFor.all, better: 'high', leagueAvg: la.goalsPerMatch / 2, format: 'dec2' },
    { key: 'ga', label: 'Goles en contra / partido', home: sh.goalsAgainst.all, away: sa.goalsAgainst.all, better: 'low', leagueAvg: la.goalsPerMatch / 2, format: 'dec2' },
    { key: 'xg', label: 'xG a favor / partido', home: sh.xgFor.all, away: sa.xgFor.all, better: 'high', format: 'dec2' },
    { key: 'xga', label: 'xG en contra / partido', home: sh.xgAgainst.all, away: sa.xgAgainst.all, better: 'low', format: 'dec2' },
    { key: 'shots', label: 'Tiros / partido', home: sh.shots.all, away: sa.shots.all, better: 'high', leagueAvg: la.shotsPerMatch / 2, format: 'dec1' },
    { key: 'sot', label: 'Tiros a puerta / partido', home: sh.shotsOnTarget.all, away: sa.shotsOnTarget.all, better: 'high', leagueAvg: la.shotsOnTargetPerMatch / 2, format: 'dec1' },
    { key: 'corners', label: 'Córners / partido', home: sh.corners.all, away: sa.corners.all, better: 'high', leagueAvg: la.cornersPerMatch / 2, format: 'dec1' },
    { key: 'cards', label: 'Tarjetas / partido', home: sh.cards.all, away: sa.cards.all, better: 'low', leagueAvg: la.cardsPerMatch / 2, format: 'dec1' },
    { key: 'poss', label: 'Posesión media', home: sh.possession.all / 100, away: sa.possession.all / 100, better: 'high', format: 'pct' },
    { key: 'over25', label: 'Partidos con +2,5 goles', home: sh.over25Pct, away: sa.over25Pct, better: 'high', leagueAvg: la.over25Pct, format: 'pct' },
    { key: 'btts', label: 'Ambos marcan', home: sh.bttsPct, away: sa.bttsPct, better: 'high', leagueAvg: la.bttsPct, format: 'pct' },
    { key: 'cs', label: 'Porterías a cero', home: sh.cleanSheetPct, away: sa.cleanSheetPct, better: 'high', format: 'pct' },
    { key: 'elo', label: 'Rating Elo', home: fh.elo, away: fa.elo, better: 'high', format: 'int' },
  ];
  const file: MatchFile = {
    generatedAt: GENERATED_AT,
    match: S(m),
    model: p.model,
    markets: p.markets,
    projections: projectionsFor(m),
    form: { home: fh, away: fa },
    h2h,
    comparison,
    players: { home: propsFor(m.home, p.lam.lambdaHome), away: propsFor(m.away, p.lam.lambdaAway) },
    valueBets: m.status === 'scheduled' ? p.valueBets : [],
    table: table.length
      ? {
          group: m.compId === 'champions' ? 'Fase liga' : COMPETITION_BY_ID.get(m.compId)!.name,
          homeRank: table.find((x) => x.team.id === m.home.id)?.rank,
          awayRank: table.find((x) => x.team.id === m.away.id)?.rank,
          rows: table,
        }
      : undefined,
    actual: m.stats ? { home: m.stats.home, away: m.stats.away } : undefined,
    events: m.events,
  };
  matchFiles.push(file);
  write(`matches/${m.id}.json`, file);
}

// --- Equipos
const TEAM_FILES = ['Real Madrid', 'Barcelona', 'Atlético de Madrid', 'Arsenal', 'Liverpool', 'Inter'].map((n) => TEAM_BY_NAME.get(n)!);
for (const t of TEAM_FILES) {
  const comps = COMP_IDS.filter((c) => teamsIn(c).some((x) => x.id === t.id));
  const pc = t.primaryComp;
  const tf: TeamFile = {
    generatedAt: GENERATED_AT,
    team: ref(t),
    competitions: [...comps],
    primaryCompId: pc,
    elo: Math.round(elo.get(t.id)),
    globalEloRank: GLOBAL_RANK.get(t.id)!,
    eloHistory: elo.history(t.id).map((h) => ({ date: h.date, elo: Math.round(h.elo) })),
    stats: SEASON.get(pc)!.get(t.id)!,
    form: formBlock(t, 'home'),
    matches: FORM_ALL(t),
    upcoming: MATCHES.filter((m) => (m.status === 'scheduled' || m.status === 'live') && m.ms < NOW_MS + 14 * DAY && (m.home.id === t.id || m.away.id === t.id))
      .sort((a, b) => a.ms - b.ms)
      .map(S),
    players: playerRows(null, t).sort((a, b) => b.formIndex - a.formIndex),
    standing: STANDINGS[pc]?.find((x) => x.team.id === t.id),
  };
  write(`teams/${t.id}.json`, tf);
}

// --- Competiciones (después de marcar hasDetail en los resúmenes)
for (const c of COMP_IDS) write(`competitions/${c}.json`, compFiles[c]);

// --- Jugadores globales (sin duplicar jugador; nos quedamos con su competición principal)
const seenPlayer = new Set<string>();
const globalPlayers = allPlayerRows
  .sort((a, b) => b.formIndex - a.formIndex || b.minutes - a.minutes)
  .filter((p) => {
    if (seenPlayer.has(p.player.id)) return false;
    seenPlayer.add(p.player.id);
    return p.minutes >= 180;
  })
  .slice(0, 600);
write('players.json', { generatedAt: GENERATED_AT, players: globalPlayers } satisfies PlayersFile);

// --- Valor
const allBets: { match: MatchSummary; pick: ValuePick }[] = [];
for (const m of MATCHES) {
  if (m.status !== 'scheduled' || m.ms > NOW_MS + 14 * DAY) continue;
  const p = predict(m);
  for (const pick of p.valueBets) allBets.push({ match: S(m), pick });
}
allBets.sort((a, b) => b.pick.ev - a.pick.ev);
write('value.json', { generatedAt: GENERATED_AT, bets: allBets, minEv: MODEL.minEv, kellyFraction: MODEL.kellyFraction } satisfies ValueFile);

// --- Modelo
const allBt = Object.values(BT).flat();
const finishedAll = MATCHES.filter((m) => m.status === 'finished');
const globalBt = backtest(allBt, Math.min(...finishedAll.map((m) => m.ms)), Math.max(...finishedAll.map((m) => m.ms)));
const modelFile: ModelFile = {
  generatedAt: GENERATED_AT,
  sections: [
    {
      title: 'Datos',
      body: [
        'Cada día se descargan de la API pública de ESPN los calendarios, resultados, estadísticas de equipo y de jugador, clasificaciones y cuotas de las competiciones cubiertas.',
        'Los datos se normalizan y se guardan de forma incremental; las estadísticas de jugador proceden de las fichas de cada partido.',
      ],
    },
    {
      title: 'Rating Elo',
      body: [
        `Elo global estilo World Football Elo con K = ${MODEL.eloK}, ventaja de campo de ${MODEL.eloHomeAdv} puntos y multiplicador por diferencia de goles.`,
        'Todas las competiciones comparten la misma escala, lo que permite comparar equipos de ligas distintas en competiciones europeas y copas.',
      ],
    },
    {
      title: 'Modelo Dixon-Coles',
      body: [
        'Modelo de Poisson bivariante con corrección de Dixon-Coles para marcadores bajos (0-0, 1-0, 0-1, 1-1).',
        `Parámetros de ataque y defensa por equipo con ponderación temporal exponencial (ξ = ${MODEL.dcXi} por día) y regularización hacia la media.`,
      ],
    },
    {
      title: 'Ensamble y mercados',
      body: [
        `Las probabilidades 1X2 combinan Dixon-Coles (${MODEL.wDixonColes * 100}%), Elo (${MODEL.wElo * 100}%) y el mercado sin margen (${MODEL.wMarket * 100}%, método de Shin).`,
        'Se buscan los goles esperados (λ) que reproducen ese ensamble y de su matriz de marcadores se derivan todos los mercados: totales, hándicaps, marcador exacto, mitades, etc.',
        'Córners, tarjetas, tiros y faltas se proyectan con distribuciones binomiales negativas y contracción hacia la media de la liga.',
      ],
    },
    {
      title: 'Apuestas de valor',
      body: [
        `Se marca una selección cuando el valor esperado supera el ${MODEL.minEv * 100}% con probabilidad mínima del ${MODEL.minProb * 100}% y cuota máxima ${MODEL.maxOdds}.`,
        `El stake recomendado es Kelly fraccional (${MODEL.kellyFraction}) con un máximo del ${MODEL.kellyCap * 100}% de la banca.`,
      ],
    },
    {
      title: 'Validación',
      body: [
        'Backtest walk-forward: cada partido se predice solo con información anterior a su fecha.',
        'Se miden Brier, log-loss, RPS y acierto frente a una referencia de frecuencias base y frente al mercado de cierre.',
      ],
    },
  ],
  backtest: globalBt,
  perCompetition: COMP_IDS.filter((c) => compFiles[c].backtest).map((c) => ({ compId: c, compName: COMPETITION_BY_ID.get(c)!.name, backtest: compFiles[c].backtest! })),
  parameters: {
    'Elo K': MODEL.eloK,
    'Ventaja local Elo': MODEL.eloHomeAdv,
    'Decaimiento DC (ξ/día)': MODEL.dcXi,
    'Ventana DC (días)': MODEL.dcWindowDays,
    'Peso Dixon-Coles': MODEL.wDixonColes,
    'Peso Elo': MODEL.wElo,
    'Peso mercado': MODEL.wMarket,
    'EV mínimo': MODEL.minEv,
    'Fracción Kelly': MODEL.kellyFraction,
    'Iteraciones Monte Carlo': 3000,
    'Método sin margen': 'Shin',
  },
};
write('model.json', modelFile);

// --- Portada
const inDays = (m: MatchRec, d: number) => m.ms >= DAY0 + d * DAY && m.ms < DAY0 + (d + 1) * DAY;
const today = MATCHES.filter((m) => inDays(m, 0)).sort((a, b) => a.ms - b.ms);
const tomorrow = MATCHES.filter((m) => inDays(m, 1)).sort((a, b) => a.ms - b.ms);
const next72 = MATCHES.filter((m) => (m.status === 'scheduled' && m.ms < NOW_MS + 3 * DAY) || m.status === 'live');
const popular = next72.map(S).sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 24);
const recent = MATCHES.filter((m) => m.status === 'finished' && m.ms > NOW_MS - 2 * DAY).sort((a, b) => b.ms - a.ms).map(S);
const topValue = allBets.filter((b) => new Date(b.match.date).getTime() < NOW_MS + 3 * DAY).slice(0, 12);
const hot = globalPlayers.slice(0, 12);
const best = popular.find((x) => x.status === 'scheduled');
const rm = TEAM_BY_NAME.get('Real Madrid')!;
const rmForm = formBlock(rm, 'home');
const bigValue = topValue[0];
const highlights = [
  best && best.prediction
    ? `${best.home.name} – ${best.away.name}, el partido del día: ${Math.round(best.prediction.p.home * 100)}% local, ${Math.round(best.prediction.p.draw * 100)}% empate y ${Math.round(best.prediction.p.away * 100)}% visitante.`
    : undefined,
  `${today.filter((m) => m.compId === 'champions').length} partidos de Champions hoy y ${tomorrow.filter((m) => m.compId === 'champions').length} mañana en la jornada 4 de la fase liga.`,
  rmForm.streaks[0] ? `Real Madrid: ${rmForm.streaks[0].toLowerCase()} (índice de forma ${rmForm.formIndex}).` : `Real Madrid suma ${rmForm.ppg5.toFixed(1).replace('.', ',')} puntos por partido en sus últimos 5.`,
  bigValue ? `Mayor valor detectado: ${bigValue.pick.selection} en ${bigValue.match.home.short}–${bigValue.match.away.short} @ ${bigValue.pick.odds.toFixed(2).replace('.', ',')} (EV +${(bigValue.pick.ev * 100).toFixed(1).replace('.', ',')}%).` : undefined,
  hot[0] ? `${hot[0].player.name} (${hot[0].team.short}) es el jugador más en forma: ${hot[0].last5.reduce((s, x) => s + x.goals, 0)} goles en sus últimos 5 partidos.` : undefined,
  `El modelo acierta el ${Math.round(globalBt.model.accuracy * 100)}% de los 1X2 en el backtest (RPS ${globalBt.model.rps.toFixed(3).replace('.', ',')}).`,
].filter((x): x is string => !!x);
const homeFile: HomeFile = {
  generatedAt: GENERATED_AT,
  popular,
  today: today.map(S),
  tomorrow: tomorrow.map(S),
  recent,
  topValue,
  hotPlayers: hot,
  highlights,
  modelHeadline: { matches: globalBt.matches, accuracy: globalBt.model.accuracy, rps: globalBt.model.rps, marketRps: globalBt.market?.rps },
};
write('home.json', homeFile);

// --- Meta (al final: cuenta todo)
const metaTeams = [...TEAMS.values()]
  .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  .map((t) => ({ id: t.id, name: t.name, abbr: t.abbr, compId: t.primaryComp }));
const metaFile: MetaFile = {
  generatedAt: GENERATED_AT,
  version: '1.0.0-mock',
  dataSource: 'ESPN (API pública) · datos simulados',
  competitions: compMetas.sort((a, b) => b.tier - a.tier),
  counts: {
    matchesAnalyzed: finishedAll.length,
    upcomingMatches: MATCHES.filter((m) => m.status === 'scheduled' && m.ms < NOW_MS + 14 * DAY).length,
    teams: TEAMS.size,
    players: globalPlayers.length,
    valueBets: allBets.length,
  },
  teams: metaTeams,
};
write('meta.json', metaFile);

console.log(
  `[mock-data] ${files} archivos (${(bytes / 1024).toFixed(0)} KB) en ${path.relative(process.cwd(), OUT)} · ` +
    `${MATCHES.length} partidos (${finishedAll.length} jugados, ${today.length} hoy, ${tomorrow.length} mañana) · ` +
    `${DETAIL.size} análisis completos · ${allBets.length} picks de valor · equipos con ficha: ${TEAM_FILES.map((t) => `${t.name}=${t.id}`).join(', ')}`,
);
