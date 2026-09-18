import { test, expect, type APIRequestContext } from '@playwright/test';
import jsQR from 'jsqr';
test.use({actionTimeout:15_000});

type Match = { id: string; player1Id: string; player2Id: string; player1Name: string; player2Name: string; status: string; revision: number; score1: number | null; score2: number | null };
type Overview = { matches: Match[]; stations: Array<{id:string}>; reports: Array<{id:string;matchId:string;status:string;userId:string|null;guestSessionId:string|null;reporterLabel:string}> };
async function signIn(request: APIRequestContext, email = 'admin@smashclub.dev') {
  const response = await request.post('/api/auth/sign-in/email', {data:{email,password:'devpassword123'}});
  expect(response.ok()).toBe(true);
}
async function query<T>(request: APIRequestContext, name: string, input?: object): Promise<T> {
  const response = await request.get(`/api/trpc/${name}`,{params:input?{input:JSON.stringify(input)}:{}});
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function mutate<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const response=await request.post(`/api/trpc/${name}`,{data});
  expect(response.ok(),await response.text()).toBe(true);
  return (await response.json()).result.data as T;
}
async function event(request: APIRequestContext) {
  await signIn(request);
  const plans=await query<Array<{id:string;name:string}>>(request,'admin.eventPlanner.plans');
  const source=plans.find(plan=>plan.name==='Nemesis · Rehearsal Night')!;
  const roster=await query<{entries:Array<{playerId:string;playerName:string;companyId?:string|null}>}>(request,'admin.eventPlanner.plan',{planId:source.id});
  const {planId}=await mutate<{planId:string}>(request,'admin.eventPlanner.createPlan',{name:`Guest rehearsal ${Date.now()}`,eventDate:new Date().toISOString(),upperTargetSize:4,rows:roster.entries.slice(0,8).map((entry,index)=>({lineNumber:index+1,rawInput:entry.playerName,cleanedName:entry.playerName,playerId:entry.playerId,companyId:entry.companyId??null,resolutionMethod:'manual',divisionPreference:'auto'}))});
  for (const name of ['admin.eventPlanner.freezeRoster','admin.eventPlanner.generatePools','eventOps.prepare']) await mutate(request,name,{planId});
  await mutate(request,'eventOps.settings',{planId,published:true,playerReports:false});
  await mutate(request,'eventOps.saveStation',{planId,name:'Stage'});
  return planId;
}

test('scannable guest QR accepts anonymous and unlinked reports, keeps approval authoritative, and revokes passes',async({page,browser,baseURL},testInfo)=>{
  test.setTimeout(120_000);
  const planId=await event(page.request);
  await page.goto(`/admin/event-operations?plan=${planId}`);
  const controls=page.locator('section').filter({has:page.getByRole('heading',{name:'Guest score reporting',exact:true})}).last();
  await controls.getByLabel('Allow guest score reports',{exact:true}).click();
  await expect(controls.getByLabel('Allow guest score reports',{exact:true})).toBeChecked();
  await controls.getByLabel('Show a rotating QR on the OBS overlay',{exact:true}).click();
  await expect(controls.getByLabel('Show a rotating QR on the OBS overlay',{exact:true})).toBeChecked();
  await controls.getByRole('button',{name:'Generate guest QR',exact:true}).click();
  const qr=controls.getByRole('img',{name:'Scan to report a match score'});
  await expect(qr).toBeVisible();
  const decode=async()=>{
    const pixels=await qr.evaluate(element=>{const source=element as HTMLCanvasElement;const box=source.getBoundingClientRect();const canvas=document.createElement('canvas');canvas.width=Math.round(box.width);canvas.height=Math.round(box.height);const context=canvas.getContext('2d')!;context.imageSmoothingEnabled=false;context.drawImage(source,0,0,canvas.width,canvas.height);return {width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};});
    return jsQR(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height)?.data??'';
  };
  await expect.poll(decode).toContain(`/guest/${planId}#token=`);
  const invitationUrl=await decode();
  const invitationToken=new URL(invitationUrl).hash.slice('#token='.length);
  const anonymous=await browser.newContext({baseURL,viewport:{width:390,height:844}});
  const unlinked=await browser.newContext({baseURL});
  const broadcast=await browser.newContext({baseURL,viewport:{width:1920,height:1080}});
  try {
    const guest=await anonymous.newPage();
    const requestUrls:string[]=[];
    guest.on('request',request=>requestUrls.push(request.url()));
    await guest.goto(invitationUrl);
    await expect(guest.getByRole('heading',{name:'Good games. Get them counted.'})).toBeVisible();
    await expect(guest.locator('article.ops-match').first()).toBeVisible();
    expect(new URL(guest.url()).hash).toBe('');
    expect(requestUrls.some(url=>url.includes(invitationToken))).toBe(false);
    const initial=await query<Overview>(page.request,'eventOps.overview',{planId});
    const first=initial.matches[0]!;
    const second=initial.matches[1]!;
    const guestCard=guest.locator('article.ops-match').filter({has:guest.getByRole('heading',{name:`${first.player1Name} vs ${first.player2Name}`,exact:true})});
    await guestCard.getByLabel(first.player1Name,{exact:true}).fill('2');
    await guestCard.getByLabel(first.player2Name,{exact:true}).fill('1');
    await guestCard.getByRole('button',{name:'Submit score for TO approval'}).click();
    await expect(guestCard).toContainText('Awaiting TO approval');
    expect(await guest.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await guest.reload();
    await expect(guestCard).toContainText('Awaiting TO approval');
    const pending=await query<Overview>(page.request,'eventOps.overview',{planId});
    expect(pending.matches.find(match=>match.id===first.id)?.status).toBe('ready');
    const report=pending.reports.find(report=>report.matchId===first.id)!;
    expect(report).toMatchObject({userId:null,status:'pending',reporterLabel:'Guest'});
    expect(report.guestSessionId).toBeTruthy();
    // Unlinked signed-in accounts use the same narrow guest permission.
    await signIn(unlinked.request,'player@smashclub.dev');
    expect((await query<Array<{status:string}>>(unlinked.request,'me.claims')).filter(claim=>claim.status==='approved')).toHaveLength(0);
    const unlinkedPage=await unlinked.newPage();
    await unlinkedPage.goto(invitationUrl);
    const otherCard=unlinkedPage.locator('article.ops-match').filter({has:unlinkedPage.getByRole('heading',{name:`${second.player1Name} vs ${second.player2Name}`,exact:true})});
    await otherCard.getByLabel(second.player1Name,{exact:true}).fill('0');
    await otherCard.getByLabel(second.player2Name,{exact:true}).fill('2');
    await otherCard.getByRole('button',{name:'Submit score for TO approval'}).click();
    await expect(otherCard).toContainText('Awaiting TO approval');
    const rejected=(await query<Overview>(page.request,'eventOps.overview',{planId})).reports.find(report=>report.matchId===second.id)!;
    await mutate(page.request,'eventOps.reviewReport',{reportId:rejected.id,approve:false});
    await expect(otherCard).toContainText('Rejected by a TO');
    await otherCard.getByRole('button',{name:'Start a new report'}).click();
    await otherCard.getByLabel(second.player1Name,{exact:true}).fill('0');
    await otherCard.getByLabel(second.player2Name,{exact:true}).fill('2');
    await otherCard.getByRole('button',{name:'Submit score for TO approval'}).click();
    await expect(otherCard).toContainText('Awaiting TO approval');
    const retry=(await query<Overview>(page.request,'eventOps.overview',{planId})).reports.find(report=>report.matchId===second.id && report.status==='pending')!;
    expect(retry.id).not.toBe(rejected.id);
    const overlay=await broadcast.newPage();
    await overlay.goto(`/overlay/${planId}`);
    const overlayQr=overlay.locator('.broadcast-guest-pass canvas');
    await expect(overlayQr).toBeVisible();
    await expect(overlay.getByTestId('broadcast-result-notice')).toHaveCount(0);
    await mutate(page.request,'eventOps.reviewReport',{reportId:report.id,approve:true});
    const flash=overlay.getByTestId('broadcast-result-notice');
    await expect(flash).toContainText('SET COMPLETE');
    await expect(flash).toContainText(`${first.player1Name} 2–1 ${first.player2Name}`);
    const capture=await overlay.locator('.event-capture').boundingBox();
    const flashBox=await flash.boundingBox();
    const qrBox=await overlayQr.boundingBox();
    expect(flashBox!.y).toBeGreaterThanOrEqual(capture!.y+capture!.height-1);
    expect(qrBox!.x+qrBox!.width).toBeLessThanOrEqual(capture!.x);
    expect(qrBox!.width).toBeCloseTo(qrBox!.height,0);
    const deck=await overlay.locator('.broadcast-deck').boundingBox();
    const lastChallenger=await overlay.locator('.broadcast-deck article').last().boundingBox();
    expect(lastChallenger!.y+lastChallenger!.height).toBeLessThanOrEqual(deck!.y+deck!.height+1);
    const overlayPixels=await overlayQr.evaluate(element=>{const source=element as HTMLCanvasElement;const box=source.getBoundingClientRect();const canvas=document.createElement('canvas');canvas.width=Math.round(box.width);canvas.height=Math.round(box.height);const context=canvas.getContext('2d')!;context.imageSmoothingEnabled=false;context.drawImage(source,0,0,canvas.width,canvas.height);return {width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};});
    expect(jsQR(new Uint8ClampedArray(overlayPixels.data),overlayPixels.width,overlayPixels.height)?.data).toContain(`/guest/${planId}#token=`);
    await overlay.screenshot({path:testInfo.outputPath('guest-qr-and-result-flash.png'),omitBackground:true});
    await expect(flash).toHaveCount(0,{timeout:12_000});
    await expect(overlay.getByLabel('Recent match outcomes')).toContainText(`${first.player1Name} 2–1 ${first.player2Name}`);
    await overlay.reload();
    await expect(overlay.locator('.broadcast-results')).toBeVisible();
    await expect(overlay.getByTestId('broadcast-result-notice')).toHaveCount(0);
    // Corrections have their own wording and reduced-motion removes movement.
    await overlay.emulateMedia({reducedMotion:'reduce'});
    const scored=(await query<Overview>(page.request,'eventOps.overview',{planId})).matches.find(match=>match.id===first.id)!;
    await mutate(page.request,'eventOps.reportScore',{matchId:first.id,expectedRevision:scored.revision,requestId:crypto.randomUUID(),score1:1,score2:2,outcome:'played'});
    await expect(flash).toContainText('CORRECTED');
    expect(await flash.evaluate(element=>getComputedStyle(element).animationName)).toBe('none');
    await expect(overlay.getByLabel('Recent match outcomes')).toContainText(`${first.player2Name} 2–1 ${first.player1Name}`);
    await mutate(page.request,'eventOps.reviewReport',{reportId:retry.id,approve:true});
    await unlinkedPage.getByRole('combobox',{name:'Match view',exact:true}).selectOption('reports');
    await expect(otherCard).toContainText('Approved by a TO');
    // Revocation is checked server-side on each poll, even with cached session data.
    page.once('dialog',dialog=>void dialog.accept());
    await controls.getByRole('button',{name:'Revoke all guest passes',exact:true}).click();
    await expect(guest.getByRole('alert')).toContainText(/revoked|expired|invalid/i);
    await unlinkedPage.goto(invitationUrl);
    await expect(unlinkedPage.getByRole('alert')).toContainText(/revoked|expired|invalid/i);
  } finally {await anonymous.close();await unlinked.close();await broadcast.close();}
});
