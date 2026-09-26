import { expect, test, type APIRequestContext } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import jsQR from 'jsqr';
async function query<T>(request: APIRequestContext, procedure: string, input?: object): Promise<T> {
 const response = await request.get(`/api/trpc/${procedure}`, { params: input ? { input: JSON.stringify(input) } : {} });
 expect(response.ok(), await response.text()).toBe(true); return (await response.json()).result.data;
}
async function mutate<T = unknown>(request: APIRequestContext, procedure: string, data: object): Promise<T> {
 const response = await request.post(`/api/trpc/${procedure}`, { data }); expect(response.ok(), await response.text()).toBe(true); return (await response.json()).result.data;
}
test('TO prints selected pool sheets with stable public QR and unclipped A4 pairings', async ({ page }, testInfo) => {
 await page.request.post('/api/auth/sign-in/email', { data: { email: 'admin@smashclub.dev', password: 'devpassword123' } });
 const plans = await query<{ id: string; name: string }[]>(page.request, 'admin.eventPlanner.plans');
 const source = plans.find(plan => plan.name === 'Nemesis · Rehearsal Night')!;
 const roster = await query<{ entries: { playerId: string; playerName: string }[] }>(page.request, 'admin.eventPlanner.plan', { planId: source.id });
 const { planId } = await mutate<{ planId: string }>(page.request, 'admin.eventPlanner.createPlan', { name: 'Pool sheets rehearsal', bracketMode: 'native', eventDate: new Date().toISOString(), upperTargetSize: 9,
 rows: roster.entries.map((entry, index) => ({ lineNumber: index + 1, rawInput: entry.playerName, cleanedName: entry.playerName, playerId: entry.playerId, companyId: null, resolutionMethod: 'manual', divisionPreference: 'auto' })) });
 for (const procedure of ['admin.eventPlanner.freezeRoster', 'admin.eventPlanner.generatePools', 'eventOps.prepare']) await mutate(page.request, procedure, { planId });
 for (const name of ['Station 1', 'Station 2']) await mutate(page.request, 'eventOps.saveStation', { planId, name });
 const snapshot = await query<{ stations: {id: string}[] }>(page.request, 'eventOps.overview', { planId });
 await mutate(page.request, 'eventOps.configurePool', { planId, division: 'upper', poolIndex: 0, active: true, stationIds: snapshot.stations.map(station => station.id), selfRun: true, autoAcceptScores: true, expectedRevision: 0 });
 await page.goto(`/admin/event-operations?plan=${planId}`);
 await page.getByRole('button', { name: 'Print pool sheets', exact: true }).click();
 const preview = page.getByRole('dialog', { name: 'Print pool sheets', exact: true });
 await expect(preview.getByText('Live board is not published.', { exact: false }).first()).toBeVisible();
 await expect(preview.locator('img')).toHaveCount(0);
 await preview.getByRole('button', { name: 'Close preview' }).click();
 await mutate(page.request, 'eventOps.settings', { planId, published: true, playerReports: true });
 await page.reload();
 await page.getByRole('button', { name: 'Print pool sheets', exact: true }).click();
 await expect(preview.getByRole('button', { name: 'Print selected pools' })).toBeEnabled();
 await expect(preview.locator('.floor-sheet-page')).toHaveCount(4);
 await preview.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
 const allPdf = await page.pdf({ format: 'A4', preferCSSPageSize: true });
 await writeFile(testInfo.outputPath('all-pools.pdf'), allPdf);
 expect(allPdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(4);
 for (const label of ['Upper Pool B', 'Lower Pool A', 'Lower Pool B']) await preview.getByRole('checkbox', { name: label, exact: true }).uncheck();
 await expect(preview.locator('.floor-sheet-page')).toHaveCount(1);
 await expect(preview.locator('.floor-sheet-stations')).toHaveText('Station 1 + Station 2');
 await expect(preview.locator('tbody tr')).toHaveCount(15); // five rounds of two matches plus rest
 const image = preview.getByRole('img', { name: 'QR code for Upper Pool A live board' });
 await expect(image).toBeVisible();
 const pixels = await image.evaluate(async node => {
   const img = node as HTMLImageElement; await img.decode();
   const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
   const context = canvas.getContext('2d')!; context.drawImage(img, 0, 0);
   return { bytes: [...context.getImageData(0, 0, canvas.width, canvas.height).data], width: canvas.width, height: canvas.height };
 });
 const code = jsQR(Uint8ClampedArray.from(pixels.bytes), pixels.width, pixels.height);
 expect(code?.data).toBe(`${new URL(page.url()).origin}/live/${planId}?pool=upper%3A0`);
 const before = await preview.locator('.floor-sheet-pages').innerText();
 await mutate(page.request, 'eventOps.configurePool', { planId, division: 'upper', poolIndex: 0, active: false, stationIds: snapshot.stations.map(station => station.id), expectedRevision: 1 });
 expect(await preview.locator('.floor-sheet-pages').innerText()).toBe(before);
 await page.emulateMedia({ media: 'print' });
 await expect(preview.locator('.floor-sheet-toolbar')).toBeHidden();
 expect(await page.locator('#root').evaluate(node => getComputedStyle(node).display)).toBe('none');
 const geometry = await preview.locator('.floor-sheet-page').evaluate(node => {
  const rect = node.getBoundingClientRect(); return { height: rect.height, width: rect.width, rowsFit: [...node.querySelectorAll('tr')].every(row => row.scrollWidth <= row.clientWidth) };
 });
 expect(geometry.rowsFit).toBe(true);
 const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: false });
 await writeFile(testInfo.outputPath('upper-pool-a.pdf'), pdf);
 // Chromium's PDF output exposes one /Type /Page object for each printed sheet.
 expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
 await page.screenshot({ path: testInfo.outputPath('pool-sheet-print.png'), fullPage: true });
 await page.emulateMedia({ media: 'screen' });
 await preview.getByRole('button', { name: 'Close preview' }).click();
 await expect(page.locator('.ops-pool-schedule').filter({ has: page.getByRole('heading', { name: 'Upper Pool A', exact: true }) }).getByRole('checkbox', { name: 'Allow this pool to play now' })).not.toBeChecked();
 await page.getByRole('button', { name: 'Print pool sheets', exact: true }).click();
 await expect(preview.locator('.floor-sheet-page').first()).toContainText('Later wave — wait to be called');
 await preview.getByRole('button', { name: 'Close preview' }).click();
 await expect(page.locator('body')).not.toHaveClass(/printing-pool-sheets/);
});
