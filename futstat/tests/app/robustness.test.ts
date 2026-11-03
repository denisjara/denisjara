/**
 * Robustez de la app ante datos anómalos (hallazgos de los revisores adversariales):
 *  - niceTicks nunca entra en bucle (crash-F1),
 *  - las tablas de etiquetas no resuelven claves de Object.prototype (crash-F2/F3),
 *  - sanitize: meta.id inválido, números no finitos, props de jugador, listas enormes (web-WEB-4, crash-F4/F5/F7/F8),
 *  - CSP de producción con hashes correctos y sin 'unsafe-inline' (web-WEB-3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { niceTicks } from '../../src/app/lib/ticks';
import { lookup } from '../../src/app/lib/lookup';
import { marketFamily } from '../../src/app/lib/picks';
import { normalizeDataFile } from '../../src/app/lib/sanitize';
import { timeAgo } from '../../src/app/lib/format';
import { inlineBlocks, inlineStyleAttributes, productionCspPolicy } from '../../scripts/csp';
import type { CompetitionFile, HomeFile, MatchFile } from '../../src/types/data';

const ROOT = path.resolve(__dirname, '../..');
const mock = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mock-data', rel), 'utf8'));
const mockMatchFile = () => fs.readdirSync(path.join(ROOT, 'public/mock-data/matches')).find((f) => f.endsWith('.json'))!;

describe('niceTicks (crash-F1)', () => {
  it('termina con valores separados por 1 ULP (1500 y 1500.0000000000002)', () => {
    const t = niceTicks(1500, 1500.0000000000002, 4);
    expect(t.length).toBeLessThanOrEqual(50);
    expect(t.length).toBeGreaterThan(0);
  });
  it('termina con magnitudes enormes y rangos desbordados', () => {
    expect(niceTicks(1e17, 100000000000000020, 4).length).toBeLessThanOrEqual(50);
    expect(niceTicks(-1e308, 1e308, 4).length).toBeLessThanOrEqual(50);
    expect(niceTicks(Number.NaN, 1, 4)).toEqual([1]);
    expect(niceTicks(0, Number.POSITIVE_INFINITY, 4)).toEqual([0]);
  });
  it('sigue dando marcas redondas en rangos normales', () => {
    expect(niceTicks(1425, 1575, 4)).toEqual([1450, 1500, 1550]);
    expect(niceTicks(0, 1, 4)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe('lookup y familias de mercado (crash-F2/F3)', () => {
  const T = { G: 'POR', shin: 'Shin' } as Record<string, string>;
  it('no resuelve claves heredadas de Object.prototype', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(lookup(T, k)).toBeUndefined();
    expect(lookup(T, 'G')).toBe('POR');
    expect(lookup(T, 42)).toBeUndefined();
  });
  it('marketFamily devuelve siempre texto', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const f = marketFamily({ marketId: id, market: 'Mercado X' });
      expect(typeof f.label).toBe('string');
      expect(typeof f.key).toBe('string');
    }
    expect(marketFamily({ marketId: 'btts', market: '' }).label).toBe('Ambos marcan');
  });
});

describe('sanitize: competición (web-WEB-4 / crash-F4 / crash-F8)', () => {
  const base = () => mock('competitions/laliga.json');
  it.each(['LaLiga', 'Champions_League', 'la liga', 'javascript:alert(1)', 'CHAMPIONS'])('meta.id inválido %j → usa el id del archivo', (id) => {
    const c = base();
    c.meta.id = id;
    const out = normalizeDataFile('competitions/laliga.json', c) as CompetitionFile;
    expect(out.meta).toBeDefined();
    expect(out.meta.id).toBe('laliga');
    expect(typeof out.meta.name).toBe('string');
  });
  it('meta ausente o de otra competición → identidad del archivo', () => {
    const c = base();
    delete c.meta;
    expect((normalizeDataFile('competitions/laliga.json', c) as CompetitionFile).meta.id).toBe('laliga');
    const d = base();
    d.meta.id = 'premier';
    expect((normalizeDataFile('competitions/laliga.json', d) as CompetitionFile).meta.id).toBe('laliga');
  });
  it('bandera de 10.000 caracteres se acota', () => {
    const c = base();
    c.meta.flag = 'W'.repeat(10000);
    const out = normalizeDataFile('competitions/laliga.json', c) as CompetitionFile;
    expect(Array.from(out.meta.flag).length).toBeLessThanOrEqual(8);
  });
  it('contadores no finitos de la clasificación → undefined (nunca Infinity/NaN/objeto)', () => {
    const c = base();
    const row = c.standings[0].rows[0];
    row.points = Number.POSITIVE_INFINITY;
    row.played = 'NaN';
    row.gd = { a: 1 };
    const out = normalizeDataFile('competitions/laliga.json', c) as CompetitionFile;
    const r = out.standings[0].rows[0];
    expect(r.points).toBeUndefined();
    expect(r.played).toBeUndefined();
    expect(r.gd).toBeUndefined();
  });
  it('listas enormes se recortan (crash-F7)', () => {
    const c = base();
    const m = c.upcoming[0] ?? c.results[0];
    c.upcoming = Array.from({ length: 5000 }, (_, i) => ({ ...m, id: String(9_000_000 + i) }));
    const out = normalizeDataFile('competitions/laliga.json', c) as CompetitionFile;
    expect(out.upcoming.length).toBeLessThanOrEqual(300);
  });
});

describe('sanitize: portada y partido (crash-F3/F5/F6/F7)', () => {
  it('last5 sin goles/asistencias no produce NaN', () => {
    const h = mock('home.json');
    const p = h.hotPlayers[0];
    delete p.last5[0].goals;
    p.last5[1].assists = 'NaN';
    const out = normalizeDataFile('home.json', h) as HomeFile;
    const l5 = out.hotPlayers[0].last5;
    expect(l5[0].goals).toBeUndefined();
    expect(l5[1].assists).toBeUndefined();
  });
  it('props con posición "__proto__", método de margen raro y matriz enorme', () => {
    const file = mockMatchFile();
    const m = mock(`matches/${file}`);
    m.players.home = m.players.home.map((p: { player: object }) => ({ ...p, player: { ...p.player, position: '__proto__' }, goals: 'NaN' }));
    m.model.market = { probs: { home: 0.5, draw: 0.3, away: 0.2 }, margin: 0.05, method: 'constructor' };
    m.model.scoreMatrix = Array.from({ length: 5000 }, () => Array.from({ length: 5000 }, () => 0));
    const out = normalizeDataFile(`matches/${file}`, m) as MatchFile;
    for (const p of out.players.home) {
      expect(['G', 'D', 'M', 'F', '?']).toContain(p.player.position);
      expect(p.goals).toBeUndefined();
    }
    expect(out.model.market?.method).toBe('');
    expect(out.model.scoreMatrix.length).toBeLessThanOrEqual(11);
    expect(out.model.scoreMatrix[0].length).toBeLessThanOrEqual(11);
  });
  it('ensamble ausente queda undefined (la pestaña Análisis lo muestra como no disponible)', () => {
    const file = mockMatchFile();
    const m = mock(`matches/${file}`);
    m.model.ensemble = { home: 0, draw: 0, away: 0 };
    delete m.match.prediction;
    const out = normalizeDataFile(`matches/${file}`, m) as MatchFile;
    expect(out.model.ensemble).toBeUndefined();
  });
});

describe('CSP de producción (web-WEB-3)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  it('no usa unsafe-inline, exige Trusted Types y no abre orígenes de Google Fonts', () => {
    const p = productionCspPolicy(html);
    expect(p).not.toContain('unsafe-inline');
    expect(p).toContain("require-trusted-types-for 'script'");
    expect(p).toContain("trusted-types 'none'");
    expect(p).not.toMatch(/googleapis|gstatic/);
  });
  it('hashea exactamente los bloques en línea (no los que se mencionan en comentarios)', () => {
    const { scripts, styles } = inlineBlocks(html);
    expect(scripts.length).toBe(1); // script de tema
    expect(styles.length).toBe(1); // pantalla de arranque
    expect(scripts[0]).toContain('futstat-theme');
    expect(inlineStyleAttributes(html)).toBe(false);
    expect(inlineBlocks('<!-- <script>x</script> --><script>y</script>').scripts).toEqual(['y']);
  });
  it('index.html trae contenido de respaldo dentro de #root (web-WEB-1)', () => {
    const root = /<div id="root">([\s\S]*?)<\/div>\s*<noscript>/.exec(html)?.[1] ?? '';
    expect(root).toMatch(/Cargando/);
    expect(root).toMatch(/Recargar/);
  });
});

describe('timeAgo: singular/plural en español', () => {
  const now = new Date('2026-11-03T20:00:00Z');
  it('futuro: "en 1 día" (no "en 1 días") y "en 2 días"', () => {
    expect(timeAgo('2026-11-04T20:00:00Z', now)).toBe('en 1 día');
    expect(timeAgo('2026-11-05T20:00:00Z', now)).toBe('en 2 días');
    expect(timeAgo('2026-11-03T23:00:00Z', now)).toBe('en 3 h');
  });
  it('pasado: "hace 1 día" y "hace 2 días"', () => {
    expect(timeAgo('2026-11-02T20:00:00Z', now)).toBe('hace 1 día');
    expect(timeAgo('2026-11-01T20:00:00Z', now)).toBe('hace 2 días');
  });
});
