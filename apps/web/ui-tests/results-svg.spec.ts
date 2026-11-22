import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mockEvent, ready } from './fixtures';

function entrant(name: string, place: number) {
  return {
    entryKey: name,
    name,
    place,
    provisional: false,
    playerId: null,
    wins: 2,
    losses: 1,
  };
}

function archive(
  name: string,
  competitionFormat: 'singles' | 'doubles',
  players: ReturnType<typeof entrant>[],
) {
  return {
    name: 'Results SVG rehearsal',
    date: '2026-11-06',
    canonicalSlug: 'results-svg',
    competitionFormat,
    divisions: [],
    brackets: [
      {
        tournamentId: '00000000-0000-4000-8000-000000000002',
        name,
        slug: 'results-svg',
        roleSource: 'unclassified',
        isComplete: true,
        players,
      },
    ],
    warnings: [],
  };
}

async function renderedDownload(page: Page, testInfo: TestInfo) {
  const downloadPromise = page.waitForEvent('download');
  const button = page.getByRole('button', { name: 'Download SVG ↓' });
  await button.press('Enter');
  await expect(button).toBeFocused();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('smash-club-results.svg');
  const path = testInfo.outputPath('results.svg');
  await download.saveAs(path);

  const exported = await page.context().newPage();
  try {
    await exported.setViewportSize({ width: 1200, height: 900 });
    const url = new URL('/downloaded-results.svg', page.url()).href;
    await exported.route(url, (route) => route.fulfill({ path, contentType: 'image/svg+xml' }));
    await exported.goto(url);
    await expect(exported.locator('parsererror')).toHaveCount(0);
    const graphic = exported.locator('svg');
    await graphic.screenshot({ path: testInfo.outputPath('rendered-results.png') });
    const { labels, cards, height } = await graphic.evaluate((node: SVGSVGElement) => {
      const bounds = (item: SVGGraphicsElement) => {
        const { x, y, width, height } = item.getBBox();
        return { left: x, right: x + width, top: y, bottom: y + height };
      };
      return {
        labels: [...node.querySelectorAll('text')]
          .filter((label) => label.textContent)
          .map((label) => ({
            text: label.textContent!,
            fontSize: Math.min(
              ...[label, ...label.querySelectorAll('tspan')].map((line) =>
                Number.parseFloat(getComputedStyle(line).fontSize),
              ),
            ),
            ...bounds(label),
          })),
        cards: [...node.querySelectorAll<SVGRectElement>('g rect')].map(bounds),
        height: node.viewBox.baseVal.height,
      };
    });
    for (const { text, left, right, top, bottom } of labels) {
      expect(text).not.toContain('�');
      expect(left, text).toBeGreaterThanOrEqual(0);
      expect(right, text).toBeLessThanOrEqual(1152);
      expect(top, text).toBeGreaterThanOrEqual(0);
      expect(bottom, text).toBeLessThanOrEqual(height);
    }
    await expect(exported.locator('script, image')).toHaveCount(0);
    return { labels, cards };
  } finally {
    await exported.close();
  }
}

test('downloaded results SVG preserves whole Unicode graphemes at label cutoffs', async ({
  page,
}, testInfo) => {
  const fixture = await mockEvent(page);
  const titlePrefix = `${'W'.repeat(51)}🎮`;
  const emojiPrefix = `${'A'.repeat(47)}👩🏿‍🚀`;
  const accentedPrefix = `${'B'.repeat(47)}e\u0301`;
  fixture.responses['public.eventOverview'] = archive(`${titlePrefix} Finals`, 'singles', [
    entrant(`${emojiPrefix} Alias`, 1),
    entrant(`${accentedPrefix} Alias`, 2),
  ]);
  await page.goto('/events/results-svg');

  const { labels } = await renderedDownload(page, testInfo);
  const text = labels.map((label) => label.text);
  expect(text[1]).toContain(titlePrefix);
  expect(text[3]).toContain(emojiPrefix);
  expect(text[5]).toContain(accentedPrefix);
  expect(fixture.unexpected).toEqual([]);
});

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`${theme} ${width}px downloads bounded SVG rows for long public doubles aliases`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page);
      const teamName = 'A remarkably long team name 🎮 with room for everyone & friends';
      const members = [
        `${'W'.repeat(58)}👩🏿‍🚀 & <fox>`,
        `${'界'.repeat(58)}${'e\u0301'.repeat(5)} / Twin`,
      ];
      const firstTeam = {
        ...entrant(`${teamName} (${members.join(' / ')})`, 1),
        graphic: { teamName, members: members.map((name) => ({ name, character: null })) },
      };
      const unnamedMembers = ['Public Gold', 'Public Silver'];
      const unnamedTeam = {
        ...entrant(unnamedMembers.join(' / '), 8),
        graphic: {
          teamName: null,
          members: unnamedMembers.map((name) => ({ name, character: null })),
        },
      };
      const legacy = entrant('Legacy Pair', 8);
      fixture.responses['public.eventOverview'] = archive('Doubles championship', 'doubles', [
        unnamedTeam,
        firstTeam,
        legacy,
        entrant('Outside Top 8', 9),
      ]);
      await page.goto('/events/results-svg');
      await expect(page.getByRole('button', { name: 'Download SVG ↓' })).toBeVisible();
      await ready(page);
      await page.screenshot({ path: testInfo.outputPath('event-route.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

      const { labels, cards } = await renderedDownload(page, testInfo);
      expect(labels.map((label) => label.text)).toEqual([
        'SMASH CLUB · RESULTS',
        'Doubles championship',
        '1',
        teamName,
        ...members,
        '8',
        ...unnamedMembers,
        '8',
        legacy.name,
      ]);
      expect(cards).toHaveLength(3);
      for (const [names, card] of [
        [[teamName, ...members], cards[0]!],
        [unnamedMembers, cards[1]!],
      ] as const) {
        let previousBottom = card.top;
        for (const name of names) {
          const label = labels.find((item) => item.text === name)!;
          expect(label.fontSize, name).toBeGreaterThanOrEqual(18);
          expect(label.top, name).toBeGreaterThanOrEqual(previousBottom);
          expect(label.bottom, name).toBeLessThanOrEqual(card.bottom);
          previousBottom = label.bottom;
        }
      }
      expect(fixture.unexpected).toEqual([]);
    });
