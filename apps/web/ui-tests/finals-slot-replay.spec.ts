import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { trpc } from '../src/lib/trpc';
import { mockEvent, PLAN_ID, ready, type FixtureOptions } from './fixtures';

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
    test(`reviews an already-played finals slot at ${width}px in ${theme}`, async ({
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
      const entrantNames = {
        [alice]: 'Alice with a long tournament alias from Western Sydney',
        [bea]: 'Bea with another long tournament alias',
        [chris.id]: chris.name,
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
      const approved: Preview = {
        allowed: true,
        issues: [],
        qualifierChanges: [changed],
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
      };
      let preview: Preview = {
        allowed: false,
        issues: ['This correction changes more than one existing finals slot.'],
        qualifierChanges: [
          changed,
          { ...changed, stage: 'consolation', bracketId: 'upper-consolation', place: 3 },
        ],
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
        if (submissions.length === 1) {
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
      const apply = card.getByRole('button', { name: 'Correct score and create replay' });
      await expect(apply).toHaveCount(0);
      expect(submissions).toHaveLength(0);

      preview = approved;
      await card.getByRole('button', { name: 'Refresh finals review' }).press('Enter');
      await expect(details).toContainText(
        `Played set kept in history · ${entrantNames[alice]} 2–1 ${chris.name}`,
      );
      await expect(details).toContainText(`Replay pairing · ${entrantNames[bea]} vs ${chris.name}`);
      await expect(details).toContainText('Waiting for the replay · Upper Championship Final');
      await expect(apply).toBeDisabled();
      await card.getByRole('textbox', { name: 'Reason for replay' }).fill('Checked the pool sheet');
      await apply.scrollIntoViewIfNeeded();
      await checkRoute(page);
      await page.screenshot({ path: testInfo.outputPath('finals-replay-review.png') });
      await apply.press('Enter');
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('Only the replay will advance in the bracket');
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await checkRoute(page);
      await page.screenshot({ path: testInfo.outputPath('finals-replay-confirm.png') });
      await page.keyboard.press('Escape');
      await expect(apply).toBeFocused();
      expect(submissions).toHaveLength(0);

      await apply.press('Enter');
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
      await expect(card.getByRole('spinbutton').last()).toHaveValue('3');
      await expect(card.getByRole('textbox', { name: 'Reason for replay' })).toHaveValue(
        'Checked the pool sheet',
      );
      await card.getByRole('button', { name: 'Retry replay' }).press('Enter');
      await expect(page.getByText('Pool score corrected · replay pairing created')).toBeVisible();
      expect(submissions).toHaveLength(2);
      expect(submissions[0]).toMatchObject({
        planId: PLAN_ID,
        requestId: expect.any(String),
        command: {
          kind: 'replayFinalsSlotV1',
          matchId: match.id,
          expectedRevision: revision,
          score1: 2,
          score2: 3,
          reason: 'Checked the pool sheet',
          revisionToken: approved.revisionToken,
        },
      });
      expect(submissions[1]).toEqual(submissions[0]);
      expect(previews).toEqual([
        { planId: PLAN_ID, matchId: match.id, expectedRevision: revision, score1: 2, score2: 3 },
        { planId: PLAN_ID, matchId: match.id, expectedRevision: revision, score1: 2, score2: 3 },
      ]);
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
