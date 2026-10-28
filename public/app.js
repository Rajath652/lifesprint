// LifeSprint front-end: whole plan lives in memory, saved to this browser (store.js) on every change.
let db, view = location.hash.slice(1) || 'dashboard', boardSprint = null, epicFilter = '', drag = null;
const STATUSES = [['todo', 'To Do'], ['inprogress', 'In Progress'], ['review', 'In Review'], ['done', 'Done']];
const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
const POINTS = [0, 1, 2, 3, 5, 8, 13, 21];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA');
const epic = id => db.epics.find(e => e.id == id);
const sprint = id => db.sprints.find(s => s.id == id);
const issue = id => db.issues.find(i => i.id == id);
const release = id => db.releases.find(r => r.id == id);
// an issue's release: its own, else inherited from its epic
const relOf = i => i.releaseId || epic(i.epicId)?.releaseId || null;
let relFilter = '';
const pts = list => list.reduce((a, i) => a + (+i.points || 0), 0);
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v == sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
const fmt = d => d ? new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
const ago = iso => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

// UI state kept per browser: collapsed sections, expanded parents, sidebar
let ui = { toggled: [], min: false };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem('ui') || '{}') }; } catch {}
const toggled = new Set(Array.isArray(ui.toggled) ? ui.toggled.filter(k => typeof k === 'string') : []);
const persistUi = () => { try { localStorage.setItem('ui', JSON.stringify({ ...ui, toggled: [...toggled] })); } catch {} };
// sections ("s…") are open by default, parent issues ("i…") are collapsed by default
const isOpen = k => k[0] === 'i' ? toggled.has(k) : !toggled.has(k);

// ---------- icons ----------
const svg = (p, c = 'currentColor', w = 1.8) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const CHEV = svg('<path d="M6 4l4 4-4 4"/>');
const TYPE_ICON = {
  story: ['#63ba3c', '<path d="M5.5 4h5v8L8 10l-2.5 2z" fill="#fff"/>'],
  task: ['#4bade8', '<path d="M4.8 8.3l2.1 2.1 4.3-4.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'],
  issue: ['#e5493a', '<path d="M8 4.2v4.6" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="11.6" r="1.15" fill="#fff"/>'],
  subtask: ['#4bade8', '<rect x="4" y="4" width="5" height="5" rx="1" stroke="#fff" fill="none" stroke-width="1.4"/><rect x="7" y="7" width="5" height="5" rx="1" fill="#fff"/>'],
  epic: ['#904ee2', '<path d="M9 3L5 9h3l-1 4 4-6H8z" fill="#fff"/>'],
};
const typeIcon = t => { const [c, g] = TYPE_ICON[t]; return `<svg class="ti" viewBox="0 0 16 16" width="16" height="16"><title>${t}</title><rect width="16" height="16" rx="3" fill="${c}"/>${g}</svg>`; };
const PRI_ICON = {
  Highest: ['#e2483d', '<path d="M3 8.5l5-4 5 4M3 12.5l5-4 5 4"/>'], High: ['#e2483d', '<path d="M3 10.5l5-4.5 5 4.5"/>'],
  Medium: ['#e97f33', '<path d="M3 6h10M3 10h10"/>'], Low: ['#2684ff', '<path d="M3 5.5l5 4.5 5-4.5"/>'],
  Lowest: ['#2684ff', '<path d="M3 3.5l5 4 5-4M3 7.5l5 4 5-4"/>'],
};
const TAG_PATH = '<path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8z"/><circle cx="5.4" cy="5.4" r=".9" fill="currentColor"/>';
const priIcon = p => `<span class="pri" title="${p} priority">${svg(PRI_ICON[p][1], PRI_ICON[p][0], 2)}</span>`;
const VIEWS = [
  ['dashboard', 'Dashboard', '<rect x="2" y="2" width="5" height="6" rx="1"/><rect x="9" y="2" width="5" height="3.5" rx="1"/><rect x="2" y="10" width="5" height="4" rx="1"/><rect x="9" y="7.5" width="5" height="6.5" rx="1"/>'],
  ['board', 'Board', '<rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/>'],
  ['backlog', 'Backlog', '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'],
  ['epics', 'Epics', '<path d="M9 1.8L3.8 9h3.6l-1 5.2L12.2 7H8.6z"/>'],
  ['releases', 'Releases', TAG_PATH],
  ['roadmap', 'Roadmap', '<path d="M2.5 4h6M5 8h7M3.5 12h5"/>'],
  ['reports', 'Reports', '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>'],
];

// ---------- data ----------
// IndexedDB copies the plan synchronously when the write is queued, so writes land in order
function save() {
  db.rev++;
  $('#saved').textContent = 'Saving…';
  Store.save(db).then(
    () => { $('#saved').textContent = 'Saved on this device'; },
    err => { $('#saved').textContent = '⚠ Not saved: ' + (err?.message || 'browser storage error'); });
  render();
}

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const statusName = s => STATUSES.find(x => x[0] === s)?.[1] || s;

// change history shown in the issue's Activity tab (newest first, capped)
function logChange(i, field, from = '', to = '') {
  if (String(from) === String(to) && field !== 'Created') return;
  (i.history ||= []).unshift({ at: new Date().toISOString(), field, from: String(from ?? ''), to: String(to ?? '') });
  if (i.history.length > 50) i.history.length = 50;
}

function setStatus(i, status) {
  logChange(i, 'Status', statusName(i.status), statusName(status));
  i.status = status; i.updated = new Date().toISOString();
  i.doneAt = status === 'done' ? (i.doneAt || today()) : null;
}

// backlog order: lower rank = higher up
const byRank = (a, b) => a.rank - b.rank || a.id - b.id;
const renumber = () => [...db.issues].sort(byRank).forEach((x, k) => { x.rank = k + 1; });

function newIssue(f) {
  const now = new Date().toISOString(); db.seq++;
  const i = { id: db.seq, key: db.prefix + '-' + db.seq, type: 'story', title: '', desc: '', epicId: null, parentId: null, sprintId: null, releaseId: null,
    status: 'todo', points: 0, priority: 'Medium', due: '', labels: [], assignee: '', comments: [], history: [],
    rank: db.issues.reduce((m, x) => Math.max(m, x.rank || 0), 0) + 1, created: now, updated: now, doneAt: null, ...f };
  logChange(i, 'Created');
  db.issues.push(i); return i;
}

// drag in the backlog: put d just above t (and in t's sprint); sub-tasks travel with their parent
function moveBefore(d, t) {
  if (t.parentId) t = issue(t.parentId);
  if (!d || !t || d.id === t.id || d.parentId) return;
  if (d.sprintId != t.sprintId) logChange(d, 'Sprint', sprint(d.sprintId)?.name || 'Backlog', sprint(t.sprintId)?.name || 'Backlog');
  [d, ...db.issues.filter(c => c.parentId == d.id)].forEach(x => { x.sprintId = t.sprintId; });
  d.rank = t.rank - 0.5; renumber();
}

const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const avatar = n => n ? `<span class="av" title="Assignee: ${esc(n)}">${esc(initials(n))}</span>` : '';

// ---------- shared pieces ----------
const chip = id => { const e = epic(id); return e ? `<span class="elz" style="--c:${esc(e.color)}" title="Epic: ${esc(e.name)}">${esc(e.name)}</span>` : ''; };
const loz = (st, attrs = '', big = '') => `<span class="lozw"><select class="loz s-${st} ${big}" ${attrs}>${opts(STATUSES, st)}</select></span>`;
const matches = i => {
  const q = $('#q').value.trim().toLowerCase();
  return (!q || (i.title + ' ' + i.key + ' ' + i.labels.join(' ') + ' ' + i.assignee).toLowerCase().includes(q)) && (!epicFilter || i.epicId == epicFilter) && (!relFilter || relOf(i) == relFilter);
};
const epicSelect = () => `<select id="ef" class="fsel"><option value="">Epic: All</option>${opts(db.epics.map(e => [e.id, e.name]), epicFilter)}</select>
  <select id="rf" class="fsel"><option value="">Release: All</option>${opts(db.releases.map(r => [r.id, r.name]), relFilter)}</select>`;
const bindEpicSelect = () => {
  $('#ef').onchange = e => { epicFilter = e.target.value; render(); };
  $('#rf').onchange = e => { relFilter = e.target.value; render(); };
};

function row(i, sub, kids = []) {
  const k = 'i' + i.id;
  return `<div class="row ${sub ? 'sub' : ''} ${i.status === 'done' ? 'done' : ''}" draggable="true" data-id="${i.id}">
    <span class="tg">${kids.length ? `<button class="chev ${isOpen(k) ? 'open' : ''}" data-tog="${k}" title="Show sub-tasks">${CHEV}</button>` : ''}</span>
    ${typeIcon(i.parentId ? 'subtask' : i.type)}<span class="key">${i.key}</span><span class="t" title="${esc(i.title)}">${esc(i.title)}</span>
    ${kids.length ? `<span class="kc" title="Sub-tasks done">${kids.filter(c => c.status === 'done').length}/${kids.length}</span>` : ''}
    ${!sub && relOf(i) ? `<span class="rv" title="Release">${esc(release(relOf(i))?.name)}</span>` : ''}${sub ? '' : chip(i.epicId)}${loz(i.status, `data-st="${i.id}"`)}<span class="pts" title="Story points">${i.points || '-'}</span>${priIcon(i.priority)}${avatar(i.assignee)}</div>`;
}

// top-level issues (in rank order) with their sub-tasks nested (collapsible) underneath
function tree(list) {
  const tops = list.filter(i => !i.parentId || !list.some(p => p.id == i.parentId)).sort(byRank);
  return tops.map(i => {
    const kids = list.filter(c => c.parentId == i.id).sort(byRank);
    return row(i, false, kids) + (kids.length && isOpen('i' + i.id) ? kids.map(c => row(c, true)).join('') : '');
  }).join('') || '<div class="empty">No issues here yet</div>';
}

function bindRows(root, onOpen = i => openIssue(i)) {
  root.querySelectorAll('[data-id]').forEach(el => {
    el.onclick = () => onOpen(issue(el.dataset.id));
    el.ondragstart = e => { drag = +el.dataset.id; e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
  });
  root.querySelectorAll('[data-st]').forEach(el => {
    el.onclick = e => e.stopPropagation();
    el.onchange = () => { setStatus(issue(el.dataset.st), el.value); save(); };
  });
  bindToggles(root);
}

// backlog only: dropping a row on another row reorders (the section drop still moves between sprints)
function bindRank(root) {
  root.querySelectorAll('.row[data-id]').forEach(el => {
    el.addEventListener('dragover', e => { if (drag && drag != el.dataset.id) { e.preventDefault(); el.classList.add('dropbefore'); } });
    el.addEventListener('dragleave', () => el.classList.remove('dropbefore'));
    el.addEventListener('drop', e => {
      el.classList.remove('dropbefore');
      if (!drag || drag == el.dataset.id || issue(drag).parentId) return;
      e.preventDefault(); e.stopPropagation();
      moveBefore(issue(drag), issue(el.dataset.id)); drag = null; save();
    });
  });
}

function bindToggles(root) {
  root.querySelectorAll('[data-tog]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const k = b.dataset.tog; toggled.has(k) ? toggled.delete(k) : toggled.add(k); persistUi(); render();
  });
}

function dropZone(el, onDrop) {
  el.ondragover = e => { e.preventDefault(); el.classList.add('over'); };
  el.ondragleave = e => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); };
  el.ondrop = e => { e.preventDefault(); el.classList.remove('over'); if (drag) { onDrop(issue(drag)); drag = null; save(); } };
}

const statusPts = list => STATUSES.filter(([s]) => s !== 'review').map(([s, l]) => {
  const v = pts(list.filter(i => s === 'inprogress' ? ['inprogress', 'review'].includes(i.status) : i.status === s));
  return `<span class="ptl s-${s}" title="${l}: ${v} points">${v}</span>`;
}).join('');

// ---------- views ----------
function renderBacklog(app) {
  const sprints = db.sprints.filter(s => s.state !== 'completed').sort((a, b) => (b.state === 'active') - (a.state === 'active') || a.start.localeCompare(b.start));
  const section = s => {
    const k = 's' + (s ? s.id : 'b'), open = isOpen(k);
    const all = db.issues.filter(i => s ? i.sprintId == s.id : !i.sprintId);
    const list = all.filter(matches);
    const head = s
      ? `<b>${esc(s.name)}</b><span class="mute">${fmt(s.start)} – ${fmt(s.end)}</span><span class="mute">(${plural(all.length, 'issue')})</span>
         ${s.state === 'active' ? '<span class="ptl s-inprogress" style="font-size:11px">ACTIVE</span>' : ''}<span class="flex"></span>${statusPts(all)}
         ${s.state === 'active' ? `<button class="btn s" data-complete="${s.id}">Complete sprint</button>` : `<button class="btn s" data-start="${s.id}">Start sprint</button>`}
         <button class="btn s g" data-edit-sprint="${s.id}" title="Edit sprint">•••</button>`
      : `<b>Backlog</b><span class="mute">(${plural(all.length, 'issue')})</span><span class="flex"></span>${statusPts(all)}
         <button class="btn s" id="newSprint">Create sprint</button>`;
    return `<div class="sec ${open ? '' : 'closed'}" data-zone="${s ? s.id : ''}">
      <div class="sh"><button class="chev ${open ? 'open' : ''}" data-tog="${k}">${CHEV}</button>${head}</div>
      ${s?.goal ? `<div class="goal">${esc(s.goal)}</div>` : ''}
      <div class="list">${tree(list)}</div>
      <div class="add"><input placeholder="+ Create issue" data-add="${s ? s.id : ''}"></div></div>`;
  };
  app.innerHTML = `<h1>Backlog</h1><div class="bar" style="margin-top:16px">${epicSelect()}<span class="flex"></span>
    <button class="btn" id="newEpic">${typeIcon('epic')} Create epic</button></div>
    ${sprints.map(section).join('')}${section(null)}
    <p class="mute">Drag issues between sprints and the backlog · Click an issue to open it · Type in “Create issue” and press Enter</p>`;
  bindEpicSelect(); bindRows(app); bindRank(app); bindToggles(app);
  app.querySelectorAll('[data-zone]').forEach(z => dropZone(z, i => {
    const sid = z.dataset.zone ? +z.dataset.zone : null;
    [i, ...db.issues.filter(c => c.parentId == i.id)].forEach(x => x.sprintId = sid);
  }));
  app.querySelectorAll('[data-add]').forEach(inp => inp.onkeydown = e => {
    if (e.key === 'Escape') inp.blur();
    if (e.key === 'Enter' && inp.value.trim()) {
      newIssue({ title: inp.value.trim(), sprintId: inp.dataset.add ? +inp.dataset.add : null, epicId: epicFilter ? +epicFilter : null });
      save(); $(`[data-add="${inp.dataset.add}"]`)?.focus();
    }
  });
  app.querySelectorAll('[data-start]').forEach(b => b.onclick = () => {
    if (db.sprints.some(s => s.state === 'active')) return alert('Complete the active sprint first.');
    sprint(b.dataset.start).state = 'active'; save();
  });
  app.querySelectorAll('[data-complete]').forEach(b => b.onclick = () => completeSprint(sprint(b.dataset.complete)));
  app.querySelectorAll('[data-edit-sprint]').forEach(b => b.onclick = () => openSprint(sprint(b.dataset.editSprint)));
  $('#newSprint').onclick = () => openSprint();
  $('#newEpic').onclick = () => openEpic();
}

function completeSprint(s) {
  const items = db.issues.filter(i => i.sprintId == s.id);
  const open = items.filter(i => i.status !== 'done');
  const next = db.sprints.filter(x => x.state === 'planned').sort((a, b) => a.start.localeCompare(b.start))[0];
  if (!confirm(`Complete ${s.name}?\n${items.length - open.length} done, ${open.length} open issues will move to ${next ? next.name : 'the Backlog'}.`)) return;
  s.state = 'completed'; s.completedOn = today();
  s.committed = pts(items); s.completed = pts(items.filter(i => i.status === 'done'));
  s.doneIssues = items.filter(i => i.status === 'done').map(i => i.id);
  open.forEach(i => i.sprintId = next ? next.id : null);
  save();
}

function renderBoard(app) {
  const active = db.sprints.filter(s => s.state !== 'completed');
  if (!boardSprint || !sprint(boardSprint)) boardSprint = (active.find(s => s.state === 'active') || active[0])?.id;
  const s = sprint(boardSprint);
  if (!s) { app.innerHTML = '<div class="empty">No sprint yet. Create one from the Backlog.</div>'; return; }
  const list = db.issues.filter(i => i.sprintId == s.id && matches(i));
  const left = Math.ceil((new Date(s.end + 'T23:59') - new Date()) / 864e5);
  app.innerHTML = `<h1>${esc(s.name)}</h1>
    <div class="bar" style="margin-top:16px"><select id="bs" class="fsel">${opts(active.map(x => [x.id, x.name + (x.state === 'active' ? ' (active)' : '')]), s.id)}</select>${epicSelect()}
    <span class="mute">${fmt(s.start)} – ${fmt(s.end)} · ${left >= 0 ? left + ' days remaining' : 'ended'}${s.goal ? ' · ' + esc(s.goal) : ''}</span>
    <span class="flex"></span>${s.state === 'active' ? `<button class="btn" id="cs">Complete sprint</button>` : ''}</div>
    <div class="board">${STATUSES.map(([st, label]) => {
      const col = list.filter(i => i.status === st).sort(byRank);
      return `<div class="col" data-col="${st}"><h3>${label} <span style="font-weight:400">${col.length}</span><span class="flex"></span><span title="Points">${pts(col)} pts</span></h3>
        ${col.map(i => `<div class="card" draggable="true" data-id="${i.id}"><div class="ct">${esc(i.title)}</div>
          ${i.parentId ? `<div class="par">↳ ${esc(issue(i.parentId)?.title)}</div>` : ''}${chip(i.epicId)}
          <div class="m">${typeIcon(i.parentId ? 'subtask' : i.type)}<span class="key">${i.key}</span><span class="flex"></span>
          ${priIcon(i.priority)}<span class="pts">${i.points || '-'}</span>${avatar(i.assignee)}</div></div>`).join('')}</div>`;
    }).join('')}</div>`;
  $('#bs').onchange = e => { boardSprint = +e.target.value; render(); };
  if ($('#cs')) $('#cs').onclick = () => completeSprint(s);
  bindEpicSelect(); bindRows(app);
  app.querySelectorAll('[data-col]').forEach(c => dropZone(c, i => setStatus(i, c.dataset.col)));
}

function renderEpics(app) {
  app.innerHTML = `<h1>Epics</h1><div class="bar" style="margin-top:16px"><span class="mute">${plural(db.epics.length, 'epic')} · progress is measured in story points done</span>
    <span class="flex"></span><button class="btn p" id="newEpic">Create epic</button></div>
    <div class="grid">${db.epics.map(e => {
      const items = db.issues.filter(i => i.epicId == e.id);
      const total = pts(items), done = pts(items.filter(i => i.status === 'done'));
      const pct = total ? Math.round(done / total * 100) : 0;
      return `<div class="ec" style="--c:${esc(e.color)}" data-ed="${e.id}">
        <div class="eh">${typeIcon('epic')}<b class="flex">${esc(e.name)}</b>${priIcon(e.priority)}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px"><span class="ptl s-${e.status}" style="font-size:11px;text-transform:uppercase">${STATUSES.find(s => s[0] === e.status)[1]}</span>
          <span class="mute">${e.key} · ${fmt(e.start)} → ${fmt(e.due)}</span></div>
        <div class="prog"><i style="width:${pct}%"></i></div>
        <div style="display:flex;align-items:center" class="mute"><span class="flex">${pct}% · ${done}/${total} pts · ${items.filter(i => i.status === 'done').length}/${plural(items.length, 'issue')}</span>
          <button class="btn s g" data-open="${e.id}">View issues →</button></div></div>`;
    }).join('')}</div>`;
  $('#newEpic').onclick = () => openEpic();
  app.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => openEpic(epic(b.dataset.ed)));
  app.querySelectorAll('[data-open]').forEach(b => b.onclick = ev => { ev.stopPropagation(); epicFilter = b.dataset.open; location.hash = 'backlog'; });
}

const progress = items => { const t = pts(items), d = pts(items.filter(i => i.status === 'done')); return [t, d, t ? Math.round(d / t * 100) : 0]; };
const relStatus = r => r.status === 'released' ? ['done', 'Released'] : r.release < today() ? ['overdue', 'Overdue'] : ['todo', 'Unreleased'];

// Structure view: Release > Epic > Story > Sub-task, with rolled-up points
function renderReleases(app) {
  const rels = [...db.releases].sort((a, b) => a.release.localeCompare(b.release));
  let dragEpic = null;
  const epicBlock = (e, items, r) => {
    const k = `ie${r ? r.id : 'u'}-${e.id}`, [t, d, pct] = progress(items);
    return `<div class="row erow" draggable="true" data-epic="${e.id}"><span class="tg"><button class="chev ${isOpen(k) ? 'open' : ''}" data-tog="${k}">${CHEV}</button></span>
      ${typeIcon('epic')}<span class="key">${e.key}</span><span class="t">${esc(e.name)}</span><span class="mute">${plural(items.length, 'issue')}</span>
      <span class="mini"><i style="width:${pct}%"></i></span><span class="mute" style="width:70px;text-align:right">${d}/${t} pts</span>
      <span class="ptl s-${e.status}" style="font-size:11px;text-transform:uppercase;width:92px">${STATUSES.find(s => s[0] === e.status)[1]}</span></div>
      ${isOpen(k) ? `<div class="nest">${tree(items.filter(matches))}</div>` : ''}`;
  };
  const section = r => {
    const items = db.issues.filter(i => r ? relOf(i) == r.id : !relOf(i));
    const epics = db.epics.filter(e => (r ? e.releaseId == r.id : !e.releaseId) || items.some(i => i.epicId == e.id));
    const loose = items.filter(i => !epics.some(e => e.id == i.epicId));
    const [t, d, pct] = progress(items), k = 'r' + (r ? r.id : 'u'), open = isOpen(k), [sc, sl] = r ? relStatus(r) : [];
    return `<div class="sec ${open ? '' : 'closed'}" data-rzone="${r ? r.id : ''}">
      <div class="sh"><button class="chev ${open ? 'open' : ''}" data-tog="${k}">${CHEV}</button>
        ${r ? `${svg(TAG_PATH, '#22a06b', 1.6)}<b>${esc(r.name)}</b><span class="ptl s-${sc}" style="font-size:11px;text-transform:uppercase">${sl}</span>
          <span class="mute">${fmt(r.start)} → ${fmt(r.release)}${r.releasedOn ? ' · released ' + fmt(r.releasedOn) : ''}</span>` : '<b>Unscheduled</b><span class="mute">not in any release</span>'}
        <span class="flex"></span><span class="mini"><i style="width:${pct}%"></i></span><span class="mute">${pct}% · ${d}/${t} pts · ${plural(epics.length, 'epic')} · ${plural(items.length, 'issue')}</span>
        ${r ? `${r.status !== 'released' ? `<button class="btn s" data-rel="${r.id}">Release</button>` : ''}<button class="btn s g" data-edit-rel="${r.id}" title="Edit release">•••</button>` : ''}</div>
      ${r?.desc ? `<div class="goal">${esc(r.desc)}</div>` : ''}
      <div class="list">${epics.map(e => epicBlock(e, items.filter(i => i.epicId == e.id), r)).join('')}
        ${loose.length ? `<div class="row erow"><span class="tg"></span><span class="t mute">Issues without an epic</span></div><div class="nest">${tree(loose.filter(matches))}</div>` : ''}
        ${!epics.length && !loose.length ? '<div class="empty">Drag epics or issues here</div>' : ''}</div></div>`;
  };
  app.innerHTML = `<h1>Releases</h1><div class="bar" style="margin-top:16px"><span class="mute">Plan by quarter or year · Issues inherit their epic's release unless set on the issue · Drag epics between releases</span>
    <span class="flex"></span><button class="btn p" id="newRel">Create release</button></div>
    ${rels.map(section).join('')}${section(null)}`;
  bindRows(app);
  app.querySelectorAll('[data-epic]').forEach(el => {
    el.onclick = () => openEpic(epic(el.dataset.epic));
    el.ondragstart = e => { dragEpic = +el.dataset.epic; drag = null; e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); };
    el.ondragend = () => el.classList.remove('dragging');
  });
  app.querySelectorAll('[data-rzone]').forEach(z => {
    const rid = z.dataset.rzone ? +z.dataset.rzone : null;
    z.ondragover = e => { e.preventDefault(); z.classList.add('over'); };
    z.ondragleave = e => { if (!z.contains(e.relatedTarget)) z.classList.remove('over'); };
    z.ondrop = e => {
      e.preventDefault(); z.classList.remove('over');
      if (dragEpic) epic(dragEpic).releaseId = rid;
      else if (drag) issue(drag).releaseId = rid && rid != epic(issue(drag).epicId)?.releaseId ? rid : null;
      dragEpic = drag = null; save();
    };
  });
  app.querySelectorAll('[data-rel]').forEach(b => b.onclick = () => {
    const r = release(b.dataset.rel), open = db.issues.filter(i => relOf(i) == r.id && i.status !== 'done').length;
    if (!confirm(`Mark ${r.name} as released?` + (open ? `\n${plural(open, 'issue')} in it ${open === 1 ? 'is' : 'are'} not done yet.` : ''))) return;
    r.status = 'released'; r.releasedOn = today(); save();
  });
  app.querySelectorAll('[data-edit-rel]').forEach(b => b.onclick = () => openRelease(release(b.dataset.editRel)));
  $('#newRel').onclick = () => openRelease();
}

function renderRoadmap(app) {
  const dates = [...db.epics.flatMap(e => [e.start, e.due]), ...db.releases.flatMap(r => [r.start, r.release]),...db.sprints.flatMap(s => [s.start, s.end]), today()].filter(Boolean).sort();
  const start = new Date(dates[0] + 'T00:00'); start.setDate(1);
  const end = new Date(dates[dates.length - 1] + 'T00:00'); end.setMonth(end.getMonth() + 1, 1);
  const PX = 4, days = (end - start) / 864e5, x = d => Math.round((new Date(d + 'T00:00') - start) / 864e5 * PX);
  const months = [];
  for (let m = new Date(start); m < end; m.setMonth(m.getMonth() + 1)) months.push(new Date(m));
  const LABEL = 240;
  const bar = (label, s, e, color, attr) => `<div class="r"><div style="position:absolute;left:16px;top:8px;width:${LABEL - 28}px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px">${label}</div>
    <div class="b" ${attr} style="left:${LABEL + x(s)}px;width:${Math.max(8, x(e) - x(s))}px;background:${color}">${label}</div></div>`;
  app.innerHTML = `<h1>Roadmap</h1><p class="mute" style="margin:8px 0 16px">Red line = today · Click a bar to edit its dates</p><div class="rm"><div style="position:relative;width:${LABEL + days * PX + 20}px">
    <div class="r" style="height:22px">${months.map(m => `<div class="mo" style="left:${LABEL + x(m.toLocaleDateString('en-CA'))}px">${m.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}</div>`).join('')}</div>
    ${db.releases.map(r => bar('◆ Release ' + esc(r.name), r.start, r.release, r.status === 'released' ? '#8590a2' : '#22a06b', `data-rl="${r.id}"`)).join('')}
    ${db.sprints.map(s => bar(esc(s.name), s.start, s.end, s.state === 'completed' ? '#8590a2' : s.state === 'active' ? '#0c66e4' : '#579dff', `data-sp="${s.id}"`)).join('')}
    ${db.epics.filter(e => e.start && e.due).map(e => {
      const items = db.issues.filter(i => i.epicId == e.id), t = pts(items), d = pts(items.filter(i => i.status === 'done'));
      return bar(`${esc(e.name)} (${t ? Math.round(d / t * 100) : 0}%)`, e.start, e.due, e.color, `data-ep="${e.id}"`);
    }).join('')}
    <div class="tl" style="left:${LABEL + x(today())}px" title="Today"></div></div></div>`;
  app.querySelectorAll('[data-ep]').forEach(b => b.onclick = () => openEpic(epic(b.dataset.ep)));
  app.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => openSprint(sprint(b.dataset.sp)));
  app.querySelectorAll('[data-rl]').forEach(b => b.onclick = () => openRelease(release(b.dataset.rl)));
}

function renderReports(app) {
  const s = db.sprints.find(x => x.state === 'active');
  let burn = '<div class="empty">No active sprint.</div>';
  if (s) {
    const items = db.issues.filter(i => i.sprintId == s.id), total = pts(items);
    const d0 = new Date(s.start + 'T00:00'), n = Math.max(1, Math.round((new Date(s.end + 'T00:00') - d0) / 864e5));
    const W = 700, H = 240, P = 36, X = k => P + k / n * (W - 2 * P), Y = v => H - P - (total ? v / total : 0) * (H - 2 * P);
    const actual = [];
    for (let k = 0; k <= n; k++) {
      const day = new Date(d0); day.setDate(day.getDate() + k); const ds = day.toLocaleDateString('en-CA');
      if (ds > today()) break;
      actual.push([k, total - pts(items.filter(i => i.doneAt && i.doneAt <= ds))]);
    }
    burn = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px">
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" class="ax"/><line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" class="ax"/>
      <text x="${P - 6}" y="${Y(total) + 4}" text-anchor="end" font-size="11">${total}</text>
      <text x="${P - 6}" y="${H - P + 4}" text-anchor="end" font-size="11">0</text>
      <text x="${P}" y="${H - P + 16}" font-size="11">${fmt(s.start)}</text>
      <text x="${W - P}" y="${H - P + 16}" text-anchor="end" font-size="11">${fmt(s.end)}</text>
      <line x1="${X(0)}" y1="${Y(total)}" x2="${X(n)}" y2="${Y(0)}" class="ideal" stroke-dasharray="5 4"/>
      <polyline fill="none" stroke="#e2483d" stroke-width="2.5" points="${actual.map(([k, v]) => X(k) + ',' + Y(v)).join(' ')}"/>
      ${actual.map(([k, v]) => `<circle cx="${X(k)}" cy="${Y(v)}" r="3" fill="#e2483d"><title>${v} pts left</title></circle>`).join('')}</svg>
      <div class="mute">Dashed = ideal · Red = remaining story points</div>`;
  }
  const done = db.sprints.filter(x => x.state === 'completed');
  const max = Math.max(1, ...done.map(x => x.committed));
  const avg = done.length ? Math.round(done.reduce((a, x) => a + x.completed, 0) / done.length) : 0;
  const velocity = done.length ? `<div style="display:flex;gap:18px;align-items:flex-end;height:200px;padding-top:10px">${done.map(x => `
      <div style="text-align:center;font-size:12px"><div style="display:flex;gap:3px;align-items:flex-end;height:170px">
        <div title="Committed ${x.committed}" class="vc" style="width:22px;height:${x.committed / max * 160}px"></div>
        <div title="Completed ${x.completed}" style="width:22px;height:${x.completed / max * 160}px;background:#22a06b"></div></div>${esc(x.name)}</div>`).join('')}</div>
      <div class="mute">Grey = committed · Green = completed · Average velocity: <b>${avg} pts/sprint</b></div>`
    : '<div class="empty">Complete a sprint to see velocity.</div>';
  const byStatus = STATUSES.map(([st, l]) => `<span class="ptl s-${st}">${l}: ${db.issues.filter(i => i.status === st).length}</span>`).join(' ');
  const overdue = db.issues.filter(i => i.due && i.due < today() && i.status !== 'done');
  app.innerHTML = `<h1 style="margin-bottom:16px">Reports</h1>
    <div class="card-box"><h3>Burndown ${s ? '· ' + esc(s.name) : ''}</h3>${burn}</div>
    <div class="card-box"><h3>Velocity</h3>${velocity}</div>
    <div class="card-box"><h3>Overall</h3><p>${byStatus} <span class="pill">${pts(db.issues.filter(i => i.status === 'done'))} / ${pts(db.issues)} pts done</span></p>
      <h3 style="margin:14px 0 8px">Overdue (${overdue.length})</h3><div class="list">${tree(overdue)}</div></div>`;
  bindRows(app);
}

// ---------- modals ----------
function modal(html, onSave, onDelete, cls = '') {
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="mb ${cls}"><button class="btn g s x" data-x title="Close (Esc)">✕</button>${html}
    <div class="foot">${onDelete ? '<button class="btn g d" data-del>Delete</button>' : ''}<span class="flex"></span>
    <button class="btn g" data-x>Cancel</button><button class="btn p" data-ok>Save</button></div></div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.onmousedown = e => { if (e.target === m) close(); };
  m.querySelectorAll('[data-x]').forEach(b => b.onclick = close);
  m.querySelector('[data-ok]').onclick = () => { if (onSave(m) !== false) { close(); save(); } };
  if (onDelete) m.querySelector('[data-del]').onclick = () => { if (confirm('Delete permanently?')) { onDelete(); close(); save(); } };
  m.querySelectorAll('select.loz').forEach(s => s.onchange = () => s.className = s.className.replace(/s-\w+/, 's-' + s.value));
  m.querySelectorAll('textarea.ttl').forEach(t => {
    const fit = () => { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
    t.oninput = fit; t.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); m.querySelector('[data-ok]').click(); } }; setTimeout(fit);
  });
  m.querySelector('input,textarea')?.focus();
  return m;
}
const val = (m, n) => m.querySelector(`[name=${n}]`).value;
const dr = (label, field) => `<div class="dr"><span>${label}</span>${field}</div>`;

const TYPES = [['story', 'Story'], ['task', 'Task'], ['issue', 'Issue']];
// fields whose changes are written to the issue history, with how to display their values
const TRACKED = [['title', 'Summary'], ['type', 'Type', v => TYPES.find(t => t[0] === v)?.[1]], ['epicId', 'Epic', v => epic(v)?.name], ['sprintId', 'Sprint', v => sprint(v)?.name || 'Backlog'],
  ['releaseId', 'Release', v => release(v)?.name], ['points', 'Story points'], ['priority', 'Priority'], ['parentId', 'Parent', v => issue(v)?.key],
  ['due', 'Due date', v => v && fmt(v)], ['assignee', 'Assignee']];

const commentHtml = i => i.comments.length ? i.comments.map(c => `<div class="cm"><div class="cmh"><b>Comment</b><span class="mute">${ago(c.at)}</span><span class="flex"></span>
  <button class="btn g s" data-cdel="${esc(c.id)}">Delete</button></div><div class="cmt">${esc(c.text)}</div></div>`).join('') : '<div class="empty">No comments yet</div>';
const historyHtml = i => i.history.length ? i.history.map(h => `<div class="hi"><span class="mute">${ago(h.at)}</span>
  ${h.field === 'Created' ? '<span>Created this issue</span>' : `<span><b>${esc(h.field)}</b>: ${esc(h.from || 'None')} → ${esc(h.to || 'None')}</span>`}</div>`).join('') : '<div class="empty">No changes recorded</div>';

function openIssue(i) {
  const isNew = !i, x = i || { type: 'story', status: 'todo', priority: 'Medium', points: 0, labels: [], epicId: epicFilter || '', sprintId: '', title: '', desc: '', assignee: '' };
  const parents = db.issues.filter(p => !p.parentId && p.id !== x.id);
  const kids = i ? db.issues.filter(c => c.parentId == i.id).sort(byRank) : [];
  const kidsDone = kids.filter(k => k.status === 'done').length;
  const people = [...new Set(db.issues.map(z => z.assignee).filter(Boolean))].sort();
  const m = modal(`<div class="mh">${x.epicId ? chip(x.epicId) + ' /' : ''}${typeIcon(x.parentId ? 'subtask' : x.type)}<span>${isNew ? 'New issue' : x.key}</span>
      ${i ? '<button class="btn g s" data-clone title="Create a copy of this issue">Clone</button>' : ''}</div>
    <div class="mgrid"><div>
      <textarea name="title" class="ttl" rows="1" placeholder="What needs to be done?">${esc(x.title)}</textarea>
      <label>Description</label><textarea name="desc" rows="7" placeholder="Add a description, notes, links…">${esc(x.desc)}</textarea>
      ${i ? `<div class="subhead"><h3>Sub-tasks</h3><div class="prog"><i style="width:${kids.length ? kidsDone / kids.length * 100 : 0}%"></i></div><span class="mute">${kidsDone}/${kids.length} done</span></div>
        <div class="list" id="kids">${kids.length ? kids.map(c => row(c)).join('') : '<div class="empty">No sub-tasks</div>'}</div>
        <div class="add"><input id="kidAdd" placeholder="+ Add sub-task"></div>
        <div class="subhead"><h3>Activity</h3></div>
        <div class="seg"><button class="on" data-tab="c">Comments <span id="cCount">${i.comments.length}</span></button><button data-tab="h">History</button></div>
        <div id="tab-c"><div class="cadd"><textarea id="cText" rows="2" placeholder="Add a comment… (Ctrl+Enter to post)"></textarea><button class="btn p s" id="cAdd">Comment</button></div>
          <div id="clist">${commentHtml(i)}</div></div>
        <div id="tab-h" hidden>${historyHtml(i)}</div>` : ''}
    </div><div>
      ${loz(x.status, 'name="status"', 'big')}
      <div class="details"><div class="dh">Details</div>
        ${dr('Type', `<select name="type">${opts(TYPES, x.type)}</select>`)}
        ${dr('Assignee', `<input name="assignee" list="people" placeholder="Unassigned" maxlength="60" value="${esc(x.assignee)}"><datalist id="people">${people.map(p => `<option value="${esc(p)}">`).join('')}</datalist>`)}
        ${dr('Epic', `<select name="epicId"><option value="">None</option>${opts(db.epics.map(e => [e.id, e.name]), x.epicId)}</select>`)}
        ${dr('Release', `<select name="releaseId"><option value="">${epic(x.epicId)?.releaseId ? 'From epic (' + esc(release(epic(x.epicId).releaseId)?.name) + ')' : 'None'}</option>${opts(db.releases.map(r => [r.id, r.name]), x.releaseId)}</select>`)}
        ${dr('Sprint', `<select name="sprintId"><option value="">Backlog</option>${opts(db.sprints.filter(s => s.state !== 'completed' || s.id == x.sprintId).map(s => [s.id, s.name]), x.sprintId)}</select>`)}
        ${dr('Story points', `<select name="points">${opts(POINTS.map(p => [p, p || 'None']), x.points)}</select>`)}
        ${dr('Priority', `<select name="priority">${opts(PRIORITIES.map(p => [p, p]), x.priority)}</select>`)}
        ${dr('Parent', `<select name="parentId" ${kids.length ? 'disabled title="An issue with sub-tasks cannot itself be a sub-task"' : ''}><option value="">None</option>${opts(parents.map(p => [p.id, p.key + ' ' + p.title]), x.parentId)}</select>`)}
        ${dr('Due date', `<input type="date" name="due" value="${x.due || ''}">`)}
        ${dr('Labels', `<input name="labels" placeholder="comma, separated" value="${esc(x.labels.join(', '))}">`)}
      </div>
      ${i ? `<p class="mute" style="margin:12px 2px">Created ${ago(x.created)}<br>Updated ${ago(x.updated)}${x.doneAt ? '<br>Done ' + fmt(x.doneAt) : ''}</p>` : ''}
    </div></div>`,
    m => {
      const t = val(m, 'title').trim(); if (!t) return alert('Summary is required'), false;
      const it = i || newIssue({});
      const before = Object.fromEntries(TRACKED.map(([k]) => [k, it[k]]));
      const parentId = val(m, 'parentId') ? +val(m, 'parentId') : null, par = issue(parentId);
      Object.assign(it, { title: t, type: val(m, 'type'), epicId: +val(m, 'epicId') || (par?.epicId ?? null), sprintId: +val(m, 'sprintId') || null,
        releaseId: +val(m, 'releaseId') || null, points: +val(m, 'points'), priority: val(m, 'priority'), parentId, due: val(m, 'due'), desc: val(m, 'desc'),
        assignee: val(m, 'assignee').trim().slice(0, 60), labels: val(m, 'labels').split(',').map(s => s.trim()).filter(Boolean), updated: new Date().toISOString() });
      if (i) TRACKED.forEach(([k, label, show = v => v]) => { if (String(before[k] ?? '') !== String(it[k] ?? '')) logChange(it, label, show(before[k]) ?? '', show(it[k]) ?? ''); });
      if (it.status !== val(m, 'status')) setStatus(it, val(m, 'status'));
    },
    i && (() => { db.issues = db.issues.filter(z => z.id !== i.id && z.parentId !== i.id); }), 'wide');
  const relHint = () => { const r = release(epic(val(m, 'epicId'))?.releaseId); m.querySelector('[name=releaseId] option[value=""]').textContent = r ? `From epic (${r.name})` : 'None'; };
  m.querySelector('[name=epicId]').addEventListener('change', relHint);
  if (!i) return;
  bindRows(m.querySelector('#kids'), k => { m.remove(); openIssue(k); });
  m.querySelectorAll('#kids [data-st]').forEach(el => el.onchange = () => { setStatus(issue(el.dataset.st), el.value); m.remove(); save(); openIssue(i); });
  m.querySelector('#kidAdd').onkeydown = e => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    newIssue({ title: e.target.value.trim(), type: 'task', parentId: i.id, epicId: i.epicId, sprintId: i.sprintId, points: 1, priority: i.priority });
    m.remove(); save(); openIssue(i); $('#kidAdd')?.focus();
  };
  m.querySelector('[data-clone]').onclick = () => {
    const { id, key, created, updated, doneAt, comments, history, rank, ...fields } = i;
    const c = newIssue({ ...fields, labels: [...i.labels], title: 'Copy of ' + i.title, status: 'todo', rank: i.rank + 0.5 });
    renumber(); m.remove(); save(); toast(`Cloned as ${c.key}`); openIssue(c);
  };
  // comments are saved straight away (like a chat), independent of the form's Save
  m.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    m.querySelectorAll('[data-tab]').forEach(o => o.classList.toggle('on', o === b));
    m.querySelector('#tab-c').hidden = b.dataset.tab !== 'c';
    m.querySelector('#tab-h').hidden = b.dataset.tab !== 'h';
    if (b.dataset.tab === 'h') m.querySelector('#tab-h').innerHTML = historyHtml(i);
  });
  const drawComments = () => {
    m.querySelector('#clist').innerHTML = commentHtml(i); m.querySelector('#cCount').textContent = i.comments.length;
    m.querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => {
      if (!confirm('Delete this comment?')) return;
      i.comments = i.comments.filter(c => c.id !== b.dataset.cdel); save(); drawComments();
    });
  };
  const post = () => {
    const ta = m.querySelector('#cText'), text = ta.value.trim(); if (!text) return;
    i.comments.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text.slice(0, 10000), at: new Date().toISOString() });
    ta.value = ''; save(); drawComments();
  };
  m.querySelector('#cAdd').onclick = post;
  m.querySelector('#cText').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } };
  drawComments();
}

function openEpic(e) {
  const x = e || { name: '', color: '#6554C0', desc: '', status: 'todo', start: today(), due: '', priority: 'Medium' };
  modal(`<div class="mh">${typeIcon('epic')}<span>${e ? x.key : 'New epic'}</span></div>
    <textarea name="name" class="ttl" rows="1" placeholder="Epic name">${esc(x.name)}</textarea>
    <div class="two"><div><label>Start date</label><input type="date" name="start" value="${x.start}"></div>
      <div><label>Target date</label><input type="date" name="due" value="${x.due}"></div>
      <div><label>Status</label><select name="status">${opts(STATUSES, x.status)}</select></div>
      <div><label>Priority</label><select name="priority">${opts(PRIORITIES.map(p => [p, p]), x.priority)}</select></div>
      <div><label>Release</label><select name="releaseId"><option value="">Unscheduled</option>${opts(db.releases.map(r => [r.id, r.name]), x.releaseId)}</select></div>
      <div><label>Color</label><input type="color" name="color" value="${x.color}" style="height:36px;padding:2px"></div></div>
    <label>Description / goal</label><textarea name="desc" rows="5" placeholder="Why does this matter? What does done look like?">${esc(x.desc)}</textarea>`,
    m => {
      const n = val(m, 'name').trim(); if (!n) return alert('Name is required'), false;
      if (val(m, 'start') && val(m, 'due') && val(m, 'due') < val(m, 'start')) return alert('Target date must be after the start date'), false;
      let it = e;
      if (!it) { const id = Math.max(0, ...db.epics.map(z => z.id)) + 1; it = { id, key: 'E' + id }; db.epics.push(it); }
      Object.assign(it, { name: n, start: val(m, 'start'), due: val(m, 'due'), status: val(m, 'status'), priority: val(m, 'priority'), color: val(m, 'color'), desc: val(m, 'desc'), releaseId: +val(m, 'releaseId') || null });
    },
    e && (() => { db.epics = db.epics.filter(z => z.id !== e.id); db.issues.forEach(i => { if (i.epicId == e.id) i.epicId = null; }); }));
}

function openSprint(s) {
  const last = [...db.sprints].sort((a, b) => b.end.localeCompare(a.end))[0];
  const st = last ? new Date(last.end + 'T00:00') : new Date(); if (last) st.setDate(st.getDate() + 1);
  const en = new Date(st); en.setDate(en.getDate() + 13);
  const x = s || { name: 'Sprint ' + (db.sprints.length + 1), goal: '', start: st.toLocaleDateString('en-CA'), end: en.toLocaleDateString('en-CA') };
  modal(`<div class="mh"><span>${s ? 'Edit sprint' : 'Create sprint'}</span></div>
    <textarea name="name" class="ttl" rows="1">${esc(x.name)}</textarea>
    <div class="two"><div><label>Start date</label><input type="date" name="start" value="${x.start}"></div><div><label>End date</label><input type="date" name="end" value="${x.end}"></div></div>
    <label>Sprint goal</label><textarea name="goal" rows="3" placeholder="What do you want to achieve this sprint?">${esc(x.goal)}</textarea>
    ${s?.state === 'completed' ? `<p class="mute">Completed ${fmt(s.completedOn)} · ${s.completed}/${s.committed} pts</p>` : ''}`,
    m => {
      if (!val(m, 'start') || !val(m, 'end') || val(m, 'end') < val(m, 'start')) return alert('Check the dates'), false;
      const it = s || (db.sprints.push({ id: Math.max(0, ...db.sprints.map(z => z.id)) + 1, state: 'planned' }), db.sprints[db.sprints.length - 1]);
      Object.assign(it, { name: val(m, 'name').trim() || x.name, start: val(m, 'start'), end: val(m, 'end'), goal: val(m, 'goal') });
    },
    s && s.state !== 'active' && (() => { db.sprints = db.sprints.filter(z => z.id !== s.id); db.issues.forEach(i => { if (i.sprintId == s.id) i.sprintId = null; }); }));
}

function openRelease(r) {
  const last = [...db.releases].sort((a, b) => b.release.localeCompare(a.release))[0];
  const next = last ? new Date(last.release + 'T00:00') : new Date(); if (last) next.setDate(next.getDate() + 1);
  const x = r || { ...quarterOf(next), desc: '', status: 'unreleased' };
  modal(`<div class="mh">${svg(TAG_PATH, '#22a06b', 1.6)}<span>${r ? 'Edit release' : 'Create release'}</span></div>
    <textarea name="name" class="ttl" rows="1" placeholder="e.g. 2027.1">${esc(x.name)}</textarea>
    <div class="two"><div><label>Start date</label><input type="date" name="start" value="${x.start}"></div>
      <div><label>Release date</label><input type="date" name="release" value="${x.release}"></div>
      <div><label>Status</label><select name="status">${opts([['unreleased', 'Unreleased'], ['released', 'Released']], x.status)}</select></div></div>
    <label>Description / goals</label><textarea name="desc" rows="4" placeholder="What should be achieved by this release?">${esc(x.desc)}</textarea>`,
    m => {
      if (!val(m, 'name').trim() || !val(m, 'start') || !val(m, 'release') || val(m, 'release') < val(m, 'start')) return alert('Check the name and dates'), false;
      const it = r || (db.releases.push({ id: Math.max(0, ...db.releases.map(z => z.id)) + 1 }), db.releases[db.releases.length - 1]);
      Object.assign(it, { name: val(m, 'name').trim(), start: val(m, 'start'), release: val(m, 'release'), status: val(m, 'status'), desc: val(m, 'desc') });
      if (it.status === 'released') it.releasedOn ||= today(); else delete it.releasedOn;
    },
    r && (() => {
      db.releases = db.releases.filter(z => z.id !== r.id);
      [...db.epics, ...db.issues].forEach(z => { if (z.releaseId == r.id) z.releaseId = null; });
    }));
}

// ---------- data: backup, import, first run ----------
function exportPlan() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
  a.download = `lifesprint-backup-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  ui.backupRev = db.rev; ui.lastBackup = today(); persistUi(); render();
}

function pickFile(onPlan) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 50e6) return alert('That file is too large to be a LifeSprint backup.');
    let plan;
    try { plan = normalizePlan(JSON.parse(await f.text())); }
    catch (e) { return alert('Could not import: ' + (e instanceof SyntaxError ? 'the file is not valid JSON.' : e.message)); }
    onPlan(plan);
  };
  inp.click();
}

// replaces the plan wholesale (import / start over); keeps rev increasing so other tabs pick it up
function replacePlan(plan, msg) {
  plan.rev = Math.max(plan.rev, db?.rev || 0);
  db = plan; boardSprint = null; epicFilter = relFilter = '';
  document.querySelectorAll('.modal').forEach(m => m.remove());
  save(); if (msg) toast(msg);
}

function openData() {
  const m = document.createElement('div'); m.className = 'modal';
  const last = ui.lastBackup ? `Last backup: ${fmt(ui.lastBackup)}${db.rev > (ui.backupRev || 0) ? ' (changes since then)' : ' (up to date)'}` : 'You have not exported a backup yet.';
  m.innerHTML = `<div class="mb"><button class="btn g s x" data-x title="Close (Esc)">✕</button><h1 style="font-size:20px">Data &amp; backup</h1>
    <p class="mute" style="font-size:13px;margin:10px 0 0">Your plan is saved only in this browser on this device (${db.issues.length} issues, ${db.epics.length} epics). Nothing is sent anywhere.
      Clearing this site's browser data deletes it, so export a backup now and then. A backup file can be imported in any browser.</p>
    <p style="font-size:13px">${last}</p>
    <div class="dgrid">
      <button class="btn p" data-a="export">Export backup (.json)</button>
      <button class="btn" data-a="import">Import backup…</button>
      <button class="btn" data-a="example">Start over with example plan</button>
      <button class="btn d" data-a="empty">Start over with empty plan</button>
    </div></div>`;
  document.body.appendChild(m);
  m.onmousedown = e => { if (e.target === m) m.remove(); };
  m.querySelector('[data-x]').onclick = () => m.remove();
  const sure = () => confirm(`This replaces your current plan (${db.issues.length} issues). Export a backup first if you might need it. Continue?`);
  m.querySelectorAll('[data-a]').forEach(b => b.onclick = () => ({
    export: () => { exportPlan(); m.remove(); toast('Backup downloaded'); },
    import: () => pickFile(plan => { if (confirm(`Replace your current plan (${db.issues.length} issues) with this backup (${plan.issues.length} issues)?`)) replacePlan(plan, 'Backup imported'); }),
    example: () => sure() && replacePlan(seedPlan(true), 'Started a new example plan'),
    empty: () => sure() && replacePlan(seedPlan(false), 'Started an empty plan'),
  })[b.dataset.a]());
}

function welcome(problem) {
  const m = document.createElement('div'); m.className = 'modal locked';
  m.innerHTML = `<div class="mb" style="width:520px;text-align:center"><div class="pav" style="width:48px;height:48px;margin:0 auto 14px;font-size:18px">LS</div>
    <h1>Welcome to LifeSprint</h1><p class="mute" style="font-size:14px;margin:10px 0 22px">Plan goals as epics, stories and sprints. Everything is saved in this browser only — no account needed.</p>
    ${problem ? `<p class="warn">${esc(problem)}</p>` : ''}
    <div class="dgrid" style="grid-template-columns:1fr">
      <button class="btn p" data-a="example">Start with an example plan</button>
      <button class="btn" data-a="empty">Start with an empty plan</button>
      <button class="btn" data-a="import">Import a backup file…</button></div></div>`;
  document.body.appendChild(m);
  m.querySelector('[data-a=example]').onclick = () => replacePlan(seedPlan(true));
  m.querySelector('[data-a=empty]').onclick = () => replacePlan(seedPlan(false));
  m.querySelector('[data-a=import]').onclick = () => pickFile(plan => replacePlan(plan, 'Backup imported'));
}

// ---------- shell ----------
window.onhashchange = () => { view = location.hash.slice(1) || 'dashboard'; render(); };
function render() {
  if (!db) return;
  $('#nav').innerHTML = VIEWS.map(([v, l, icon]) => `<a class="${v === view ? 'on' : ''}" href="#${v}" title="${l}">${svg(icon, 'currentColor', 1.6)}<span class="lbl">${l}</span></a>`).join('');
  // nudge to back up after a good amount of unsaved work
  const unsaved = db.rev - (ui.backupRev || 0), stale = !ui.lastBackup || (Date.now() - new Date(ui.lastBackup)) > 7 * 864e5;
  $('#backup').hidden = !(unsaved >= 25 && stale);
  const app = $('#app');
  ({ dashboard: renderDashboard, board: renderBoard, backlog: renderBacklog, epics: renderEpics, releases: renderReleases, roadmap: renderRoadmap, reports: renderReports }[view] || renderDashboard)(app);
}
$('#q').oninput = render;
$('#create').onclick = () => openIssue();
$('#shell').classList.toggle('min', ui.min);
$('#collapse').onclick = () => { ui.min = !ui.min; $('#shell').classList.toggle('min', ui.min); persistUi(); };
$('#theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') [...document.querySelectorAll('.modal:not(.locked)')].pop()?.remove();
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || e.ctrlKey || e.metaKey || e.altKey;
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
  if (e.key.toLowerCase() === 'c' && !typing && db && !document.querySelector('.modal')) { e.preventDefault(); openIssue(); }
});
$('#data').onclick = () => db && openData();
$('#backup').onclick = () => { exportPlan(); toast('Backup downloaded'); };

// installable app: shown in any browser tab (hidden once running as the installed app).
// Chrome / Edge may hand us a prompt to trigger; otherwise explain the browser's own install menu.
let installEvt;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
$('#install').hidden = standalone;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { $('#install').hidden = true; toast('LifeSprint installed'); });
$('#install').onclick = async () => {
  if (installEvt) { installEvt.prompt(); const { outcome } = await installEvt.userChoice; installEvt = null; if (outcome === 'accepted') $('#install').hidden = true; return; }
  const ua = navigator.userAgent, how = /Edg\//.test(ua)
    ? ['Click the <b>…</b> menu at the top right of Edge.', 'Choose <b>Apps → Install this site as an app</b>.', 'If it says <b>Open in app</b> instead, LifeSprint is already installed. Look for it in the Start menu.']
    : /iPhone|iPad/.test(ua) ? ['Tap the <b>Share</b> button in Safari.', 'Choose <b>Add to Home Screen</b>.']
    : /Firefox\//.test(ua) ? ['Firefox on computers can\'t install web apps. Open this page in Chrome or Edge to install it, or keep using it in this tab (it still works offline).']
    : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? ['In the menu bar choose <b>File → Add to Dock</b> (macOS Sonoma or later).']
    : ['Click the install icon at the right end of the address bar, or open the <b>⋮</b> menu and choose <b>Cast, save and share → Install page as app</b>.', 'If you see <b>Open in LifeSprint</b> instead, it is already installed.'];
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="mb" style="width:480px"><button class="btn g s x" data-x title="Close (Esc)">✕</button><h1 style="font-size:20px">Install LifeSprint</h1>
    <p class="mute" style="font-size:13px;margin:8px 0 12px">Installing opens LifeSprint in its own window and works without internet. Your plan stays the same.</p>
    <ol style="padding-left:20px;line-height:1.7">${how.map(s => `<li>${s}</li>`).join('')}</ol>
    <div class="foot"><span class="flex"></span><button class="btn p" data-x>Got it</button></div></div>`;
  document.body.appendChild(m);
  m.onmousedown = e => { if (e.target === m) m.remove(); };
  m.querySelectorAll('[data-x]').forEach(b => { b.onclick = () => m.remove(); });
};
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

// another tab saved: take its version (open dialogs would hold stale objects, so close them)
Store.onExternalChange(async ({ rev }) => {
  if (!db || rev <= db.rev) return;
  db = normalizePlan(await Store.load());
  document.querySelectorAll('.modal:not(.locked)').forEach(m => m.remove());
  document.querySelector('.modal.locked')?.remove();
  render(); toast('Updated from another window');
});

(async () => {
  let stored;
  try { stored = await Store.load(); }
  catch (e) { $('#app').innerHTML = `<div class="empty">This browser blocked storage, so LifeSprint can't save your plan (${esc(e?.message || e)}). Private/incognito windows can cause this.</div>`; return; }
  navigator.storage?.persist?.().catch(() => {});
  if (!stored) return welcome();
  try { db = normalizePlan(stored); }
  catch (e) { return welcome(`Your saved plan could not be read (${e.message}). Import a backup or start again.`); }
  render();
})();
