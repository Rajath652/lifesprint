// Tries to break plan loading/import (normalizePlan) with hostile, broken and old data.
const test = require('node:test'), assert = require('node:assert'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');

const ctx = { self: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/store.js'), 'utf8') + ';globalThis.api = { normalizePlan, seedPlan };', ctx);
const { normalizePlan, seedPlan } = ctx.api;
const plain = x => JSON.parse(JSON.stringify(x));   // vm objects -> this realm for deepEqual
const base = (over = {}) => ({ seq: 0, epics: [], issues: [], sprints: [], ...over });
const issue = (over = {}) => ({ id: 1, key: 'LS-1', type: 'story', title: 'T', status: 'todo', priority: 'Medium', points: 3, labels: [], created: '2026-01-01T00:00:00.000Z', ...over });

test('rejects things that are not plans', () => {
  for (const bad of [null, undefined, 42, 'plan', [], {}, { issues: [] }, { epics: [], issues: {}, sprints: [] }, { epics: 'x', issues: [], sprints: [] }])
    assert.throws(() => normalizePlan(bad), /not a LifeSprint plan/, JSON.stringify(bad));
});

test('example plan is complete and valid', () => {
  const p = seedPlan(true);
  assert.equal(p.epics.length, 3);
  assert.ok(p.issues.length > 5);
  assert.ok(p.releases.length >= 5);
  assert.ok(p.epics.every(e => p.releases.some(r => r.id === e.releaseId)), 'every epic in a release');
  assert.equal(p.sprints.filter(s => s.state === 'active').length, 1);
  assert.ok(p.issues.every(i => /^LS-\d+$/.test(i.key)));
  assert.equal(p.seq, Math.max(...p.issues.map(i => i.id)));
});

test('empty plan is valid', () => {
  const p = seedPlan(false);
  assert.equal(p.issues.length, 0); assert.equal(p.epics.length, 0);
  assert.equal(p.sprints.length, 1); assert.ok(p.releases.length >= 5);
});

test('normalising twice changes nothing', () => {
  const once = normalizePlan(seedPlan(true));
  assert.deepStrictEqual(plain(normalizePlan(plain(once))), plain(once));
});

test('hostile values are neutralised', () => {
  const p = normalizePlan(base({
    epics: [{ id: 1, name: '<img src=x onerror=alert(1)>', color: 'red" onmouseover="alert(1)', status: 'pwned', priority: 'urgent', start: '2026-13-45', due: '<script>' }],
    issues: [issue({ type: 'exploit', status: 'hacked', priority: 'x', points: -5, due: '2026-02-30x', labels: 'not-an-array', doneAt: 'whenever' }),
      issue({ id: 2, points: 'abc' }), issue({ id: 3, points: 1e12 }), issue({ id: 4, points: Infinity }), issue({ id: 5, title: 'x'.repeat(100000) })],
    sprints: [{ id: 1, name: 5, start: 'yesterday', end: null, state: 'running' }],
  }));
  const e = p.epics[0];
  assert.equal(e.color, '#6554C0'); assert.equal(e.status, 'todo'); assert.equal(e.priority, 'Medium');
  assert.equal(e.start, ''); assert.equal(e.due, '');
  const [a, b, c, d, long] = p.issues;
  assert.equal(a.type, 'task'); assert.equal(a.status, 'todo'); assert.equal(a.priority, 'Medium');
  assert.equal(a.points, 0); assert.equal(a.due, ''); assert.deepStrictEqual(plain(a.labels), []); assert.equal(a.doneAt, null);
  assert.equal(b.points, 0); assert.equal(c.points, 999); assert.equal(d.points, 0);
  assert.equal(long.title.length, 500);
  const s = p.sprints[0];
  assert.equal(s.state, 'planned'); assert.equal(s.name, '5'); assert.match(s.start, /^\d{4}-\d{2}-\d{2}$/); assert.equal(s.end, s.start);
});

test('broken references are cleared', () => {
  const p = normalizePlan(base({
    epics: [{ id: 1, name: 'E', releaseId: 77 }],
    releases: [{ id: 1, name: 'R', start: '2026-01-01', release: '2026-03-31' }],
    sprints: [{ id: 1, name: 'S', start: '2026-01-01', end: '2026-01-14', state: 'active' }],
    issues: [
      issue({ id: 1, epicId: 99, sprintId: 99, releaseId: 99, parentId: 1 }),       // self-parent
      issue({ id: 2, parentId: 404 }),                                              // missing parent
      issue({ id: 3, parentId: 4 }), issue({ id: 4, parentId: 5 }), issue({ id: 5 }), // chain 3 -> 4 -> 5
      issue({ id: 6, epicId: 1, sprintId: 1, releaseId: 1, parentId: 5 }),         // valid
    ],
  }));
  const by = Object.fromEntries(p.issues.map(i => [i.id, i]));
  assert.equal(p.epics[0].releaseId, null);
  assert.equal(by[1].epicId, null); assert.equal(by[1].sprintId, null); assert.equal(by[1].releaseId, null); assert.equal(by[1].parentId, null);
  assert.equal(by[2].parentId, null);
  assert.ok(p.issues.every(i => !i.parentId || !by[i.parentId].parentId), 'sub-tasks are one level deep');
  assert.deepStrictEqual([by[6].epicId, by[6].sprintId, by[6].releaseId, by[6].parentId], [1, 1, 1, 5]);
});

test('duplicates, junk entries and bad ids are dropped', () => {
  const p = normalizePlan(base({ issues: [issue({ id: 1 }), issue({ id: 1, title: 'dupe' }), null, 'str', 7, issue({ id: -3 }), issue({ id: 'abc' }), issue({ id: 2.5 }), issue({ id: '9' })] }));
  assert.deepStrictEqual(plain(p.issues.map(i => i.id)), [1, 9]);
  assert.equal(p.issues[0].title, 'T');
  assert.ok(p.seq >= 9, 'next id will not collide');
});

test('only one sprint can be active', () => {
  const p = normalizePlan(base({ sprints: [1, 2, 3].map(id => ({ id, name: 'S' + id, start: '2026-01-01', end: '2026-01-10', state: 'active' })) }));
  assert.deepStrictEqual(plain(p.sprints.map(s => s.state)), ['active', 'planned', 'planned']);
});

test('dates out of order are repaired', () => {
  const p = normalizePlan(base({
    epics: [{ id: 1, name: 'E', start: '2026-05-01', due: '2026-01-01' }],
    sprints: [{ id: 1, name: 'S', start: '2026-05-10', end: '2026-05-01' }],
    releases: [{ id: 1, name: 'R', start: '2026-06-01', release: '2026-01-01' }],
  }));
  assert.equal(p.epics[0].due, '2026-05-01'); assert.equal(p.sprints[0].end, '2026-05-10'); assert.equal(p.releases[0].release, '2026-06-01');
});

test('old plans keep their key prefix and get quarterly releases', () => {
  const p = normalizePlan(base({ epics: [{ id: 1, name: 'E', due: new Date().toLocaleDateString('en-CA') }], issues: [issue({ key: 'AB-1' })] }));
  assert.equal(p.prefix, 'AB');
  assert.ok(p.releases.length >= 5);
  assert.ok(p.epics[0].releaseId, 'epic slotted into the current quarter');
});

test('prototype pollution in an imported file has no effect', () => {
  const evil = JSON.parse('{"__proto__":{"polluted":true},"epics":[],"sprints":[],"issues":[{"id":1,"title":"x","__proto__":{"polluted":true}}]}');
  const p = normalizePlan(evil);
  assert.equal(({}).polluted, undefined); assert.equal(p.issues[0].polluted, undefined); assert.equal(p.polluted, undefined);
});

test('a large plan normalises quickly', () => {
  const issues = Array.from({ length: 20000 }, (_, k) => issue({ id: k + 1, key: 'LS-' + (k + 1), parentId: k % 5 ? k - (k % 5) + 1 : null }));
  const t = Date.now(), p = normalizePlan(base({ issues }));
  assert.equal(p.issues.length, 20000);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t}ms`);
});

test('the real data.json (if present) imports without losing anything', { skip: !fs.existsSync(path.join(__dirname, '../data.json')) }, () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data.json'), 'utf8'));
  const p = normalizePlan(raw);
  assert.equal(p.issues.length, raw.issues.length); assert.equal(p.epics.length, raw.epics.length); assert.equal(p.sprints.length, raw.sprints.length);
  assert.deepStrictEqual(plain(p.issues.map(i => i.key)), raw.issues.map(i => i.key));
});

test('old "bug" items become the Issue type', () => {
  const p = normalizePlan(base({ issues: [issue({ type: 'bug' }), issue({ id: 2, type: 'issue' })] }));
  assert.deepStrictEqual(plain(p.issues.map(i => i.type)), ['issue', 'issue']);
});

test('comments, history, assignee and rank are cleaned up', () => {
  const p = normalizePlan(base({ issues: [
    issue({ assignee: '  Sam  ', rank: '7', comments: [{ id: 'a', text: 'hi', at: '2026-01-02T00:00:00Z' }, { text: '   ' }, null, { text: 5 }, { text: 'x'.repeat(20000), at: 'never' }],
      history: [{ field: 'Status', from: 'To Do', to: 'Done', at: '2026-01-03T00:00:00Z' }, { nope: 1 }, 'junk'] }),
    issue({ id: 2, assignee: 42, comments: 'nope', history: {}, rank: null }),
  ] }));
  const [a, b] = p.issues;
  assert.equal(a.assignee, 'Sam'); assert.equal(a.rank, 7);
  assert.equal(a.comments.length, 2); assert.equal(a.comments[1].text.length, 10000); assert.equal(a.comments[1].at, a.created);
  assert.equal(a.history.length, 1);
  assert.equal(b.assignee, '42'); assert.deepStrictEqual(plain(b.comments), []); assert.deepStrictEqual(plain(b.history), []); assert.equal(b.rank, 2);
});

test('example plan includes every issue type and a comment', () => {
  const p = seedPlan(true);
  assert.ok(['story', 'task', 'issue'].every(t => p.issues.some(i => i.type === t)));
  assert.ok(p.issues.some(i => i.comments.length));
  assert.ok(p.issues.every(i => i.history.length >= 1));
});
