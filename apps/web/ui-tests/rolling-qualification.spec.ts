import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { bracketCaptureOptions, mockEvent, PLAN_ID, PLAYER_NAME, ready } from './fixtures';
import { broadcastProgressPages } from '../src/lib/broadcastProgress';
import type { PoolQualifierSlot } from '../src/lib/eventDisplay';

for (const [width, theme] of [
  [390, 'dark'],
  [390, 'light'],
  [1440, 'dark'],
  [1440, 'light'],
] as const)
  test(`${theme} ${width}px player path appears while other places in the same pool stay tied`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const fixture = await mockEvent(page, { bracket: true, role: 'player', idle: true });
    const bracket = fixture.snapshot.nativeBrackets[0]!;
    const player = bracket.entrantIds[0]!;
    fixture.snapshot.entrants.find((entrant) => entrant.id === player)!.name = PLAYER_NAME;
    const own = fixture.snapshot.matches.find(
      (m) => m.stage === 'group' && [m.player1Id, m.player2Id].includes(player),
    )!;
    const poolEntrants = (index: number) => [
      ...new Set(
        fixture.snapshot.matches
          .filter(
            (m) => m.stage === 'group' && m.division === own.division && m.poolIndex === index,
          )
          .flatMap((m) => [m.player1Id, m.player2Id])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const otherIndex = fixture.snapshot.matches.find(
      (m) => m.stage === 'group' && m.division === own.division && m.poolIndex !== own.poolIndex,
    )!.poolIndex!;
    const source = (index: number, place: number): PoolQualifierSlot => ({
      poolId: `pool-${index}`,
      division: own.division,
      poolIndex: index,
      place,
      status: 'pending',
      entrantId: null,
      eligibleEntrantIds: poolEntrants(index),
    });
    const slots = [
      source(own.poolIndex!, 1),
      source(otherIndex, 2),
      source(otherIndex, 1),
      source(own.poolIndex!, 2),
    ];
    Object.assign(bracket, { entrantIds: [], qualifierSlots: slots });
    const [semiA, semiB, final] = fixture.snapshot.matches.filter(
      (m) => m.nativeBracketId === bracket.id,
    );
    for (const [match, first, second] of [
      [semiA, slots[0], slots[1]],
      [semiB, slots[2], slots[3]],
    ] as const)
      Object.assign(match!, {
        player1Id: null,
        player2Id: null,
        player1Name: 'TBD',
        player2Name: 'TBD',
        status: 'blocked',
        outcome: null,
        winnerId: null,
        score1: null,
        score2: null,
        player1Qualifier: first,
        player2Qualifier: second,
        qualificationBlocks: [first, second],
      });
    Object.assign(final!, {
      player1Id: null,
      player2Id: null,
      player1Name: 'TBD',
      player2Name: 'TBD',
      status: 'blocked',
      outcome: null,
      winnerId: null,
      score1: null,
      score2: null,
      parent1MatchId: semiA!.id,
      parent2MatchId: semiB!.id,
      qualificationBlocks: slots,
    });
    await page.goto(`/play/${PLAN_ID}?player=${player}`);
    await expect(
      page.getByRole('heading', { name: 'Finals qualification', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your bracket path', exact: true })).toHaveCount(
      0,
    );
    await expect(page.locator('#my-matches')).not.toContainText('Semi-final A');
    await page.getByRole('button', { name: 'Full draw & bracket standings', exact: true }).click();
    const graph = page.locator('#event-brackets');
    await expect(graph).toContainText('Upper Pool A · place 1');
    await expect(graph).toContainText('Waiting for qualifiers');
    await expect(graph).not.toContainText('TBD');
    await expect(graph).not.toContainText('advanced automatically');
    await expect(graph.getByRole('spinbutton')).toHaveCount(0);
    await ready(page);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.player-event-hub')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`pool-qualification-${width}.png`),
      fullPage: true,
      ...bracketCaptureOptions,
    });
    // Publishing actual IDs changes personal ownership; a provisional slot alone never did.
    const opponent = poolEntrants(otherIndex)[0]!;
    Object.assign(slots[0]!, { status: 'resolved', entrantId: player });
    Object.assign(slots[1]!, { status: 'resolved', entrantId: opponent });
    slots[3]!.candidateEntrantIds = poolEntrants(own.poolIndex!).filter((id) => id !== player);
    Object.assign(bracket, { entrantIds: [player, opponent] });
    const name = (id: string) => fixture.snapshot.entrants.find((e) => e.id === id)!.name;
    Object.assign(semiA!, {
      status: 'ready',
      player1Id: player,
      player2Id: opponent,
      player1Name: name(player),
      player2Name: name(opponent),
      qualificationBlocks: [],
    });
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Your bracket path', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Finals qualification', exact: true }),
    ).toHaveCount(0);
    const assigned = page
      .locator('article.ops-match')
      .filter({ has: page.locator('.ops-match-meta').filter({ hasText: semiA!.label }) });
    await expect(assigned).toContainText(name(opponent));
    await expect(assigned.getByRole('spinbutton')).toHaveCount(2);
    await graph.getByRole('button', { name: 'Full draw & bracket standings' }).click();
    await expect(graph).toContainText(name(player));
    await expect(graph).toContainText('Waiting for qualifiers');
    await expect(graph).toContainText('place 2');
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .include('#event-brackets')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`mixed-qualification-${theme}-${width}.png`),
      fullPage: true,
      ...bracketCaptureOptions,
    });
    Object.assign(slots[0]!, { status: 'review_pending' });
    Object.assign(semiA!, { status: 'playing', called: true, qualificationBlocks: [slots[0]] });
    await page.reload();
    await expect(assigned.getByRole('status')).toContainText('under review');
    await expect(assigned.getByRole('status')).toContainText('Your recorded pairing is unchanged');
    await expect(assigned).toContainText(name(opponent));
    // A hold on later calls does not prevent recording games already played.
    await expect(assigned.getByRole('spinbutton')).toHaveCount(2);
    if (width === 1440 && theme === 'dark') {
      Object.assign(slots[0]!, { status: 'resolved' });
      Object.assign(semiA!, { status: 'ready', called: false, qualificationBlocks: [] });
      await page.goto(`/overlay/${PLAN_ID}?presentation=progress`);
      const progress = page.getByRole('region', { name: 'Tournament progress' });
      await expect(progress).toBeVisible();
      const firstBracket = broadcastProgressPages(fixture.snapshot).findIndex(
        (item) => item.kind === 'bracket',
      );
      for (let i = 0; i < firstBracket; i++)
        await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(progress).toContainText(name(player));
      await expect(progress).toContainText('place 2');
      await expect(progress).not.toContainText('TBD');
      await page.screenshot({ path: testInfo.outputPath('mixed-qualification-obs.png') });
    }
    expect(fixture.unexpected).toEqual([]);
  });
