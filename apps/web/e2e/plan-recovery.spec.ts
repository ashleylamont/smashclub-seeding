import { test, expect, type APIRequestContext } from '@playwright/test';

async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${procedure}`, {
    params: input ? { input: JSON.stringify(input) } : {},
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
  const response = await request.post(`/api/trpc/${procedure}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
test('an admin reverts a locked doubles draw, edits the fresh draft, then deletes it after locking again', async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.request.post('/api/auth/sign-in/email', {
    data: { email: 'admin@smashclub.dev', password: 'devpassword123' },
  });
  const members = (await query<{ id: string; status: string }[]>(page.request, 'admin.players'))
    .filter((p) => p.status === 'active')
    .slice(0, 4);
  const { planId } = await mutate<{ planId: string }>(
    page.request,
    'admin.eventPlanner.createPlan',
    {
      name: 'Post-lock recovery rehearsal',
      eventDate: '2026-10-01T00:00:00Z',
      competitionFormat: 'doubles',
      bracketMode: 'native',
      structure: 'round_robin',
      rows: [],
    },
  );
  for (let i = 0; i < 2; i++)
    await mutate(page.request, 'admin.eventPlanner.addDoublesPair', {
      planId,
      playerId: members[i * 2]!.id,
      partnerPlayerId: members[i * 2 + 1]!.id,
      teamName: `Recovery pair ${i + 1}`,
    });
  await mutate(page.request, 'admin.eventPlanner.freezeRoster', { planId });
  await mutate(page.request, 'admin.eventPlanner.generatePools', { planId });
  await mutate(page.request, 'eventOps.softLockPools', { planId, confirm: true });
  await page.goto(`/admin/event-planner?plan=${planId}`);
  await page.getByRole('button', { name: 'Revert to draft', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review event recovery' });
  await expect(review).toContainText('2 entrants');
  await review.getByLabel('Reason for reset').fill('Correct the accidentally locked roster');
  await review.getByRole('button', { name: 'Confirm revert to draft', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`plan=${planId}`));
  const freshId = new URL(page.url()).searchParams.get('plan')!;
  expect(freshId).not.toBe(planId);
  await expect(page.getByRole('button', { name: 'Freeze team seeds', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove pair', exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Choose partner', exact: true })).toBeVisible();
  await mutate(page.request, 'admin.eventPlanner.freezeRoster', { planId: freshId });
  await mutate(page.request, 'admin.eventPlanner.generatePools', { planId: freshId });
  await mutate(page.request, 'eventOps.softLockPools', { planId: freshId, confirm: true });
  await page.reload();
  await page
    .getByRole('button', { name: 'Delete plan Post-lock recovery rehearsal', exact: true })
    .click();
  await expect(review).toContainText('2 entrants');
  await review.getByLabel('Reason for deletion').fill('Discard the rehearsal');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await review.getByRole('button', { name: 'Confirm delete event', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/event-planner$/);
  const plans = await query<{ id: string }[]>(page.request, 'admin.eventPlanner.plans');
  expect(plans.some((p) => p.id === planId || p.id === freshId)).toBe(false);
  expect(await query(page.request, 'admin.eventPlanner.plan', { planId: freshId })).toBeNull();
});
