import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { EventPlanExports, EventPlanView } from '../src/lib/apiTypes';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const planner = '/admin/event-planner';
const savedPlan = `${planner}?plan=${PLAN_ID}`;
const longAlias = 'Saltwater Sentinel of the Eastern Coast';
const aliases = [longAlias, 'BucketCrab', 'Harbour Lantern Collector', 'Parallax'];
const lowerAliases = ['Canary', 'Monochrome', 'Peppermint', 'RightAngle'];
const eventDate = '2026-10-05T08:00:00Z';

function planView(bracketMode: EventPlanView['plan']['bracketMode'] = 'native'): EventPlanView {
  const linked = bracketMode === 'challonge';
  const divisions = linked ? (['upper', 'lower'] as const) : (['upper'] as const);
  return {
    plan: {
      id: PLAN_ID,
      name: 'Nemesis · Tournament format rehearsal',
      eventDate,
      slugPrefix: linked ? 'club-night' : null,
      status: 'pools_ready',
      bracketMode,
      competitionFormat: 'singles',
      structure: linked ? 'dual_division' : 'round_robin_finals',
      structureOptions: linked
        ? { roundRobinMeetings: 1 }
        : { roundRobinMeetings: 1, playoffSize: 2, consolation: false },
      historicalAdoption: null,
      softLockedAt: null,
      softLockedBy: null,
      upperTargetSize: linked ? 4 : null,
      poolSize: 4,
      rankingSnapshotAt: null,
      createdAt: '2026-10-04T00:00:00Z',
    },
    entries: divisions.flatMap((division, divisionIndex) =>
      (division === 'upper' ? aliases : lowerAliases).map((alias, index) => ({
        id: `${division}-entry-${index}`,
        sourceLineNumber: divisionIndex * aliases.length + index + 1,
        rawInput: alias,
        cleanedName: alias,
        playerName: alias,
        publicName: alias,
        companyCode: null,
        playerId: `${division}-player-${index}`,
        playerStatus: 'active',
        divisionPreference: 'auto',
        assignedDivision: division,
        divisionSeed: index + 1,
        resolutionMethod: 'alias',
        snapshotRank: index + 1,
        snapshotScore: null,
        currentRank: null,
        currentScore: null,
        lastPlayedDate: null,
        candidates: [],
      })),
    ),
    divisions: divisions.map((division) => ({
      division,
      size: aliases.length,
      poolCount: 1,
      pools: [
        {
          poolIndex: 0,
          label: 'A',
          members: (division === 'upper' ? aliases : lowerAliases).map((name, index) => ({
            entryId: `${division}-entry-${index}`,
            playerId: `${division}-player-${index}`,
            name,
            seed: index + 1,
            snapshotRank: index + 1,
            place: null,
          })),
        },
      ],
      consolation: null,
      championship: [],
    })),
    brackets: [],
    issues: { blocking: [], warnings: [] },
  };
}

async function setup(page: Page, view: EventPlanView) {
  const fixture = await mockEvent(page, { role: 'admin' });
  Object.assign(fixture.responses, {
    'admin.eventPlanner.plan': view,
    'admin.eventPlanner.projectTournament': { formats: [] },
    'admin.eventPlanner.historicalCandidates': [],
  });
  return fixture;
}

async function selectByKeyboard(control: Locator, label: string) {
  await control.press('Enter');
  await expect(control.page().getByRole('listbox')).toBeVisible();
  // Use the visible menu's typeahead and submit the focused option.
  await control.page().keyboard.press(label[0]!);
  await expect(control.page().getByRole('option', { name: label, exact: true })).toBeFocused();
  await control.page().keyboard.press('Enter');
  await expect(control).toBeFocused();
}

async function checkPage(page: Page, testInfo: TestInfo, state: string) {
  await ready(page);
  const width = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath(`${state}.png`),
    animations: 'disabled',
    fullPage: true,
  });
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test.describe(`planner format guidance at ${width}px in ${theme}`, () => {
      test.use({ viewport: { width, height: 900 } });
      test.beforeEach(async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      });

      test('keeps Challonge details with the linked setting and native knockout copy with the draw', async ({
        page,
      }, testInfo) => {
        const view = planView();
        view.plan.structure = 'single_elimination';
        view.plan.structureOptions = { roundRobinMeetings: 1 };
        view.divisions[0]!.pools = [];
        view.divisions[0]!.poolCount = 0;
        const fixture = await setup(page, view);
        await page.goto(planner);
        const owner = page.getByRole('combobox', { name: /^Bracket system/ });
        const structure = page.getByRole('combobox', { name: 'Tournament structure', exact: true });
        const prefix = page.getByRole('textbox', { name: /^Slug prefix/ });
        const attendance = page.getByRole('textbox', { name: /^Attendance list/ });
        await attendance.fill(aliases.join('\n'));
        await page.getByRole('checkbox', { name: 'Include a consolation bracket' }).press('Space');
        await expect(structure).toHaveAccessibleDescription(
          'Two seeded divisions, each with a championship bracket.',
        );
        await selectByKeyboard(owner, 'Challonge — manage external brackets');
        await expect(page.getByText(/Used to suggest Challonge slugs/)).toBeVisible();
        await prefix.fill('club-night');
        await selectByKeyboard(owner, 'Nemesis — run the whole event here');
        await selectByKeyboard(structure, 'Single elimination');
        await expect(page.getByRole('textbox', { name: 'Pool size', exact: true })).toHaveValue(
          'No pool stage',
        );
        await expect(prefix).toHaveCount(0);
        await expect(
          page.getByText(/Nemesis runs pools, championship and consolation/),
        ).toHaveCount(0);
        await expect(attendance).toHaveValue(aliases.join('\n'));
        await checkPage(page, testInfo, 'native-knockout-creation');

        await selectByKeyboard(owner, 'Challonge — manage external brackets');
        await expect(prefix).toHaveValue('club-night');
        await expect(attendance).toHaveValue(aliases.join('\n'));

        view.plan.status = 'roster_frozen';
        await page.goto(`${savedPlan}&step=pools`);
        await expect(
          page.getByText('Generate the seeded knockout draw in Divisions.'),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Knockout draw ready' })).toHaveCount(0);
        await checkPage(page, testInfo, 'frozen-knockout-before-generation');
        await page.getByRole('button', { name: 'Divisions', exact: true }).press('Enter');
        await expect(
          page.getByRole('button', { name: 'Generate draw', exact: true }),
        ).toBeEnabled();

        view.plan.status = 'pools_ready';
        await page.goto(`${savedPlan}&step=handoff`);
        await expect(page.getByText(/Lock the seeded knockout draw/)).toBeVisible();
        await expect(page.getByText(/losers-bracket finalist/)).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Open event desk' })).toHaveAttribute(
          'href',
          `/admin/event-operations?plan=${PLAN_ID}`,
        );
        view.plan.structure = 'double_elimination';
        view.plan.status = 'underway';
        view.plan.softLockedAt = eventDate;
        await page.reload();
        await expect(page.getByText(/Draw: soft-locked/)).toBeVisible();
        await expect(page.getByText(/Lock the seeded knockout draw/)).toHaveCount(0);
        await expect(
          page.getByText(/reset final runs if the losers-bracket finalist wins/),
        ).toBeVisible();

        // A paused draw keeps the same status and soft-lock timestamp in the planner.
        fixture.overview.plan.drawPaused = true;
        await page.getByRole('button', { name: 'Draw', exact: true }).press('Enter');
        await expect(
          page.getByRole('heading', { name: 'Knockout draw', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText('Review the draw and manage matches in the event desk.'),
        ).toBeVisible();
        await expect(page.getByText(/The seeded draw is locked/)).toHaveCount(0);
        await checkPage(page, testInfo, 'knockout-draw-event-desk');
        expect(fixture.unexpected).toEqual([]);
      });

      test('shows only playoffs both before and after finishing orders are confirmed', async ({
        page,
      }, testInfo) => {
        const view = planView();
        const pool = view.divisions[0]!.pools[0]!;
        pool.members[3]!.withdrawn = true;
        const fixture = await setup(page, view);
        await page.goto(`${savedPlan}&step=pools`);
        await expect(page.getByText(/advance the top 2 active entrants to playoffs/)).toBeVisible();
        await expect(page.getByRole('listitem').filter({ hasText: longAlias })).toBeVisible();
        await expect(
          page.getByText(/generate the consolation draw|import list|Update linked Challonge/),
        ).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Confirm pool' })).toBeDisabled();
        await checkPage(page, testInfo, 'playoffs-before-confirmation');

        await page.getByRole('button', { name: 'Run event', exact: true }).press('Enter');
        await expect(
          page.getByText(/Preview and create the playoffs in the event desk/),
        ).toBeVisible();
        await expect(
          page.getByText(/resolve pending reports before finalizing results/),
        ).toBeVisible();
        await expect(page.getByText(/create the playoffs and consolation/)).toHaveCount(0);
        await expect(page.getByText(/Soft-lock the pool draw/)).toBeVisible();
        await checkPage(page, testInfo, 'playoffs-handoff');

        view.plan.status = 'underway';
        view.plan.softLockedAt = eventDate;
        await page.reload();
        await expect(page.getByText(/Draw: soft-locked/)).toBeVisible();
        await expect(page.getByText(/Soft-lock the pool draw/)).toHaveCount(0);
        await expect(
          page.getByText(/Preview and create the playoffs in the event desk/),
        ).toBeVisible();
        await checkPage(page, testInfo, 'playoffs-underway-handoff');

        pool.members.forEach((member, index) => {
          member.place = index + 1;
        });
        view.divisions[0]!.championship = pool.members.slice(0, 2).map((member, index) => ({
          playerId: member.playerId,
          name: member.name,
          label: `A${index + 1}`,
        }));
        await page.goto(`${savedPlan}&step=pools`);
        await expect(page.getByText(/1\/1 pools confirmed/)).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Playoff qualifiers' })).toBeVisible();
        await expect(
          page.getByText('No active entrants are eligible for consolation.'),
        ).toHaveCount(0);
        await checkPage(page, testInfo, 'playoffs-confirmed');

        view.plan.structureOptions!.consolation = true;
        view.plan.structureOptions!.playoffSize = null;
        await page.goto(`${savedPlan}&step=pools`);
        await expect(
          page.getByText('No active entrants are eligible for consolation.'),
        ).toBeVisible();

        view.plan.status = 'complete';
        await page.goto(`${savedPlan}&step=handoff`);
        await expect(
          page.getByRole('heading', { name: 'Review this event in Nemesis' }),
        ).toBeVisible();
        await expect(page.getByText(/Results are finalized/)).toBeVisible();
        expect(fixture.unexpected).toEqual([]);
      });

      test('keeps the linked consolation import and Challonge handoff', async ({
        page,
      }, testInfo) => {
        const view = planView('challonge');
        const upperPool = view.divisions[0]!.pools[0]!;
        upperPool.members[2]!.withdrawn = true;
        upperPool.members[3]!.withdrawn = true;
        view.brackets = view.divisions.flatMap(({ division }) =>
          (['main', 'consolation'] as const).map((stage) => ({
            id: `${division}-${stage}`,
            division,
            stage,
            challongeSlug: null,
            tournamentId: null,
            externalState: 'draft',
            lastError: null,
            tournamentEventDate: null,
            tournamentSyncState: null,
            tournamentIsRookie: null,
            suggestedSlug: `club-night_${division}${stage === 'main' ? '' : '_consolation'}`,
          })),
        );
        const exports: EventPlanExports = {
          eventDate,
          rankingSnapshotAt: null,
          brackets: view.brackets.map(({ division, stage, challongeSlug, suggestedSlug }) => ({
            division,
            stage,
            challongeSlug,
            suggestedSlug,
            title: `${division} ${stage}`,
            participants:
              stage === 'main' ? (division === 'upper' ? aliases : lowerAliases).join('\n') : '',
            audit: '',
            checklist: [
              stage === 'main'
                ? 'Paste the participants in seed order.'
                : 'Confirm each pool first.',
            ],
          })),
          poolCards: [{ division: 'upper', label: 'Upper — Pool A', lines: aliases }],
        };
        const fixture = await setup(page, view);
        fixture.responses['admin.eventPlanner.exports'] = exports;
        await page.goto(`${savedPlan}&step=pools`);
        await expect(
          page.getByText(/generate the consolation draw and its import list/),
        ).toHaveCount(2);
        await expect(page.getByText(/Update linked Challonge brackets to match/)).toContainText(
          'This pool sends 2 to championship.',
        );
        await expect(page.getByText(/striped across seed order/)).toContainText(
          'at least two advance when available',
        );
        await checkPage(page, testInfo, 'linked-pools');

        await page.getByRole('button', { name: 'Challonge', exact: true }).press('Enter');
        await expect(page.getByRole('heading', { name: 'Challonge handoff' })).toBeVisible();
        await expect(
          page.getByRole('textbox', { name: 'Participants, in seed order' }).first(),
        ).toHaveValue(aliases.join('\n'));
        await expect(
          page.getByRole('textbox', { name: 'Challonge slug for Upper main' }),
        ).toBeVisible();
        await expect(page.getByText('Confirm each pool first.')).toHaveCount(2);
        await checkPage(page, testInfo, 'linked-handoff');
        expect(fixture.unexpected).toEqual([]);
      });
    });
  }
}
