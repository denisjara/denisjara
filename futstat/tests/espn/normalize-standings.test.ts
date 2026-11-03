import { describe, expect, it } from 'vitest';
import { normalizeStandings, translateGroupName, translateNote } from '../../pipeline/espn/normalize';
import { fixture } from './helpers';

describe('normalizeStandings', () => {
  it('single-table league: one group named after the competition, rows by rank', () => {
    const groups = normalizeStandings(fixture('standings-laliga.json'), 'LaLiga');
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.name).toBe('LaLiga');
    expect(g.rows).toHaveLength(20);
    expect(g.rows.map((r) => r.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(g.rows[0]).toEqual({
      rank: 1,
      team: { id: '83', name: 'Barcelona', short: 'Barcelona', abbr: 'BAR', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/83.png' },
      played: 11,
      won: 10,
      drawn: 0,
      lost: 1,
      gf: 46,
      ga: 12,
      gd: 34,
      points: 30,
      note: { label: 'Champions League', color: '#81d6ac' },
    });
    // malformed colour "##c6d1e0" is repaired
    expect(g.rows[9].note).toEqual({ label: 'Europa League', color: '#c6d1e0' });
    expect(g.rows[6].note?.label).toBe('Previa de Conference League');
    expect(g.rows.slice(-3).map((r) => r.note?.label)).toEqual(['Descenso', 'Descenso', 'Descenso']);
    expect(g.rows[7].note).toBeUndefined();
    for (const r of g.rows) {
      expect(r.won + r.drawn + r.lost).toBe(r.played);
      expect(r.gf - r.ga).toBe(r.gd);
      expect(r.won * 3 + r.drawn).toBe(r.points);
    }
  });

  it('keeps the source name when no competition name is given', () => {
    expect(normalizeStandings(fixture('standings-laliga.json'))[0].name).toBe('2026-27 LALIGA');
  });

  it('multiple groups (MLS conferences)', () => {
    const groups = normalizeStandings(fixture('standings-mls.json'), 'MLS');
    expect(groups.map((g) => g.name)).toEqual(['Conferencia Este', 'Conferencia Oeste']);
    for (const g of groups) {
      expect(g.rows).toHaveLength(15);
      const ranks = g.rows.map((r) => r.rank);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
    expect(groups[0].rows[0].note?.label).toBe('Playoffs MLS (primera ronda)');
  });

  it('competition without a table', () => {
    expect(normalizeStandings(fixture('standings-copadelrey.json'), 'Copa del Rey')).toEqual([]);
    expect(normalizeStandings(undefined)).toEqual([]);
  });

  it('translations', () => {
    expect(translateGroupName('Group A', 8)).toBe('Grupo A');
    expect(translateGroupName('League Phase', 1, 'UEFA Champions League')).toBe('Fase de liga');
    expect(translateGroupName('2026 Torneo Apertura', 1, 'Liga MX')).toBe('Apertura 2026');
    expect(translateNote('Relegation')).toBe('Descenso');
    expect(translateNote('Promotion playoffs')).toBe('Playoff de ascenso');
    expect(translateNote('Knockout phase playoffs - seeded')).toBe('Playoff eliminatorio (cabeza de serie)');
    expect(translateNote('A, B: Relegation; C: Relegation or playoffs')).toBe('A, B: Descenso; C: Descenso o playoff');
    expect(translateNote('Champions League qualifying')).toBe('Previa de Champions League');
  });
});
