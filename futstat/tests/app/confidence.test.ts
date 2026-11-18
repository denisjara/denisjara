/**
 * App: pronósticos de alta confianza (confidence.json, prediction.safe, MatchFile.confidence, portada). La capa de
 * datos debe aceptar el archivo, normalizarlo de forma defensiva y no inventar cifras.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConfidenceFile, HomeFile, MatchFile } from '../../src/types/data';
import { normalizeDataFile, normConfidencePick } from '../../src/app/lib/sanitize';
import { beyond90, groupByMatch, outOfSample, ownRate, wilson90 } from '../../src/app/lib/confidence';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mock = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/mock-data', rel), 'utf8'));

const PICK = {
  family: 'ah+1.5',
  marketId: 'ah-home-1.5',
  market: 'Hándicap asiático Local +1.5',
  selection: 'Local +1.5',
  prob: 0.91,
  fairOdds: 1.099,
  tier: 'oro',
  historicalHitRate: 0.9,
  historicalN: 600,
  threshold: 0.8,
  calibratedProb: 0.9,
  source: 'mercado',
  validationHitRate: 0.8869,
  validationN: 1521,
  validationWilsonLow: 0.8728,
  validationWilsonHigh: 0.8997,
  holdoutHitRate: 0.885,
  holdoutN: 864,
  holdoutWilsonLow: 0.865,
  holdoutWilsonHigh: 0.902,
  baseRate: 0.911,
};

describe('alta confianza en la app', () => {
  it('el archivo de prueba se normaliza sin perder picks y con cifras coherentes', () => {
    const raw = mock('confidence.json');
    const out = normalizeDataFile('confidence.json', raw) as ConfidenceFile;
    expect(out.picks.length).toBe(raw.picks.length);
    expect(out.recent.length).toBe(raw.recent.length);
    expect(out.track.holdout.n).toBeGreaterThan(0);
    expect(out.track.holdout.hitRate).toBeCloseTo(out.track.holdout.hits / out.track.holdout.n, 3);
    expect(out.track.byFamily.length).toBe(23);
    expect(out.note.length).toBeGreaterThan(20);
    for (const r of out.recent) expect(r.hit).toBe(r.pick.result === 'hit');
    // solo nivel oro; contexto honesto: línea base sin modelo, lift, walk-forward y n + Wilson por familia
    expect([...out.picks, ...out.recent].every((x) => x.pick.tier === 'oro')).toBe(true);
    expect(out.track.byTier.map((x) => x.tier)).toEqual(['oro']);
    expect(out.track.baseline!.hitRate).toBeGreaterThan(0.8);
    expect(out.track.baseline!.label).toMatch(/visitante/);
    expect(out.track.lift).toBeCloseTo(out.track.holdout.hitRate - out.track.expectedBaseRate!, 3);
    expect(out.track.walkForward!.folds.length).toBeGreaterThan(1);
    for (const f of out.track.byFamily.filter((x) => x.n > 0)) {
      expect(f.wilsonLow!).toBeLessThanOrEqual(f.hitRate!);
      expect(f.wilsonHigh!).toBeGreaterThanOrEqual(f.hitRate!);
      expect(f.baseRate).toBeDefined();
    }
    expect(out.track.byFamily.find((f) => f.family === 'cards-over-2.5')!.excluded).toBeTruthy();
    expect(out.rules.validation).toEqual({ minN: 30, minRate: 0.8 });
  });

  it('picks dañados se descartan; campos raros se neutralizan; el acierto nunca se inventa', () => {
    const out = normalizeDataFile('confidence.json', {
      generatedAt: '2026-11-15T00:00:00Z',
      picks: [
        { match: { id: '1', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: PICK },
        { match: { id: '2', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, prob: 1.7 } },
        { match: { id: '3', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, selection: '' } },
        { match: { id: '4', date: 'mañana', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: PICK },
        { match: { id: '5', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, source: 'x', holdoutN: 0, validationWilsonLow: 0.95, marketOdds: 0.5 } },
        { match: { id: '6', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, tier: 'plata' } },
        { match: { id: '7', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, tier: '__proto__' } },
      ],
      recent: [{ match: { id: '9', date: '2026-11-10T18:00:00Z', status: 'finished', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, result: 'miss' }, hit: true }],
      track: { holdout: { picks: 10, n: 10, hits: 12, hitRate: 1.2 }, byFamily: [{ family: 'dc', label: 'Doble oportunidad', theme: 'x', n: 0, hitRate: 0.5, thresholds: [{ source: 'mercado', threshold: 0.82 }, { source: 'otro', threshold: 0.8 }] }] },
      rules: null,
      note: 7,
    }) as ConfidenceFile;
    // los picks de nivel plata (ficheros antiguos) o de nivel desconocido nunca se muestran
    expect(out.picks.map((p) => p.match.id)).toEqual(['1', '5']);
    const odd = out.picks[1].pick;
    expect(odd.tier).toBe('oro');
    expect(odd.source).toBeUndefined();
    expect(odd.holdoutN).toBeUndefined();
    expect(odd.holdoutHitRate).toBeUndefined();
    expect(odd.holdoutWilsonLow).toBeUndefined();
    // un intervalo que no contiene el acierto se descarta (el acierto y n se conservan)
    expect(odd.validationHitRate).toBe(0.8869);
    expect(odd.validationWilsonLow).toBeUndefined();
    expect(odd.validationWilsonHigh).toBeUndefined();
    expect(odd.marketOdds).toBeUndefined();
    expect(out.recent[0].hit).toBe(false); // un fallo nunca se muestra como acierto
    expect(out.track.holdout.n).toBe(0); // aciertos > resueltos y acierto > 1 → registro inválido, no se muestra
    expect(out.track.byFamily[0].hitRate).toBeUndefined();
    expect(out.track.byFamily[0].theme).toBe('goles');
    expect(out.track.byFamily[0].thresholds).toEqual([
      { source: 'mercado', threshold: 0.82, goldThreshold: undefined, validationN: undefined, validationHits: undefined, validationHitRate: undefined },
    ]);
    expect(out.track.avgFairOdds).toBe(0);
    expect(out.note).toBe('7');
  });

  it('prediction.safe, MatchFile.confidence y portada (topConfidence, confidenceHeadline)', () => {
    const files = fs.readdirSync(path.join(ROOT, 'public/mock-data/matches')).filter((f) => f.endsWith('.json'));
    const withConf = files.map((f) => mock(`matches/${f}`)).find((m: { confidence?: unknown[]; match: { status: string } }) => m.confidence?.length && m.match.status === 'scheduled');
    expect(withConf).toBeTruthy();
    const mf = normalizeDataFile(`matches/${withConf.match.id}.json`, withConf) as MatchFile;
    expect(mf.confidence!.length).toBe(withConf.confidence.length);
    expect(mf.match.prediction?.safe?.selection).toBe(mf.confidence![0].selection);
    const home = normalizeDataFile('home.json', mock('home.json')) as HomeFile;
    expect(home.topConfidence!.length).toBeGreaterThan(0);
    expect(home.topConfidence!.length).toBeLessThanOrEqual(8);
    expect(home.confidenceHeadline!.hitRate).toBeGreaterThan(0.8);
    expect(home.confidenceHeadline!.wilsonLow!).toBeLessThan(home.confidenceHeadline!.hitRate);
    expect(home.confidenceHeadline!.baselineRate).toBeGreaterThan(0.8);
    // cabecera inválida → se omite (la UI muestra «—», nunca una cifra inventada)
    const bad = normalizeDataFile('home.json', { ...mock('home.json'), confidenceHeadline: { hitRate: 2, picks: 10 } }) as HomeFile;
    expect(bad.confidenceHeadline).toBeUndefined();
    // un safe roto no rompe el partido: se descarta
    const m = normalizeDataFile('home.json', { ...mock('home.json'), popular: [{ ...mock('home.json').popular[0], prediction: { ...mock('home.json').popular[0].prediction, safe: { prob: 'x' } } }] }) as HomeFile;
    expect(m.popular[0].prediction?.safe).toBeUndefined();
  });

  it('validación fuera de muestra y agrupación por partido', () => {
    const p = normConfidencePick(PICK)!;
    expect(outOfSample(p)).toBe('ok');
    // n < 50: «muestra pequeña», sin acierto propio
    expect(outOfSample({ validationHitRate: 0.93, validationN: 36 })).toBe('pequena');
    expect(outOfSample({ validationHitRate: 0.744, validationN: 125 })).toBe('bajo');
    expect(outOfSample({ validationHitRate: 1, validationN: 0 })).toBe('sin-validar');
    expect(outOfSample({})).toBe('sin-validar');
    expect(ownRate(49)).toBe(false);
    expect(ownRate(50)).toBe(true);
    // mismo intervalo de Wilson al 90 % que el pipeline (holdout real: 2.362/2.630 → 88,8–90,7 %)
    const [lo, hi] = wilson90(2362, 2630);
    expect(lo).toBeCloseTo(0.888, 3);
    expect(hi).toBeCloseTo(0.9074, 3);
    expect(wilson90(0, 0)).toEqual([0, 1]);
    const match = (id: string) => ({ id, compId: 'x', compName: 'X', date: '2026-11-16T18:00:00Z', status: 'scheduled' as const, home: { id: 'a', name: 'A', short: 'A', abbr: 'A' }, away: { id: 'b', name: 'B', short: 'B', abbr: 'B' }, hasDetail: true });
    const g = groupByMatch([
      { match: match('1'), pick: p },
      { match: match('1'), pick: { ...p, family: 'team-score' } },
      { match: match('2'), pick: p },
    ]);
    expect(g.map((x) => [x.match.id, x.picks.length])).toEqual([
      ['1', 2],
      ['2', 1],
    ]);
  });

  it('partidos con prórroga o penaltis: la UI avisa de que se resuelven a 90 minutos', () => {
    expect(beyond90({ statusDetail: 'Final' })).toBeUndefined();
    expect(beyond90({ statusDetail: 'Final (prórroga)', score: { home: 1, away: 2 } })).toBe('prórroga');
    expect(beyond90({ statusDetail: 'Final (penaltis)' })).toBe('penaltis');
    expect(beyond90({ score: { home: 3, away: 3, penHome: 2, penAway: 3 } })).toBe('penaltis');
    expect(beyond90({})).toBeUndefined();
  });
});
