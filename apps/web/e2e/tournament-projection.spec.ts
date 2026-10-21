import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';

async function query<T>(request: APIRequestContext, name: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${name}`, {
    params: input ? { input: JSON.stringify(input) } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${name}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(15_000);
  const response = await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  expect(response.ok()).toBe(true);
});

test('compares draft formats and station timelines before saving, including a next-day finish', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const before = await query<{ id: string }[]>(page.request, 'admin.eventPlanner.plans');
  await page.goto('/admin/event-planner');
  const preview = page.getByRole('region', { name: 'Tournament night preview', exact: true });
  await preview.getByRole('button', { name: 'Explore timeline, run order and brackets' }).click();
  await expect(preview.getByLabel('Projected players')).toHaveValue('16');
  await expect(preview.locator('.projection-summary')).toContainText('36');
  expect(
    (
      await new AxeBuilder({ page })
        .include('.planner-projection')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await preview.screenshot({ path: 'screenshots/draft-projection-desktop-timeline.png' });
  const fourStations = await preview.locator('.projection-summary').innerText();
  await preview.getByLabel('Available stations', { exact: true }).fill('1');
  await expect(preview.locator('.projection-summary')).not.toHaveText(fourStations);
  await expect(preview.locator('.projection-lane')).toHaveCount(1);
  await preview.getByLabel('Projected players').fill('4');
  await chooseOption(
    preview.getByRole('combobox', { name: 'Detailed preview format' }),
    'round_robin',
  );
  await preview.getByLabel('Available stations', { exact: true }).fill('2');
  await preview.getByLabel('Preview start time').fill('23:50');
  await expect(preview.locator('.projection-summary')).toContainText('00:24 (+1d)');
  await expect(preview.locator('.projection-summary')).toContainText('6');
  await preview
    .getByRole('region', { name: 'Projected station timeline' })
    .getByRole('button')
    .first()
    .click();
  await expect(preview.locator('.projection-inspector')).toContainText('Station 1');
  await preview.getByRole('button', { name: 'Provisional run sheet and CSV' }).click();
  await expect(
    preview.getByRole('region', { name: 'Projected run sheet' }).locator('tbody tr'),
  ).toHaveCount(6);
  const csv = preview.getByRole('link', { name: 'Download projected run sheet' });
  expect(decodeURIComponent((await csv.getAttribute('href'))!)).toContain('00:24 (+1d)');
  await preview.getByRole('tab', { name: 'Pools and bracket layout' }).click();
  await expect(preview.getByText('Confirmed pool order → final standings')).toBeVisible();
  await chooseOption(
    preview.getByRole('combobox', { name: 'Detailed preview format' }),
    'dual_division',
  );
  await expect(preview.getByRole('alert')).toContainText('at least six');
  await expect(preview.getByRole('region', { name: 'Projected station timeline' })).toHaveCount(0);
  await preview.getByLabel('Available stations', { exact: true }).fill('0');
  await expect(preview.getByRole('alert')).toContainText('1–32 stations');
  expect(
    (await query<{ id: string }[]>(page.request, 'admin.eventPlanner.plans')).map((p) => p.id),
  ).toEqual(before.map((p) => p.id));
});

test('uses doubles teams in a saved draft, shows finals and byes, and keeps what-if controls read-only on mobile', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const members = (await query<{ id: string; status: string }[]>(page.request, 'admin.players'))
    .filter((p) => p.status === 'active')
    .slice(0, 4);
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Timeline draft rehearsal',
      eventDate: '2026-10-21T08:30:00Z',
      bracketMode: 'native',
      competitionFormat: 'doubles',
      structure: 'round_robin',
      rows: [],
    },
  );
  for (let i = 0; i < 2; i++)
    await mutate(page.request, 'admin.eventPlanner.addDoublesPair', {
      planId,
      playerId: members[i * 2]!.id,
      partnerPlayerId: members[i * 2 + 1]!.id,
    });
  const before = await query(page.request, 'admin.eventPlanner.plan', { planId });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/event-planner?plan=${planId}`);
  const preview = page.getByRole('region', { name: 'Tournament night preview', exact: true });
  await preview.getByRole('button', { name: 'Explore timeline, run order and brackets' }).click();
  await expect(preview.getByLabel('Projected teams')).toHaveValue('2');
  await expect(preview.getByLabel('Minutes per set', { exact: true })).toHaveValue('15');
  await expect(preview).toContainText('4 people in 2 fixed pairs');
  await expect(preview.locator('.projection-summary')).toContainText('1 sets');
  await preview.getByLabel('Projected teams').fill('7');
  await chooseOption(
    preview.getByRole('combobox', { name: 'Detailed preview format' }),
    'pools_finals',
  );
  await expect(preview.locator('.projection-summary')).toContainText('14');
  await preview.getByRole('tab', { name: 'Pools and bracket layout' }).click();
  await expect(
    preview.getByRole('heading', { name: 'Open championship · 4 entrants' }),
  ).toBeVisible();
  await expect(preview.getByRole('img', { name: /Open consolation: 3 qualifiers/ })).toBeVisible();
  await expect(preview.locator('.projection-node-title').filter({ hasText: 'Bye' })).toHaveCount(1);
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
    elements: [...document.querySelectorAll('body *')]
      .filter(
        (node) =>
          !node.closest('.projection-scroll') && node.getBoundingClientRect().right > innerWidth,
      )
      .map((node) => `${node.tagName}.${node.className}: ${node.getBoundingClientRect().width}`),
  }));
  expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
  await page.screenshot({ path: 'screenshots/draft-projection-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await preview.screenshot({ path: 'screenshots/draft-projection-desktop-brackets.png' });
  await preview.getByRole('button', { name: 'Use plan counts and format' }).click();
  await expect(preview.getByLabel('Projected teams')).toHaveValue('2');
  await expect(preview.getByRole('combobox', { name: 'Detailed preview format' })).toHaveAttribute(
    'data-value',
    'round_robin',
  );
  expect(await query(page.request, 'admin.eventPlanner.plan', { planId })).toEqual(before);
});
