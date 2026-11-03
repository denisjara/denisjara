import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPETITION_BY_ID } from '../../pipeline/config';
import type { CompetitionConfig } from '../../pipeline/config';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../fixtures/espn');

export function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

export function comp(id: string): CompetitionConfig {
  const c = COMPETITION_BY_ID.get(id);
  if (!c) throw new Error(`competición desconocida ${id}`);
  return c;
}

/** fixed "now" used across the tests (the fixtures were captured on 2026-11-03) */
export const NOW = new Date('2026-11-03T12:00:00Z');
