/**
 * App: panel «Factores del partido» (src/app/pages/match/FactorsPanel.tsx) y sus utilidades puras (src/app/lib/factors.ts).
 * Frases y etiquetas coherentes con los datos (árbitro estricto/permisivo, qué necesita cada equipo en la vuelta, bajas,
 * lo que se juega), insignia «Usado en el modelo» / «Informativo» en cada pieza y render sin fallos con bloques
 * parciales o rotos (nunca NaN, undefined ni excepciones).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MatchFactors, MatchFile, MatchSummary } from '../../src/types/data';
import { normalizeDataFile, normMatchFactors } from '../../src/app/lib/sanitize';
import {
  absenceDetail,
  absenceEffect,
  absenceKindLabel,
  factorHighlights,
  factorUsage,
  firstLegHostIsAway,
  ratioDelta,
  refereeGaugePos,
  refereeSentence,
  refereeTone,
  stakeText,
  tieNeed,
  tieNeeds,
} from '../../src/app/lib/factors';

const ROOT = path.resolve(__dirname, '../..');
/**
 * El componente (.tsx) se carga en tiempo de ejecución: tsconfig.node.json (que compila tests/) no tiene JSX ni DOM,
 * y el componente ya lo comprueba tsconfig.app.json. Vitest sí transforma el .tsx.
 */
type PanelProps = { factors?: MatchFactors; match: MatchSummary };
const { FactorsPanel } = (await import(path.join(ROOT, 'src/app/pages/match/FactorsPanel.tsx'))) as { FactorsPanel: (p: PanelProps) => ReactElement | null };
const MATCH_DIR = path.join(ROOT, 'public/mock-data/matches');
const mockFiles = (): MatchFile[] =>
  fs
    .readdirSync(MATCH_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => normalizeDataFile(`matches/${f}`, JSON.parse(fs.readFileSync(path.join(MATCH_DIR, f), 'utf8'))) as MatchFile);

const render = (factors: MatchFactors | undefined, match: MatchSummary) => renderToStaticMarkup(createElement(FactorsPanel, { factors, match }));
const badgeCount = (html: string) => (html.match(/Usado en el modelo|Informativo/g) ?? []).length;

describe('utilidades de factores', () => {
  it('árbitro: estricto / permisivo / normal con banda ±5 % y delta con signo', () => {
    expect(refereeTone(1.08)).toBe('estricto');
    expect(refereeTone(1.05)).toBe('estricto');
    expect(refereeTone(1.049)).toBe('normal');
    expect(refereeTone(0.931)).toBe('permisivo');
    expect(refereeTone(undefined)).toBe('normal');
    expect(refereeTone(Number.NaN)).toBe('normal');
    expect(ratioDelta(1.081)).toBe('+8%');
    expect(ratioDelta(0.931)).toBe('−7%');
    expect(ratioDelta(1)).toBe('0%');
    expect(ratioDelta(undefined)).toBe('—');
    expect(refereeGaugePos(1)).toBeCloseTo(0.5, 9);
    expect(refereeGaugePos(5)).toBe(1);
    expect(refereeGaugePos(0.2)).toBe(0);
    expect(refereeSentence({ status: 'conocido', name: 'X', matches: 46, cardsRatio: 0.931, usedInModel: true })).toBe('X: 7 % menos tarjetas que la media de la liga (46 partidos previos)');
    expect(refereeSentence({ status: 'no publicado', usedInModel: false })).toBe('Árbitro aún no publicado');
  });

  it('eliminatoria: qué necesita cada equipo según el global (sin valor doble de los goles fuera)', () => {
    expect(tieNeed(-2)).toBe('Necesita ganar por 3 goles para pasar; por 2 goles, iguala la eliminatoria');
    expect(tieNeed(-1)).toBe('Necesita ganar por 2 goles para pasar; por 1 gol, iguala la eliminatoria');
    expect(tieNeed(0)).toMatch(/^Si gana, pasa/);
    expect(tieNeed(1)).toBe('Le vale el empate; perder por 1 gol iguala la eliminatoria');
    expect(tieNeed(2)).toBe('Le vale empatar o perder por 1 gol; perder por 2 goles iguala la eliminatoria');
    expect(tieNeed(3)).toBe('Le vale empatar o perder por hasta 2 goles; perder por 3 goles iguala la eliminatoria');
    expect(tieNeed(Number.NaN)).toBe('');
    const n = tieNeeds({ aggregate: { home: 0, away: 2 } });
    expect(n.home).toMatch(/^Necesita ganar por 3/);
    expect(n.away).toMatch(/^Le vale empatar/);
    // la ida se jugó en casa del visitante de hoy (lo normal) salvo que el marcador diga lo contrario
    expect(firstLegHostIsAway({ firstLeg: { home: 2, away: 0 }, aggregate: { home: 0, away: 2 } })).toBe(true);
    expect(firstLegHostIsAway({ firstLeg: { home: 2, away: 0 }, aggregate: { home: 2, away: 0 } })).toBe(false);
    expect(firstLegHostIsAway({ firstLeg: { home: 1, away: 1 }, aggregate: { home: 1, away: 1 } })).toBe(true);
  });

  it('bajas y lo que se juega: etiquetas en lista blanca (claves de Object.prototype no resuelven)', () => {
    expect(absenceKindLabel('susp')).toBe('Sancionado');
    expect(absenceDetail('susp')).toBe('expulsado en el último partido');
    expect(absenceKindLabel('__proto__' as never)).toBe('Duda');
    expect(absenceDetail('constructor' as never)).toBe('no jugó los últimos partidos');
    expect(absenceEffect({ minutesFactor: 0 })).toBe('Fuera de las props');
    expect(absenceEffect({ minutesFactor: 0.6 })).toBe('Minutos ×0,60');
    expect(absenceEffect({ minutesFactor: 1 })).toBe('Sin ajuste');
    expect(stakeText('descenso')).toBe('Se juega el descenso');
    expect(stakeText('toString' as never)).toBe('Sin nada en juego');
  });

  it('resumen: árbitro no neutral, vuelta, bajas y lo que se juega; nada sin bloque', () => {
    const home = { name: 'Tenerife', short: 'Tenerife' };
    const away = { name: 'Real Betis', short: 'Betis' };
    expect(factorHighlights(undefined, home, away)).toEqual([]);
    const f: MatchFactors = {
      asOf: '2026-11-26T17:50:00.000Z',
      referee: { status: 'conocido', name: 'R', matches: 46, cardsRatio: 1.09, usedInModel: true },
      tie: { leg: 2, firstLegId: '1', firstLegDate: '2026-11-21T19:00:00Z', firstLeg: { home: 2, away: 0 }, aggregate: { home: 0, away: 2 }, leader: 'away', summary: 's', usedInModel: false },
      absences: {
        home: [],
        away: [{ playerId: '9', name: 'J', kind: 'susp', reason: 'sancionado (expulsado en el último partido)', minutesShare: 0.97, minutesFactor: 0, usedInModel: true }],
      },
      notes: [],
    };
    const h = factorHighlights(f, home, away);
    expect(h.map((x) => x.label)).toEqual(['Árbitro estricto', 'Vuelta: Tenerife necesita remontar', '1 baja probable (1 sancionado)']);
    expect(h.map((x) => x.used)).toEqual([true, false, true]);
    // árbitro sin historial o en la banda normal: no se destaca
    expect(factorHighlights({ ...f, referee: { status: 'conocido', name: 'R', matches: 0, cardsRatio: 1, usedInModel: true } }, home, away)[0].key).toBe('tie');
    expect(factorUsage(f)).toEqual({ used: 2, info: 1 });
    expect(factorUsage({ asOf: '', referee: { status: 'no publicado', usedInModel: false }, notes: [] })).toEqual({ used: 0, info: 1 });
  });
});

describe('FactorsPanel (render)', () => {
  it('pinta cada pieza de los datos de prueba con su insignia y sin NaN/undefined', () => {
    const files = mockFiles().filter((f) => f.factors);
    expect(files.length).toBeGreaterThan(5);
    let sawTie = false;
    let sawUnknownRef = false;
    let sawSusp = false;
    for (const f of files) {
      const html = render(f.factors, f.match);
      expect(html).toContain('Factores del partido');
      expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
      const fx = f.factors!;
      // árbitro + bajas siempre; el resto, solo si existe
      const tiles = 2 + [fx.tie, fx.stakes, fx.form, fx.venue, fx.inForm].filter(Boolean).length;
      expect((html.match(/<article/g) ?? []).length).toBe(tiles);
      expect(badgeCount(html)).toBe(tiles);
      if (fx.tie) {
        sawTie = true;
        expect(html).toContain('Ida');
        expect(html).toContain('Global');
      }
      if (fx.referee.status === 'no publicado') {
        sawUnknownRef = true;
        expect(html).toMatch(/Árbitro (aún no publicado|no publicado antes del partido)/);
      } else {
        expect(html).toContain(fx.referee.name);
      }
      if (fx.absences && [...fx.absences.home, ...fx.absences.away].some((a) => a.kind === 'susp')) {
        sawSusp = true;
        expect(html).toContain('Sancionado');
        expect(html).toContain('Fuera de las props');
      }
    }
    expect(sawTie && sawUnknownRef && sawSusp).toBe(true);
  });

  it('vuelta con árbitro y bajas: estricto/permisivo, ida, global y lo que necesita cada uno', () => {
    const f = mockFiles().find((x) => x.factors?.tie && x.factors.referee.status === 'conocido' && x.factors.absences);
    expect(f, 'el mock debe tener una vuelta con árbitro y bajas').toBeDefined();
    const html = render(f!.factors, f!.match);
    expect(html).toMatch(/Estricto|Permisivo|Normal/);
    expect(html).toContain('tarjetas vs media de la liga');
    expect(html).toMatch(/Necesita ganar por \d+ goles? para pasar/);
    expect(html).toContain('Usado en el modelo');
    expect(html).toContain('Informativo');
  });

  it('no falla con bloques mínimos, parciales o rotos (pasan por normMatchFactors)', () => {
    const match = mockFiles()[0].match;
    expect(render(undefined, match)).toBe('');
    const bad: unknown[] = [
      {},
      { referee: null, notes: null },
      { referee: { status: 'conocido', name: 'Sin datos', matches: 0, cardsRatio: 1, usedInModel: true }, notes: ['n'] },
      { referee: { status: 'conocido', name: 'X', matches: 3, cardsRatio: 1.2 }, form: { home: { last: 3, goalsFor: 1, goalsAgainst: 1, netRes: 0, label: '__proto__' } } },
      { tie: { firstLeg: { home: 1, away: 1 }, aggregate: { home: 1, away: 1 }, summary: 'igualado' }, stakes: { teams: 20, home: { position: 1 } } },
      { venue: { home: { played: 2, w: 1, d: 1, l: 0, gfPerMatch: 1, gaPerMatch: 0.5 } }, absences: { home: [{ playerId: '1', name: 'A', kind: 'miss2', minutesFactor: 0.5 }], away: 'x' } },
      { inForm: { home: [{ playerId: '1', name: 'A', formIndex: 88, note: '' }], away: null } },
    ];
    for (const b of bad) {
      const fx = normMatchFactors(b);
      expect(fx).toBeDefined();
      const html = render(fx, match);
      expect(html).toContain('Factores del partido');
      expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
    }
    const tieOnly = render(normMatchFactors(bad[4]), match);
    expect(tieOnly).toContain('Si gana, pasa');
    expect(render(normMatchFactors(bad[5]), match)).toContain('Minutos ×0,50');
  });
});

describe('FactorsPanel con datos hostiles (revisión adversarial 26-nov)', () => {
  const LONG = 'W'.repeat(5000);
  const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const abs = (i: number, id = String(i % 5)) => ({ playerId: id, name: XSS + LONG, kind: ['susp', 'miss2', '__proto__', 'constructor', 'miss1s'][i % 5], minutesShare: [Number.NaN, 0.5, -1, 0.5, 2][i % 5], minutesFactor: [0, 1, 0.6, 0.65, Infinity][i % 5] });
  const hostile = {
    asOf: 'no es fecha',
    referee: { status: 'conocido', name: XSS + LONG, matches: 12, cardsRatio: 4.99, cardsPerMatch: Infinity, foulsRatio: '1.2', usedInModel: 'yes' },
    tie: { firstLeg: { home: 99, away: 0 }, aggregate: { home: 0, away: 99 }, summary: XSS + LONG, firstLegDate: 'x', firstLegId: { a: 1 } },
    stakes: { teams: 20, home: { position: 20, points: 9, played: 30, remaining: 8, best: 15, worst: 20, status: 'descenso', inPlay: Array(500).fill(LONG) }, away: { position: 1, points: 70, played: 30, remaining: 8, best: 1, worst: 3, status: 'título', inPlay: [XSS] } },
    form: { home: { last: 5, goalsFor: 1, goalsAgainst: 2, netRes: -0.9, label: 'toString' }, away: 'x' },
    venue: { home: { played: 10, w: 8, d: 1, l: 1, gfPerMatch: 2, gaPerMatch: 1, scope: XSS }, away: { played: 0 }, note: LONG },
    absences: { home: Array.from({ length: 500 }, (_, i) => abs(i)), away: Array.from({ length: 500 }, (_, i) => abs(i, `a${i}`)) },
    inForm: { home: Array.from({ length: 500 }, () => ({ playerId: 'p', name: LONG, formIndex: 100, note: LONG })), away: [{ playerId: 'q', name: XSS, formIndex: Number.NaN, note: XSS }] },
    notes: Array(500).fill(LONG + XSS),
  };

  it('textos acotados, sin marcado inyectado, sin NaN/Infinity, listas acotadas y sin jugadores repetidos', () => {
    const fx = normMatchFactors(JSON.parse(JSON.stringify(hostile)))!;
    expect(fx.referee.status).toBe('conocido');
    if (fx.referee.status === 'conocido') {
      expect(Array.from(fx.referee.name).length).toBeLessThanOrEqual(80);
      expect(fx.referee.usedInModel).toBe(false); // "yes" no es true
      expect(fx.referee.cardsPerMatch).toBeUndefined();
      expect(fx.referee.foulsRatio).toBeUndefined();
    }
    expect(fx.notes.length).toBeLessThanOrEqual(8);
    expect(fx.stakes!.home.inPlay.length).toBeLessThanOrEqual(8);
    // un playerId repetido no duplica filas (ni claves de React)
    expect(fx.absences!.home.map((a) => a.playerId)).toEqual(['0', '1', '4']);
    expect(fx.absences!.away.length).toBe(11);
    expect(fx.inForm!.home.length).toBe(1);
    expect(fx.inForm!.away.length).toBe(0);
    // etiqueta desconocida: se deduce del residuo, no se inventa «en línea» con −0,9
    expect(fx.form!.home!.label).toBe('rinde por debajo de lo esperado');
    const match = mockFiles()[0].match;
    const html = render(fx, match);
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
    // los textos libres se parten en vez de recortarse o desbordar a 390 px
    expect((html.match(/\[overflow-wrap:anywhere\]/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it('lo que se juega: peor posición fuera de la tabla → apartado descartado', () => {
    const fx = normMatchFactors({ ...hostile, stakes: { ...hostile.stakes, home: { ...hostile.stakes.home, worst: 1000 } } })!;
    expect(fx.stakes).toBeUndefined();
  });

  it('local / visita: el balance V-E-D llega a lectores de pantalla como texto (no aria-label en un span)', () => {
    const fx = normMatchFactors(hostile)!;
    const html = render(fx, mockFiles()[0].match);
    expect(html).toContain('<span class="sr-only">8 victorias, 1 empates y 1 derrotas en 10 partidos</span>');
    // aria-label solo en elementos con rol (role="img"…): en un <span> genérico se ignora
    for (const tag of html.match(/<span[^>]*aria-label=[^>]*>/g) ?? []) expect(tag).toMatch(/role="/);
  });
});
