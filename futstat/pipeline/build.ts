/**
 * CLI: data-store/<compId>.json → public/data/*.json (contrato en src/types/data.ts).
 *
 *   npx tsx pipeline/build.ts [--only=laliga,champions] [--fast] [--now=2026-11-03T12:00:00Z] [--out=dir]
 *
 *   --only   publica solo esas competiciones (los modelos se ajustan siempre con todos los stores)
 *   --fast   menos iteraciones (simulación 2.000, re-ajuste walk-forward quincenal) para depurar
 *   --now    fecha de referencia (por defecto, ahora)
 *   --out    directorio de salida (por defecto public/data)
 *
 * Fases: índices + modelos actuales (Elo global, Dixon-Coles por liga, Elo→goles, medias de goles) →
 * Dixon-Coles walk-forward y predicciones pre-partido de la temporada actual (xG proxy, backtest, aciertos) →
 * competiciones (clasificación con forma/xPts/Elo, próximos, resultados, estadísticas, ratings, simulación,
 * jugadores, backtest, insights) → fichas de partido → jugadores → fichas de equipo → valor, portada, modelo, meta.
 *
 * Todo se escribe en un directorio temporal y al final sustituye a la salida (solo se borra ese directorio).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BacktestSummary, CompetitionMeta, MetaFile } from '../src/types/data';
import { COMPETITIONS, OUTPUT_DIR, ROOT_DIR } from './config';
import { loadAllStores } from './store';
import { computeWalkForward, createContext, type BuildOptions } from './publish/context';
import { buildCompetition } from './publish/competition';
import { buildMatchFile } from './publish/matches';
import { buildTeamFile, primaryCompetition, teamCompetitions, teamsToPublish } from './publish/teams';
import {
  aggregateBacktest,
  buildHomeFile,
  buildMetaFile,
  buildModelFile,
  buildPlayersFile,
  buildValueFile,
  collectValueBets,
  globalPlayerRows,
} from './publish/root';
import { JsonWriter, PhaseTimer, formatBytes, swapDir } from './publish/util';

export interface RunBuildOptions extends BuildOptions {
  outDir: string;
}

export interface BuildReport {
  outDir: string;
  seconds: number;
  phases: { name: string; seconds: number }[];
  files: number;
  bytes: number;
  bytesByDir: Record<string, { files: number; bytes: number }>;
  competitions: number;
  matchFiles: number;
  teamFiles: number;
  valueBets: number;
  /** valores no finitos corregidos al sanear el JSON (deberían ser 0) */
  cleaned: { droppedKeys: number; zeroedItems: number; examples: string[] };
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/** Ejecuta el build completo y escribe la salida en opts.outDir (sustituyéndola). */
export function runBuild(opts: RunBuildOptions): BuildReport {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const timer = new PhaseTimer(log);
  const ctx = createContext({ ...opts, log });
  timer.lap(
    'Índices y modelos actuales',
    `${ctx.allMatches.length} partidos, ${ctx.suite.eloBuild.samples.length} terminados, ${ctx.suite.dcModels.size} ligas DC, ${ctx.globalEloRank.size} equipos con Elo`,
  );

  const wf = computeWalkForward(ctx);
  timer.lap('Walk-forward y predicciones pre-partido', `${wf.refits} ajustes DC, ${wf.predictions} partidos`);

  const staging = `${opts.outDir.replace(/[\\/]+$/, '')}.__tmp__`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const writer = new JsonWriter(staging);

  try {
    // ---- competiciones
    const metas: CompetitionMeta[] = [];
    const per: { compId: string; compName: string; backtest: BacktestSummary }[] = [];
    let simFixtures = 0;
    let synthetic = 0;
    for (const comp of ctx.publish) {
      const b = buildCompetition(ctx, comp);
      writer.write(`competitions/${comp.id}.json`, b.file);
      metas.push(b.meta);
      if (b.file.backtest) per.push({ compId: comp.id, compName: comp.name, backtest: b.file.backtest });
      simFixtures += b.stats.simulatedFixtures;
      synthetic += b.stats.syntheticFixtures;
    }
    timer.lap('Competiciones', `${metas.length} archivos, ${simFixtures} partidos simulados (${synthetic} de calendario completado)`);

    // ---- fichas de partido
    let matchFiles = 0;
    for (const id of ctx.detailIds) {
      const m = ctx.matchById.get(id);
      if (!m) continue;
      writer.write(`matches/${id}.json`, buildMatchFile(ctx, m));
      matchFiles++;
    }
    timer.lap('Fichas de partido', `${matchFiles} archivos`);

    // ---- jugadores
    const players = globalPlayerRows(ctx);
    const playersFile = buildPlayersFile(ctx, players);
    writer.write('players.json', playersFile);
    timer.lap('Jugadores', `${players.length} con minutos, ${playersFile.players.length} publicados`);

    // ---- equipos
    const compsByTeam = teamCompetitions(ctx);
    const teamIds = teamsToPublish(ctx, compsByTeam);
    const teamIndex: MetaFile['teams'] = [];
    for (const id of teamIds) {
      const comps = compsByTeam.get(id) ?? [];
      const file = buildTeamFile(ctx, id, comps, players);
      writer.write(`teams/${id}.json`, file);
      const entry: MetaFile['teams'][number] = { id, name: file.team.name, abbr: file.team.abbr, compId: primaryCompetition(ctx, id, comps) };
      if (file.team.logo) entry.logo = file.team.logo;
      teamIndex.push(entry);
    }
    teamIndex.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    timer.lap('Fichas de equipo', `${teamIds.length} archivos`);

    // ---- raíz
    const bets = collectValueBets(ctx);
    writer.write('value.json', buildValueFile(ctx, bets));
    const backtest = aggregateBacktest(per);
    writer.write('home.json', buildHomeFile(ctx, bets, players, backtest));
    writer.write(
      'model.json',
      buildModelFile(ctx, per, backtest, { competitions: metas.length, teams: teamIds.length, players: players.length, valueBets: bets.length }),
    );
    writer.write('meta.json', buildMetaFile(ctx, metas, teamIndex, { players: players.length, valueBets: bets.length }, packageVersion()));
    timer.lap('Portada, valor, modelo y meta', `${bets.length} apuestas de valor`);

    swapDir(staging, opts.outDir);

    const report: BuildReport = {
      outDir: opts.outDir,
      seconds: timer.total(),
      phases: timer.phases,
      files: writer.files,
      bytes: writer.bytes,
      bytesByDir: Object.fromEntries(writer.bytesByDir),
      competitions: metas.length,
      matchFiles,
      teamFiles: teamIds.length,
      valueBets: bets.length,
      cleaned: writer.clean,
    };
    return report;
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(args: string[], name: string): string | undefined {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const i = a.indexOf('=');
  return i >= 0 ? a.slice(i + 1) : '';
}

export function main(args: string[]): number {
  const only = argValue(args, 'only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fast = argValue(args, 'fast') !== undefined;
  const nowArg = argValue(args, 'now');
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now inválido: ${nowArg}`);
  const outDir = path.resolve(argValue(args, 'out') || OUTPUT_DIR);
  if (only) {
    const unknown = only.filter((id) => !COMPETITIONS.some((c) => c.id === id));
    if (unknown.length) throw new Error(`Competiciones desconocidas en --only: ${unknown.join(', ')}`);
  }

  console.log(`FutStat Lab · build ${now.toISOString()}${fast ? ' (rápido)' : ''}${only ? ` · solo ${only.join(', ')}` : ''}`);
  const t0 = performance.now();
  const stores = loadAllStores();
  if (!stores.length) {
    console.error('No hay datos en data-store/: ejecuta antes `npm run data:fetch`.');
    return 1;
  }
  console.log(`  ✓ ${'Carga de data-store'.padEnd(40)} ${((performance.now() - t0) / 1000).toFixed(2).padStart(7)} s  ${stores.length} competiciones`);
  const r = runBuild({ stores, configs: COMPETITIONS, now, only, fast, outDir });
  console.log(`\nSalida: ${path.relative(process.cwd(), r.outDir) || r.outDir}`);
  for (const [dir, e] of Object.entries(r.bytesByDir).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${dir.padEnd(14)} ${String(e.files).padStart(5)} archivos  ${formatBytes(e.bytes).padStart(10)}`);
  }
  console.log(`  ${'total'.padEnd(14)} ${String(r.files).padStart(5)} archivos  ${formatBytes(r.bytes).padStart(10)}`);
  if (r.cleaned.droppedKeys || r.cleaned.zeroedItems) {
    console.warn(
      `AVISO: ${r.cleaned.droppedKeys + r.cleaned.zeroedItems} valores no finitos corregidos al publicar (p. ej. ${r.cleaned.examples.slice(0, 5).join(', ')})`,
    );
  }
  console.log(`Tiempo total: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  }
}
