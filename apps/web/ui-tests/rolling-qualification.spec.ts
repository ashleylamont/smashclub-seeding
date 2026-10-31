import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';
import type { PoolQualifierSlot } from '../src/lib/eventDisplay';

for (const width of [390, 1440])
  test(`${width}px pool-place draw stays provisional until the selected player is assigned`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await mockEvent(page, { bracket: true, role: 'player', idle: true });
    const bracket = fixture.snapshot.nativeBrackets[0]!;
    const player = bracket.entrantIds[0]!;
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
    });
    // Publishing actual IDs changes personal ownership; a provisional slot alone never did.
    const opponent = poolEntrants(otherIndex)[0]!;
    Object.assign(slots[0]!, { status: 'resolved', entrantId: player });
    Object.assign(slots[1]!, { status: 'resolved', entrantId: opponent });
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
    expect(fixture.unexpected).toEqual([]);
  });
