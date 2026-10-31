import { expect, test, type Locator, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { bracketFixture, TEAM_ALIAS } from '../test/fixtures/brackets';
import { mockEvent, PLAN_ID, ready } from './fixtures';

async function graphFixture(page: Page, size = 7, double = true) {
  const fixture = await mockEvent(page, { bracket: true });
  const matches = bracketFixture(size, double);
  const played = matches.find((match) => match.player1Id && match.player2Id);
  if (played)
    Object.assign(played, {
      status: 'complete',
      outcome: 'played',
      winnerId: played.player2Id,
      score1: 1,
      score2: 2,
    });
  Object.assign(fixture.snapshot, {
    matches,
    stationQueues: [],
    poolRounds: [],
    poolSchedules: [],
    nativeBrackets: [
      {
        id: 'rehearsal',
        division: 'upper',
        stage: 'main',
        entrantIds: Array.from({ length: size }, (_, i) => `entrant-${i}`),
        complete: false,
        winnerId: null,
        standings: [],
      },
    ],
    entrants: Array.from({ length: size }, (_, i) => ({
      id: `entrant-${i}`,
      name: i === 0 ? TEAM_ALIAS : `Entrant ${i + 1}`,
    })),
  });
  return { fixture, matches };
}

async function boundedCards(brackets: Locator) {
  const canvases = brackets.locator('.event-bracket-canvas');
  for (const canvas of await canvases.all()) {
    const geometry = await canvas.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        cards: [...element.querySelectorAll<HTMLElement>('.event-bracket-match')].map((card) => {
          const box = card.getBoundingClientRect();
          return {
            id: card.dataset.matchId,
            x: box.x - bounds.x,
            y: box.y - bounds.y,
            width: box.width,
            height: box.height,
            clipped:
              card.scrollHeight > card.clientHeight + 1 || card.scrollWidth > card.clientWidth + 1,
          };
        }),
      };
    });
    for (const card of geometry.cards) {
      expect(card.clipped, card.id).toBe(false);
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.y).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(geometry.width + 1);
      expect(card.y + card.height).toBeLessThanOrEqual(geometry.height + 1);
      expect(
        geometry.cards.filter(
          (other) =>
            other.id !== card.id &&
            card.x < other.x + other.width &&
            card.x + card.width > other.x &&
            card.y < other.y + other.height &&
            card.y + card.height > other.y,
        ),
        card.id,
      ).toEqual([]);
    }
  }
}

/** SVG endpoints must follow the intended participant after real text wrapping. */
async function connectedRows(brackets: Locator) {
  await expect
    .poll(async () =>
      brackets.locator('.event-bracket-canvas').evaluateAll((canvases) => {
        const errors: string[] = [];
        for (const canvas of canvases) {
          const bounds = canvas.getBoundingClientRect();
          const cards = [...canvas.querySelectorAll<HTMLElement>('.event-bracket-match')];
          for (const path of canvas.querySelectorAll<SVGPathElement>('path[data-feed-from]')) {
            const source = cards.find((card) => card.dataset.matchId === path.dataset.feedFrom)!;
            const target = cards.find((card) => card.dataset.matchId === path.dataset.feedTo)!;
            const sourceBox = source.getBoundingClientRect(),
              targetBox = target.getBoundingClientRect();
            const sourceRows = [...source.querySelectorAll<HTMLElement>(':scope > div')];
            const winner = sourceRows.find((row) => row.classList.contains('is-winner'));
            const sourceRow =
              path.dataset.feedOutcome === 'winner'
                ? winner
                : winner && sourceRows.find((row) => row !== winner && row.dataset.entrantId);
            const targetRow =
              target.querySelectorAll<HTMLElement>(':scope > div')[Number(path.dataset.feedSide)]!;
            const rowCenter = (row: HTMLElement) => {
              const box = row.getBoundingClientRect();
              return box.y + box.height / 2 - bounds.y;
            };
            const start = path.getPointAtLength(0),
              end = path.getPointAtLength(path.getTotalLength());
            if (
              Math.abs(start.x - (sourceBox.right - bounds.x)) > 1 ||
              Math.abs(
                start.y -
                  (sourceRow
                    ? rowCenter(sourceRow)
                    : sourceBox.y + sourceBox.height / 2 - bounds.y),
              ) > 1 ||
              Math.abs(end.x - (targetBox.left - bounds.x)) > 1 ||
              Math.abs(end.y - rowCenter(targetRow)) > 1
            )
              errors.push(
                `${path.dataset.feedFrom} -> ${path.dataset.feedTo}:${path.dataset.feedSide}`,
              );
          }
        }
        return errors;
      }),
    )
    .toEqual([]);
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px double elimination preserves sources, geometry and keyboard scrolling`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      const { fixture, matches } = await graphFixture(page);
      await page.goto(`/live/${PLAN_ID}`);
      const brackets = page.locator('.event-brackets');
      await expect(
        brackets.getByRole('heading', { name: 'Winners bracket', exact: true }),
      ).toBeVisible();
      await expect(
        brackets.getByRole('heading', { name: 'Losers bracket', exact: true }),
      ).toBeVisible();
      await expect(
        brackets.getByRole('heading', { name: 'Grand final and reset', exact: true }),
      ).toBeVisible();
      await expect(brackets.locator('.event-bracket-match')).toHaveCount(matches.length);
      await expect(brackets).toContainText(TEAM_ALIAS);
      await expect(brackets).toContainText('Scroll sideways to follow later rounds.');
      await expect(brackets).toContainText('Loser of winners 1');
      await expect(brackets).toContainText('Reset final · If needed');
      await expect(brackets).not.toContainText('Winner ·');
      const reset = matches.find((match) => match.bracketLane === 'reset')!;
      await expect(brackets.locator(`path[data-feed-to="${reset.id}"]`)).toHaveCount(2);
      const lower = matches.find((match) => match.bracketLane === 'losers')!;
      await expect(brackets.locator(`path[data-feed-to="${lower.id}"]`)).toHaveCount(0);
      await ready(page);
      await boundedCards(brackets);
      await connectedRows(brackets);
      await page.setViewportSize({ width: width === 390 ? 780 : 390, height: 900 });
      await boundedCards(brackets);
      await connectedRows(brackets);
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.event-brackets')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      const scroll = brackets.locator('.event-bracket-rounds').first();
      await scroll.focus();
      await expect(scroll).toBeFocused();
      if (width === 390) {
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }
      await scroll.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      const finalCard = scroll.locator('.event-bracket-match').last();
      await finalCard.scrollIntoViewIfNeeded();
      await expect(finalCard).toBeInViewport({ ratio: 1 });
      await scroll.evaluate((node) => {
        node.scrollLeft = 0;
      });
      await testInfo.attach(`double-elimination-${theme}-${width}`, {
        body: await brackets.screenshot(),
        contentType: 'image/png',
      });
      expect(fixture.unexpected).toEqual([]);
    });

test('completed byes and no contests do not claim unresolved entrants or a result winner', async ({
  page,
}) => {
  const { fixture, matches } = await graphFixture(page, 3);
  const lower = matches.find((match) => match.bracketLane === 'losers')!;
  const secondLower = matches.find(
    (match) => match.bracketLane === 'losers' && match.id !== lower.id,
  )!;
  Object.assign(lower, {
    status: 'complete',
    outcome: null,
    winnerId: null,
    blockedReason: 'Both players withdrawn: no contest; no winner or score recorded',
  });
  Object.assign(secondLower, {
    status: 'complete',
    outcome: 'bye',
    player1Id: 'entrant-0',
    player1Name: TEAM_ALIAS,
    player2Id: null,
    winnerId: 'entrant-0',
  });
  await page.goto(`/live/${PLAN_ID}`);
  const brackets = page.locator('.event-brackets');
  const noContest = brackets
    .locator('.event-bracket-match')
    .filter({ has: page.locator('small').filter({ hasText: lower.label }) });
  await expect(noContest.locator('small')).toContainText('No contest');
  await expect(noContest).not.toContainText('Winner of');
  await expect(noContest.locator('.is-winner')).toHaveCount(0);
  const bye = brackets
    .locator('.event-bracket-match')
    .filter({ has: page.locator('small').filter({ hasText: secondLower.label }) });
  await expect(bye).toContainText('Bye');
  await expect(bye).not.toContainText('Winner of');
  await expect(bye).not.toContainText('Loser of');
  expect(fixture.unexpected).toEqual([]);
});

test('changed result and grand-final completion update the draw without inventing a reset', async ({
  page,
}) => {
  const { fixture, matches } = await graphFixture(page, 4);
  const match = matches.find((match) => match.player1Id && match.player2Id)!;
  Object.assign(match, {
    status: 'complete',
    outcome: 'played',
    winnerId: match.player1Id,
    score1: 2,
    score2: 1,
  });
  await page.goto(`/live/${PLAN_ID}`);
  const card = page.locator(`[data-match-id="${match.id}"]`);
  await expect(card.locator('.is-winner')).toContainText(match.player1Name!);
  Object.assign(match, { winnerId: match.player2Id, score1: 1, score2: 2 });
  const reset = matches.find((match) => match.bracketLane === 'reset')!;
  const completed = matches.filter((match) => match.id !== reset.id);
  for (const current of completed) {
    if (current.status === 'complete') continue;
    const entrant = (side: 0 | 1) => {
      const parentId = side === 0 ? current.parent1MatchId : current.parent2MatchId;
      const outcome = side === 0 ? current.parent1Outcome : current.parent2Outcome;
      if (!parentId) return side === 0 ? current.player1Id : current.player2Id;
      const parent = completed.find((match) => match.id === parentId)!;
      return outcome === 'loser'
        ? ([parent.player1Id, parent.player2Id].find((id) => id && id !== parent.winnerId) ?? null)
        : parent.winnerId;
    };
    const [a, b] = [entrant(0), entrant(1)];
    Object.assign(current, {
      player1Id: a,
      player2Id: b,
      player1Name: fixture.snapshot.entrants.find((entrant) => entrant.id === a)?.name ?? null,
      player2Name: fixture.snapshot.entrants.find((entrant) => entrant.id === b)?.name ?? null,
      status: 'complete',
      winnerId: a ?? b,
      outcome: a && b ? 'played' : a || b ? 'bye' : null,
      score1: a && b ? 2 : null,
      score2: a && b ? 0 : null,
    });
  }
  const champion = completed.find((match) => match.bracketLane === 'final')!.winnerId!;
  const championName = fixture.snapshot.entrants.find((entrant) => entrant.id === champion)!.name;
  Object.assign(fixture.snapshot, {
    matches: completed,
    nativeBrackets: [
      {
        ...fixture.snapshot.nativeBrackets[0],
        complete: true,
        winnerId: champion,
        standings: [{ playerId: champion, place: 1 }],
      },
    ],
  });
  await page.reload();
  await expect(card.locator('.is-winner')).toContainText(match.player2Name!);
  await expect(page.locator('.event-brackets')).toContainText(`Winner · ${championName}`);
  await expect(page.locator(`[data-match-id="${reset.id}"]`)).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

for (const size of [0, 1])
  test(`${size}-entrant completed bracket has an explicit outcome and no invented match`, async ({
    page,
  }) => {
    const { fixture } = await graphFixture(page, size);
    Object.assign(fixture.snapshot, {
      nativeBrackets: [
        {
          ...fixture.snapshot.nativeBrackets[0],
          complete: true,
          winnerId: size ? 'entrant-0' : null,
        },
      ],
    });
    await page.goto(`/live/${PLAN_ID}`);
    const brackets = page.locator('.event-brackets');
    await expect(brackets).toContainText(
      size ? 'One entrant advances without a played set.' : 'Empty bracket — no entrants.',
    );
    await expect(brackets.locator('.event-bracket-match')).toHaveCount(size);
    if (!size) await expect(brackets.getByRole('region')).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });

test('unpublished draw stays pending and linked historical brackets remain discoverable', async ({
  page,
}) => {
  const { fixture } = await graphFixture(page, 0);
  Object.assign(fixture.snapshot.plan, { bracketMode: 'challonge' });
  Object.assign(fixture.snapshot, {
    brackets: [{ division: 'upper', stage: 'main', slug: 'synthetic rehearsal' }],
  });
  await page.goto(`/live/${PLAN_ID}`);
  const brackets = page.locator('.event-brackets');
  await expect(brackets).toContainText(
    'The draw will appear when the organisers publish the bracket.',
  );
  await expect(brackets.locator('.event-bracket-match')).toHaveCount(0);
  await expect(brackets).not.toContainText('Winner ·');
  await expect(
    brackets.getByRole('navigation', { name: 'Challonge brackets' }).getByRole('link'),
  ).toHaveAttribute('href', 'https://challonge.com/synthetic%20rehearsal');
  expect(fixture.unexpected).toEqual([]);
});

test('multiple division and stage brackets keep their own labels, matches, scores and local feeds', async ({
  page,
}) => {
  const { fixture } = await graphFixture(page, 0);
  const scopes = [
    ['upper', 'main'],
    ['upper', 'consolation'],
    ['lower', 'main'],
    ['lower', 'consolation'],
  ] as const;
  const matches = scopes.flatMap(([division, stage], index) => {
    const prefix = `${division}:${stage}:`;
    return bracketFixture(4, false).map((match, slot) => ({
      ...match,
      id: prefix + match.id,
      nativeBracketId: prefix,
      division,
      stage,
      label: prefix + match.label,
      parent1MatchId: match.parent1MatchId ? prefix + match.parent1MatchId : null,
      parent2MatchId: match.parent2MatchId ? prefix + match.parent2MatchId : null,
      player1Name: match.player1Id ? prefix + match.player1Id : null,
      player2Name: match.player2Id ? prefix + match.player2Id : null,
      ...(slot === 0
        ? {
            status: 'complete',
            outcome: 'played',
            winnerId: match.player1Id,
            score1: index + 1,
            score2: 0,
          }
        : {}),
    }));
  });
  Object.assign(fixture.snapshot, {
    matches,
    nativeBrackets: scopes.map(([division, stage]) => ({
      id: `${division}:${stage}:`,
      division,
      stage,
      entrantIds: [],
      complete: false,
      winnerId: null,
      standings: [],
    })),
  });
  await page.goto(`/live/${PLAN_ID}`);
  const brackets = page.locator('.event-brackets');
  await expect(brackets.locator('.event-bracket')).toHaveCount(4);
  for (const [index, [division, stage]] of scopes.entries()) {
    const prefix = `${division}:${stage}:`;
    const bracket = brackets.locator('.event-bracket').filter({
      has: page.getByRole('heading', {
        name: `${division} · ${stage === 'main' ? 'Championship' : 'Consolation'}`,
        exact: true,
      }),
    });
    await expect(bracket.locator('.event-bracket-match')).toHaveCount(3);
    await expect(bracket).toContainText(`Winner of ${prefix}Round 1`);
    await expect(bracket.getByLabel(`Score ${index + 1}`, { exact: true })).toHaveCount(1);
    const ids = await bracket
      .locator('.event-bracket-match')
      .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.matchId!));
    expect(ids.every((id) => id.startsWith(prefix))).toBe(true);
    expect(
      await bracket
        .locator('path')
        .evaluateAll(
          (paths, prefix) =>
            paths.every(
              (path) =>
                (path as SVGPathElement).dataset.feedFrom!.startsWith(prefix) &&
                (path as SVGPathElement).dataset.feedTo!.startsWith(prefix),
            ),
          prefix,
        ),
    ).toBe(true);
  }
  const ids = await brackets
    .locator('.event-bracket-match')
    .evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.matchId));
  expect(new Set(ids).size).toBe(12);
  expect(fixture.unexpected).toEqual([]);
});
