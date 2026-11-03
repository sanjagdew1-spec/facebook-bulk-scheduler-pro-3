import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('Phase 4 customer website has dedicated Details, Manual, Plans and Get Started views', () => {
  for (const id of ['home', 'details', 'manual', 'plans', 'signup']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing customer section: ' + id);
  }
  for (const view of ['details', 'manual', 'plans']) {
    assert.ok(html.includes('data-view-link="' + view + '"'), 'missing navigation item: ' + view);
  }
  assert.match(html, /location\.replace\("scheduler\.html"\)/);
  assert.match(html, /document\.getElementById\('signup'\)\.hidden=view!=='signup'/);
  assert.match(html, /document\.getElementById\('cta-section'\)\.hidden=true/);
  assert.match(html, /href="\?view=plans"/);
  assert.match(html, /href="\?open=software"/);
});

test('Phase 4 website explains signup and plan activation are not live yet', () => {
  assert.match(html, /Email verification and plan activation need the production email\/payment services configured/i);
  assert.match(html, /payment\/UPI is intentionally not activated/i);
  assert.match(html, /no account or demo has been created/i);
});

test('Phase 4 landing page is responsive and does not expose owner/admin navigation', () => {
  assert.match(html, /@media\s*\(max-width:\s*680px\)/);
  assert.match(html, /\.nav a\{display:inline-flex/);
  assert.doesNotMatch(html, /href=["'][^"']*owner-admin/i);
  assert.doesNotMatch(html, /Owner Admin Control Panel/i);
  assert.doesNotMatch(html, /Developer Panel/i);
});

test('customer/API server does not serve the future Phase 5 owner UI route', () => {
  assert.doesNotMatch(server, /app\.get\(['"]\/owner-admin['"]/);
});


test('Phase 4 restores the locked Advanced Mode workspaces and respects Phase 5 plan entitlements', async () => {
  const scheduler = await readFile(new URL('../scheduler.html', import.meta.url), 'utf8');
  assert.match(scheduler, /id="advancedModeToggle"/, 'Bulk Photos Advanced Mode switch must exist');
  assert.match(scheduler, /id="bulkPagesAdvancedModeToggle"/, 'Bulk Pages Advanced Mode switch must exist');
  assert.match(scheduler, /feature-access\?planKey=/, 'customer plan must be checked against Phase 5 feature access');
  assert.match(scheduler, /developerAccess=allowed&&access\.role==='developer'/, 'developer access must retain Advanced Mode');
  assert.match(scheduler, /card\.hidden=!enabled/, 'Advanced Mode controls must respect the assigned plan entitlement');
  assert.match(scheduler, /const DEFAULT_API='https:\/\/facebook-bulk-scheduler-pro-3-p3-api\.onrender\.com'/, 'Phase 4 must remain connected to the original Phase 3 API');
});


test('Bulk Pages Only Selected Pages copies Post One selection across active slots only in Advanced Mode', async () => {
  const scheduler = await readFile(new URL('../scheduler.html', import.meta.url), 'utf8');
  assert.match(scheduler, /id="allGroupsSelector"[^>]*>All Pages Selected</, 'all-pages action must use the corrected label');
  assert.match(scheduler, /id="onlySelectedPages"[^>]*>Only Selected Pages</, 'Only Selected Pages action must exist');
  assert.match(scheduler, /#view-bulk-pages\.advanced-mode-on \.only-selected-pages\{display:block\}/, 'Only Selected Pages must appear only in Advanced Mode');
  assert.match(scheduler, /view\.classList\.toggle\('advanced-mode-on', toggle\.checked\)/, 'Bulk Pages must track Advanced Mode visibility');
  assert.match(scheduler, /const selectedIds=\(firstSlot\?\.pageIds\|\|\[\]\)\.map\(id=>String\(id\)\)/, 'the first Post Slot must be the source selection');
  assert.match(scheduler, /for\(let i=1;i<active;i\+\+\)/, 'the selection must be copied to every other active Post Slot');
  assert.match(scheduler, /onlySelectedPages'\)\.addEventListener\('click',applyOnlySelectedPagesToAllSlots\)/, 'the new button must be connected to its action');
});

test('Bulk Pages scheduling assigns five workers to complete photo slots without mixing post data', async () => {
  const scheduler = await readFile(new URL('../scheduler.html', import.meta.url), 'utf8');
  assert.match(scheduler, /async function mapWithConcurrency\(items,limit,mapper\)/, 'scheduling must use a bounded worker pool');
  assert.match(scheduler, /mapWithConcurrency\(slotTasks,5,async\(\{slot,slotIndex\}\)=>\{/, 'five workers must each receive one complete photo slot');
  assert.match(scheduler, /for\(const file of slot\.files\)images\.push\(await fileToData\(file\)\)/, 'each worker must finish the images belonging to its own slot');
  assert.match(scheduler, /imageGroupKey:String\(slotIndex\)/, 'each Page job must retain its original photo-slot identity');
  assert.match(scheduler, /return \{slotIndex,images,pagePosts\}/, 'each worker must return its complete slot bundle');
  assert.match(scheduler, /for\(const result of slotResults\)\{imageGroups\[String\(result\.slotIndex\)\]=result\.images;prepared\.push\(\.\.\.result\.pagePosts\)\}/, 'slot bundles must be merged by their original slot identity');
  assert.match(scheduler, /api\('\/api\/bulk-photos',[\s\S]{0,150}mode:'schedule'/, 'all completed slot bundles must use the existing single Phase 3 batch request');
  assert.match(scheduler, /schedulingWorkers:5,workerUnit:'complete-photo-slot'/, 'timing diagnostics must identify the five complete-slot workers');
});


test('Phase 7 Direct Schedule Facebook is a separate button below the unchanged local scheduler', async () => {
  const scheduler = await readFile(new URL('../scheduler.html', import.meta.url), 'utf8');
  assert.match(scheduler, /<div class="actions"><button class="btn" id="bulkPublishNow" type="button">Publish Now<\/button><button class="btn secondary" id="bulkScheduleAll" type="button">Schedule all selected photos<\/button><\/div>\s*<div class="actions"><button class="btn" id="bulkScheduleDirectFacebook" type="button">Direct Schedule Facebook<\/button><\/div>/, 'the new Direct Schedule Facebook button must sit below the unchanged existing buttons');
  assert.match(scheduler, /async function submitBulkSchedule\(\)[\s\S]*?api\('\/api\/bulk-photos'/, 'the existing Schedule button must continue using the original Phase 3 scheduler');
  assert.match(scheduler, /async function submitBulkDirectFacebook\(\)[\s\S]*?api\('\/api\/meta-schedule\/(?:chunk|commit)'/, 'the new button must upload chunks and commit through the separate Meta-owned direct scheduling routes');
  assert.match(scheduler, /bulkScheduleAll'\)\.addEventListener\('click',submitBulkSchedule\)/, 'the existing Schedule button handler must remain connected');
  assert.match(scheduler, /bulkScheduleDirectFacebook'\)\.addEventListener\('click',submitBulkDirectFacebook\)/, 'the new direct scheduling button must have its own handler');
});
