import { describe, expect, it } from 'vitest';
import { isNeutralRound, normalizeScoreboard, parseMinute, roundLabel } from '../../pipeline/espn/normalize';
import { NOW, comp, fixture } from './helpers';

const laliga = normalizeScoreboard(fixture('scoreboard-laliga-2026.json'), comp('laliga'), { now: NOW });
const byId = (id: string) => {
  const m = laliga.matches.find((x) => x.id === id);
  if (!m) throw new Error(`no match ${id}`);
  return m;
};

describe('normalizeScoreboard · LaLiga 2026', () => {
  it('extracts league info', () => {
    expect(laliga.league).toEqual({
      name: 'Spanish LALIGA',
      logo: 'https://a.espncdn.com/i/leaguelogos/soccer/500/15.png',
      logoDark: 'https://a.espncdn.com/i/leaguelogos/soccer/500-dark/15.png',
      seasonYear: 2026,
      seasonLabel: '2026-27',
      seasonStart: '2026-06-01T04:00:00Z',
      seasonEnd: '2027-06-01T03:59:00Z',
    });
    expect(laliga.matches).toHaveLength(5);
    // sorted chronologically
    const dates = laliga.matches.map((m) => m.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('normalizes a finished match (Betis 2-5 Barcelona)', () => {
    const m = byId('401882846');
    expect(m).toMatchObject({
      compId: 'laliga',
      season: 2026,
      currentSeason: true,
      date: '2026-10-17T16:30:00Z',
      status: 'finished',
      statusDetail: 'Final',
      venue: 'Estadio La Cartuja',
      home: { id: '244', name: 'Real Betis', short: 'Betis', abbr: 'BET', color: '288a00' },
      away: { id: '83', name: 'Barcelona', short: 'Barcelona', abbr: 'BAR', color: '990000' },
      score: { home: 2, away: 5, htHome: 1, htAway: 2 },
    });
    expect(m.home.logo).toBe('https://a.espncdn.com/i/teamlogos/soccer/500/244.png');
    expect(m.stats).toEqual({
      home: { goals: 2, shots: 6, shotsOnTarget: 5, corners: 2, fouls: 10, possession: 30.7, yellow: 4, red: 1 },
      away: { goals: 5, shots: 18, shotsOnTarget: 10, corners: 5, fouls: 11, possession: 69.3, yellow: 2, red: 0 },
    });
    // finished matches do not store the (current, not historical) form string
    expect(m.homeForm).toBeUndefined();
    expect(m.odds).toBeUndefined();
    const goals = m.events!.filter((e) => e.type === 'goal');
    expect(goals).toHaveLength(7);
    expect(goals[0]).toEqual({ minute: 10, clock: "10'", type: 'goal', teamId: '83', playerId: '362150', player: 'Lamine Yamal' });
    const red = m.events!.find((e) => e.type === 'red');
    expect(red).toMatchObject({ minute: 54, teamId: '244', playerId: '359912' });
  });

  it('handles own goals (credited to the benefiting team), penalties and stoppage-time minutes', () => {
    const m = byId('401882855'); // Betis 5-2 Osasuna
    expect(m.score).toEqual({ home: 5, away: 2, htHome: 2, htAway: 0 });
    const og = m.events!.find((e) => e.type === 'own-goal');
    expect(og).toMatchObject({ minute: 48, teamId: '244', player: 'Ante Budimir' });
    expect(m.events!.filter((e) => e.type === 'penalty')).toHaveLength(1);
    const late = m.events!.find((e) => e.clock === "90'+6'" && e.type === 'goal');
    expect(late?.minute).toBe(90);
    const ht = m.events!.find((e) => e.clock === "45'+2'");
    expect(ht).toMatchObject({ minute: 45, type: 'yellow' });
    expect(m.stats?.home.yellow).toBe(2);
    expect(m.stats?.away.yellow).toBe(5);
  });

  it('converts DraftKings American odds of a scheduled match', () => {
    const m = byId('401882809'); // Sevilla - Alavés
    expect(m.status).toBe('scheduled');
    expect(m.statusDetail).toBeUndefined();
    expect(m.score).toBeUndefined();
    expect(m.odds).toEqual({
      provider: 'DraftKings',
      home: 1.952, // -105
      draw: 3.4, // +240
      away: 4, // +300
      homeOpen: 2.05, // +105
      drawOpen: 3.25, // +225
      awayOpen: 3.7, // +270
      totalLine: 2.5,
      over: 2.15, // +115
      under: 1.667, // -150
      overOpen: 2.15,
      underOpen: 1.625, // -160
      spreadLine: -0.5,
      spreadHome: 1.87, // -115
      spreadAway: 1.8, // -125
      margin: expect.closeTo(1 / 1.952 + 1 / 3.4 + 1 / 4 - 1, 3),
      capturedAt: '2026-11-03T12:00:00Z',
    });
    // ESPN form is most-recent-first ("LWWLD"); we store it chronologically
    expect(m.homeForm).toBe('DLWWL');
    expect(m.awayForm).toBe('DLLDL');
  });

  it('scheduled match without odds has no odds snapshot', () => {
    const m = byId('401882805');
    expect(m.status).toBe('scheduled');
    expect(m.odds).toBeUndefined();
  });

  it('maps an abandoned match to cancelled without score', () => {
    const m = byId('401882849');
    expect(m.status).toBe('cancelled');
    expect(m.statusDetail).toBe('Suspendido');
    expect(m.score).toBeUndefined();
    expect(m.stats).toBeUndefined();
  });

  it('currentSeason follows the given current season year', () => {
    const r = normalizeScoreboard(fixture('scoreboard-laliga-2026.json'), comp('laliga'), { currentSeasonYear: 2025 });
    expect(r.matches.every((m) => m.currentSeason === false)).toBe(true);
  });
});

describe('normalizeScoreboard · cups', () => {
  const cdr = normalizeScoreboard(fixture('scoreboard-copadelrey-2026.json'), comp('copadelrey'), { now: NOW });
  const get = (id: string) => cdr.matches.find((m) => m.id === id)!;

  it('penalty shoot-out, round label and missing team stats', () => {
    const m = get('401928509');
    expect(m.statusDetail).toBe('Final (penaltis)');
    expect(m.round).toBe('Primera ronda');
    expect(m.score).toEqual({ home: 3, away: 3, penHome: 2, penAway: 4, htHome: 2, htAway: 0 });
    // no stats coverage, but cards are known from the details
    expect(m.stats).toEqual({ home: { goals: 3, yellow: 6, red: 0 }, away: { goals: 3, yellow: 4, red: 0 } });
    // extra-time goal minutes are kept (shoot-out kicks are not events)
    expect(m.events!.filter((e) => e.type === 'goal' || e.type === 'penalty')).toHaveLength(6);
  });

  it('extra time and two-legged ties', () => {
    expect(get('401928495').statusDetail).toBe('Final (prórroga)');
    expect(get('401918761').round).toBe('Ronda previa · Vuelta');
    // 3-3 without any detail: HT unknown, no stats
    const m = get('401918758');
    expect(m.score).toEqual({ home: 3, away: 3 });
    expect(m.stats).toBeUndefined();
  });

  it('shoot-out kicks are excluded from events (Carabao Cup)', () => {
    const { matches } = normalizeScoreboard(fixture('scoreboard-carabao-2026.json'), comp('carabao'));
    const m = matches[0];
    expect(m.round).toBe('Ronda preliminar');
    expect(m.score).toEqual({ home: 2, away: 2, penHome: 1, penAway: 2, htHome: 1, htAway: 1 });
    expect(m.events!.filter((e) => e.type === 'goal' || e.type === 'penalty')).toHaveLength(4);
  });

  it('falls back to Bet 365 decimal 1X2 odds when DraftKings is absent', () => {
    const { matches } = normalizeScoreboard(fixture('scoreboard-premier-2026.json'), comp('premier'), { now: NOW });
    const m = matches.find((x) => x.id === '401879233')!;
    expect(m.odds).toEqual({
      provider: 'Bet 365',
      home: 1.444,
      draw: 4.75,
      away: 6.25,
      margin: expect.closeTo(1 / 1.444 + 1 / 4.75 + 1 / 6.25 - 1, 3),
      capturedAt: '2026-11-03T12:00:00Z',
    });
  });
});

describe('helpers', () => {
  it('parseMinute', () => {
    expect(parseMinute("45'+2'")).toBe(45);
    expect(parseMinute("90'")).toBe(90);
    expect(parseMinute("120'+1'")).toBe(120);
    expect(parseMinute('', 555)).toBe(10);
    expect(parseMinute(undefined)).toBe(0);
  });

  it('isNeutralRound: single-match finals are neutral, two-legged ties and league games are not', () => {
    const cup = { kind: 'cup' as const };
    const league = { kind: 'league' as const };
    expect(isNeutralRound('Final', cup)).toBe(true);
    expect(isNeutralRound('Final', { kind: 'continental' })).toBe(true);
    expect(isNeutralRound('Semifinales · Ida', cup)).toBe(false);
    expect(isNeutralRound('Playoff de ascenso · Final', league)).toBe(true);
    expect(isNeutralRound('Playoff de ascenso · Final · Vuelta', league)).toBe(false);
    expect(isNeutralRound('Apertura · Final', league)).toBe(true);
    expect(isNeutralRound('Clausura 2025 · Final · Ida', league)).toBe(false);
    expect(isNeutralRound('Playoffs Conferencia Este · Final', league)).toBe(false);
    expect(isNeutralRound(undefined, cup)).toBe(false);
  });

  it('roundLabel translates ESPN season slugs and notes', () => {
    expect(roundLabel('2026-27-laliga', {})).toBeUndefined();
    expect(roundLabel('regular-season', {})).toBeUndefined();
    expect(roundLabel('round-of-16', { notes: [{ headline: '1st Leg' }] })).toBe('Octavos de final · Ida');
    expect(roundLabel('league-phase', { altGameNote: 'UEFA Champions League, League Phase' })).toBe('Fase de liga');
    expect(roundLabel('group-stage', { altGameNote: 'CONMEBOL Sudamericana, Group H' })).toBe('Fase de grupos · Grupo H');
    expect(roundLabel('apertura---quarterfinals', {})).toBe('Apertura · Cuartos de final');
    expect(roundLabel('torneo-clausura', {})).toBe('Clausura');
  });
});
