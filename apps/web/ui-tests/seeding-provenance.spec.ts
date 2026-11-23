import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { SeedingRunData } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { bracketCaptureOptions, mockEvent, ready } from './fixtures';

const snapshotDate = '2026-09-29T08:15:00Z';
const runDate = '2026-10-04T00:00:00Z';
const alias = 'Alex with a long tournament alias';

async function openRun(page: Page, hasSnapshot: boolean) {
  const fixture = await mockEvent(page, { role: 'admin' });
  const data: SeedingRunData = {
    run: { id: 'run', status: 'draft', createdAt: runDate, pushedAt: null, pushLog: null },
    ratingSnapshot: hasSnapshot ? { model: 'whr', publishedAt: snapshotDate } : null,
    entries: [
      {
        id: 'first-entry',
        participantId: 'first',
        playerId: 'first-player',
        autoScore: 1552,
        autoSeed: 1,
        overrideSeed: null,
        locked: false,
        rawName: alias,
        cleanedName: alias,
        canonicalName: alias,
        displayName: null,
        challongeSeed: 2,
        name: alias,
        seedRating: hasSnapshot ? { skill: 1720, uncertainty: 84 } : null,
      },
      {
        id: 'new-entry',
        participantId: 'new',
        playerId: null,
        autoScore: null,
        autoSeed: 2,
        overrideSeed: null,
        locked: false,
        rawName: 'New player',
        cleanedName: 'New player',
        canonicalName: null,
        displayName: null,
        challongeSeed: 1,
        name: 'New player',
        seedRating: null,
      },
    ],
  };
  const lockChanges: unknown[] = [];
  fixture.mutationResponses.set('admin.setSeedingEntryLocked', (input) => {
    lockChanges.push(input);
    const { entryId, locked } = input as { entryId: string; locked: boolean };
    const entry = data.entries.find(({ id }) => id === entryId);
    if (entry) entry.locked = locked;
    return { ok: true };
  });
  Object.assign(fixture.responses, {
    'public.tournaments': [
      { id: 'tournament', name: 'Seeding rehearsal', challongeState: 'pending' },
    ],
    'admin.seedingRun': data,
  });
  await page.goto('/admin/seeding');
  const tournament = page.getByRole('combobox', { name: 'Tournament to seed' });
  await chooseOption(tournament, 'tournament');
  await expect(page.getByText(alias, { exact: true })).toBeVisible();
  return { ...fixture, lockChanges };
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`the saved seed inputs can be inspected at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await openRun(page, true);
      await ready(page);
      await page.screenshot({
        path: testInfo.outputPath(`workbench-${width}-${theme}.png`),
        fullPage: true,
      });

      await expect(page.locator(`time[datetime="${snapshotDate}"]`)).toBeVisible();
      await expect(page.getByText(/Run from 4 Oct 2026/)).toBeVisible();
      const details = page.getByRole('button', { name: 'How automatic seeds are calculated' });
      await details.press('Enter');
      await expect(details).toBeFocused();
      await expect(page.getByText(/skill estimate minus twice its uncertainty/)).toBeVisible();
      await expect(page.getByText(/club rating.*attendance penalty/)).toBeVisible();
      await expect(page.getByText(/without a rating score.*alphabetical/)).toBeVisible();

      const table = page.getByRole('region', { name: 'Seeding order' });
      const rated = table.locator('.seeding-row').filter({ hasText: alias });
      await expect(rated).toContainText('1552');
      await expect(rated).toContainText(/Skill estimate 1720.*Uncertainty 84/);
      await expect(table.locator('.seeding-row').filter({ hasText: 'New player' })).toContainText(
        'Unrated',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await table.focus();
      if (width === 390) {
        await table.press('ArrowRight');
        await expect.poll(() => table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        await table.evaluate((el) => (el.scrollLeft = el.scrollWidth));
        const player = rated.getByText(alias, { exact: true });
        const lock = rated.getByRole('button', { name: `Lock seed 1 in place for ${alias}` });
        await lock.focus();
        await expect(lock).toBeFocused();
        await expect(lock).toBeInViewport({ ratio: 1 });
        await expect(player).toBeInViewport({ ratio: 1 });
        await expect(rated.locator('.seed-number')).toBeInViewport({ ratio: 1 });
        await expect
          .poll(() => table.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft))
          .toBe(0);
        await page.keyboard.press('Enter');
        await expect(
          rated.getByRole('button', { name: `Unlock seed 1 for ${alias}` }),
        ).toHaveAttribute('aria-pressed', 'true');
        expect(fixture.lockChanges).toEqual([{ entryId: 'first-entry', locked: true }]);
      }

      await ready(page);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({
        ...bracketCaptureOptions,
        path: testInfo.outputPath(`seed-details-${width}-${theme}.png`),
        fullPage: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });

test('a draft without its source keeps the recorded score without inventing rating inputs', async ({
  page,
}) => {
  await openRun(page, false);
  await expect(page.getByText(/no saved rating snapshot is available/i)).toBeVisible();
  await expect(page.locator('time')).toHaveCount(0);
  await expect(page.getByText('1552', { exact: true })).toBeVisible();
  await expect(page.getByText(/Skill estimate 1720/)).toHaveCount(0);
});

test('320px keeps rating text readable and the visible lock beside its player', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => localStorage.setItem('smashclub:theme', 'light'));
  const fixture = await openRun(page, true);
  const table = page.getByRole('region', { name: 'Seeding order' });
  const rated = table.getByRole('row').filter({ hasText: alias });
  const skill = rated.getByText('Skill estimate 1720', { exact: true });
  await table.scrollIntoViewIfNeeded();
  await ready(page);
  await skill.evaluate((el) => {
    const region = el.closest<HTMLElement>('[role="region"]')!;
    region.scrollLeft += el.getBoundingClientRect().left - region.getBoundingClientRect().left;
  });
  for (const detail of ['Skill estimate 1720', 'Uncertainty 84']) {
    const text = rated.getByText(detail, { exact: true });
    await expect
      .poll(() =>
        text.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return [...range.getClientRects()].every(({ left, right, top, bottom }) =>
            [left + 1, right - 1].every((x) =>
              el.contains(document.elementFromPoint(x, (top + bottom) / 2)),
            ),
          );
        }),
      )
      .toBe(true);
  }
  await table.screenshot({ path: testInfo.outputPath('readable-rating-320.png') });

  const lock = rated.getByRole('button', { name: `Lock seed 1 in place for ${alias}` });
  const player = rated.getByText(alias, { exact: true });
  await expect(lock).not.toBeInViewport();
  await lock.focus();
  await expect(lock).toBeFocused();
  await expect(lock).toBeInViewport({ ratio: 1 });
  await expect(player).toBeInViewport({ ratio: 1 });
  const lockRight = await lock.evaluate((el) => el.getBoundingClientRect().right);
  expect(lockRight).toBeLessThan(await player.evaluate((el) => el.getBoundingClientRect().left));
  await table.screenshot({ path: testInfo.outputPath('identifiable-lock-320.png') });

  await page.keyboard.press('Enter');
  await expect(rated.getByRole('button', { name: `Unlock seed 1 for ${alias}` })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(fixture.lockChanges).toEqual([{ entryId: 'first-entry', locked: true }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(fixture.unexpected).toEqual([]);
});
