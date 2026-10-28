// LifeSprint storage: the whole plan is one JSON document kept in this browser's IndexedDB.
// Nothing leaves the device; Export/Import move it between browsers.
const Store = (() => {
  const DB_NAME = 'lifesprint', STORE = 'kv', KEY = 'plan';
  let conn;
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    conn ||= await open();
    return new Promise((res, rej) => {
      const t = conn.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => res(req.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  // tells other open tabs/windows that the plan changed
  const channel = 'BroadcastChannel' in self ? new BroadcastChannel('lifesprint') : null;
  return {
    load: () => tx('readonly', s => s.get(KEY)),
    save: async data => { await tx('readwrite', s => s.put(data, KEY)); channel?.postMessage({ rev: data.rev }); },
    onExternalChange: fn => { if (channel) channel.onmessage = e => fn(e.data); },
  };
})();

const PLAN_STATUSES = ['todo', 'inprogress', 'review', 'done'];
const PLAN_PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
const isoDay = d => d.toLocaleDateString('en-CA');
const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
const quarterOf = d => {
  const y = d.getFullYear(), q = Math.floor(d.getMonth() / 3);
  return { name: `${y}.${q + 1}`, start: isoDay(new Date(y, q * 3, 1)), release: isoDay(new Date(y, q * 3 + 3, 0)) };
};

// Example project shown on first run (or an empty plan)
function seedPlan(example = true) {
  const db = { version: 2, rev: 0, seq: 0, prefix: 'LS', epics: [], issues: [], sprints: [], releases: [] };
  db.sprints.push({ id: 1, name: 'Sprint 1', goal: example ? 'Get started' : '', start: dayOffset(0), end: dayOffset(13), state: 'active' });
  if (!example) { delete db.releases; return normalizePlan(db); }
  db.sprints.push({ id: 2, name: 'Sprint 2', goal: '', start: dayOffset(14), end: dayOffset(27), state: 'planned' });
  // [name, color, startOffsetDays, durationDays, priority, [[title, points, [sub-tasks...], type?]...]]
  const plan = [
    ['Example: Write an eBook', '#6554C0', 0, 60, 'High', [
      ['Pick a topic and outline chapters', 3, ['Research what readers search for', 'Write chapter outline']],
      ['Write the first draft', 8, []],
      ['Design cover and format the book', 5, []],
      ['Publish and market it', 5, []]]],
    ['Example: Grow a social media page', '#FF5630', 0, 120, 'Medium', [
      ['Choose a niche and set up the profile', 2, []],
      ['Learn to shoot and edit short videos', 5, []],
      ['Post consistently for 30 days', 8, ['Make a content calendar']],
      ['Phone storage fills up while filming', 2, [], 'issue']]],
    ['Example: Learn an instrument', '#36B37E', 30, 180, 'Low', [
      ['Learn the basics', 5, []],
      ['Practice 20 minutes a day for a month', 5, []]]],
  ];
  const now = new Date().toISOString();
  plan.forEach(([name, color, so, dur, priority, stories], i) => {
    const epic = { id: i + 1, key: 'E' + (i + 1), name, color, desc: '', status: i === 0 ? 'inprogress' : 'todo', start: dayOffset(so), due: dayOffset(so + dur), priority };
    db.epics.push(epic);
    stories.forEach(([title, points, tasks, type = 'story'], si) => {
      const story = { id: ++db.seq, key: 'LS-' + db.seq, type, title, desc: '', epicId: epic.id, parentId: null,
        sprintId: i < 2 && si < 2 ? 1 : null, status: 'todo', points, priority, due: '', labels: [], created: now, updated: now, doneAt: null,
        history: [{ at: now, field: 'Created', from: '', to: '' }], comments: si === 0 && i === 0 ? [{ id: 'c1', text: 'Start with what readers already search for.', at: now }] : [] };
      db.issues.push(story);
      tasks.forEach(t => db.issues.push({ ...story, id: ++db.seq, key: 'LS-' + db.seq, type: 'task', title: t, points: 1, parentId: story.id, labels: [], comments: [] }));
    });
  });
  delete db.releases;   // let normalizePlan create quarterly releases and slot epics in
  return normalizePlan(db);
}

// Makes any plan (old file, hand-edited backup, partial import) safe to render.
// Throws if it isn't recognisably a LifeSprint plan.
function normalizePlan(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.issues) || !Array.isArray(d.epics) || !Array.isArray(d.sprints))
    throw new Error('This file is not a LifeSprint plan (expected epics, issues and sprints).');
  const str = (v, max = 5000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + 'T00:00')) ? v : '';
  const color = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#6554C0';
  const pick = (v, list, def) => list.includes(v) ? v : def;
  const num = v => Number.isFinite(+v) && +v >= 0 ? Math.min(+v, 999) : 0;   // story points
  const int = v => Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0;
  const ids = (list) => { const seen = new Set(); return list.filter(x => x && typeof x === 'object' && Number.isInteger(+x.id) && +x.id > 0 && !seen.has(+x.id) && seen.add(+x.id)); };

  const releases = Array.isArray(d.releases) ? ids(d.releases).map(r => {
    const start = date(r.start) || isoDay(new Date()), release = date(r.release) || start;
    return { id: +r.id, name: str(r.name, 100) || 'Release', start, release: release < start ? start : release,
      status: pick(r.status, ['unreleased', 'released'], 'unreleased'), desc: str(r.desc), ...(date(r.releasedOn) && { releasedOn: r.releasedOn }) };
  }) : null;
  const relIds = new Set((releases || []).map(r => r.id));
  const ref = (v, set) => set.has(+v) ? +v : null;

  const epics = ids(d.epics).map(e => {
    const start = date(e.start), due = date(e.due);
    return { id: +e.id, key: str(e.key, 20) || 'E' + e.id, name: str(e.name, 200) || 'Untitled epic', color: color(e.color), desc: str(e.desc),
      status: pick(e.status, PLAN_STATUSES, 'todo'), start, due: start && due && due < start ? start : due,
      priority: pick(e.priority, PLAN_PRIORITIES, 'Medium'), releaseId: ref(e.releaseId, relIds) };
  });
  const epicIds = new Set(epics.map(e => e.id));

  let active = false;
  const sprints = ids(d.sprints).map(s => {
    const start = date(s.start) || isoDay(new Date()), end = date(s.end) || start;
    let state = pick(s.state, ['planned', 'active', 'completed'], 'planned');
    if (state === 'active') { if (active) state = 'planned'; active = true; }   // only one active sprint
    return { ...(state === 'completed' && { completedOn: date(s.completedOn), committed: int(s.committed), completed: int(s.completed) }),
      id: +s.id, name: str(s.name, 100) || 'Sprint', goal: str(s.goal), start, end: end < start ? start : end, state };
  });
  const sprintIds = new Set(sprints.map(s => s.id));

  // older plans have no prefix: reuse the one in existing keys (e.g. "AB-12")
  const keyPrefix = d.issues.map(i => /^([A-Za-z0-9]{1,10})-\d+$/.exec(i?.key)?.[1]).find(Boolean);
  const prefix = str(d.prefix, 10).replace(/[^A-Za-z0-9]/g, '') || keyPrefix || 'LS';
  const iso = (v, fallback) => (typeof v === 'string' || typeof v === 'number') && !isNaN(new Date(v)) ? new Date(v).toISOString() : fallback;
  const issues = ids(d.issues).map((i, idx) => {
    const status = pick(i.status, PLAN_STATUSES, 'todo'), created = iso(i.created, new Date().toISOString());
    return { id: +i.id, key: str(i.key, 20) || prefix + '-' + i.id,
      type: pick(i.type === 'bug' ? 'issue' : i.type, ['story', 'task', 'issue'], 'task'),   // "bug" was renamed to "issue"
      title: str(i.title, 500) || 'Untitled', desc: str(i.desc, 50000), epicId: ref(i.epicId, epicIds), parentId: +i.parentId || null,
      sprintId: ref(i.sprintId, sprintIds), releaseId: ref(i.releaseId, relIds), status, points: num(i.points),
      priority: pick(i.priority, PLAN_PRIORITIES, 'Medium'), due: date(i.due), assignee: str(i.assignee, 60).trim(),
      labels: Array.isArray(i.labels) ? i.labels.map(l => str(l, 50)).filter(Boolean).slice(0, 20) : [],
      rank: Number.isFinite(+i.rank) && i.rank !== null && i.rank !== '' ? +i.rank : idx + 1,
      comments: Array.isArray(i.comments) ? i.comments.filter(c => c && typeof c.text === 'string' && c.text.trim()).slice(0, 500)
        .map((c, k) => ({ id: str(c.id, 40) || 'c' + k, text: str(c.text, 10000), at: iso(c.at, created) })) : [],
      history: Array.isArray(i.history) ? i.history.filter(h => h && typeof h.field === 'string').slice(0, 50)
        .map(h => ({ at: iso(h.at, created), field: str(h.field, 40), from: str(h.from, 200), to: str(h.to, 200) })) : [],
      created, updated: iso(i.updated, created),
      doneAt: status === 'done' ? (date(i.doneAt) || created.slice(0, 10)) : null };
  });
  // sub-tasks are one level deep and must point at an existing top-level issue
  const byId = new Map(issues.map(i => [i.id, i]));
  issues.forEach(i => { const p = byId.get(i.parentId); if (!p || p.id === i.id || p.parentId) i.parentId = null; });

  const plan = { version: 2, rev: int(d.rev), prefix, seq: issues.reduce((m, i) => Math.max(m, i.id), int(d.seq)), epics, issues, sprints, releases };
  if (!releases) addQuarterlyReleases(plan);
  return plan;
}

// older plans have no releases: create quarterly ones and slot epics in by target date
function addQuarterlyReleases(plan) {
  plan.releases = [];
  const now = new Date(), maxDue = plan.epics.map(e => e.due).filter(Boolean).sort().pop() || isoDay(now);
  for (let d = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1), n = 0; n < 5 || isoDay(d) <= maxDue; d.setMonth(d.getMonth() + 3), n++)
    plan.releases.push({ id: n + 1, ...quarterOf(d), desc: '', status: 'unreleased' });
  plan.epics.forEach(e => { e.releaseId = plan.releases.find(r => e.due >= r.start && e.due <= r.release)?.id ?? null; });
}
