import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * The event planner, end to end against the dev harness.
 *
 * This is the flow the club runs the night on, so what it checks is the night's
 * shape rather than any one screen: a messy paste resolves, the divisions come
 * off a frozen snapshot, the pools stripe, and — the part no unit test can see
 * — the whole thing is recoverable from the URL, because in practice it is set
 * up on a laptop and finished on somebody's phone.
 */

const ADMIN = { email: 'admin@smashclub.dev', password: 'devpassword123' };

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
}

async function signInAsAdmin(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/auth/sign-in/email', { data: ADMIN });
  expect(response.ok(), `sign-in failed: ${response.status()} ${await response.text()}`).toBe(true);
}

/**
 * Sixteen ranked club members, chosen through the planner's own preview.
 *
 * Asking the API which names it can resolve *and* rank is the only way to build
 * a paste the harness will accept whatever it seeded: an unranked entrant needs
 * an explicit division, which is a different test than this one.
 */
async function rankedNames(request: APIRequestContext, count: number): Promise<string[]> {
  const players = await (await request.get('/api/trpc/admin.players')).json();
  const roster = (players.result?.data ?? players) as Array<{ canonicalName: string; status: string }>;
  const active = roster.filter((player) => player.status === 'active').map((player) => player.canonicalName);

  const preview = await request.post('/api/trpc/admin.eventPlanner.previewRoster', {
    data: { text: active.join('\n') },
  });
  expect(preview.ok(), `previewRoster failed: ${preview.status()} ${await preview.text()}`).toBe(true);
  const body = await preview.json();
  const rows = (body.result?.data ?? body) as Array<{
    cleanedName: string;
    playerId: string | null;
    currentRank: number | null;
  }>;
  const usable = rows
    .filter((row) => row.playerId !== null && row.currentRank !== null)
    .sort((a, b) => a.currentRank! - b.currentRank!)
    .map((row) => row.cleanedName);
  return usable.slice(0, count);
}

test.describe('event planner', () => {
  test('paste, resolve, freeze, pool and recover from the URL', async ({ page }) => {
    await signInAsAdmin(page.request);
    const names = await rankedNames(page.request, 16);
    test.skip(names.length < 16, 'the harness seeded fewer than 16 ranked players');

    // A real paste: bullets, numbering, stray whitespace and a rule.
    const pasted = names
      .map((name, index) => {
        if (index === 0) return `1. ${name}`;
        if (index === 1) return `- ${name}`;
        if (index === 2) return `  ${name}  `;
        return name;
      })
      .join('\n');
    const planName = `E2E Club Night ${Date.now()}`;

    await page.goto('/admin/event-planner');
    await settle(page);

    await page.getByLabel(/Event name/i).fill(planName);
    await page.locator('textarea.planner-textarea').first().fill([pasted, '---', ''].join('\n'));
    await page.getByRole('button', { name: /Preview roster/i }).click();
    await settle(page);

    // The rule and the blank line are decoration, not people.
    await expect(page.locator('.preview-summary')).toContainText('16');
    await page.locator('.preview-summary select.select').selectOption('8');
    await page.getByRole('button', { name: /^Save plan$/i }).click();
    await settle(page);

    // Saving puts the plan in the URL, which is what makes it resumable.
    await expect(page).toHaveURL(/plan=/);
    await expect(page.locator('h2')).toContainText(planName);
    const rows = page.locator('.roster-table .roster-row').filter({ hasNot: page.locator('.roster-head') });
    await expect(page.locator('.roster-row.roster-head')).toHaveCount(1);
    await expect(page.locator('.roster-row.unresolved')).toHaveCount(0);

    // The pasted line is kept beside what the club thinks it means.
    await expect(rows.nth(1)).toContainText(`1. ${names[0]}`);

    await page.getByRole('button', { name: /Freeze roster/i }).click();
    await settle(page);

    // Divisions come off the frozen snapshot: eight and eight, seeded 1..8.
    await expect(page.locator('.division-column')).toHaveCount(2);
    const upper = page.locator('.division-column').first();
    await expect(upper.locator('.division-row')).toHaveCount(8);
    const seeds = await upper.locator('.division-row .seed-number').evaluateAll((nodes) =>
      nodes.map((node) => Number(node.textContent)),
    );
    expect(seeds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(page.getByText(/Ranking snapshot:/i)).toBeVisible();

    // A keyboard-only reorder: the move buttons, not the drag handle.
    const secondName = (await upper.locator('.division-row').nth(1).locator('.division-name').innerText()).trim();
    await upper.locator('.division-row').nth(1).getByRole('button', { name: /Move .* up/i }).click();
    await settle(page);
    await expect(upper.locator('.division-row').first().locator('.division-name')).toContainText(secondName);

    await page.getByRole('button', { name: /Generate pools/i }).click();
    await settle(page);

    // Four pools of four, striped across both divisions.
    await expect(page.locator('.pool-card')).toHaveCount(4);
    for (const card of await page.locator('.pool-card').all()) {
      await expect(card.locator('.pool-members li')).toHaveCount(4);
    }

    // A refresh at this step lands back on the same plan, same step.
    const url = page.url();
    await page.reload();
    await settle(page);
    expect(page.url()).toBe(url);
    await expect(page.locator('h2')).toContainText(planName);
    await expect(page.locator('.pool-card')).toHaveCount(4);

    // The manual handoff is available and carries names, not pasted lines.
    await page.getByRole('button', { name: /^Challonge$/ }).click();
    await settle(page);
    const participants = page.locator('.bracket-card').first().locator('textarea.copy-block-text').first();
    const exported = await participants.inputValue();
    expect(exported.split('\n')).toHaveLength(8);
    expect(exported).not.toContain('1. ');
    await expect(page.locator('.bracket-card')).toHaveCount(4);
  });

  test('records pool results and warns about unavoidable single-pool consolation rematches', async ({ page }) => {
    await signInAsAdmin(page.request);
    const names = await rankedNames(page.request, 8);
    test.skip(names.length < 8, 'the harness seeded fewer than 8 ranked players');

    const planName = `E2E Consolation ${Date.now()}`;
    await page.goto('/admin/event-planner');
    await settle(page);
    await page.getByLabel(/Event name/i).fill(planName);
    await page.locator('textarea.planner-textarea').first().fill(names.join('\n'));
    await page.getByRole('button', { name: /Preview roster/i }).click();
    await settle(page);
    await page.locator('.preview-summary select.select').selectOption('4');
    await page.getByRole('button', { name: /^Save plan$/i }).click();
    await settle(page);
    await page.getByRole('button', { name: /Freeze roster/i }).click();
    await settle(page);
    await page.getByRole('button', { name: /Generate pools/i }).click();
    await settle(page);

    // Two pools of four — one per division. Record both in seed order.
    const cards = page.locator('.pool-card');
    await expect(cards).toHaveCount(2);
    for (let cardIndex = 0; cardIndex < 2; cardIndex++) {
      const card = cards.nth(cardIndex);
      const options = await card
        .locator('.pool-place select')
        .first()
        .locator('option')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter(Boolean));
      for (const [place, value] of options.entries()) {
        await card.locator('.pool-place select').nth(place).selectOption(value);
      }
      await card.getByRole('button', { name: /Confirm pool/i }).click();
      await settle(page);
    }

    // Each division has one pool, so its consolation final is the unavoidable
    // rematch — and the app says so rather than pretending otherwise.
    await expect(page.getByRole('heading', { name: 'Consolation draw', exact: true })).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Championship qualifiers', exact: true })).toHaveCount(2);
    await expect(page.locator('.consolation-list li').first()).toContainText('A3');
    await expect(page.getByText(/Pool rematch in round one/i)).toHaveCount(2);
  });
});
