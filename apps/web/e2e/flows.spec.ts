import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * End-to-end flows against the dev harness: the real Fastify app, the real tRPC
 * router, the real auth bridge and the real recompute pipeline, on an in-process
 * Postgres seeded through the real Challonge sync.
 *
 * These cover the paths that only break when the pieces are wired together —
 * a session cookie reaching an admin procedure, a settings save triggering a
 * recompute, seeds surviving a reorder — which unit tests on either side cannot
 * see.
 */

const ADMIN = { email: 'admin@smashclub.dev', password: 'devpassword123' };

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
}

/** Player names are arbitrary strings; match them literally inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Signs in through the real credential endpoint. The harness enables
 * email/password auth (production has OAuth only), which is what makes the
 * better-auth ↔ Fastify session bridge testable at all.
 *
 * Must be called with `page.request`, not the standalone `request` fixture: the
 * fixture has its own cookie jar, so a session established through it would
 * never reach the page and every admin screen would render as anonymous.
 */
async function signInAsAdmin(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/auth/sign-in/email', { data: ADMIN });
  expect(response.ok(), `sign-in failed: ${response.status()} ${await response.text()}`).toBe(true);
}

test.describe('public browsing', () => {
  test('ranks on skill, shows uncertainty separately, and sorts from the header', async ({ page }) => {
    await page.goto('/');
    await settle(page);

    const rows = page.locator('.board-list .board-row');
    await expect(rows.first()).toBeVisible();
    const total = await rows.count();
    expect(total).toBeGreaterThan(10);

    // Uncertainty is published next to the rating, not folded into it.
    await expect(rows.first().locator('.rating-band')).toContainText('±');

    // Descending rating is the default order; ranks run 1, 2, 3…
    const ranks = await rows.locator('.rank').evaluateAll((nodes) =>
      nodes.slice(0, 5).map((node) => Number(node.textContent)),
    );
    expect(ranks).toEqual([1, 2, 3, 4, 5]);

    const ratings = await rows.locator('.rating-value').evaluateAll((nodes) =>
      nodes.slice(0, 5).map((node) => Number(node.textContent)),
    );
    expect([...ratings].sort((a, b) => b - a)).toEqual(ratings);

    // The column header is the sort control. Sorting by events reorders the board.
    await page.locator('.head-events').click();
    await settle(page);
    const events = await rows.locator('.events').evaluateAll((nodes) =>
      nodes.slice(0, 5).map((node) => Number(node.textContent)),
    );
    expect([...events].sort((a, b) => b - a)).toEqual(events);

    // Clicking again flips the direction.
    await page.locator('.head-events').click();
    await settle(page);
    const ascending = await rows.locator('.events').evaluateAll((nodes) =>
      nodes.slice(0, 5).map((node) => Number(node.textContent)),
    );
    expect([...ascending].sort((a, b) => a - b)).toEqual(ascending);
  });

  test('filters by name and clears back to the full field', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const rows = page.locator('.board-list .board-row');
    const total = await rows.count();

    const target = (await rows.first().locator('.identity-name').innerText()).trim();
    await page.getByPlaceholder('Player name…').fill(target.slice(0, 4));
    await settle(page);
    const filtered = await rows.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(total);

    await page.getByPlaceholder('Player name…').fill('');
    await settle(page);
    expect(await rows.count()).toBe(total);
  });

  test('a board row opens that player, whose page leads with skill and its band', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const name = (await page.locator('.board-row .identity-name').first().innerText()).trim();

    await page.locator('.board-row .board-link').first().click();
    await expect(page).toHaveURL(/\/players\//);
    await settle(page);

    // The board uppercases names in CSS, so compare case-insensitively.
    await expect(page.locator('.profile-name')).toHaveText(new RegExp(escapeRegExp(name), 'i'));
    await expect(page.locator('.headline-label')).toHaveText('Skill');
    await expect(page.locator('.headline-band')).toContainText('±');
    // Seeding is published as its own, separate figure.
    await expect(page.locator('.profile-stats')).toContainText('Seeding rating');
    // The match log lists real results.
    await expect(page.locator('.match-table tbody tr').first()).toBeVisible();
  });

  test('rating history compares a bounded set of players, each keeping its colour', async ({ page }) => {
    await page.goto('/');
    await settle(page);

    const legend = page.locator('.chart-legend .legend-item');
    const before = await legend.count();
    expect(before).toBeGreaterThan(1);

    const names = await legend.locator('.legend-name').allInnerTexts();
    const swatchColours = () =>
      legend.locator('.legend-swatch line').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('stroke')),
      );
    const coloursBefore = await swatchColours();

    // Removing one player must not repaint the others — colour follows the
    // player, not their position in the list.
    await legend.first().click();
    await settle(page);
    await expect(legend).toHaveCount(before - 1);
    const namesAfter = await legend.locator('.legend-name').allInnerTexts();
    expect(namesAfter).toEqual(names.slice(1));
    expect(await swatchColours()).toEqual(coloursBefore.slice(1));
  });
});

test.describe('auth bridge', () => {
  test('a credential session reaches an admin-only procedure', async ({ page }) => {
    // Anonymous callers are refused.
    const anonymous = await page.request.get('/api/trpc/admin.settings');
    expect(anonymous.status()).toBeGreaterThanOrEqual(400);

    await signInAsAdmin(page.request);

    // The same session now satisfies the admin procedure...
    const authorised = await page.request.get('/api/trpc/admin.settings');
    expect(authorised.ok(), `admin.settings rejected an admin session: ${authorised.status()}`).toBe(true);

    // ...and the UI reflects the role: the Admin nav entry only exists for admins.
    await page.goto('/');
    await settle(page);
    await expect(page.locator('.app-nav .nav-link', { hasText: 'Admin' })).toBeVisible();
    await expect(page.locator('.user-chip')).toBeVisible();
  });

  test('the account page offers a claim and search finds a player to claim', async ({ page }) => {
    await signInAsAdmin(page.request);
    await page.goto('/me');
    await settle(page);
    await expect(page.locator('.me-account .account-name')).toBeVisible();

    const search = page.locator('.claim-form-row .input').first();
    await search.fill('a');
    await settle(page);
    await expect(page.locator('.claim-search-results li').first()).toBeVisible();
  });
});

test.describe('admin', () => {
  test('the review queue resolves an item and the queue shrinks', async ({ page }) => {
    await signInAsAdmin(page.request);
    await page.goto('/admin/review');
    await settle(page);

    const cards = page.locator('.review-card');
    const before = await cards.count();
    test.skip(before === 0, 'nothing pending review in this seed');

    // "Keep separate" rejects the suggested candidates — the safe resolution, and
    // the one that must never be applied automatically by a fuzzy name match.
    await cards.first().getByRole('button', { name: /Keep separate/i }).click();
    await expect(cards).toHaveCount(before - 1, { timeout: 30_000 });
  });

  test('seeding generates from the leaderboard, reorders, and survives a reload', async ({ page }) => {
    await signInAsAdmin(page.request);
    await page.goto('/admin/seeding');
    await settle(page);

    const select = page.locator('select.select').first();
    const values = await select.locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
    );
    test.skip(values.length === 0, 'no tournaments to seed in this seed');
    await select.selectOption(values[0]!);
    await settle(page);

    const generate = page.getByRole('button', { name: /Generate seeding/i });
    if (await generate.count()) {
      await generate.click();
    }
    const rows = page.locator('.seeding-list .seeding-row');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });

    // Seeds are dense and start at 1.
    const seeds = await rows.locator('.seed-number').evaluateAll((nodes) =>
      nodes.map((node) => Number(node.textContent)),
    );
    expect(seeds).toEqual(seeds.map((_, index) => index + 1));

    /*
     * Locking a seed is the manual override, and it survives a reload. Toggle
     * whichever way the seed currently sits rather than assuming it starts
     * unlocked: the harness is reused between runs (reuseExistingServer), so a
     * previous run may already have locked it.
     */
    const secondName = (await rows.nth(1).locator('.seeding-name').innerText()).trim();
    const toggle = rows.nth(1).getByRole('button', { name: /^(Un)?lock seed \d+/i });
    const wasLocked = /^Unlock/i.test((await toggle.getAttribute('aria-label')) ?? '');
    await toggle.click();

    const expected = wasLocked ? /^Lock seed \d+ in place/i : /^Unlock seed \d+/i;
    await expect(rows.nth(1).getByRole('button', { name: expected })).toBeVisible();

    await page.reload();
    await settle(page);
    // The tournament choice is page state, not a route, so re-pick it after reload.
    await page.locator('select.select').first().selectOption(values[0]!);
    await settle(page);

    const reloaded = page.locator('.seeding-list .seeding-row');
    // Names are uppercased in CSS, so the rendered read is not case-comparable.
    await expect(reloaded.nth(1)).toContainText(new RegExp(escapeRegExp(secondName), 'i'));
    await expect(reloaded.nth(1).getByRole('button', { name: expected })).toBeVisible();
  });

  test('model comparison fits both models and publishes neither', async ({ page }) => {
    await signInAsAdmin(page.request);

    const before = await (await page.request.get('/api/trpc/public.leaderboard')).json();
    const modelBefore = (before.result?.data ?? before).model;

    await page.goto('/admin/settings');
    await settle(page);
    await page.getByRole('button', { name: /Run comparison/i }).click();

    const stats = page.locator('.comparison-stats');
    await expect(stats).toBeVisible({ timeout: 120_000 });
    await expect(stats).toContainText('Median rank move');
    // Both models produced a rank for the rows shown.
    await expect(page.locator('.model-comparison tbody tr').first()).toBeVisible();
    const firstRow = await page.locator('.model-comparison tbody tr').first().innerText();
    expect(firstRow).toMatch(/#\d+/);

    // Read-only: the published model is untouched until the setting is saved.
    const after = await (await page.request.get('/api/trpc/public.leaderboard')).json();
    expect((after.result?.data ?? after).model).toBe(modelBefore);
  });

  test('switching the active model recomputes and republishes under that model', async ({ page }) => {
    await signInAsAdmin(page.request);
    await page.goto('/admin/settings');
    await settle(page);

    await page.locator('select.select').first().selectOption('whr');
    await page.getByRole('button', { name: /Save settings/i }).click();
    await expect(page.getByText(/recompute queued/i)).toBeVisible({ timeout: 60_000 });

    // Poll the public read until the new model lands — the recompute is async.
    await expect
      .poll(
        async () => {
          const body = await (await page.request.get('/api/trpc/public.leaderboard')).json();
          const data = body.result?.data ?? body;
          return data.rows.length > 0 ? data.model : null;
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe('whr');

    await page.goto('/');
    await settle(page);
    await expect(page.locator('.hero-meta')).toContainText('whr');
    // The board still ranks and still publishes a ± band under the other model.
    await expect(page.locator('.board-row .rating-band').first()).toContainText('±');

    // Put it back, so this test does not decide what the next one sees.
    await page.goto('/admin/settings');
    await settle(page);
    await page.locator('select.select').first().selectOption('glicko2');
    await page.getByRole('button', { name: /Save settings/i }).click();
    await expect(page.getByText(/recompute queued/i)).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(
        async () => {
          const body = await (await page.request.get('/api/trpc/public.leaderboard')).json();
          const data = body.result?.data ?? body;
          return data.rows.length > 0 ? data.model : null;
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe('glicko2');
  });
});
