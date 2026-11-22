import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';
import type { EventPlanDivision, EventPlanView } from '../src/lib/apiTypes';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const planName = 'Nemesis · Club night setup';
const planPath = '/admin/event-planner';
const aliases = [
  'Alex with a long tournament alias',
  'BucketCrab',
  'Saltwater Sentinel of the Eastern Coast',
  'RightAngle',
  'Harbour Lantern Collector',
  'Parallax',
  'Sunset Observatory Recording Desk',
  'Canary',
];
const unrankedAlias = aliases[0]!;

function draftPlan(): EventPlanView {
  return {
    plan: {
      id: PLAN_ID,
      name: planName,
      eventDate: '2026-10-05T08:00:00Z',
      slugPrefix: null,
      status: 'draft',
      bracketMode: 'native',
      competitionFormat: 'singles',
      structure: 'dual_division',
      structureOptions: { roundRobinMeetings: 1 },
      nativeSeedContext: null,
      historicalAdoption: null,
      softLockedAt: null,
      softLockedBy: null,
      upperTargetSize: 4,
      poolSize: 4,
      rankingSnapshotAt: null,
      createdAt: '2026-10-04T00:00:00Z',
    },
    entries: aliases.map((alias, i) => ({
      id: `entry-${i}`,
      sourceLineNumber: i + 1,
      rawInput: alias,
      cleanedName: alias,
      playerName: alias,
      publicName: alias,
      companyCode: null,
      playerId: `player-${i}`,
      playerStatus: 'active',
      divisionPreference: 'auto',
      assignedDivision: null,
      divisionSeed: null,
      resolutionMethod: 'manual',
      snapshotRank: null,
      snapshotScore: null,
      currentRank: i === 0 ? null : i,
      currentScore: i === 0 ? null : 1250 - i,
      lastPlayedDate: null,
      candidates: [],
    })),
    divisions: [],
    brackets: [],
    issues: {
      blocking: [
        {
          code: 'unranked_needs_division',
          message: '1 entrant has no club ranking. Choose Upper or Lower for them.',
          entryIds: ['entry-0'],
        },
      ],
      warnings: [],
    },
  };
}

function freezeDraft(view: EventPlanView) {
  view.plan.status = 'roster_frozen';
  view.plan.rankingSnapshotAt = '2026-10-04T00:00:00Z';
  view.divisions = (['upper', 'lower'] as const).map((division, i): EventPlanDivision => {
    const members = view.entries.slice(i * 4, (i + 1) * 4).map((entry, j) => {
      entry.assignedDivision = division;
      entry.divisionSeed = j + 1;
      entry.snapshotRank = entry.currentRank;
      return {
        entryId: entry.id,
        playerId: entry.playerId!,
        name: entry.publicName!,
        seed: entry.divisionSeed,
        snapshotRank: entry.snapshotRank,
        place: null,
      };
    });
    return {
      division,
      size: members.length,
      poolCount: 1,
      pools: [{ poolIndex: 0, label: 'A', members }],
      consolation: null,
      championship: [],
    };
  });
}

async function expectBefore(first: Locator, next: Locator) {
  await expect(first).toBeVisible();
  await expect(next).toBeVisible();
  await expect
    .poll(async () => (await first.boundingBox())!.y)
    .toBeLessThan((await next.boundingBox())!.y);
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`the active setup step leads saved-plan entry at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page, { role: 'admin' });
      const view = draftPlan();
      const mutations: { operation: string; input: unknown }[] = [];
      Object.assign(fixture.responses, {
        'admin.eventPlanner.plans': [
          {
            id: PLAN_ID,
            name: planName,
            eventDate: view.plan.eventDate,
            status: 'draft',
            entryCount: 8,
          },
        ],
        'admin.eventPlanner.plan': view,
        'admin.eventPlanner.projectTournament': { formats: [] },
        'admin.eventPlanner.historicalCandidates': [],
      });
      fixture.mutationResponses.set('admin.eventPlanner.updateEntry', (input) => {
        mutations.push({ operation: 'updateEntry', input });
        view.entries[0]!.divisionPreference = 'upper';
        view.issues.blocking = [];
        return {};
      });
      fixture.mutationResponses.set('admin.eventPlanner.freezeRoster', (input) => {
        mutations.push({ operation: 'freezeRoster', input });
        freezeDraft(view);
        return {};
      });
      fixture.mutationResponses.set('admin.eventPlanner.generatePools', (input) => {
        mutations.push({ operation: 'generatePools', input });
        view.plan.status = 'pools_ready';
        return {};
      });

      const capture = async (state: string) => {
        await ready(page);
        await page.screenshot({
          animations: 'disabled',
          path: testInfo.outputPath(`${state}-${theme}-${width}.png`),
        });
      };
      const heading = (name: string | RegExp) => page.getByRole('heading', { name, exact: true });
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const axe = async () => {
        await ready(page);
        expect(
          (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
            .violations,
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      };

      await page.goto(planPath);
      await expect(page.getByText(planName)).toBeVisible();
      await capture('saved-plans');
      await expectBefore(heading('Saved plans'), heading('New event plan'));

      const newPlan = page.getByRole('link', { name: 'New event plan', exact: true });
      await newPlan.press('Enter');
      await expect(page).toHaveURL(new RegExp(`${planPath}#new-event-plan$`));
      await expect(heading('New event plan')).toBeInViewport();
      await button('Open').press('Enter');
      const roster = heading(/Roster 8\/8 matched/);
      await expect(roster).toBeVisible();
      await capture('blocked-roster');
      const actions = page.getByRole('navigation', { name: 'Planner steps' });
      await expect(actions.getByRole('button', { name: 'Roster' })).toHaveAttribute(
        'aria-current',
        'step',
      );
      const freeze = button('Freeze roster & split divisions');
      await expect(freeze).toBeDisabled();
      await expect(freeze).toBeInViewport();
      await expect(freeze).toHaveAccessibleDescription(/no club ranking/);
      await expectBefore(actions, roster);
      await expectBefore(freeze, page.getByText('Fix before freezing', { exact: true }));
      await expectBefore(roster, heading('Night preview'));
      await expectBefore(roster, heading('Adopt historical results'));
      await expectBefore(roster, heading('Plan recovery'));
      await axe();

      const settings = button('Draft settings');
      await settings.press('Enter');
      const name = page.getByLabel('Event name', { exact: true });
      await name.fill('Unsaved event name');
      await settings.press('Space');
      await expect(name).toBeHidden();
      await settings.press('Space');
      await expect(name).toHaveValue('Unsaved event name');
      await axe();
      await settings.press('Space');

      await button('Show affected entrants').press('Enter');
      const affectedRow = page.getByRole('row').filter({ hasText: unrankedAlias });
      await expect(affectedRow).toHaveClass(/highlighted/);
      await expect(affectedRow).toBeFocused();
      await chooseOption(affectedRow.getByRole('combobox'), 'upper');
      await expect(freeze).toBeEnabled();
      await freeze.press('Enter');
      const generate = button('Generate pools');
      await expect(generate).toBeEnabled();
      await expectBefore(actions, heading('Divisions'));
      await expectBefore(generate, heading('Night preview'));
      await page.evaluate(() => scrollTo(0, 0));
      await capture('divisions');
      await expect(generate).toBeInViewport();

      await generate.press('Enter');
      await expect(heading('Pools')).toBeVisible();
      await expectBefore(actions, heading('Pools'));
      await expectBefore(heading('Pools'), heading('Night preview'));
      await expect(heading(/Upper 1 pool · sizes 4/)).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Open event desk', exact: true }),
      ).toHaveAttribute('href', `/admin/event-operations?plan=${PLAN_ID}`);
      await page.evaluate(() => scrollTo(0, 0));
      await capture('generated-pools');

      await button('Choose historical brackets').press('Enter');
      await expect(button('Preview historical adoption')).toBeVisible();
      await axe();
      await button('Close adoption form').press('Enter');

      await page.goto(`${planPath}?plan=${PLAN_ID}&step=roster`);
      await expect(roster).toBeVisible();
      await expectBefore(roster, heading('Night preview'));
      expect(mutations).toEqual([
        {
          operation: 'updateEntry',
          input: { planId: PLAN_ID, entryId: 'entry-0', divisionPreference: 'upper' },
        },
        { operation: 'freezeRoster', input: { planId: PLAN_ID } },
        { operation: 'generatePools', input: { planId: PLAN_ID } },
      ]);
      expect(fixture.unexpected).toEqual([]);
    });
