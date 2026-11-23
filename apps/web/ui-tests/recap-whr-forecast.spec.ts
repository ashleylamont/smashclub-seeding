import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { RecapData, RecapFactEntry, RecapPlayer } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const winner = {
  playerId: 'ac184b5a-fba4-4bc9-9ee9-c1610d3c8373',
  name: 'Returning Player With An Exceptionally Long Tournament Alias',
  companyCode: null,
  characters: [],
} satisfies RecapPlayer;
const opponent = { ...winner, playerId: null, name: 'Practice opponent' };
const slug = 'pre-night-odds';
const eventName = 'Club night tournament';

function upset(id: string, probability: number, headline: string, chance: string): RecapFactEntry {
  return {
    id,
    headline,
    detail: `The ratings gave them ${chance} against ${opponent.name} — 415 points apart in the winners final. Won 3-2.`,
    notability: 0.8,
    fact: {
      kind: 'rating_upset',
      tournamentId: 'main',
      winner,
      loser: opponent,
      probability,
      ratingGap: 415,
      stage: 'the winners final',
      score: '3-2',
    },
  };
}

const forecasts = [
  upset('unlikely', 0.004, 'An unlikely final', 'less than one chance in 100'),
  upset('regular', 0.12, 'An upset', 'one chance in 8'),
];

for (const width of [390, 1440]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`recap labels pre-night WHR chances at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page);
      fixture.responses['public.recap'] = {
        slug,
        eventKey: '2026-10-02',
        name: eventName,
        competitionFormat: 'singles',
        isComplete: true,
        isAbandoned: false,
        entrants: 19,
        setsPlayed: 24,
        tournaments: [
          {
            id: 'main',
            name: 'Open championship',
            slug,
            eventDate: '2026-10-02T08:30:00Z',
            challongeState: 'complete',
            isRookie: false,
          },
        ],
        facts: forecasts,
        highlights: forecasts,
        coverage: {
          unsyncedBrackets: 0,
          unresolvedEntrants: 0,
          unlinkedPlayedSets: 0,
          ignoredGroupSets: 0,
        },
      } satisfies RecapData;

      await page.goto(`/recaps/${slug}`);
      await expect(page.getByRole('heading', { name: eventName, level: 1 })).toBeVisible();
      const lead = page.getByRole('article').filter({ hasText: 'An unlikely final' });
      await expect(lead.getByText('<1%', { exact: true })).toBeVisible();
      await expect(lead.getByText('WHR pre-night win chance')).toBeVisible();
      const other = page.getByRole('listitem').filter({ hasText: 'An upset' });
      await expect(other.getByText('12%', { exact: true })).toBeVisible();
      await expect(other.getByText('WHR pre-night win chance')).toBeVisible();
      const profile = lead.getByRole('link', { name: winner.name });
      await expect(profile).toHaveAttribute('href', `/players/${winner.playerId}`);
      const results = page.getByRole('link', { name: 'Event results →' });
      await expect(results).toHaveAttribute('href', `/events/${slug}`);
      await results.focus();
      await page.keyboard.press('Tab');
      await expect(profile).toBeFocused();

      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath('recap-pre-night-odds.png'),
        fullPage: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
