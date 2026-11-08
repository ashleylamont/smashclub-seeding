import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { bracketCaptureOptions, mockEvent, PLAN_ID, ready, type FixtureOptions } from './fixtures';

type Preview = Awaited<ReturnType<typeof trpc.eventOps.live.previewFinalsSlotReplay.query>>;
type Command = Parameters<typeof trpc.eventOps.live.command.mutate>[0];

async function checkRoute(page: Page) {
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440]) {
    for (const reciprocal of [false, true])
      test(`reviews ${reciprocal ? 'reciprocal finals routes' : 'an already-played finals slot'} at ${width}px in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
        const options: FixtureOptions = {
          role: 'admin',
          history: [
            {
              entries: [
                {
                  id: 'act:52',
                  eventName: 'DecisionRecordedV6',
                  version: 52,
                  at: '2026-10-03T23:59:00.000Z',
                  actor: 'Organiser',
                  source: 'operator',
                  category: 'scores',
                  title: 'Score recorded',
                  summary: 'Pool score',
                  matchId: '',
                  details: {},
                },
              ],
              nextCursor: null,
            },
          ],
        };
        const fixture = await mockEvent(page, options);
        const match = fixture.overview.matches.find(
          (row) => row.status === 'complete' && row.stage === 'group',
        )!;
        const revision = match.revision;
        const alice = match.player1Id!;
        const bea = match.player2Id!;
        const chris = fixture.overview.entrants.find(({ id }) => id !== alice && id !== bea)!;
        const opponent = fixture.overview.entrants.find(
          ({ id }) => id !== alice && id !== bea && id !== chris.id,
        )!;
        const entrantNames = {
          [alice]: 'Alice with a long tournament alias from Western Sydney',
          [bea]: 'Bea with another long tournament alias',
          [chris.id]: chris.name,
          [opponent.id]: 'The other consolation qualifier',
        };
        options.history![0]!.entries[0]!.matchId = match.id;
        Object.assign(fixture.overview.plan, {
          bracketMode: 'native',
          drawPaused: false,
          liveOwned: true,
        });
        Object.assign(match, {
          label: 'Recorded pool set',
          player1Name: entrantNames[alice],
          player2Name: entrantNames[bea],
          reviewPoolGames: true,
          score1: 2,
          score2: 0,
          winnerId: alice,
          outcome: 'played',
        });
        const changed = {
          bracketId: 'upper-championship',
          division: 'upper',
          stage: 'main',
          poolId: 'upper-pool-a',
          poolIndex: 0,
          place: 2,
          beforeEntrantId: alice,
          afterEntrantId: bea,
        } as const;
        const companionChange = {
          ...changed,
          stage: 'consolation' as const,
          bracketId: 'upper-consolation',
          place: 3,
          beforeEntrantId: bea,
          afterEntrantId: alice,
        };
        const approved: Preview = {
          allowed: true,
          issues: [],
          qualifierChanges: reciprocal ? [changed, companionChange] : [changed],
          entrantNames,
          revisionToken: 'a'.repeat(64),
          original: {
            id: 'original',
            label: 'Upper Championship Semi-final',
            player1Id: alice,
            player2Id: chris.id,
            score1: 2,
            score2: 1,
          },
          replay: { player1Id: bea, player2Id: chris.id },
          downstream: [{ id: 'final', label: 'Upper Championship Final' }],
          ...(reciprocal && {
            companion: {
              matchId: 'consolation',
              label: 'Upper Consolation Semi-final',
              player1Id: bea,
              player2Id: opponent.id,
              changedSide: 'player1' as const,
              beforeEntrantId: bea,
              afterEntrantId: alice,
              downstream: [{ id: 'consolation-final', label: 'Upper Consolation Final' }],
            },
          }),
        };
        let preview: Preview = {
          allowed: false,
          issues: ['This correction changes more than one existing finals slot.'],
          qualifierChanges: [changed, companionChange],
          entrantNames,
        };
        const previews: unknown[] = [];
        fixture.queryResponses.set('eventOps.live.previewFinalsSlotReplay', (input) => {
          previews.push(input);
          return preview;
        });
        const submissions: Command[] = [];
        await page.route('**/api/trpc/eventOps.live.command*', async (route) => {
          const batched = new URL(route.request().url()).searchParams.has('batch');
          const body = route.request().postDataJSON();
          submissions.push(batched ? body[0] : body);
          if (reciprocal && submissions.length === 1) {
            preview = { ...approved, revisionToken: 'b'.repeat(64) };
            const conflict = {
              error: {
                message:
                  'Return any untaken call on the consolation route before reviewing this change.',
                code: -32009,
                data: { code: 'CONFLICT', httpStatus: 409 },
              },
            };
            await route.fulfill({ json: batched ? [conflict] : conflict });
            return;
          }
          if (submissions.length === (reciprocal ? 2 : 1)) {
            Object.assign(match, { revision: revision + 1, score2: 3, winnerId: bea });
            await route.abort();
            return;
          }
          const result = { result: { data: {} } };
          await route.fulfill({ json: batched ? [result] : result });
        });

        await page.goto(`/operate/${PLAN_ID}?view=history`);
        await page.getByRole('button', { name: 'Open match', exact: true }).click();
        await expect(page.locator('#match-desk')).toBeFocused();
        const card = page.locator('article.ops-match:visible').filter({ hasText: match.label });
        await card.getByRole('button', { name: 'Correct score' }).press('Enter');
        await card.getByRole('spinbutton').last().fill('3');
        await card.getByRole('button', { name: 'Review finals replay' }).press('Enter');
        const details = card.getByRole('region', { name: 'Finals replay review' });
        await expect(details).toBeFocused();
        await expect(details).toContainText('Consolation · Upper Pool A · place 3');
        await expect(details).toContainText('changes more than one existing finals slot');
        const apply = card.getByRole('button', {
          name: reciprocal
            ? 'Correct score and update both routes'
            : 'Correct score and create replay',
        });
        await expect(apply).toHaveCount(0);
        expect(submissions).toHaveLength(0);

        preview = approved;
        await card.getByRole('button', { name: 'Refresh finals review' }).press('Enter');
        await expect(details).toContainText(
          `Played set kept in history · ${entrantNames[alice]} 2–1 ${chris.name}`,
        );
        await expect(details).toContainText(
          `Replay pairing · ${entrantNames[bea]} vs ${chris.name}`,
        );
        await expect(details).toContainText('Waiting for the replay · Upper Championship Final');
        if (reciprocal) {
          await expect(details).toContainText(
            `Unplayed consolation pairing · ${entrantNames[bea]} vs ${entrantNames[opponent.id]}`,
          );
          await expect(details).toContainText(
            `Updated consolation pairing · ${entrantNames[alice]} vs ${entrantNames[opponent.id]}`,
          );
          await expect(details).toContainText(
            'Waiting for consolation result · Upper Consolation Final',
          );
        }
        await expect(apply).toBeDisabled();
        await card
          .getByRole('textbox', { name: 'Reason for replay' })
          .fill('Checked the pool sheet');
        await apply.scrollIntoViewIfNeeded();
        await checkRoute(page);
        await page.screenshot({ path: testInfo.outputPath('finals-replay-review.png') });
        if (reciprocal)
          await page.screenshot({
            path: testInfo.outputPath('reciprocal-finals-complete-route.png'),
            fullPage: true,
            style: readFileSync(bracketCaptureOptions.stylePath, 'utf8'),
          });
        await apply.press('Enter');
        const dialog = page.getByRole('alertdialog');
        await expect(dialog).toContainText(
          reciprocal
            ? 'update the unplayed consolation pairing'
            : 'Only the replay will advance in the bracket',
        );
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await checkRoute(page);
        await page.screenshot({ path: testInfo.outputPath('finals-replay-confirm.png') });
        await page.keyboard.press('Escape');
        await expect(apply).toBeFocused();
        expect(submissions).toHaveLength(0);

        await apply.press('Enter');
        await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
        await expect(card.getByRole('spinbutton').last()).toHaveValue('3');
        if (reciprocal) {
          await expect(page.getByRole('alert')).toContainText(
            'Return any untaken call on the consolation route',
          );
          await expect(card.getByRole('spinbutton').last()).toHaveValue('3');
          const rereview = card.getByRole('button', { name: 'Review finals replay' });
          await expect(rereview).toBeFocused();
          await rereview.press('Enter');
          await expect(card.getByRole('textbox', { name: 'Reason for replay' })).toHaveValue(
            'Checked the pool sheet',
          );
          await apply.press('Enter');
          await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
        }
        await expect(card.getByRole('textbox', { name: 'Reason for replay' })).toHaveValue(
          'Checked the pool sheet',
        );
        await card.getByRole('button', { name: 'Retry replay' }).press('Enter');
        await expect(
          page.getByText(
            reciprocal
              ? 'Pool score corrected · championship replay created and consolation pairing updated'
              : 'Pool score corrected · replay pairing created',
          ),
        ).toBeVisible();
        expect(submissions).toHaveLength(reciprocal ? 3 : 2);
        expect(submissions[0]).toMatchObject({
          planId: PLAN_ID,
          requestId: expect.any(String),
          command: {
            kind: reciprocal ? 'replayFinalsRoutesV2' : 'replayFinalsSlotV1',
            matchId: match.id,
            expectedRevision: revision,
            score1: 2,
            score2: 3,
            reason: 'Checked the pool sheet',
            revisionToken: approved.revisionToken,
          },
        });
        if (reciprocal) {
          expect(submissions[1]?.requestId).not.toBe(submissions[0]?.requestId);
          expect(submissions[1]?.command).toMatchObject({ revisionToken: 'b'.repeat(64) });
        }
        expect(submissions.at(-1)).toEqual(submissions.at(-2));
        expect(previews).toHaveLength(reciprocal ? 3 : 2);
        for (const input of previews)
          expect(input).toEqual({
            planId: PLAN_ID,
            matchId: match.id,
            expectedRevision: revision,
            score1: 2,
            score2: 3,
            reviewVersion: 2,
          });
        expect(fixture.unexpected).toEqual([]);
      });

    test(`keeps the original finals score in closed history at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { bracket: true });
      const [alice, bea] = fixture.snapshot.entrants;
      const active = fixture.snapshot.matches.find(({ id }) => id === 'fixture-semi-b')!;
      const archived = {
        matchId: 'superseded-played',
        replacementMatchId: active.id,
        bracketId: active.nativeBracketId,
        label: 'Upper Championship Semi-final',
        division: 'upper',
        stage: 'main',
        player1Id: alice!.id,
        player2Id: bea!.id,
        player1Name: 'Alice with a long tournament alias from Western Sydney',
        player2Name: 'Bea with another long tournament alias',
        score1: 2,
        score2: 1,
        winnerId: alice!.id,
        completedAt: '2026-10-03T23:59:00.000Z',
        advancementDisposition: 'superseded',
      };
      Object.assign(fixture.snapshot, { supersededPlayedSets: [archived] });
      fixture.snapshot.plan.status = 'complete';
      await page.goto(`/play/${PLAN_ID}#event-results`);
      const history = page.getByRole('region', { name: 'Played before a finals replay' });
      await expect(history).toContainText('The replay determines who advances.');
      await expect(history).toContainText(`${archived.player1Name} 2–1 ${archived.player2Name}`);
      await expect(history.getByRole('button')).toHaveCount(0);
      await expect(history.getByRole('link')).toHaveCount(0);
      await expect(page.locator('#event-brackets')).not.toContainText(archived.player1Name);
      await history.scrollIntoViewIfNeeded();
      await checkRoute(page);
      await page.screenshot({ path: testInfo.outputPath('archived-finals-player-hub.png') });
      expect(fixture.unexpected).toEqual([]);
    });
  }
