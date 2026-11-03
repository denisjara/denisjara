import { describe, expect, it } from 'vitest';
import { parseArgs, pickCurrentLeague, yearsToFetch } from '../../pipeline/fetch';

describe('fetch CLI helpers', () => {
  it('years to fetch: previous + current, next year only in December', () => {
    expect(yearsToFetch(new Date('2026-11-03T12:00:00Z'))).toEqual([2025, 2026]);
    expect(yearsToFetch(new Date('2026-12-15T12:00:00Z'))).toEqual([2025, 2026, 2027]);
    expect(yearsToFetch(new Date('2027-01-02T12:00:00Z'))).toEqual([2026, 2027]);
  });

  it('current season = latest season that already started', () => {
    const now = new Date('2026-12-15T12:00:00Z');
    const leagues = [
      { seasonYear: 2025, seasonStart: '2025-01-01T10:00:00Z' },
      { seasonYear: 2026, seasonStart: '2026-01-01T10:00:00Z' },
      { seasonYear: 2027, seasonStart: '2027-01-01T10:00:00Z' }, // dates=2027 in December (MLS)
    ];
    expect(pickCurrentLeague(leagues, now)?.seasonYear).toBe(2026);
    expect(pickCurrentLeague([{ seasonYear: 2027, seasonStart: '2027-01-01T00:00:00Z' }], now)?.seasonYear).toBe(2027);
    expect(pickCurrentLeague([], now)).toBeUndefined();
  });

  it('parses flags', () => {
    expect(parseArgs([])).toMatchObject({ summaries: true, maxSummaries: Infinity, help: false });
    expect(parseArgs(['--only=laliga,premier', '--no-summaries', '--max-summaries=5', '--concurrency=3'])).toEqual({
      only: ['laliga', 'premier'],
      summaries: false,
      maxSummaries: 5,
      concurrency: 3,
      help: false,
    });
    expect(() => parseArgs(['--foo'])).toThrow();
  });
});
