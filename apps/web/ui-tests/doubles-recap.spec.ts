import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { ready } from './fixtures';
import { rpcProcedures } from '../test-support/rpcBatch';

const team =
  'Sydney Doubles (An entrant with a long public alias / Another entrant with a long public alias)';
const slug = 'tip13-review';
const data = {
  slug,
  name: 'Tech In Place 13',
  competitionFormat: 'doubles',
  isComplete: true,
  isAbandoned: false,
  entrants: 19,
  setsPlayed: 44,
  tournaments: [{ id: 'main', name: 'Open Main', slug, eventDate: '2026-11-10T07:00:00.000Z' }],
  facts: [
    {
      id: 'podium:main',
      notability: 1,
      fact: {
        kind: 'podium',
        tournamentId: 'main',
        derived: false,
        places: [
          {
            place: 1,
            seed: null,
            player: { playerId: null, name: team, companyCode: null, characters: [] },
          },
        ],
      },
    },
  ],
  highlights: [],
  coverage: {
    unsyncedBrackets: 0,
    unresolvedEntrants: 0,
    unlinkedPlayedSets: 0,
    ignoredGroupSets: 0,
  },
};

for (const [width, theme] of [
  [390, 'dark'],
  [1440, 'light'],
] as const) {
  test(`doubles recap ${width}px ${theme} presents teams and a readable podium`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/api/auth/')) return route.fulfill({ json: null });
      if (url.endsWith('/api/live'))
        return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      const results = rpcProcedures(url).map((procedure) => {
        expect(procedure).toBe('public.recap');
        return { result: { data } };
      });
      return route.fulfill({ json: new URL(url).searchParams.has('batch') ? results : results[0] });
    });
    await page.goto(`/recaps/${slug}`);
    await expect(page.getByRole('heading', { name: 'Tech In Place 13', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open Main', level: 2 })).toBeVisible();
    await expect(page.getByText('19 teams · 44 sets', { exact: false })).toBeVisible();
    await expect(page.getByText(team)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Event results →' })).toHaveAttribute(
      'href',
      `/events/${slug}`,
    );
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await new AxeBuilder({ page }).include('.recap-page').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: testInfo.outputPath('doubles-recap.png') });
  });
}
