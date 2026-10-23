import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID } from './fixtures';
import { chooseOption } from '../test-support/controls';

test('long player menus scroll to their last option and return to the first by keyboard', async ({
  page,
}) => {
  const fixture = await mockEvent(page, { role: 'admin' });
  const template = fixture.snapshot.entrants[0]!;
  fixture.overview.entrants = Array.from({ length: 32 }, (_, index) => ({
    ...template,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `Synthetic entrant ${String(index + 1).padStart(2, '0')}`,
  }));
  fixture.responses['eventOps.attendeeRoster'] = {
    attendees: fixture.overview.entrants.map((entrant) => ({
      entryId: entrant.id,
      playerId: entrant.id,
      rawInput: entrant.name,
      cleanedName: entrant.name,
      division: 'upper',
      canonicalName: entrant.name,
      displayName: entrant.name,
      publicAlias: entrant.name,
      companyCode: null,
      companyName: null,
    })),
    companies: [],
  };
  await page.goto(`/operate/${PLAN_ID}`);
  await page.getByRole('tab', { name: 'Players', exact: true }).click();
  const roster = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Attending players', exact: true }),
  });
  await expect(roster.locator('tbody tr')).toHaveCount(32);
  const attendance = page.locator('section.card').filter({
    has: page.getByRole('heading', { name: 'Late arrivals and no-shows', exact: true }),
  });
  await chooseOption(attendance.getByRole('combobox', { name: 'Change', exact: true }), 'withdraw');
  const player = attendance.getByRole('combobox', { name: 'Player', exact: true });
  await player.click();
  const menu = page.getByRole('listbox');
  const empty = page.getByRole('option', { name: 'Choose a player', exact: true });
  await expect(menu).toBeInViewport();
  await expect(empty).toBeFocused();
  const viewport = menu.locator('[data-radix-select-viewport]');
  const bounds = await viewport.evaluate((node) => ({
    height: node.clientHeight,
    scroll: node.scrollHeight,
    menuHeight: node.parentElement!.clientHeight,
  }));
  expect(bounds.height).toBeLessThanOrEqual(bounds.menuHeight);
  expect(bounds.scroll).toBeGreaterThan(bounds.height);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(player).toBeFocused();
  await player.click();
  await expect(empty).toBeFocused();
  const last = page.getByRole('option', { name: 'Synthetic entrant 32', exact: true });
  // Exercise the user's scroll path. Mounting a scroll arrow must not scroll
  // the previously focused option back into view and undo this wheel event.
  await viewport.hover();
  await page.mouse.wheel(0, bounds.scroll);
  await expect(last).toBeInViewport();
  await last.click();
  await expect(player).toHaveAttribute('data-value', fixture.overview.entrants[31]!.id);
  await player.click();
  await expect(last).toBeFocused();
  await page.keyboard.press('Home');
  await expect(empty).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const first = page.getByRole('option', { name: 'Synthetic entrant 01', exact: true });
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(player).toHaveAttribute('data-value', fixture.overview.entrants[0]!.id);
  await expect(player).toBeFocused();
  expect(fixture.unexpected).toEqual([]);
});
