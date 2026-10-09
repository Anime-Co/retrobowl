// News feed of short headlines (league results, streaks, injuries, signings, records).
// Stored in save.feed, newest last, capped at NEWS.feedMax.

import { NEWS } from './config.js';
import { newId } from './state.js';

/**
 * @param {import('../types.js').Save} save
 * @param {string} text
 * @param {'result'|'league'|'streak'|'injury'|'signing'|'record'|'team'|'draft'|'award'|'staff'} [tag]
 */
export function addHeadline(save, text, tag = 'league') {
  if (!Array.isArray(save.feed)) save.feed = [];
  const item = { id: newId(save, 'h'), year: save.season.year, week: save.season.week, text, tag };
  save.feed.push(item);
  if (save.feed.length > NEWS.feedMax) save.feed.splice(0, save.feed.length - NEWS.feedMax);
  return item;
}

/** Newest-first headlines, optionally limited. */
export function headlines(save, limit = 30) {
  return (save.feed || []).slice(-limit).reverse();
}
