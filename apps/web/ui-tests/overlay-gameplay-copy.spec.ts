import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
])
  test(`OBS gameplay at ${width}x${height} shows one idle message and keeps its capture layout`, async ({
    page,
  }, testInfo) => {
    const { snapshot, unexpected } = await mockEvent(page);
    const match = snapshot.matches.find(({ status }) => status === 'playing')!;
    const station = snapshot.stations.find(({ id }) => id === match.stationId)!;
    Object.assign(match, { status: 'ready', stationId: null, called: false, started: false });
    Object.assign(station, { status: 'free', currentMatchId: null });
    await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
    await page.setViewportSize({ width, height });

    const source = `/overlay/${PLAN_ID}?presentation=gameplay&controls=0&station=`;
    const topline = page.locator('.broadcast-topline');
    const stationLabel = topline.locator('span').nth(1);
    const waiting = page.getByText('WAITING FOR A MATCH', { exact: true });
    const scoreboard = page.locator('.broadcast-matchup');
    const capture = page.getByRole('region', { name: 'Transparent game capture area' });
    const layout = () =>
      Promise.all([
        capture.boundingBox(),
        scoreboard.boundingBox(),
        ...['.broadcast-fighter-one', '.broadcast-fighter-two'].map((selector) =>
          scoreboard.locator(selector).boundingBox(),
        ),
      ]);
    const screenshot = async (name: string) => {
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`), omitBackground: true });
    };
    const pollSnapshot = () =>
      Promise.all([
        page.waitForResponse('**/api/trpc/eventOps.snapshot*'),
        page.clock.runFor(5100),
      ]);

    await page.goto(`${source}missing-station`);
    await expect(waiting).toBeVisible();
    await expect(stationLabel).toBeEmpty();
    await expect(page.getByText(/awaiting match|next set soon/i)).toHaveCount(0);
    await screenshot('unknown-station');

    await page.goto(`${source}${station.id}`);
    await expect(waiting).toBeVisible();
    await expect(stationLabel).toHaveText(station.name);
    await expect(capture).toBeVisible();
    await expect(scoreboard.getByText(/awaiting match/i)).toHaveCount(0);
    await screenshot('idle');
    const idleLayout = await layout();

    Object.assign(match, { status: 'playing', stationId: station.id, called: true });
    Object.assign(station, { status: 'occupied', currentMatchId: match.id });
    await pollSnapshot();
    await expect(waiting).toBeVisible();
    await expect(stationLabel).toHaveText(station.name);
    await expect(scoreboard.locator('b')).toHaveText(['—', '—']);
    expect(await layout()).toEqual(idleLayout);

    Object.assign(match, { called: false, started: true, score1: 1, score2: 2 });
    await pollSnapshot();
    await expect(topline).toContainText('PLAYING NOW');
    await expect(stationLabel).toContainText(station.name);
    await expect(scoreboard.locator('strong')).toHaveText([match.player1Name!, match.player2Name!]);
    await expect(scoreboard.locator('b')).toHaveText(['1', '2']);
    await screenshot('playing');
    expect(await layout()).toEqual(idleLayout);
    expect(unexpected).toEqual([]);
  });
