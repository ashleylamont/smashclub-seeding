import { expect, test } from '@playwright/test';
import { chooseOption } from '../test-support/controls';
import type { trpc } from '../src/lib/trpc';

const EVENT = 'Nemesis · Rehearsal Night';
type EventNights = Awaited<ReturnType<typeof trpc.eventOps.publicEvents.query>>;
type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;

for (const width of [390, 1440]) {
  test(`rehearsal credential sign-in returns to the assigned event at ${width}px`, async ({
    page,
  }, testInfo) => {
    const allowed = width === 390;
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: allowed ? 'dark' : 'light' });
    const nightsResponse = await page.request.get('/api/trpc/eventOps.publicEvents');
    expect(nightsResponse.ok(), await nightsResponse.text()).toBe(true);
    const nights: EventNights = (await nightsResponse.json()).result.data;
    const { id: planId } = nights.find((night) => night.name === EVENT)!;
    const snapshotResponse = await page.request.get('/api/trpc/eventOps.snapshot', {
      params: { input: JSON.stringify({ planId }) },
    });
    expect(snapshotResponse.ok(), await snapshotResponse.text()).toBe(true);
    const snapshot: Snapshot = (await snapshotResponse.json()).result.data;
    const stage = snapshot.stations.find((station) => station.name === 'Stage')!;
    const path = `/operate/${planId}?view=broadcast&station=${stage.id}`;

    await page.goto(`${path}&token=rehearsal-invite#unrelated`);
    await page.getByRole('link', { name: 'Sign in to event control' }).press('Enter');
    await expect(page).toHaveURL(`/login?operate=${planId}&view=broadcast&station=${stage.id}`);
    await chooseOption(page.getByLabel('Account', { exact: true }), {
      label: allowed ? 'Event organiser' : 'Event player',
    });
    await page.getByRole('button', { name: 'Sign in to rehearsal' }).click();
    await expect(page).toHaveURL(path);
    if (allowed) {
      await expect(page.getByRole('heading', { name: EVENT })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Broadcast' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByRole('combobox', { name: 'Station', exact: true })).toContainText(
        stage.name,
      );
      await expect(page.getByRole('heading', { name: 'Event access' })).toHaveCount(0);
    } else {
      await expect(page.getByRole('heading', { name: 'Event access denied' })).toBeVisible();
      await expect(page.getByRole('heading', { name: EVENT })).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath('credential-return.png') });
  });
}
