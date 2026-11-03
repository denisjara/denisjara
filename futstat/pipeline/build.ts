/**
 * CLI: data-store/<compId>.json → public/data/*.json (contrato en src/types/data.ts).
 *
 *   npx tsx pipeline/build.ts [--only=laliga,champions] [--fast] [--now=2026-11-03T12:00:00Z] [--out=dir] [--no-sanity] [--allow-stale]
 *
 *   --only       publica solo esas competiciones (los modelos se ajustan siempre con todos los stores)
 *   --fast       menos iteraciones (simulación 2.000, re-ajuste walk-forward quincenal) para depurar
 *   --now        fecha de referencia (por defecto, ahora)
 *   --out        directorio de salida (por defecto public/data)
 *   --no-sanity  valida solo el contrato, sin umbrales de cordura (desarrollo con datos parciales)
 *   --allow-stale publica aunque la última descarga correcta de ESPN tenga más de 72 h (desarrollo con un almacén viejo)
 *
 * Seguridad del equipo: --out solo acepta un directorio inexistente, vacío o con una salida anterior de FutStat (nunca
 * borra contenido ajeno) y un cerrojo impide dos builds a la vez sobre la misma salida.
 *
 * Fases: índices + modelos actuales (Elo global, Dixon-Coles por liga, Elo→goles, medias de goles) →
 * Dixon-Coles walk-forward y predicciones pre-partido de la temporada actual (xG proxy, backtest, aciertos) →
 * competiciones (clasificación con forma/xPts/Elo, próximos, resultados, estadísticas, ratings, simulación,
 * jugadores, backtest, insights) → fichas de partido → jugadores → fichas de equipo → valor, portada, modelo, meta.
 *
 * PUERTA DE CALIDAD: todo se escribe en un directorio temporal (`<salida>.tmp`, p. ej. public/data.tmp), se valida
 * con scripts/validate-data.ts (contrato + umbrales de cordura) y SOLO si pasa sustituye a la salida: la versión
 * anterior se aparta a `<salida>.prev`, el temporal se renombra a la salida y la anterior se borra al final (si el
 * renombrado falla se restaura). Si la validación falla, el proceso sale con código 1 y la salida anterior queda
 * intacta. Un build interrumpido se recupera al empezar el siguiente.
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
import {
  JsonWriter,
  LockedError,
  PhaseTimer,
  UnsafeOutputError,
  acquireLock,
  assertSafeOutputDir,
  formatBytes,
  recoverInterruptedSwap,
  stagingDirFor,
  swapDir,
  type CleanStats,
} from './publish/util';
import { DEFAULT_SANITY, validateDataDir, type ValidateOptions, type ValidationResult } from '../scripts/validate-data';

export interface RunBuildOptions extends BuildOptions {
  outDir: string;
  /** validación antes de publicar (por defecto contrato + umbrales de cordura de producción) */
  validate?: ValidateOptions;
}

/** La salida generada no pasó la validación: no se ha publicado nada (la salida anterior sigue intacta). */
export class PublishRejectedError extends Error {
  readonly validation: ValidationResult;
  constructor(validation: ValidationResult) {
    super(`Datos rechazados por la validación (${validation.errors.length} errores): no se publica nada y se conserva la versión anterior`);
    this.name = 'PublishRejectedError';
    this.validation = validation;
  }
}

export { stagingDirFor };

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
  /** valores corregidos al sanear el JSON (deberían ser 0) */
  cleaned: CleanStats;
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
  // Antes de calcular nada: el destino debe ser una salida de FutStat (nunca se borra contenido ajeno) y nadie más
  // puede estar publicando en él (dos builds a la vez compartirían <salida>.tmp y fallarían los dos).
  const outDir = path.resolve(opts.outDir.replace(/[\\/]+$/, ''));
  assertSafeOutputDir(outDir, ROOT_DIR);
  const releaseLock = acquireLock('build', outDir, `La salida ${outDir}`);
  try {
    return runBuildLocked(opts, outDir, log);
  } finally {
    releaseLock();
  }
}

function runBuildLocked(opts: RunBuildOptions, outDir: string, log: (msg: string) => void): BuildReport {
  const timer = new PhaseTimer(log);
  const ctx = createContext({ ...opts, log });
  timer.lap(
    'Índices y modelos actuales',
    `${ctx.allMatches.length} partidos, ${ctx.suite.eloBuild.samples.length} terminados, ${ctx.suite.dcModels.size} ligas DC, ${ctx.globalEloRank.size} equipos con Elo`,
  );

  const wf = computeWalkForward(ctx);
  timer.lap('Walk-forward y predicciones pre-partido', `${wf.refits} ajustes DC, ${wf.predictions} partidos`);

  const staging = stagingDirFor(outDir);
  assertSafeOutputDir(outDir, ROOT_DIR); // otra vez: pudo cambiar mientras se ajustaban los modelos
  recoverInterruptedSwap(outDir);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const writer = new JsonWriter(staging);

  try {
    // ---- tolerancia por partido: una ficha que no se puede construir (registro anómalo) se omite y el partido deja de
    // anunciarse con hasDetail=true ANTES de escribir nada que lo referencie; el resto se publica (degradar, no rechazar)
    const brokenMatches: string[] = [];
    for (const id of [...ctx.detailIds]) {
      const m = ctx.matchById.get(id);
      if (!m) continue;
      try {
        buildMatchFile(ctx, m);
      } catch (e) {
        ctx.detailIds.delete(id);
        brokenMatches.push(`${id} (${(e as Error)?.message ?? e})`);
      }
    }
    if (brokenMatches.length) log(`  aviso: ${brokenMatches.length} fichas de partido omitidas por datos anómalos: ${brokenMatches.slice(0, 5).join('; ')}`);

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
    let brokenTeams = 0;
    for (const id of teamIds) {
      const comps = compsByTeam.get(id) ?? [];
      let file: ReturnType<typeof buildTeamFile>;
      try {
        file = buildTeamFile(ctx, id, comps, players);
      } catch (e) {
        // ficha de equipo anómala: se omite (y no entra en el índice del buscador); el resto se publica
        if (brokenTeams++ < 5) log(`  aviso: ficha del equipo ${id} omitida: ${(e as Error)?.message ?? e}`);
        continue;
      }
      writer.write(`teams/${id}.json`, file);
      const entry: MetaFile['teams'][number] = { id, name: file.team.name, abbr: file.team.abbr, compId: primaryCompetition(ctx, id, comps) };
      if (file.team.logo) entry.logo = file.team.logo;
      if (file.team.color) entry.color = file.team.color;
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

    // ---- puerta de calidad: solo se publica si el conjunto completo pasa la validación
    const validation = validateDataDir(staging, { ...(opts.validate ?? {}), partial: opts.validate?.partial ?? !!opts.only?.length });
    if (!validation.ok) throw new PublishRejectedError(validation);
    timer.lap('Validación (contrato y cordura)', `${validation.files} archivos válidos`);

    swapDir(staging, outDir);

    const report: BuildReport = {
      outDir,
      seconds: timer.total(),
      phases: timer.phases,
      files: writer.files,
      bytes: writer.bytes,
      bytesByDir: Object.fromEntries(writer.bytesByDir),
      competitions: metas.length,
      matchFiles,
      teamFiles: teamIndex.length,
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
  const noSanity = argValue(args, 'no-sanity') !== undefined;
  const allowStale = argValue(args, 'allow-stale') !== undefined;
  const known = new Set(['only', 'fast', 'now', 'out', 'no-sanity', 'allow-stale']);
  const unknownArgs = args.filter((a) => !known.has(a.replace(/^--/, '').split('=')[0]));
  if (unknownArgs.length) throw new Error(`Argumentos desconocidos: ${unknownArgs.join(' ')}`);
  if (only) {
    const unknown = only.filter((id) => !COMPETITIONS.some((c) => c.id === id));
    if (unknown.length) throw new Error(`Competiciones desconocidas en --only: ${unknown.join(', ')}`);
  }

  console.log(`FutStat Lab · build ${now.toISOString()}${fast ? ' (rápido)' : ''}${only ? ` · solo ${only.join(', ')}` : ''}`);
  const t0 = performance.now();
  const stores = loadAllStores();
  if (!stores.length) {
    console.error('No hay datos en data-store/: ejecuta antes `npm run data:fetch`. No se modifica public/data.');
    return 1;
  }
  console.log(`  ✓ ${'Carga de data-store'.padEnd(40)} ${((performance.now() - t0) / 1000).toFixed(2).padStart(7)} s  ${stores.length} competiciones`);
  // con --only se publican menos competiciones: el umbral de competiciones con datos se ajusta a las pedidas
  const validate: ValidateOptions = noSanity
    ? { sanity: false }
    : {
        sanity: {
          ...(only ? { minCompetitionsWithData: Math.min(DEFAULT_SANITY.minCompetitionsWithData, only.length) } : {}),
          ...(allowStale ? { maxDataAgeHours: Infinity } : {}),
        },
      };
  let r: BuildReport;
  try {
    r = runBuild({ stores, configs: COMPETITIONS, now, only, fast, outDir, validate });
  } catch (e) {
    if (e instanceof PublishRejectedError) {
      console.error(`\n✗ ${e.message}.`);
      for (const err of e.validation.errors.slice(0, 60)) console.error(`  - ${err}`);
      if (e.validation.errors.length > 60) console.error(`  … ${e.validation.errors.length - 60} errores más`);
      console.error(`Se conserva sin cambios: ${path.relative(process.cwd(), outDir) || outDir}`);
      return 1;
    }
    if (e instanceof UnsafeOutputError || e instanceof LockedError) {
      console.error(`\n✗ ${e.message}`);
      return 1;
    }
    throw e;
  }
  console.log(`\nSalida: ${path.relative(process.cwd(), r.outDir) || r.outDir}`);
  for (const [dir, e] of Object.entries(r.bytesByDir).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${dir.padEnd(14)} ${String(e.files).padStart(5)} archivos  ${formatBytes(e.bytes).padStart(10)}`);
  }
  console.log(`  ${'total'.padEnd(14)} ${String(r.files).padStart(5)} archivos  ${formatBytes(r.bytes).padStart(10)}`);
  const fixed = r.cleaned.droppedKeys + r.cleaned.zeroedItems + (r.cleaned.sanitizedStrings ?? 0);
  if (fixed) {
    console.warn(
      `AVISO: ${fixed} valores corregidos al publicar (no finitos, URLs no permitidas o textos saneados; p. ej. ${r.cleaned.examples.slice(0, 5).join(', ')})`,
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
