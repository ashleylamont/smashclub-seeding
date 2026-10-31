import { expect, it } from 'vitest';
import { liveEventNights, type PublicEventNight } from '../src/lib/publicEvents';

const NOW = Date.parse('2026-10-31T10:00:00Z');

function event(status: string, overrides: Partial<PublicEventNight> = {}): PublicEventNight {
  return {
    id: status,
    name: `Night ${status}`,
    eventDate: '2026-10-31T08:00:00Z',
    bracketMode: 'native',
    competitionFormat: 'singles',
    drawPaused: false,
    status,
    ...overrides,
  };
}

it('requires the running lifecycle, excluding published preparation, finished and paused events', () => {
  expect(liveEventNights([], NOW)).toEqual([]);
  const states = ['draft', 'roster_frozen', 'pools_ready', 'underway', 'complete', 'cancelled'];
  expect(
    liveEventNights(
      states.map((status) => event(status)),
      NOW,
    ),
  ).toEqual([event('underway')]);
  expect(liveEventNights([event('underway', { drawPaused: true })], NOW)).toEqual([]);
});

it('preserves every simultaneous event and its format instead of picking the first', () => {
  const singles = event('underway', { id: 'singles' });
  const doubles = event('underway', { id: 'doubles', competitionFormat: 'doubles' });
  const published = [singles, event('draft'), doubles, event('complete')];
  expect(liveEventNights(published, NOW)).toEqual([singles, doubles]);
  expect(published).toHaveLength(4);
});

it('opens at the scheduled instant and expires after 24 hours even if never finalized', () => {
  const running = event('underway');
  const start = Date.parse(running.eventDate);
  expect(liveEventNights([running], start - 1)).toEqual([]);
  expect(liveEventNights([running], start)).toEqual([running]);
  expect(liveEventNights([running], start + 86_400_000 - 1)).toEqual([running]);
  expect(liveEventNights([running], start + 86_400_000)).toEqual([]);
  expect(liveEventNights([event('underway', { eventDate: 'invalid' })], NOW)).toEqual([]);
});

it('uses ISO instants across Sydney midnight and the daylight-saving clock change', () => {
  const evening = event('underway', { eventDate: '2026-10-03T23:00:00+10:00' });
  const utc = { ...evening, eventDate: '2026-10-03T13:00:00Z' };
  // The next local morning is already a different calendar date and UTC offset.
  const morning = Date.parse('2026-10-04T04:00:00+11:00');
  expect(liveEventNights([evening, utc], morning)).toEqual([evening, utc]);
  expect(liveEventNights([evening], Date.parse('2026-10-03T22:59:59+10:00'))).toEqual([]);
  expect(liveEventNights([evening], Date.parse('2026-10-05T00:00:00+11:00'))).toEqual([]);
});
