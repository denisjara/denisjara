/**
 * American -> decimal odds conversion (private helper of normalize.ts), exercised through the
 * public normalizers with a minimal synthetic payload shaped like ESPN's.
 */
import { describe, expect, it } from 'vitest';
import { normalizeScoreboard, normalizeSummary, oddsFromScoreboard } from '../../pipeline/espn/normalize';
import { NOW, comp } from './helpers';

function scheduledEvent(odds: unknown[]) {
  return {
    leagues: [{ name: 'Test', season: { year: 2026, displayName: '2026-27 Test' } }],
    events: [
      {
        id: '1',
        date: '2026-11-10T20:00Z',
        season: { year: 2026, slug: '2026-27-test' },
        competitions: [
          {
            status: { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false } },
            competitors: [
              { homeAway: 'home', team: { id: '10', displayName: 'Local FC', abbreviation: 'LOC' } },
              { homeAway: 'away', team: { id: '20', displayName: 'Visitante CF', abbreviation: 'VIS' } },
            ],
            odds,
          },
        ],
      },
    ],
  };
}

const ml = (home: string, draw: string, away: string) => ({
  provider: { name: 'DraftKings' },
  moneyline: { home: { close: { odds: home } }, draw: { close: { odds: draw } }, away: { close: { odds: away } } },
});

function oddsOf(odds: unknown[]) {
  return normalizeScoreboard(scheduledEvent(odds), comp('laliga'), { now: NOW }).matches[0].odds;
}

describe('American -> decimal odds', () => {
  it('positive, negative and EVEN prices', () => {
    const o = oddsOf([ml('+105', '-140', 'EVEN')]);
    expect(o?.home).toBe(2.05);
    expect(o?.draw).toBe(1.714);
    expect(o?.away).toBe(2);
    expect(o?.margin).toBeCloseTo(1 / 2.05 + 1 / 1.714 + 1 / 2 - 1, 3);
    expect(o?.provider).toBe('DraftKings');
  });

  it('extreme prices', () => {
    const o = oddsOf([ml('-1000', '+1200', '+2500')]);
    expect(o).toMatchObject({ home: 1.1, draw: 13, away: 26 });
  });

  it('invalid prices are dropped (and margin needs all three)', () => {
    const o = oddsOf([ml('+150', 'OFF', '+50')]);
    expect(o?.home).toBe(2.5);
    expect(o?.draw).toBeUndefined();
    expect(o?.away).toBeUndefined(); // |ml| < 100 is not a valid American price
    expect(o?.margin).toBeUndefined();
  });

  it('numeric pickcenter fields (closing odds of a finished match)', () => {
    const match = normalizeScoreboard(scheduledEvent([]), comp('laliga')).matches[0];
    const res = normalizeSummary(
      {
        pickcenter: [
          {
            provider: { name: 'DraftKings' },
            overUnder: 2.5,
            spread: -0.5,
            overOdds: -120,
            underOdds: 100,
            homeTeamOdds: { moneyLine: -245, spreadOdds: 110 },
            awayTeamOdds: { moneyLine: 550, spreadOdds: -135 },
            drawOdds: { moneyLine: 450 },
          },
        ],
      },
      match,
    );
    expect(res.closingOdds).toMatchObject({
      provider: 'DraftKings',
      home: 1.408,
      draw: 5.5,
      away: 6.5,
      totalLine: 2.5,
      over: 1.833,
      under: 2,
      spreadLine: -0.5,
      spreadHome: 2.1,
      spreadAway: 1.741,
    });
  });

  it('null odds entries and empty lists', () => {
    expect(oddsOf([null])).toBeUndefined();
    expect(oddsOf([])).toBeUndefined();
    expect(oddsFromScoreboard(undefined, '2026-11-03T12:00:00Z')).toBeUndefined();
  });

  it('total line parsed from "o2.5"/"u2.5" and opening total only for the same line', () => {
    const o = oddsOf([
      {
        provider: { name: 'DraftKings' },
        total: {
          over: { open: { line: 'o3.5', odds: '+120' }, close: { line: 'o2.5', odds: '-110' } },
          under: { open: { line: 'u2.5', odds: '-105' }, close: { line: 'u2.5', odds: '-110' } },
        },
      },
    ]);
    expect(o).toMatchObject({ totalLine: 2.5, over: 1.909, under: 1.909, underOpen: 1.952 });
    expect(o?.overOpen).toBeUndefined();
  });
});
