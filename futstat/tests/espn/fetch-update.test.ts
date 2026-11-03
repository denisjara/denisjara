/**
 * updateCompetition con el cliente de ESPN simulado: años a descargar (temporadas Ago→May), respuestas incompletas
 * que no deben borrar datos guardados, guardia de disco y presupuesto de tiempo para los resúmenes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../pipeline/espn/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../pipeline/espn/client')>();
  return { ...orig, getScoreboard: vi.fn(), getStandings: vi.fn(), getSummary: vi.fn() };
});

import { CircuitOpenError, getScoreboard, getStandings, getSummary } from '../../pipeline/espn/client';
import { EMPTY_SUMMARY_MAX_ATTEMPTS, seasonEndsAfterYear, updateCompetition, yearsToFetch, type FetchOptions } from '../../pipeline/fetch';
import { emptyStore, loadStore, saveStore } from '../../pipeline/store';
import type { MatchRecord } from '../../pipeline/types';
import { comp } from './helpers';

const NOW = new Date('2026-11-03T12:00:00Z');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futstat-fetch-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const sb = vi.mocked(getScoreboard);
const st = vi.mocked(getStandings);
const su = vi.mocked(getSummary);

const LEAGUE = { season: { year: 2026, startDate: '2026-06-01T04:00Z', endDate: '2027-06-01T03:59Z', displayName: '2026-27 English Premier League' } };

function rawEvent(id: string, date: string, state: 'pre' | 'post' = 'pre') {
  return {
    id,
    date,
    season: { year: 2026, slug: '2026-27-english-premier-league' },
    competitions: [
      {
        status: { type: { state, name: state === 'post' ? 'STATUS_FULL_TIME' : 'STATUS_SCHEDULED', completed: state === 'post' } },
        competitors: [
          { homeAway: 'home', score: '1', team: { id: `h${id}`, displayName: `Local ${id}` } },
          { homeAway: 'away', score: '0', team: { id: `a${id}`, displayName: `Visitante ${id}` } },
        ],
      },
    ],
  };
}

const board = (events: unknown[]) => ({ leagues: [LEAGUE], events });

function scheduled(n: number, from = 0): ReturnType<typeof rawEvent>[] {
  return Array.from({ length: n }, (_, i) => rawEvent(String(5000 + from + i), new Date(Date.parse('2026-11-20T15:00:00Z') + (from + i) * 3_600_000).toISOString()));
}

function opts(over: Partial<FetchOptions> = {}): FetchOptions {
  return { summaries: true, maxSummaries: Infinity, now: NOW, storeDir: dir, ...over };
}

beforeEach(() => {
  sb.mockReset();
  st.mockReset();
  su.mockReset();
  st.mockResolvedValue({ children: [] });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
});

describe('años a descargar', () => {
  it('Ago→May: si la temporada termina el año siguiente también se descarga ese año', () => {
    expect(yearsToFetch(NOW)).toEqual([2025, 2026]);
    expect(yearsToFetch(NOW, '2027-06-01T03:59:00Z')).toEqual([2025, 2026, 2027]);
    // año natural (MLS, Libertadores: fin "2027-01-01T04:59Z" por la zona horaria) → no
    expect(yearsToFetch(NOW, '2026-12-31T04:59:00Z')).toEqual([2025, 2026]);
    expect(seasonEndsAfterYear('2027-01-01T04:59:00Z', 2026)).toBe(false);
    expect(seasonEndsAfterYear('2027-05-30T00:00:00Z', 2026)).toBe(true);
    expect(seasonEndsAfterYear(undefined, 2026)).toBe(false);
    expect(yearsToFetch(new Date('2027-02-01T00:00:00Z'), '2027-06-01T03:59:00Z')).toEqual([2026, 2027]);
  });

  it('con la temporada guardada pide 2025, 2026 y 2027 a la vez', async () => {
    const s = emptyStore('premier');
    s.league = { seasonYear: 2026, seasonStart: '2026-06-01T04:00:00Z', seasonEnd: '2027-06-01T03:59:00Z' };
    saveStore(s, dir);
    sb.mockImplementation(async (_slug, y) => board(Number(y) === 2027 ? [rawEvent('7001', '2027-01-02T15:00:00Z')] : []));
    const r = await updateCompetition(comp('premier'), opts({ summaries: false }));
    expect(sb.mock.calls.map((c) => Number(c[1])).sort()).toEqual([2025, 2026, 2027]);
    expect(r.ok).toBe(true);
    const back = loadStore('premier', dir, { warn: () => {} });
    expect(back.matches.find((m) => m.id === '7001')?.currentSeason).toBe(true);
  });

  it('primera ejecución (sin temporada guardada): descubre que termina en 2027 y pide ese año', async () => {
    sb.mockImplementation(async () => board([]));
    await updateCompetition(comp('premier'), opts({ summaries: false }));
    expect(sb.mock.calls.map((c) => Number(c[1]))).toEqual([2025, 2026, 2027]);
  });
});

describe('respuestas incompletas no borran datos guardados', () => {
  function seedStore(n: number) {
    const s = emptyStore('premier');
    s.league = { seasonYear: 2026, seasonEnd: '2026-12-31T00:00:00Z' };
    s.standings = [{ name: 'Premier', rows: [{ rank: 1, team: { id: '1', name: 'A', short: 'A', abbr: 'A' }, played: 1, won: 1, drawn: 0, lost: 0, gf: 1, ga: 0, gd: 1, points: 3 }] }];
    s.matches = scheduled(n).map(
      (e): MatchRecord => ({
        id: e.id,
        compId: 'premier',
        season: 2026,
        currentSeason: true,
        date: e.date,
        status: 'scheduled',
        home: { id: `h${e.id}`, name: 'L', short: 'L', abbr: 'L' },
        away: { id: `a${e.id}`, name: 'V', short: 'V', abbr: 'V' },
      }),
    );
    saveStore(s, dir);
  }

  it('un año que llega vacío conserva sus partidos y la clasificación vacía no pisa la anterior', async () => {
    seedStore(30);
    sb.mockImplementation(async () => board([]));
    st.mockResolvedValue({ children: [] });
    await updateCompetition(comp('premier'), opts({ summaries: false }));
    const back = loadStore('premier', dir, { warn: () => {} });
    expect(back.matches).toHaveLength(30);
    expect(back.standings).toHaveLength(1);
  });

  it('si desaparecen muchos partidos a la vez se conservan; si son pocos, se eliminan', async () => {
    seedStore(30);
    sb.mockImplementation(async (_s, y) => board(Number(y) === 2026 ? scheduled(5) : []));
    await updateCompetition(comp('premier'), opts({ summaries: false }));
    expect(loadStore('premier', dir, { warn: () => {} }).matches).toHaveLength(30);
    sb.mockImplementation(async (_s, y) => board(Number(y) === 2026 ? scheduled(28) : []));
    await updateCompetition(comp('premier'), opts({ summaries: false }));
    expect(loadStore('premier', dir, { warn: () => {} }).matches).toHaveLength(28);
  });

  it('si fallan todos los scoreboards la competición falla sin tocar el almacén', async () => {
    seedStore(3);
    const before = fs.readFileSync(path.join(dir, 'premier.json'), 'utf8');
    sb.mockRejectedValue(new Error('fetch failed'));
    await expect(updateCompetition(comp('premier'), opts())).rejects.toThrow(/ningún scoreboard/);
    expect(fs.readFileSync(path.join(dir, 'premier.json'), 'utf8')).toBe(before);
  });
});

describe('resúmenes: guardia de disco y presupuesto de tiempo', () => {
  const finished = () => board([rawEvent('8001', '2026-11-01T15:00:00Z', 'post'), rawEvent('8002', '2026-11-02T15:00:00Z', 'post')]);

  it('si data-store supera el límite no se descargan resúmenes', async () => {
    sb.mockImplementation(async () => finished());
    su.mockResolvedValue({});
    saveStore(emptyStore('premier'), dir);
    await updateCompetition(comp('premier'), opts({ maxStoreBytes: 10 }));
    expect(su).not.toHaveBeenCalled();
  });

  it('con el tiempo agotado los resúmenes se aplazan', async () => {
    sb.mockImplementation(async () => finished());
    su.mockResolvedValue({});
    const r = await updateCompetition(comp('premier'), opts({ deadline: Date.now() - 1 }));
    expect(su).not.toHaveBeenCalled();
    expect(r.summariesSkipped).toBe(2);
  });

  it('PIPE-02: con el circuito de resúmenes abierto, lo pendiente se aplaza (no cuenta como fallido)', async () => {
    sb.mockImplementation(async () => finished());
    su.mockRejectedValue(new CircuitOpenError('https://site.api.espn.com/x', 'summary'));
    const r = await updateCompetition(comp('premier'), opts());
    expect(r.summariesFailed).toBe(0);
    expect(r.summariesSkipped).toBe(2);
  });

  it('PIPE-07: un resumen vacío ({} con 200) no marca el partido como descargado para siempre', async () => {
    sb.mockImplementation(async () => board([rawEvent('8101', '2026-10-20T15:00:00Z', 'post')])); // 14 días
    su.mockResolvedValue({});
    await updateCompetition(comp('premier'), opts());
    let m = loadStore('premier', dir, { warn: () => {} }).matches.find((x) => x.id === '8101')!;
    expect(m.summaryFetched).toBe(false);
    expect(m.summaryAttempts).toBe(1);
    expect(Date.parse(m.summaryRetryAt!)).toBeGreaterThan(Date.now());
    // en la misma ventana de espera no se reintenta
    su.mockClear();
    await updateCompetition(comp('premier'), opts());
    expect(su).not.toHaveBeenCalled();
    // solo tras EMPTY_SUMMARY_MAX_ATTEMPTS intentos (en ejecuciones distintas) se da por perdido
    for (let i = 1; i < EMPTY_SUMMARY_MAX_ATTEMPTS; i++) {
      const s = loadStore('premier', dir, { warn: () => {} });
      for (const x of s.matches) delete x.summaryRetryAt; // simula que ha pasado la espera
      saveStore(s, dir);
      await updateCompetition(comp('premier'), opts());
    }
    m = loadStore('premier', dir, { warn: () => {} }).matches.find((x) => x.id === '8101')!;
    expect(m.summaryAttempts).toBe(EMPTY_SUMMARY_MAX_ATTEMPTS);
    expect(m.summaryFetched).toBe(true);
  });

  it('sin límites se descargan', async () => {
    sb.mockImplementation(async () => finished());
    su.mockResolvedValue({});
    const r = await updateCompetition(comp('premier'), opts());
    expect(su).toHaveBeenCalledTimes(2);
    expect(r.summariesFetched).toBe(2);
  });
});
