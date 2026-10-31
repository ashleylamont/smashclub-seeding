import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const width of [390, 1440])
  for (const state of ['finished', 'loser-path', 'conditional-reset'] as const)
    test(`${width}px personal ${state} stays distinct from the event ending`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await mockEvent(page, { bracket: true, role: 'player', idle: true });
      const bracket = fixture.snapshot.nativeBrackets[0]!;
      const player = bracket.entrantIds[0]!;
      const name = (id: string) => fixture.snapshot.entrants.find((item) => item.id === id)!.name;
      const ownPool = fixture.snapshot.matches.find(
        (m) => m.stage === 'group' && [m.player1Id, m.player2Id].includes(player),
      )!;
      const opponent = fixture.snapshot.matches.find(
        (m) =>
          m.stage === 'group' &&
          m.division === ownPool.division &&
          m.poolIndex === ownPool.poolIndex &&
          m.player1Id !== player,
      )!.player1Id!;
      for (const match of fixture.snapshot.matches)
        if (
          match.stage === 'group' &&
          match.division === ownPool.division &&
          match.poolIndex === ownPool.poolIndex
        )
          Object.assign(match, {
            status: 'complete',
            score1: 2,
            score2: 0,
            winnerId: match.player1Id,
          });
      const [semiA, semiB, final] = fixture.snapshot.matches.filter(
        (m) => m.nativeBracketId === bracket.id,
      );
      Object.assign(semiB!, {
        status: 'complete',
        outcome: 'bye',
        winnerId: semiB!.player1Id,
        score1: null,
        score2: null,
      });
      Object.assign(semiA!, {
        status: 'complete',
        outcome: 'played',
        player1Id: player,
        player2Id: opponent,
        player1Name: name(player),
        player2Name: name(opponent),
        winnerId: opponent,
        score1: 0,
        score2: 2,
      });
      Object.assign(final!, {
        status: 'playing',
        player1Id: opponent,
        player2Id: semiB!.winnerId,
        player1Name: name(opponent),
        player2Name: name(semiB!.winnerId!),
        winnerId: null,
        outcome: null,
        score1: 0,
        score2: 0,
        parent1MatchId: semiA!.id,
        parent2MatchId: semiB!.id,
      });
      if (state === 'loser-path') {
        Object.assign(semiB!, {
          status: 'playing',
          outcome: null,
          winnerId: null,
          player2Id: player,
          player2Name: name(player),
        });
        // The other live set has different actual entrants; its loser is still unknown.
        const other = fixture.snapshot.entrants.find(
          (e) => e.id !== player && e.id !== opponent && e.id !== semiB!.player1Id,
        )!;
        Object.assign(semiB!, { player2Id: other.id, player2Name: other.name });
        Object.assign(final!, { status: 'blocked', player2Id: null, player2Name: 'TBD' });
        fixture.snapshot.matches.push(
          Object.assign(
            { ...final! },
            {
              id: 'losers-pending',
              label: 'Losers round 1',
              player1Id: player,
              player1Name: name(player),
              player2Id: null,
              player2Name: 'TBD',
              parent1MatchId: semiA!.id,
              parent2MatchId: semiB!.id,
              parent1Outcome: 'loser',
              parent2Outcome: 'loser',
              nativeRound: 2,
              nativeSlot: 1,
            },
          ),
        );
      } else if (state === 'conditional-reset') {
        Object.assign(final!, {
          label: 'Grand final',
          player1Id: player,
          player1Name: name(player),
          bracketLane: 'final',
        });
        fixture.snapshot.matches.push(
          Object.assign(
            { ...final! },
            {
              id: 'conditional-reset',
              label: 'Reset final (if needed)',
              status: 'blocked',
              player1Id: null,
              player2Id: null,
              player1Name: 'TBD',
              player2Name: 'TBD',
              parent1MatchId: final!.id,
              parent2MatchId: final!.id,
              parent1Outcome: 'winner',
              parent2Outcome: 'loser',
              bracketLane: 'reset',
              nativeRound: 3,
            },
          ),
        );
      }
      await page.goto(`/play/${PLAN_ID}?player=${player}`);
      const progress = page.getByRole('complementary', { name: 'Your progress' });
      if (state === 'finished') {
        await expect(progress).toHaveAttribute('data-journey-state', 'bracket_finished');
        await expect(progress).toContainText('Your published bracket run is finished');
        await expect(progress).toContainText('while the event continues');
        await expect(progress.getByRole('button', { name: 'Find next match' })).toHaveCount(0);
        await expect(page.locator('#event-results')).toContainText(name(opponent));
      } else if (state === 'loser-path') {
        await expect(progress).toHaveAttribute('data-journey-state', 'awaiting_opponent');
        await expect(progress).toContainText('Losers round 1');
        await expect(progress).not.toContainText('run is finished');
        await expect(progress).not.toContainText('TBD');
      } else {
        await expect(progress).toHaveAttribute('data-journey-state', 'active');
        await expect(progress.getByRole('definition')).toContainText(['Reset final (if needed)']);
        await expect(progress.locator('dt')).toHaveText(['Conditional']);
      }
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
        path: testInfo.outputPath(`journey-${state}-${width}.png`),
        fullPage: true,
      });
      await page.reload();
      await expect(progress).toContainText(
        state === 'finished'
          ? 'Your published bracket run is finished'
          : state === 'loser-path'
            ? 'Losers round 1'
            : 'Reset final (if needed)',
      );
      expect(fixture.unexpected).toEqual([]);
    });
