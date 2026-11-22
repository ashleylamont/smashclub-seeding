import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Request } from '@playwright/test';
import type { TournamentData } from '../src/lib/apiTypes';
import { mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';

const draftEndpoint = 'https://github.com/ashleylamont/smashclub-seeding/issues/new';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`public feedback dialog fits ${theme} at ${width}px and supports keyboard dismissal`, async ({
      page,
      context,
    }, testInfo) => {
      const requests: Request[] = [];
      await context.route('https://github.com/**', async (route) => {
        requests.push(route.request());
        await route.abort();
      });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page);
      await page.goto('/changelog');
      await expect(page.getByRole('heading', { name: 'Nemesis changelog' })).toBeVisible();
      const footer = page.getByRole('contentinfo');
      const changelog = footer.getByRole('link', { name: 'Changelog' });
      const trigger = footer.getByRole('button', { name: 'Give feedback' });
      await changelog.focus();
      await page.keyboard.press('Tab');
      await expect(trigger).toBeFocused();
      await ready(page);
      await footer.screenshot({ path: testInfo.outputPath('footer.png') });
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Give feedback' });
      const close = dialog.getByRole('button', { name: 'Close dialog' });
      await expect(close).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('link', { name: 'Open GitHub draft (new tab)' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await expect(dialog).toContainText('Issues are public');
      await expect(dialog).toContainText('requires a GitHub account');
      await ready(page);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(result.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('dialog.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(page).toHaveURL('/changelog');
      expect(requests).toHaveLength(0);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

for (const actor of ['guest', 'player', 'admin'] as const) {
  test(`${actor} opens a draft with only the displayed build context and keeps score edits`, async ({
    page,
    context,
  }, testInfo) => {
    const requests: Request[] = [];
    await context.route('https://github.com/**', async (route) => {
      requests.push(route.request());
      await route.fulfill({
        contentType: 'text/html',
        body: '<title>Intercepted GitHub draft</title>',
      });
    });
    const fixture = await mockEvent(page, { role: actor === 'guest' ? undefined : actor });
    const invitation = 'fixture-private-invitation';
    const guestSession = 'fixture-private-guest-session'.repeat(2);
    fixture.responses['eventOps.guests.redeem'] = { sessionToken: guestSession, expiresAt: null };
    fixture.responses['eventOps.guests.matches'] = { ...fixture.snapshot, reports: [] };
    const route = actor === 'admin' ? 'operate' : actor === 'guest' ? 'guest' : 'play';
    const query = 'private=fixture-private-query';
    const fragment = 'fixture-private-fragment';
    await page.setViewportSize(
      actor === 'admin' ? { width: 1440, height: 900 } : { width: 390, height: 844 },
    );
    await page.emulateMedia({ colorScheme: actor === 'player' ? 'dark' : 'light' });
    await page.goto(
      `/${route}/${PLAN_ID}?${query}#${actor === 'guest' ? `token=${invitation}` : fragment}`,
    );
    if (actor === 'guest') {
      await expect(page.getByText('Reporting with your venue guest pass.')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/play/${PLAN_ID}\\?${query}$`));
    }
    if (actor === 'admin') {
      await page.getByRole('button', { name: 'Finish match', exact: true }).first().click();
    }
    const score = page
      .locator('article.ops-match')
      .filter({ hasText: PLAYER_NAME })
      .first()
      .getByRole('spinbutton')
      .first();
    await score.fill('2');
    const originalUrl = page.url();
    expect(originalUrl).toContain(query);
    if (actor !== 'guest') expect(originalUrl).toContain(`#${fragment}`);
    const footer = page.getByRole('contentinfo');
    const version = await footer.locator('.app-version').innerText();
    const build = await footer.locator('.build-label').innerText();
    const trigger = footer.getByRole('button', { name: 'Give feedback' });
    await ready(page);
    await page.screenshot({ path: testInfo.outputPath('score-draft.png') });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Give feedback' });
    const link = dialog.getByRole('link', { name: 'Open GitHub draft (new tab)' });
    const metadata = `${version} · build ${build}`;
    await expect(dialog).toContainText(metadata);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(requests).toHaveLength(0);
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await expect(popup).toHaveTitle('Intercepted GitHub draft');
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const url = new URL(request.url());
    expect(url.origin + url.pathname).toBe(draftEndpoint);
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['body']);
    expect(url.searchParams.get('body')).toBe(
      `<!-- Describe the bug or idea. For a bug, include what you expected and the steps to reproduce it. For an idea, explain what would improve. -->\n\nNemesis ${metadata}`,
    );
    expect(request.method()).toBe('GET');
    expect(await request.headerValue('referer')).toBeNull();
    await popup.close();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(originalUrl);
    await expect(score).toHaveValue('2');
    expect(fixture.submissions).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test('feedback stays off OBS and venue displays, including on browser Back', async ({
  page,
}, testInfo) => {
  const fixture = await mockEvent(page);
  const venue = {
    id: 'fixture-venue',
    slug: 'fixture-venue',
    name: 'Fixture venue bracket',
    provider: 'native',
    competitionFormat: 'singles',
    resultsMode: 'auto',
    eventDate: '2026-10-04T00:00:00Z',
    isRookie: false,
    challongeState: 'underway',
    syncState: 'synced',
    lastSyncedAt: '2026-10-04T00:00:00Z',
    liveUntil: null,
    participants: [],
    sets: [],
  } satisfies TournamentData;
  fixture.responses['public.tournament'] = venue;
  await page.route('**/api/live/fixture-venue', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }),
  );
  await page.goto(`/overlay/${PLAN_ID}?presentation=gameplay`);
  await expect(page.locator('.broadcast-identity h1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Give feedback' })).toHaveCount(0);
  const bracketPath = `/tournaments/${venue.slug}`;
  const venuePath = `${bracketPath}/live`;
  await page.goto(venuePath);
  const exit = page.getByRole('link', { name: 'Exit', exact: true });
  const trigger = page.getByRole('button', { name: 'Give feedback' });
  await expect(page.getByRole('heading', { name: venue.name })).toBeVisible();
  await expect(page.locator('.app-footer')).toBeHidden();
  await expect(trigger).toHaveCount(0);

  await exit.click();
  await expect(page).toHaveURL(bracketPath);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Give feedback' });
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(venuePath);
  await expect(page.locator('.venue-header h1')).toHaveText(venue.name);
  await expect(dialog).toBeHidden();
  await ready(page);
  await page.screenshot({ path: testInfo.outputPath('venue-after-browser-back.png') });
  await exit.click();
  await expect(page).toHaveURL(bracketPath);
  await expect(trigger).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(fixture.unexpected).toEqual([]);
});
