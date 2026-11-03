/**
 * Guard against impossible bookmaker prices (feed errors), shared by normalize (fresh ESPN data), store (records
 * loaded from data-store, possibly saved by an older version) and publish (defence in depth).
 *
 * A 1X2 trio, the opening 1X2 trio or the over/under pair whose overround falls outside
 * [ODDS_MARGIN_MIN, ODDS_MARGIN_MAX] is removed; the other markets of the snapshot are kept. One bad external price
 * must neither feed the ensemble (market weight 0.8) nor make the validator reject the whole publication.
 */
import { isPlausibleMargin, overroundOf } from './config';
import type { OddsSnapshot } from '../src/types/data';

export type OddsGroup = '1x2' | '1x2-open' | 'ou';

/** Mutates `s`; returns the groups removed (empty when everything is plausible). */
export function stripImplausibleOdds(s: OddsSnapshot): OddsGroup[] {
  const dropped: OddsGroup[] = [];
  const m1x2 = overroundOf(s.home, s.draw, s.away);
  if (m1x2 !== undefined && !isPlausibleMargin(m1x2)) {
    delete s.home;
    delete s.draw;
    delete s.away;
    delete s.margin;
    dropped.push('1x2');
  }
  const mOpen = overroundOf(s.homeOpen, s.drawOpen, s.awayOpen);
  if (mOpen !== undefined && !isPlausibleMargin(mOpen)) {
    delete s.homeOpen;
    delete s.drawOpen;
    delete s.awayOpen;
    dropped.push('1x2-open');
  }
  const mOu = overroundOf(s.over, s.under);
  if (mOu !== undefined && !isPlausibleMargin(mOu)) {
    delete s.over;
    delete s.under;
    delete s.overOpen;
    delete s.underOpen;
    delete s.totalLine;
    dropped.push('ou');
  }
  if (s.margin !== undefined && !isPlausibleMargin(s.margin)) delete s.margin;
  return dropped;
}

/** true when the snapshot still carries at least one price. */
export function hasAnyPrice(s: OddsSnapshot): boolean {
  return [s.home, s.draw, s.away, s.homeOpen, s.drawOpen, s.awayOpen, s.over, s.under, s.overOpen, s.underOpen, s.spreadHome, s.spreadAway].some(
    (v) => typeof v === 'number' && Number.isFinite(v) && v > 1,
  );
}
