import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function recentFixture(page: Page, guestQr = false) {
  const fixture = await mockEvent(page);
  const source = fixture.snapshot.matches.find((match) => match.status === 'complete')!;
  const latest = {
    ...source,
    id: 'rail-latest',
    player1Name: 'Alex with a long tournament alias and a doubles partner',
    player2Name: 'Bea with another long tournament alias and partner',
    score1: 2,
    score2: 1,
    winnerId: source.player1Id,
    outcome: 'played',
    resultUpdatedAt: '2026-10-04T00:00:02Z',
  };
  const forfeit = {
    ...source,
    id: 'rail-forfeit',
    stage: 'main',
    poolIndex: null,
    label: 'Winners semi-final A',
    player1Name: 'Cody',
    player2Name: 'Drew',
    score1: 99,
    score2: 0,
    winnerId: source.player1Id,
    outcome: 'forfeit',
    resultUpdatedAt: '2026-10-04T00:00:01Z',
  };
  Object.assign(fixture.snapshot, {
    matches: [
      ...fixture.snapshot.matches.filter((match) => match.status !== 'complete'),
      latest,
      forfeit,
    ],
  });
  Object.assign(fixture.snapshot, {
    announcements: [
      { id: 'floor-message', message: 'Venue announcement stays in the footer', expiresAt: null },
    ],
  });
  if (guestQr)
    fixture.responses['eventOps.guests.overlayInvitation'] = {
      token: 'broadcast-fixture-invitation'.repeat(3),
      expiresAt: null,
    };
  return { ...fixture, latest, forfeit };
}

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
])
  for (const qr of [false, true])
    test(`${width}x${height} recent rail with ${qr ? 'guest QR' : 'no QR'} keeps scores, stages and gameplay readable`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      const fixture = await recentFixture(page, qr);
      const current = fixture.snapshot.matches.find((match) => match.status === 'playing')!;
      await page.goto(`/overlay/${PLAN_ID}?controls=0`);
      const rail = page.getByRole('region', { name: 'Recent resolved sets' });
      await expect(rail.locator('article')).toHaveCount(2);
      expect(
        await rail
          .locator('article')
          .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-match-id'))),
      ).toEqual(['rail-latest', 'rail-forfeit']);
      await expect(rail.locator('article').first().locator('small')).toContainText('Pool');
      await expect(rail.locator('article').first().locator('b')).toHaveText(['2', '1']);
      await expect(rail.locator('article').last()).toContainText(
        'Championship · Winners semi-final A',
      );
      await expect(rail.locator('article').last()).toContainText('Drew forfeits');
      await expect(rail).not.toContainText('99');
      await expect(rail).not.toContainText(/COMING UP|PLAY NEXT|provisional/);
      await expect(page.getByLabel('Current match')).toContainText(current.player1Name!);
      await expect(page.getByLabel('Current match')).toContainText(current.player2Name!);
      await expect(page.getByLabel('Current match').locator('.character-icons')).not.toHaveCount(0);
      await expect(page.getByTestId('broadcast-result-notice')).toHaveCount(0);
      await expect(page.locator('.broadcast-floor')).toContainText(
        'Venue announcement stays in the footer',
      );
      await ready(page);
      const aperture = (await page.getByLabel('Transparent game capture area').boundingBox())!;
      const footer = (await page.locator('.broadcast-footer').boundingBox())!;
      expect(footer.y).toBeGreaterThanOrEqual(aperture.y + aperture.height - 1);
      const railBox = (await page.locator('.broadcast-rail').boundingBox())!;
      const resultBox = (await rail.boundingBox())!;
      const lastCard = (await rail.locator('article').last().boundingBox())!;
      expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(resultBox.y + resultBox.height + 1);
      expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(railBox.y + railBox.height);
      if (qr) {
        const qrImage = page.getByRole('img', { name: 'Scan to report a match score' });
        await expect(qrImage).toBeVisible();
        const qrBox = (await qrImage.boundingBox())!;
        expect(qrBox.x + qrBox.width).toBeLessThanOrEqual(aperture.x);
        expect(qrBox.y).toBeGreaterThan(lastCard.y + lastCard.height);
        expect(qrBox.y + qrBox.height).toBeLessThanOrEqual(height);
        expect(qrBox.width).toBeGreaterThan(120);
        expect(qrBox.width).toBeCloseTo(qrBox.height, 0);
      }
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementsFromPoint(x, y)
              .filter(
                (element) =>
                  !['transparent', 'rgba(0, 0, 0, 0)'].includes(
                    getComputedStyle(element).backgroundColor,
                  ),
              ).length,
          { x: aperture.x + aperture.width / 2, y: aperture.y + aperture.height / 2 },
        ),
      ).toBe(0);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.event-overlay')
            .withTags(['wcag2a', 'wcag2aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`recent-sidebar-${width}-${qr ? 'qr' : 'plain'}.png`),
        omitBackground: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
]) {
  for (const theme of ['dark', 'light']) {
    test(`${width}x${height} crowded OBS rail fits the full title, recent results and QR in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await recentFixture(page, true);
      const name =
        'Smash Club South East Queensland Championships and Community Invitational Grand Finals';
      const edition = 'November tournament night';
      fixture.snapshot.plan.name = `${name} · ${edition}`;
      fixture.forfeit.player1Name = 'Cody with an exceptionally long tournament alias';
      fixture.forfeit.player2Name = 'Drew and their tournament doubles partner';
      await page.goto(`/overlay/${PLAN_ID}?controls=0`);

      const rail = page.locator('.broadcast-rail');
      const heading = rail.getByRole('heading', { name, exact: true });
      const results = rail.getByRole('region', { name: 'Recent resolved sets' });
      const qr = rail.getByRole('img', { name: 'Scan to report a match score' });
      await expect(heading).toBeVisible();
      await expect(rail.getByText(edition, { exact: true })).toBeVisible();
      await expect(results.locator('article')).toHaveCount(2);
      await expect(results.getByText('Forfeit', { exact: true })).toBeVisible();
      await expect(
        results.locator('.is-winner').getByText('Advances', { exact: true }),
      ).toBeVisible();
      await expect(results.locator('article').first().locator('b')).toHaveText(['2', '1']);
      await expect(qr).toBeVisible();
      await expect(page.locator('.broadcast-topline')).toContainText('nemesis.ashl.dev');
      await ready(page);
      await expect
        .poll(() => rail.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBe(0);
      const titleBox = (await heading.boundingBox())!;
      const resultsBox = (await results.boundingBox())!;
      const qrBox = (await qr.boundingBox())!;
      const capture = (await page.getByLabel('Transparent game capture area').boundingBox())!;
      expect(titleBox.y + titleBox.height).toBeLessThan(resultsBox.y);
      expect(resultsBox.y + resultsBox.height).toBeLessThan(qrBox.y);
      expect(qrBox.y + qrBox.height).toBeLessThan(height);
      expect(qrBox.x + qrBox.width).toBeLessThan(capture.x);
      expect(qrBox.width).toBeGreaterThan(120);
      expect(
        await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(18);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.event-overlay')
            .withTags(['wcag2a', 'wcag2aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`long-event-title-${width}-${theme}.png`),
        omitBackground: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

test('a maximum-length unbroken title fits at 720p and after source resize', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await recentFixture(page, true);
  fixture.snapshot.plan.name = '界'.repeat(120);
  fixture.forfeit.player1Name = fixture.latest.player1Name;
  fixture.forfeit.player2Name = fixture.latest.player2Name;
  await page.goto(`/overlay/${PLAN_ID}?controls=0`);
  const rail = page.locator('.broadcast-rail');
  await expect(rail.getByRole('heading')).toHaveText(fixture.snapshot.plan.name);
  await expect(rail.getByRole('img', { name: 'Scan to report a match score' })).toBeVisible();
  await ready(page);
  await expect
    .poll(() => rail.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBe(0);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect
    .poll(() => rail.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test('corrections update one stable card and only the footer flashes; byes have no fabricated played score', async ({
  page,
}) => {
  const fixture = await recentFixture(page);
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.goto(`/overlay/${PLAN_ID}?controls=0`);
  const rail = page.getByRole('region', { name: 'Recent resolved sets' });
  const card = rail.locator('[data-match-id="rail-latest"]');
  await expect(card).toBeVisible();
  await card.evaluate((element) => element.setAttribute('data-persisted-card', 'yes'));
  Object.assign(fixture.latest, {
    score1: 1,
    score2: 2,
    winnerId: fixture.latest.player2Id,
    resultUpdatedAt: '2026-10-04T00:00:03Z',
  });
  await page.clock.runFor(5100);
  await expect(card).toHaveAttribute('data-persisted-card', 'yes');
  await expect(card.locator('b')).toHaveText(['1', '2']);
  await expect(rail.locator('[data-match-id="rail-latest"]')).toHaveCount(1);
  await expect(page.getByTestId('broadcast-result-notice')).toContainText('CORRECTED');
  await expect(page.locator('.broadcast-result-copy small')).toHaveText(
    `${fixture.latest.division} / Pool A · ${fixture.latest.label}`,
  );
  await expect(rail.getByTestId('broadcast-result-notice')).toHaveCount(0);
  await page.clock.runFor(5100);
  await expect(page.getByTestId('broadcast-result-notice')).toHaveCount(1);
  await page.clock.runFor(8100);
  await expect(page.getByTestId('broadcast-result-notice')).toHaveCount(0);
  Object.assign(fixture.forfeit, {
    outcome: 'bye',
    player2Id: null,
    player2Name: 'TBD',
    score1: 99,
  });
  await page.clock.runFor(5100);
  const bye = rail.locator('[data-match-id="rail-forfeit"]');
  await expect(bye).toHaveAttribute('data-outcome', 'bye');
  await expect(bye).toContainText('Advanced automatically · Bye');
  await expect(bye.locator('b')).toHaveCount(0);
  await expect(bye).not.toContainText(/99|TBD|vs/);
  await expect(page.getByTestId('broadcast-result-notice')).toContainText('CORRECTED');
  await expect(page.locator('.broadcast-result-copy small')).toHaveText(
    `${fixture.forfeit.division} / main · Winners semi-final A`,
  );
  Object.assign(fixture.latest, { status: 'ready' });
  Object.assign(fixture.forfeit, { status: 'ready' });
  await page.clock.runFor(5100);
  await expect(rail.locator('article')).toHaveCount(0);
  await expect(rail).toContainText('No confirmed results yet.');
});

for (const [width, height, theme] of [
  [1280, 720, 'dark'],
  [1920, 1080, 'light'],
] as const) {
  for (const kind of ['native', 'linked'] as const) {
    test(`${kind} final notice matches the recent rail at ${width}x${height} in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await recentFixture(page);
      const native = kind === 'native';
      const providerIdentifier = 'M700351 · Replay 2';
      const caption = native ? 'Final' : `Upper Championship · ${providerIdentifier}`;
      Object.assign(fixture.latest, {
        division: 'upper',
        stage: 'main',
        poolIndex: null,
        label: native ? 'Final' : `upper main · ${providerIdentifier}`,
        labelFromStructure: native ? true : undefined,
        nativeBracketId: native ? 'final-draw' : null,
        sourceSetId: native ? null : 'source-final',
        sourceKey: native ? 'native:final' : 'set:source-final',
        ...(native && {
          status: 'ready',
          score1: null,
          score2: null,
          winnerId: null,
          outcome: null,
        }),
      });
      Object.assign(fixture.snapshot.plan, { bracketMode: native ? 'native' : 'challonge' });
      await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
      await page.goto(`/overlay/${PLAN_ID}?presentation=gameplay&controls=0`);
      const rail = page.getByRole('region', { name: 'Recent resolved sets' });
      const card = rail.locator('[data-match-id="rail-latest"]');
      await expect(card).toHaveCount(native ? 0 : 1);
      const notice = page.getByTestId('broadcast-result-notice');
      await expect(notice).toHaveCount(0);

      Object.assign(fixture.latest, {
        status: 'complete',
        score1: 1,
        score2: 2,
        winnerId: fixture.latest.player2Id,
        outcome: 'played',
        resultUpdatedAt: '2026-10-04T00:00:03Z',
      });
      await page.clock.runFor(5100);
      await expect(card.locator('small')).toHaveText(caption);
      await expect(card.locator('b')).toHaveText(['1', '2']);
      await expect(notice.locator('.broadcast-result-label strong')).toHaveText(
        native ? 'FINISHED' : 'CORRECTED',
      );
      const copy = notice.locator('.broadcast-result-copy');
      await expect(copy.locator('strong')).toHaveText(
        `${fixture.latest.player2Name} 2–1 ${fixture.latest.player1Name}`,
      );
      const noticeCaption = copy.locator('small');
      await expect(noticeCaption).toHaveText(caption);
      expect(
        await noticeCaption.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      const aperture = (await page.getByLabel('Transparent game capture area').boundingBox())!;
      const footer = (await page.locator('.broadcast-footer').boundingBox())!;
      expect(footer.y).toBeGreaterThanOrEqual(aperture.y + aperture.height - 1);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.event-overlay')
            .withTags(['wcag2a', 'wcag2aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('result-flash.png'),
        omitBackground: true,
      });
      await page.clock.runFor(8100);
      await expect(notice).toHaveCount(0);
      await expect(card).toHaveCount(1);
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

test('the bounded recent count survives an OBS reload', async ({ page }) => {
  await recentFixture(page);
  await page.goto(`/overlay/${PLAN_ID}?recent=1&controls=0`);
  await expect(
    page.getByRole('region', { name: 'Recent resolved sets' }).locator('article'),
  ).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Recent resolved sets' }).locator('article'),
  ).toHaveCount(1);
  await expect(page).toHaveURL(/recent=1/);
});
