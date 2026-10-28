// Drives the real app in headless Edge/Chrome and tries to break it.
// Needs puppeteer-core (npm install) and Edge or Chrome installed; set CHROME_PATH to override.
const test = require('node:test'), { after } = test, assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { start } = require('../server');

const BROWSERS = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const exe = BROWSERS.find(p => fs.existsSync(p));
let puppeteer; try { puppeteer = require('puppeteer-core'); } catch {}
const skip = !exe || !puppeteer ? 'needs puppeteer-core and Edge/Chrome' : false;

let server, base, browser;
const errors = [], dialogs = [];

// Node 20 doesn't await async top-level before() hooks, so tests await this instead
const ready = skip ? null : (async () => {
  server = await start(0); base = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
})();
after(async () => { await browser?.close(); server?.close(); });

// a fresh, isolated browser profile (own IndexedDB) with the app open
async function fresh(choice = 'example', { width = 1400, height = 900 } = {}) {
  await ready;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  watch(page);
  await page.goto(base);
  if (choice) {
    await page.waitForSelector('.modal.locked [data-a]');
    await page.click(`.modal.locked [data-a=${choice}]`);
    await page.waitForSelector('#app h1');
    await saved(page);
  }
  return { ctx, page };
}
function watch(page) {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', async d => { dialogs.push(d.message()); await (page.__dismiss ? d.dismiss() : d.accept()); });
}
const saved = page => page.waitForFunction(() => /Saved/.test(document.querySelector('#saved').textContent));
const go = async (page, v) => { await page.evaluate(v => { location.hash = v; }, v); await page.waitForFunction(v => document.querySelector('.side nav a.on')?.getAttribute('href') === '#' + v, {}, v); };
const VIEWS = ['dashboard', 'board', 'backlog', 'epics', 'releases', 'roadmap', 'reports'];
const text = page => page.evaluate(() => document.body.innerText);
async function assertCleanEverywhere(page) {
  for (const v of VIEWS) {
    await go(page, v);
    const t = await text(page);
    assert.ok(!/\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/.test(t), `${v} shows a broken value`);
  }
}

test('first run, example plan, every view renders cleanly', { skip }, async () => {
  const { ctx, page } = await fresh();
  assert.equal(await page.$$eval('.kpi', k => k.length), 6);
  await assertCleanEverywhere(page);
  await ctx.close();
});

test('welcome screen cannot be dismissed with Escape', { skip }, async () => {
  const { ctx, page } = await fresh(null);
  await page.waitForSelector('.modal.locked');
  await page.keyboard.press('Escape');
  assert.ok(await page.$('.modal.locked'));
  await ctx.close();
});

test('plan survives a reload', { skip }, async () => {
  const { ctx, page } = await fresh();
  await go(page, 'backlog');
  await page.type('[data-add=""]', 'Persist me');
  await page.keyboard.press('Enter');
  await saved(page);
  await page.reload(); await page.waitForSelector('#app h1');
  assert.ok(await page.evaluate(() => db.issues.some(i => i.title === 'Persist me')));
  await ctx.close();
});

test('script injection in names is shown as text, never run', { skip }, async () => {
  const { ctx, page } = await fresh();
  const evil = `<img src=x onerror="window.__xss=1">"'><svg onload=window.__xss=2>`;
  await go(page, 'backlog');
  await page.type('[data-add=""]', evil); await page.keyboard.press('Enter'); await saved(page);
  await page.evaluate(evil => {          // also through every other name field
    db.epics[0].name = evil; db.sprints[0].name = evil; db.sprints[0].goal = evil; db.releases[0].name = evil; db.releases[0].desc = evil;
    db.issues[0].labels = [evil]; db.issues[0].desc = evil; db.issues[1].due = '2020-01-01'; save();
  }, evil);
  await assertCleanEverywhere(page);
  await page.evaluate(() => openIssue(db.issues[0]));
  await page.evaluate(() => openEpic(db.epics[0]));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await go(page, 'dashboard');
  for (const m of await page.$$('[data-tip]')) { await m.hover().catch(() => {}); }
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.ok((await text(page)).length > 0);
  await ctx.close();
});

test('blank quick-add is ignored', { skip }, async () => {
  const { ctx, page } = await fresh();
  await go(page, 'backlog');
  const before = await page.evaluate(() => db.issues.length);
  await page.type('[data-add=""]', '    '); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => db.issues.length), before);
  await ctx.close();
});

test('marking done records the date and updates the dashboard', { skip }, async () => {
  const { ctx, page } = await fresh();
  await go(page, 'backlog');
  const id = await page.evaluate(() => db.issues.find(i => !i.parentId && i.sprintId).id);
  await page.select(`[data-st="${id}"]`, 'done'); await saved(page);
  assert.equal(await page.evaluate(id => issue(id).doneAt, id), await page.evaluate(() => today()));
  await go(page, 'dashboard');
  assert.match(await page.$eval('.kpi:nth-child(2) .kv', e => e.textContent), /^1$/);
  await page.select(`#app select.fsel`, String(await page.evaluate(() => db.epics[2].id)));   // filter to an epic with no done work
  assert.match(await page.$eval('.kpi:nth-child(2) .kv', e => e.textContent), /^0$/);
  await page.evaluate(id => { setStatus(issue(id), 'todo'); save(); }, id);
  assert.equal(await page.evaluate(id => issue(id).doneAt, id), null);
  await ctx.close();
});

test('completing a sprint moves unfinished work to the next sprint', { skip }, async () => {
  const { ctx, page } = await fresh();
  await go(page, 'backlog');
  const [open, s2] = await page.evaluate(() => [db.issues.filter(i => i.sprintId === 1 && i.status !== 'done').length, db.issues.filter(i => i.sprintId === 2).length]);
  await page.click('[data-complete="1"]'); await saved(page);
  const r = await page.evaluate(() => ({ s1: sprint(1).state, moved: db.issues.filter(i => i.sprintId === 2).length, active: db.sprints.filter(s => s.state === 'active').length }));
  assert.equal(r.s1, 'completed'); assert.equal(r.moved, s2 + open); assert.equal(r.active, 0);
  await page.click('[data-start="2"]'); await saved(page);
  assert.equal(await page.evaluate(() => sprint(2).state), 'active');
  await assertCleanEverywhere(page);
  await ctx.close();
});

test('deleting an epic, sprint and release keeps issues and views intact', { skip }, async () => {
  const { ctx, page } = await fresh();
  const n = await page.evaluate(() => db.issues.length);
  await page.evaluate(() => openEpic(db.epics[0])); await page.click('.modal [data-del]'); await saved(page);
  await page.evaluate(() => openSprint(sprint(2))); await page.click('.modal [data-del]'); await saved(page);
  await page.evaluate(() => openRelease(db.releases[0])); await page.click('.modal [data-del]'); await saved(page);
  const r = await page.evaluate(() => ({ n: db.issues.length, epics: db.epics.length, dangling: db.issues.filter(i => (i.epicId && !epic(i.epicId)) || (i.sprintId && !sprint(i.sprintId)) || (i.releaseId && !release(i.releaseId))).length }));
  assert.equal(r.n, n); assert.equal(r.epics, 2); assert.equal(r.dangling, 0);
  await assertCleanEverywhere(page);
  await ctx.close();
});

test('the active sprint cannot be deleted', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => openSprint(sprint(1)));
  assert.equal(await page.$('.modal [data-del]'), null);
  await ctx.close();
});

test('validation: epic dates, sprint dates, empty names', { skip }, async () => {
  const { ctx, page } = await fresh();
  dialogs.length = 0;
  await page.evaluate(() => openEpic());
  await page.$eval('.modal [name=name]', e => e.value = 'Bad dates');
  await page.$eval('.modal [name=start]', e => e.value = '2026-05-01');
  await page.$eval('.modal [name=due]', e => e.value = '2026-01-01');
  await page.click('.modal [data-ok]');
  assert.ok(dialogs.some(d => /Target date/.test(d))); assert.ok(await page.$('.modal'));
  await page.keyboard.press('Escape');
  await page.evaluate(() => openSprint());
  await page.$eval('.modal [name=end]', e => e.value = '2000-01-01');
  await page.click('.modal [data-ok]');
  assert.ok(dialogs.some(d => /Check the dates/.test(d)));
  await page.keyboard.press('Escape');
  await page.evaluate(() => openIssue());
  await page.click('.modal [data-ok]');
  assert.ok(dialogs.some(d => /Summary is required/.test(d)));
  assert.equal(await page.evaluate(() => db.epics.some(e => e.name === 'Bad dates')), false);
  await ctx.close();
});

test('an issue with sub-tasks cannot be made a sub-task', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => openIssue(db.issues.find(i => db.issues.some(c => c.parentId === i.id))));
  assert.ok(await page.$eval('.modal [name=parentId]', e => e.disabled));
  await ctx.close();
});

test('import rejects broken files and leaves the plan alone', { skip }, async () => {
  const { ctx, page } = await fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  const before = await page.evaluate(() => JSON.stringify(db.issues));
  for (const [name, body] of [['bad.json', '{ not json'], ['wrong.json', '{"hello":"world"}'], ['array.json', '[1,2,3]'], ['empty.json', '']]) {
    fs.writeFileSync(path.join(dir, name), body);
    dialogs.length = 0;
    await page.evaluate(() => openData());
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.modal [data-a=import]')]);
    await chooser.accept([path.join(dir, name)]);
    await page.waitForFunction(() => true);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(dialogs.some(d => /Could not import/.test(d)), `${name}: ${dialogs}`);
    await page.keyboard.press('Escape');
  }
  assert.equal(await page.evaluate(() => JSON.stringify(db.issues)), before);
  await ctx.close();
});

test('import of a hostile plan renders safely', { skip }, async () => {
  const { ctx, page } = await fresh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
  const evil = { epics: [{ id: 1, name: '<b>x</b>', color: '#fff" onmouseover="window.__xss=1', due: 'nope' }],
    sprints: [{ id: 1, name: 's', state: 'active' }, { id: 2, name: 's2', state: 'active' }],
    issues: [{ id: 1, title: 'a', parentId: 1, epicId: 1, sprintId: 1, type: 'zzz', priority: 'zzz', status: 'done', points: 'many' }, { id: 1 }, { id: 2, parentId: 1, status: 'done', doneAt: '2026-99-99' }] };
  fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify(evil));
  await page.evaluate(() => openData());
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.modal [data-a=import]')]);
  await chooser.accept([path.join(dir, 'evil.json')]);
  await page.waitForFunction(() => db.issues.length === 2);
  await assertCleanEverywhere(page);
  for (const m of await page.$$('.elz, .ec, [data-tip]')) await m.hover().catch(() => {});
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await ctx.close();
});

test('export produces a backup that imports back identically', { skip }, async () => {
  const { ctx, page } = await fresh();
  // headless Chrome blocks downloads, so capture the file the app hands to the browser
  await page.evaluate(() => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = b => { window.__blob = b; return orig(b); };
    HTMLAnchorElement.prototype.click = function () { window.__download = this.download; };
  });
  await page.evaluate(() => openData()); await page.click('.modal [data-a=export]');
  assert.match(await page.evaluate(() => window.__download), /^lifesprint-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-dl-')), file = path.join(dir, 'backup.json');
  fs.writeFileSync(file, await page.evaluate(() => window.__blob.text()));
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(exported.issues, await page.evaluate(() => db.issues));
  // wipe, then import it back
  await page.evaluate(() => replacePlan(seedPlan(false)));
  await page.evaluate(() => openData());
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.modal [data-a=import]')]);
  await chooser.accept([file]);
  await page.waitForFunction(n => db.issues.length === n, {}, exported.issues.length);
  assert.deepStrictEqual(await page.evaluate(() => db.issues), exported.issues);
  await ctx.close();
});

test('two windows stay in sync', { skip }, async () => {
  const { ctx, page: a } = await fresh();
  const b = await ctx.newPage(); watch(b); await b.goto(base); await b.waitForSelector('#app h1');
  await a.evaluate(() => { newIssue({ title: 'From window A' }); save(); }); await saved(a);
  await b.waitForFunction(() => db.issues.some(i => i.title === 'From window A'), { timeout: 3000 });
  await b.evaluate(() => { newIssue({ title: 'From window B' }); save(); }); await saved(b);
  await a.waitForFunction(() => db.issues.some(i => i.title === 'From window B'), { timeout: 3000 });
  assert.equal(await a.evaluate(() => db.issues.filter(i => /From window/.test(i.title)).length), 2);
  assert.equal(await a.evaluate(() => new Set(db.issues.map(i => i.id)).size === db.issues.length), true, 'no duplicate ids');
  await ctx.close();
});

test('empty plan: no broken numbers anywhere', { skip }, async () => {
  const { ctx, page } = await fresh('empty');
  await assertCleanEverywhere(page);
  assert.match(await text(page), /No issues/i);
  await ctx.close();
});

test('large plan (3000 issues) stays responsive', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => {
    const p = seedPlan(true);
    for (let k = 0; k < 3000; k++) { p.seq++; p.issues.push({ ...p.issues[0], id: p.seq, key: 'LS-' + p.seq, title: 'Bulk ' + k, parentId: null, sprintId: k % 3 ? null : 1, epicId: 1 + k % 3, status: ['todo', 'inprogress', 'done'][k % 3], doneAt: k % 3 === 2 ? today() : null }); }
    replacePlan(normalizePlan(p));
  });
  for (const v of VIEWS) {
    const ms = await page.evaluate(v => { const t = performance.now(); view = v; render(); return performance.now() - t; }, v);
    assert.ok(ms < 1500, `${v} took ${Math.round(ms)}ms`);
  }
  await ctx.close();
});

test('works offline after the first visit', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker.ready.then(() => true), { timeout: 10000 });
  await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 10000 });
  await page.setOfflineMode(true);
  await page.reload(); await page.waitForSelector('#app h1', { timeout: 5000 });
  assert.ok(await page.evaluate(() => db.issues.length > 0));
  await page.setOfflineMode(false);
  await ctx.close();
});

test('phone-sized screen has no sideways page scroll', { skip }, async () => {
  const { ctx, page } = await fresh('example', { width: 390, height: 844 });
  for (const v of VIEWS) {
    await go(page, v);
    const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(sw <= w + 1, `${v}: page is ${sw}px wide on a ${w}px screen`);
  }
  await ctx.close();
});

test('keyboard: Escape closes dialogs, / focuses search', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => openIssue(db.issues[0]));
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.modal'), null);
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
  await ctx.close();
});

test('dashboard tooltips show values on hover', { skip }, async () => {
  const { ctx, page } = await fresh();
  await go(page, 'dashboard');
  await page.hover('.prow .track i, .stack i');
  assert.equal(await page.$eval('#tip', t => t.hidden), false);
  const r = await page.$eval('.chart .hit', e => { const b = e.getBoundingClientRect(); return [b.x + b.width - 5, b.y + b.height / 2]; });
  await page.mouse.move(...r);
  assert.match(await page.$eval('#tip', t => t.innerText), /pts/);
  await ctx.close();
});

test('damaged browser settings do not break the app', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => { localStorage.setItem('ui', '{"toggled":5,"min":"x"}'); localStorage.setItem('dash', '{"range":"abc","epic":{}}'); localStorage.setItem('theme', '"><script>'); });
  await page.reload(); await page.waitForSelector('#app h1');
  await assertCleanEverywhere(page);
  await page.evaluate(() => localStorage.setItem('ui', 'not json')); await page.reload(); await page.waitForSelector('#app h1');
  await ctx.close();
});

test('Issue type exists and old "bug" items show as Issues', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => openIssue(db.issues[0]));
  assert.deepStrictEqual(await page.$$eval('.modal [name=type] option', o => o.map(x => x.textContent)), ['Story', 'Task', 'Issue']);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const p = JSON.parse(JSON.stringify(db)); p.issues[0].type = 'bug'; replacePlan(normalizePlan(p)); });
  assert.equal(await page.evaluate(() => db.issues[0].type), 'issue');
  await go(page, 'backlog');
  assert.ok(await page.$('svg.ti title') && await page.evaluate(() => [...document.querySelectorAll('svg.ti title')].some(t => t.textContent === 'issue')));
  assert.ok(!/\bbug\b/i.test(await text(page)));
  await ctx.close();
});

test('comments are saved, survive reload and can be deleted', { skip }, async () => {
  const { ctx, page } = await fresh();
  const id = await page.evaluate(() => db.issues.find(i => !i.parentId).id);
  await page.evaluate(id => openIssue(issue(id)), id);
  const before = await page.evaluate(id => issue(id).comments.length, id);
  await page.type('#cText', 'First note <b>bold?</b>\nsecond line');
  await page.click('#cAdd'); await saved(page);
  await page.type('#cText', '   '); await page.click('#cAdd');                  // blank is ignored
  await page.focus('#cText'); await page.keyboard.type('Posted with keyboard');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control'); await saved(page);
  assert.equal(await page.evaluate(id => issue(id).comments.length, id), before + 2);
  assert.match(await page.$eval('#clist', e => e.innerText), /First note <b>bold\?<\/b>/);
  await page.keyboard.press('Escape');                                           // comments don't depend on Save
  await page.reload(); await page.waitForSelector('#app h1');
  await page.evaluate(id => openIssue(issue(id)), id);
  assert.equal(await page.$eval('#cCount', e => e.textContent), String(before + 2));
  await page.click('[data-cdel]'); await saved(page);
  assert.equal(await page.evaluate(id => issue(id).comments.length, id), before + 1);
  await ctx.close();
});

test('history records status and field changes', { skip }, async () => {
  const { ctx, page } = await fresh();
  const id = await page.evaluate(() => db.issues.find(i => !i.parentId && i.sprintId).id);
  await go(page, 'backlog');
  await page.select(`[data-st="${id}"]`, 'inprogress'); await saved(page);
  await page.evaluate(id => openIssue(issue(id)), id);
  await page.select('.modal [name=priority]', 'Highest');
  await page.$eval('.modal [name=assignee]', e => { e.value = 'Alex Doe'; });
  await page.click('.modal [data-ok]'); await saved(page);
  await page.evaluate(id => openIssue(issue(id)), id);
  await page.click('[data-tab=h]');
  const h = await page.$eval('#tab-h', e => e.innerText);
  assert.match(h, /Status: To Do → In Progress/); assert.match(h, /Priority: \w+ → Highest/); assert.match(h, /Assignee: None → Alex Doe/); assert.match(h, /Created this issue/);
  await ctx.close();
});

test('drag a row onto another row to reorder the backlog', { skip }, async () => {
  const { ctx, page } = await fresh();
  await go(page, 'backlog');
  const order = () => page.$$eval('.sec[data-zone="1"] .row:not(.sub)', r => r.map(x => +x.dataset.id));
  const [first, second, third] = await order();
  // real DOM drag events, as a mouse drag would fire them
  await page.evaluate((from, to) => {
    const src = document.querySelector(`.row[data-id="${from}"]`), dst = document.querySelector(`.row[data-id="${to}"]`), dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, third, first);
  await saved(page);
  assert.deepStrictEqual((await order()).slice(0, 3), [third, first, second]);
  await page.reload(); await page.waitForSelector('#app h1'); await go(page, 'backlog');
  assert.deepStrictEqual((await order()).slice(0, 3), [third, first, second], 'order survives reload');
  // drag a backlog item onto a sprint row: it joins that sprint at that spot
  const fromBacklog = await page.$eval('.sec[data-zone=""] .row:not(.sub)', r => +r.dataset.id);
  await page.evaluate((from, to) => {
    const dt = new DataTransfer();
    document.querySelector(`.row[data-id="${from}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const dst = document.querySelector(`.row[data-id="${to}"]`);
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, fromBacklog, third);
  await saved(page);
  assert.equal((await order())[0], fromBacklog);
  assert.equal(await page.evaluate(id => issue(id).sprintId, fromBacklog), 1);
  await ctx.close();
});

test('clone copies the issue without its comments or status', { skip }, async () => {
  const { ctx, page } = await fresh();
  const src = await page.evaluate(() => { const i = db.issues.find(x => x.comments.length); setStatus(i, 'done'); save(); return i; });
  await page.evaluate(id => openIssue(issue(id)), src.id);
  await page.click('.modal [data-clone]'); await saved(page);
  const c = await page.evaluate(() => db.issues[db.issues.length - 1]);
  assert.equal(c.title, 'Copy of ' + src.title); assert.equal(c.status, 'todo'); assert.equal(c.comments.length, 0);
  assert.equal(c.epicId, src.epicId); assert.notEqual(c.key, src.key);
  assert.equal(await page.$eval('.modal .mh', (e, key) => e.textContent.includes(key), c.key), true, 'clone opens');
  await ctx.close();
});

test('assignee shows on cards and is searchable; C opens create', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => { const i = db.issues.find(x => x.sprintId === 1 && !x.parentId); i.assignee = 'Priya Shah'; save(); });
  await go(page, 'board');
  assert.equal(await page.$eval('.card .av', e => e.textContent), 'PS');
  await go(page, 'backlog');
  await page.type('#q', 'priya');
  assert.equal(await page.$$eval('.row:not(.sub)', r => r.length), 1);
  await page.$eval('#q', e => { e.value = ''; e.blur(); });
  await page.keyboard.press('c');
  assert.equal(await page.$eval('.modal .mh', e => e.textContent.trim().includes('New issue')), true);
  await page.keyboard.press('Escape');
  await page.focus('#q'); await page.keyboard.press('c');                         // typing "c" in a field must not open it
  assert.equal(await page.$('.modal'), null);
  await ctx.close();
});

test('create form: release hint follows the chosen epic; counts use singular for one', { skip }, async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(() => openIssue());
  assert.equal(await page.$eval('.modal [name=releaseId] option[value=""]', o => o.textContent), 'None');
  const [eid, rname] = await page.evaluate(() => [db.epics[0].id, release(db.epics[0].releaseId).name]);
  await page.select('.modal [name=epicId]', String(eid));
  assert.equal(await page.$eval('.modal [name=releaseId] option[value=""]', o => o.textContent), `From epic (${rname})`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { db.issues = db.issues.filter(i => i.sprintId !== 2); newIssue({ title: 'Only one', sprintId: 2 }); save(); });
  await go(page, 'backlog');
  const t = await text(page);
  assert.match(t, /\(1 issue\)/); assert.ok(!/\b1 issues\b|\b1 epics\b/.test(t));
  await ctx.close();
});

test('Install button is always offered in a browser tab and explains how', { skip }, async () => {
  const { ctx, page } = await fresh();
  assert.equal(await page.$eval('#install', b => b.hidden), false);
  await page.click('#install');
  await page.waitForSelector('.modal ol li');
  assert.match(await page.$eval('.modal', m => m.innerText), /Install LifeSprint/);
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.modal'), null);
  await ctx.close();
});

test('no uncaught errors anywhere in the run', { skip }, () => {
  assert.deepStrictEqual(errors, []);
});
