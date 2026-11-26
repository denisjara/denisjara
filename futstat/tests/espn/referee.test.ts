/**
 * Árbitros: validación al cargar el almacén, conservación al fusionar con el scoreboard, lectura de
 * gameInfo.officials del resumen y de la respuesta de /officials, calendario de reintentos y paso de descarga.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../pipeline/espn/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../pipeline/espn/client')>();
  return { ...orig, getScoreboard: vi.fn(), getStandings: vi.fn(), getSummary: vi.fn(), getOfficials: vi.fn() };
});

import { OFFICIALS_MAX_CHECKS, OFFICIALS_RETRY_DAYS } from '../../pipeline/config';
import { HttpError, getOfficials, getScoreboard, getStandings, getSummary, officialsUrl } from '../../pipeline/espn/client';
import { normalizeSummary, parseOfficialsResponse, pickReferee } from '../../pipeline/espn/normalize';
import { noteEmptyOfficials, officialsDue, refereeIdsByName, updateCompetition, updateOfficials, type FetchOptions } from '../../pipeline/fetch';
import { preMatchView } from '../../pipeline/experiments/types';
import { emptyStore, loadStore, mergeMatches, sanitizeMatchRecord, saveStore } from '../../pipeline/store';
import type { MatchRecord } from '../../pipeline/types';
import { comp } from './helpers';

const NOW = new Date('2026-11-03T12:00:00Z');
const DAY = 86_400_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futstat-ref-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function rec(id: string, date: string, status: MatchRecord['status'] = 'finished', over: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id,
    compId: 'premier',
    season: 2026,
    currentSeason: true,
    date,
    status,
    home: { id: 'h', name: 'Local', short: 'Local', abbr: 'LOC' },
    away: { id: 'a', name: 'Visitante', short: 'Visitante', abbr: 'VIS' },
    ...(status === 'finished' ? { score: { home: 1, away: 0 } } : {}),
    ...over,
  };
}

const OFFICIALS_OK = {
  count: 2,
  items: [
    { id: '9', displayName: 'Asistente Uno', position: { name: 'Assistant Referee' }, order: 2 },
    { id: '4737', fullName: 'Jarred Gillett', displayName: 'Jarred Gillett', position: { name: 'Referee', displayName: 'Referee', id: '1' }, order: 1 },
  ],
};

describe('almacén: referee', () => {
  it('conserva un árbitro válido (nombre recortado y acotado) y la contabilidad', () => {
    const m = sanitizeMatchRecord(
      { ...rec('1', '2026-10-01T15:00:00Z'), referee: { id: '4737', name: '  Jarred   Gillett ' }, refereeChecks: 2, refereeRetryAt: '2026-11-05T00:00:00.000Z' },
      'premier',
    )!;
    expect(m.referee).toEqual({ id: '4737', name: 'Jarred Gillett' });
    expect(m.refereeChecks).toBe(2);
    expect(m.refereeRetryAt).toBe('2026-11-05T00:00:00.000Z');
    const long = sanitizeMatchRecord({ ...rec('1', '2026-10-01T15:00:00Z'), referee: { id: '1', name: 'x'.repeat(500) } }, 'premier')!;
    expect(long.referee!.name.length).toBe(80);
  });

  it('descarta árbitros mal formados sin descartar el partido', () => {
    for (const referee of [{ id: '', name: 'A' }, { id: '1', name: '   ' }, { id: 7, name: 'A' }, { id: '1/../x', name: 'A' }, 'Gillett', null, [{ id: '1', name: 'A' }]]) {
      const m = sanitizeMatchRecord({ ...rec('1', '2026-10-01T15:00:00Z'), referee, refereeChecks: -1, refereeRetryAt: 'mañana' }, 'premier');
      expect(m).toBeDefined();
      expect(m!.referee).toBeUndefined();
      expect(m!.refereeChecks).toBeUndefined();
      expect(m!.refereeRetryAt).toBeUndefined();
    }
  });

  it('mergeOne conserva árbitro y contabilidad cuando el scoreboard no los trae', () => {
    const prev = rec('1', '2026-11-04T15:00:00Z', 'scheduled', { referee: { id: '4737', name: 'Jarred Gillett' } });
    const prevFin = rec('2', '2026-10-01T15:00:00Z', 'finished', { refereeChecks: 3, refereeRetryAt: '2026-11-10T00:00:00Z', summaryFetched: true });
    const out = mergeMatches([prev, prevFin], [rec('1', '2026-11-04T15:00:00Z', 'finished'), rec('2', '2026-10-01T15:00:00Z', 'finished')], { now: NOW });
    const m1 = out.find((m) => m.id === '1')!;
    const m2 = out.find((m) => m.id === '2')!;
    expect(m1.status).toBe('finished');
    expect(m1.referee).toEqual({ id: '4737', name: 'Jarred Gillett' });
    expect(m2.refereeChecks).toBe(3);
    expect(m2.refereeRetryAt).toBe('2026-11-10T00:00:00Z');
  });

  it('un partido aplazado más de un día pierde el árbitro designado', () => {
    const prev = rec('1', '2026-11-04T15:00:00Z', 'scheduled', { referee: { id: '4737', name: 'Jarred Gillett' } });
    const [m] = mergeMatches([prev], [rec('1', '2026-11-12T15:00:00Z', 'scheduled')], { now: NOW });
    expect(m.referee).toBeUndefined();
  });

  it('la vista pre-partido conserva el árbitro y omite la contabilidad', () => {
    const v = preMatchView(rec('1', '2026-10-01T15:00:00Z', 'finished', { referee: { id: '1', name: 'A' }, refereeChecks: 1, refereeRetryAt: '2026-11-10T00:00:00Z' }));
    expect(v.referee).toEqual({ id: '1', name: 'A' });
    expect('refereeChecks' in v).toBe(false);
    expect('refereeRetryAt' in v).toBe(false);
  });
});

describe('lectura de oficiales', () => {
  it('resumen: gameInfo.officials da el árbitro (sin id)', () => {
    const raw = { gameInfo: { venue: {}, officials: [{ fullName: 'Jair Marrufo', displayName: 'Jair Marrufo', position: { name: 'Referee', id: '1' }, order: 1 }] } };
    expect(normalizeSummary(raw, rec('1', '2026-10-01T15:00:00Z')).referee).toEqual({ name: 'Jair Marrufo' });
    expect(normalizeSummary({ gameInfo: { officials: [] } }, rec('1', '2026-10-01T15:00:00Z')).referee).toBeUndefined();
    expect(normalizeSummary({ gameInfo: { officials: 'x' } }, rec('1', '2026-10-01T15:00:00Z')).referee).toBeUndefined();
    expect(normalizeSummary({}, rec('1', '2026-10-01T15:00:00Z')).referee).toBeUndefined();
  });

  it('elige position Referee (exacto) y si no, order 1; limpia el nombre', () => {
    expect(pickReferee(OFFICIALS_OK.items)).toEqual({ id: '4737', name: 'Jarred Gillett' });
    expect(pickReferee([{ id: '5', displayName: 'VAR', position: { name: 'Video Assistant Referee' }, order: 3 }])).toBeUndefined();
    expect(pickReferee([{ id: '6', displayName: 'Sin <b>puesto</b>', order: 1 }])).toEqual({ id: '6', name: 'Sin bpuesto/b' });
    expect(pickReferee([{ id: '6', displayName: '  ', position: { name: 'Referee' } }])).toBeUndefined();
  });

  it('/officials: count 0, mal formada y válida', () => {
    expect(parseOfficialsResponse({ count: 0, pageIndex: 0, items: [] })).toEqual({ kind: 'empty' });
    expect(parseOfficialsResponse({ count: 0 })).toEqual({ kind: 'empty' });
    expect(parseOfficialsResponse({ count: 1, items: [{ displayName: 'Sin id', position: { name: 'Referee' } }] })).toEqual({ kind: 'empty' });
    expect(parseOfficialsResponse(null)).toEqual({ kind: 'invalid' });
    expect(parseOfficialsResponse([])).toEqual({ kind: 'invalid' });
    expect(parseOfficialsResponse({ count: 1, items: 'x' })).toEqual({ kind: 'invalid' });
    expect(parseOfficialsResponse({ error: 'x' })).toEqual({ kind: 'invalid' });
    expect(parseOfficialsResponse(OFFICIALS_OK)).toEqual({ kind: 'referee', referee: { id: '4737', name: 'Jarred Gillett' } });
  });

  it('URL del endpoint core (host permitido) y ids validados', () => {
    expect(officialsUrl('eng.1', '401879295')).toBe(
      'https://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.1/events/401879295/competitions/401879295/officials',
    );
    expect(() => officialsUrl('eng.1', '1/../x')).toThrow();
  });

  it('índice nombre → id: ignora nombres ambiguos', () => {
    const idx = refereeIdsByName([
      rec('1', '2026-10-01T15:00:00Z', 'finished', { referee: { id: '1', name: 'Ana Pérez' } }),
      rec('2', '2026-10-02T15:00:00Z', 'finished', { referee: { id: '2', name: 'Luis Gil' } }),
      rec('3', '2026-10-03T15:00:00Z', 'finished', { referee: { id: '3', name: 'luis gil' } }),
    ]);
    expect(idx.get('ana pérez')).toBe('1');
    expect(idx.get('luis gil')).toBeNull();
  });
});

describe('calendario de reintentos', () => {
  const now = NOW.getTime();

  it('programados: solo dentro de las 72 h siguientes, sin espera', () => {
    expect(officialsDue(rec('1', new Date(now + 10 * 3_600_000).toISOString(), 'scheduled'), now)).toBe('scheduled');
    expect(officialsDue(rec('1', new Date(now + 80 * 3_600_000).toISOString(), 'scheduled'), now)).toBeUndefined();
    expect(officialsDue(rec('1', new Date(now - 3_600_000).toISOString(), 'scheduled'), now)).toBeUndefined();
    expect(officialsDue(rec('1', new Date(now + 3_600_000).toISOString(), 'scheduled', { refereeRetryAt: new Date(now + DAY).toISOString() }), now)).toBe('scheduled');
    expect(officialsDue(rec('1', new Date(now + 3_600_000).toISOString(), 'scheduled', { referee: { id: '1', name: 'A' } }), now)).toBeUndefined();
  });

  it('terminados: desde 2025, sin árbitro, espera creciente y máximo de consultas', () => {
    expect(officialsDue(rec('1', '2024-12-31T15:00:00Z'), now)).toBeUndefined();
    expect(officialsDue(rec('1', '2025-01-02T15:00:00Z'), now)).toBe('finished'); // antiguo: una consulta
    expect(officialsDue(rec('1', '2025-01-02T15:00:00Z', 'finished', { refereeChecks: 1 }), now)).toBeUndefined();
    expect(officialsDue(rec('1', '2026-10-01T15:00:00Z', 'live'), now)).toBeUndefined();

    const m = rec('1', new Date(now - 2 * DAY).toISOString());
    let t = now;
    const waits: number[] = [];
    for (let i = 0; i < OFFICIALS_MAX_CHECKS; i++) {
      expect(officialsDue(m, t)).toBe('finished');
      noteEmptyOfficials(m, t);
      if (m.refereeRetryAt) {
        const next = Date.parse(m.refereeRetryAt);
        waits.push(Math.round((next - t) / DAY));
        expect(officialsDue(m, next - 1)).toBeUndefined();
        t = next;
      }
    }
    expect(waits).toEqual(OFFICIALS_RETRY_DAYS);
    expect(m.refereeChecks).toBe(OFFICIALS_MAX_CHECKS);
    expect(m.refereeRetryAt).toBeUndefined();
    expect(officialsDue(m, t + 365 * DAY)).toBeUndefined();
  });

  it('pasados 120 días desde el partido no se repite una consulta vacía', () => {
    const m = rec('1', new Date(now - 119 * DAY).toISOString(), 'finished', { refereeChecks: 2 });
    expect(officialsDue(m, now)).toBe('finished');
    expect(officialsDue(m, now + 2 * DAY)).toBeUndefined();
  });
});

describe('paso de descarga', () => {
  const sb = vi.mocked(getScoreboard);
  const st = vi.mocked(getStandings);
  const su = vi.mocked(getSummary);
  const go = vi.mocked(getOfficials);
  const opts = (over: Partial<FetchOptions> = {}): FetchOptions => ({ summaries: false, maxSummaries: Infinity, now: NOW, storeDir: dir, officials: true, ...over });

  beforeEach(() => {
    for (const f of [sb, st, su, go]) f.mockReset();
    st.mockResolvedValue({ children: [] });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  });

  it('rellena terminados (más recientes primero, con límite) y programados próximos; las vacías esperan', async () => {
    const s = emptyStore('premier');
    s.matches = [
      rec('10', '2026-10-30T15:00:00Z'),
      rec('11', '2026-10-31T15:00:00Z'),
      rec('12', '2026-11-01T15:00:00Z'),
      rec('20', '2026-11-04T15:00:00Z', 'scheduled'),
      rec('21', '2026-11-20T15:00:00Z', 'scheduled'),
    ];
    go.mockImplementation(async (_slug, id) => (id === '12' ? OFFICIALS_OK : id === '11' ? Promise.reject(new HttpError(404, 'x')) : { count: 0, items: [] }));
    const budget = { left: 2 };
    const r = await updateOfficials(comp('premier'), s, opts({ officialsBudget: budget }));
    expect(go.mock.calls.map((c) => c[1]).sort()).toEqual(['11', '12', '20']);
    expect(budget.left).toBe(0);
    expect(r).toMatchObject({ checked: 3, found: 1, failed: 0 });
    const by = new Map(s.matches.map((m) => [m.id, m]));
    expect(by.get('12')!.referee).toEqual({ id: '4737', name: 'Jarred Gillett' });
    expect(by.get('11')!.refereeChecks).toBe(1);
    expect(by.get('20')!.refereeChecks).toBeUndefined(); // programado: sin espera ni contador
    expect(by.get('10')!.refereeChecks).toBeUndefined(); // fuera del límite de esta ejecución
  });

  it('un error de red nunca hace fallar la competición ni cuenta como consulta vacía', async () => {
    sb.mockResolvedValue({ leagues: [], events: [] });
    const s = emptyStore('premier');
    s.matches = [rec('10', '2026-10-30T15:00:00Z')];
    saveStore(s, dir);
    go.mockRejectedValue(new Error('ECONNRESET'));
    const r = await updateCompetition(comp('premier'), opts());
    expect(r.ok).toBe(true);
    expect(r.officialsChecked).toBe(0);
    const m = loadStore('premier', dir, { warn: () => {} }).matches.find((x) => x.id === '10')!;
    expect(m.refereeChecks).toBeUndefined();
  });

  it('sin `officials` (por defecto) no se consulta /officials', async () => {
    sb.mockResolvedValue({ leagues: [], events: [] });
    const s = emptyStore('premier');
    s.matches = [rec('10', '2026-10-30T15:00:00Z')];
    saveStore(s, dir);
    await updateCompetition(comp('premier'), opts({ officials: undefined }));
    expect(go).not.toHaveBeenCalled();
  });

  it('el árbitro del resumen se guarda con el id conocido por nombre; si no, lo busca /officials', async () => {
    const s = emptyStore('premier');
    s.league = { seasonYear: 2026, seasonEnd: '2026-12-31T00:00:00Z' };
    s.matches = [rec('1', '2026-09-01T15:00:00Z', 'finished', { summaryFetched: true, referee: { id: '4737', name: 'Jarred Gillett' } })];
    saveStore(s, dir);
    const ev = (id: string) => ({
      id,
      date: '2026-11-01T15:00:00Z',
      season: { year: 2026 },
      competitions: [
        {
          status: { type: { state: 'post', name: 'STATUS_FULL_TIME', completed: true } },
          competitors: [
            { homeAway: 'home', score: '1', team: { id: 'h', displayName: 'Local' } },
            { homeAway: 'away', score: '0', team: { id: 'a', displayName: 'Visitante' } },
          ],
        },
      ],
    });
    sb.mockResolvedValue({ leagues: [], events: [ev('2'), ev('3')] });
    su.mockImplementation(async (_slug, id) => ({
      gameInfo: { officials: [{ displayName: id === '2' ? 'Jarred Gillett' : 'Nuevo Árbitro', position: { name: 'Referee' }, order: 1 }] },
    }));
    go.mockResolvedValue({ count: 1, items: [{ id: '999', displayName: 'Nuevo Árbitro', position: { name: 'Referee' }, order: 1 }] });
    await updateCompetition(comp('premier'), opts({ summaries: true }));
    const by = new Map(loadStore('premier', dir, { warn: () => {} }).matches.map((m) => [m.id, m]));
    expect(by.get('2')!.referee).toEqual({ id: '4737', name: 'Jarred Gillett' });
    expect(by.get('3')!.referee).toEqual({ id: '999', name: 'Nuevo Árbitro' });
    expect(go.mock.calls.map((c) => c[1])).toEqual(['3']);
  });
});
