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
import { groupByMatch, outOfSample } from '../../src/app/lib/confidence';

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
  holdoutHitRate: 0.885,
  holdoutN: 864,
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
  });

  it('picks dañados se descartan; campos raros se neutralizan; el acierto nunca se inventa', () => {
    const out = normalizeDataFile('confidence.json', {
      generatedAt: '2026-11-15T00:00:00Z',
      picks: [
        { match: { id: '1', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: PICK },
        { match: { id: '2', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, prob: 1.7 } },
        { match: { id: '3', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, selection: '' } },
        { match: { id: '4', date: 'mañana', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: PICK },
        { match: { id: '5', date: '2026-11-16T18:00:00Z', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, tier: '__proto__', source: 'x', holdoutN: 0, marketOdds: 0.5 } },
      ],
      recent: [{ match: { id: '9', date: '2026-11-10T18:00:00Z', status: 'finished', home: { id: 'a', name: 'A' }, away: { id: 'b', name: 'B' } }, pick: { ...PICK, result: 'miss' }, hit: true }],
      track: { holdout: { picks: 10, n: 10, hits: 12, hitRate: 1.2 }, byFamily: [{ family: 'dc', label: 'Doble oportunidad', theme: 'x', n: 0, hitRate: 0.5, thresholds: [{ source: 'mercado', threshold: 0.82 }, { source: 'otro', threshold: 0.8 }] }] },
      rules: null,
      note: 7,
    }) as ConfidenceFile;
    expect(out.picks.map((p) => p.match.id)).toEqual(['1', '5']);
    const odd = out.picks[1].pick;
    expect(odd.tier).toBe('plata');
    expect(odd.source).toBeUndefined();
    expect(odd.holdoutN).toBeUndefined();
    expect(odd.holdoutHitRate).toBeUndefined();
    expect(odd.marketOdds).toBeUndefined();
    expect(out.recent[0].hit).toBe(false); // un fallo nunca se muestra como acierto
    expect(out.track.holdout.n).toBe(0); // aciertos > resueltos y acierto > 1 → registro inválido, no se muestra
    expect(out.track.byFamily[0].hitRate).toBeUndefined();
    expect(out.track.byFamily[0].theme).toBe('goles');
    expect(out.track.byFamily[0].thresholds).toEqual([{ source: 'mercado', threshold: 0.82, goldThreshold: undefined }]);
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
    expect(outOfSample({ holdoutHitRate: 0.711, holdoutN: 38 })).toBe('bajo');
    expect(outOfSample({ holdoutHitRate: 1, holdoutN: 11 })).toBe('sin-validar');
    expect(outOfSample({})).toBe('sin-validar');
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
});
