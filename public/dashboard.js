// LifeSprint dashboard: KPIs and charts computed from the in-memory plan (globals from app.js / store.js).
let dash = { range: '90', epic: '', release: '' };
const RANGES = [['30', '30 days'], ['90', '90 days'], ['365', '12 months'], ['all', 'All time']];
try { const s = JSON.parse(localStorage.getItem('dash') || '{}'); if (RANGES.some(r => r[0] === s.range)) dash.range = s.range; } catch {}
const COL = { scope: 'var(--c-blue)', done: 'var(--c-aqua)', inprogress: 'var(--c-blue)', review: 'var(--c-violet)', todo: 'var(--c-neutral)' };
let tips = [], lines = {};

// ---------- buckets & numbers ----------
const createdDay = i => isoDay(new Date(i.created));   // local date, not UTC
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoDay(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 864e5);
function buckets(from, to) {
  const out = [];
  if (daysBetween(from, to) <= 120) {           // weekly, Monday-based
    const d = new Date(from + 'T00:00'); d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    for (let s = isoDay(d); s <= to; s = addDays(s, 7))
      out.push({ start: s, end: addDays(s, 6) < to ? addDays(s, 6) : to, label: fmt(s), long: 'Week of ' + fmt(s) });
  } else {                                       // monthly
    const d = new Date(from + 'T00:00');
    for (let m = new Date(d.getFullYear(), d.getMonth(), 1); isoDay(m) <= to; m.setMonth(m.getMonth() + 1)) {
      const s = isoDay(m), e = isoDay(new Date(m.getFullYear(), m.getMonth() + 1, 0));
      out.push({ start: s, end: e < to ? e : to, label: m.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), long: m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) });
    }
  }
  return out;
}
// axis max with 4 whole-number steps (counts and points are integers)
const niceMax = v => {
  const raw = Math.max(v, 1) / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(f => f * p).find(s => s >= raw && Number.isInteger(s)) || Math.ceil(raw);
  return step * 4;
};
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const tipAttr = (title, rows) => `data-tip="${tips.push({ title, rows }) - 1}" tabindex="0"`;

// ---------- SVG charts ----------
// charts are drawn at their card's real pixel width (W) so text stays 11-12px at any size
let W = 640;
const H = 230, PL = 36, PT = 14, PB = 28;
let PR = 84;
function axes(max, labels, xOf) {
  const n = labels.length, step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - PL - PR) / 80))));
  const show = i => i === n - 1 || (i % step === 0 && n - 1 - i >= Math.max(1, step * 0.6));
  return [0, 1, 2, 3, 4].map(k => {
    const y = PT + (H - PT - PB) * (1 - k / 4);
    return `<line x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}" class="${k ? 'grid' : 'base'}"/><text x="${PL - 8}" y="${y + 4}" text-anchor="end">${max * k / 4}</text>`;
  }).join('') + labels.map((l, i) => !show(i) ? '' : `<text x="${xOf(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`).join('');
}

function lineChart(id, labels, series, width) {
  W = width; PR = 96;
  const max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
  const n = labels.length, xOf = i => PL + (n <= 1 ? (W - PL - PR) / 2 : i * (W - PL - PR) / (n - 1)), yOf = v => PT + (H - PT - PB) * (1 - v / max);
  lines[id] = { labels, series, xOf, yOf, W };
  // direct end labels, nudged apart if they would collide
  const ends = series.map(s => ({ s, y: yOf(s.values[n - 1] || 0) })).sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => { if (i && e.y - ends[i - 1].y < 14) e.y = ends[i - 1].y + 14; });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(series.map(s => s.name).join(' and '))} over time">${axes(max, labels, xOf)}
    ${series.map(s => `<path class="ln" style="stroke:${s.color}" d="${s.values.map((v, i) => (i ? 'L' : 'M') + xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1)).join('')}"/>`).join('')}
    ${n === 1 ? series.map(s => `<circle r="4" cx="${xOf(0)}" cy="${yOf(s.values[0])}" style="fill:${s.color}"/>`).join('') : ''}
    ${ends.map(e => `<text x="${W - PR + 8}" y="${e.y + 4}" class="endl">${esc(e.s.name)} <tspan class="endv">${e.s.values[n - 1] || 0}</tspan></text>`).join('')}
    <g class="xh" visibility="hidden"><line y1="${PT}" y2="${H - PB}"/>${series.map(s => `<circle r="4.5" style="fill:${s.color}"/>`).join('')}</g>
    <rect class="hit" data-line="${id}" x="${PL - 10}" y="${PT}" width="${W - PL - PR + 20}" height="${H - PT - PB}"/></svg>`;
}

function barChart(labels, values, color, tip, width) {
  W = width; PR = 12;
  const max = niceMax(Math.max(0, ...values)), n = labels.length, band = (W - PL - PR) / n;
  const bw = Math.max(2, Math.min(band - 2, 30)), xOf = i => PL + band * i + band / 2, base = H - PB;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Bar chart">${axes(max, labels, xOf)}
    ${values.map((v, i) => {
      const h = (H - PT - PB) * v / max, x = xOf(i) - bw / 2, top = base - h, r = Math.min(4, bw / 2, h);
      const bar = h <= 0 ? '' : `<path class="bar" style="fill:${color}" d="M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z"/>`;
      return `<g class="mark" ${tipAttr(...tip(i))}><rect class="hitb" x="${PL + band * i}" y="${PT}" width="${band}" height="${H - PT - PB}"/>${bar}</g>`;
    }).join('')}</svg>`;
}

// horizontal stacked track: done / in progress (incl. review) / remaining
function progressRow(attrs, dot, name, items) {
  const t = pts(items), d = pts(items.filter(i => i.status === 'done')), p = pts(items.filter(i => i.status === 'inprogress' || i.status === 'review'));
  const seg = (v, c, label) => v ? `<i style="width:${v / t * 100}%;background:${c}" ${tipAttr(name, [{ value: `${v} pts`, label, color: c }])}></i>` : '';
  return `<div class="prow" ${attrs}><span class="pname">${dot}<span>${esc(name)}</span></span>
    <span class="track">${t ? seg(d, COL.done, 'Done') + seg(p, COL.inprogress, 'In progress') : ''}</span>
    <span class="pval"><b>${pct(d, t)}%</b> · ${d}/${t} pts</span></div>`;
}

const legend = items => `<div class="legend">${items.map(([c, l, kind]) => `<span><i class="${kind || ''}" style="background:${c}"></i>${l}</span>`).join('')}</div>`;
const tableView = (head, rows) => `<details class="tv"><summary>View as table</summary><table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>
  ${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></details>`;

// ---------- view ----------
function renderDashboard(app) {
  tips = []; lines = {};
  const cs = getComputedStyle(app), inner = app.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const full = Math.max(240, inner - 42), half = innerWidth <= 1000 ? full : Math.max(240, (inner - 16) / 2 - 42);   // 42 = card padding
  if (dash.epic && !epic(dash.epic)) dash.epic = '';
  if (dash.release && !release(dash.release)) dash.release = '';
  const T = today();
  const scope = db.issues.filter(i => (!dash.epic || i.epicId == dash.epic) && (!dash.release || relOf(i) == dash.release));
  const earliest = scope.map(i => createdDay(i)).sort()[0] || addDays(T, -30);
  const from = dash.range === 'all' ? (earliest < T ? earliest : addDays(T, -30)) : addDays(T, -+dash.range);
  const [tot, done] = progress(scope);
  const open = scope.filter(i => i.status !== 'done');
  const doneIn = scope.filter(i => i.doneAt && i.doneAt >= from);
  const overdue = open.filter(i => i.due && i.due < T);
  const act = db.sprints.find(s => s.state === 'active'), actItems = act ? scope.filter(i => i.sprintId == act.id) : [];
  const [at, ad] = progress(actItems);
  const recent = db.sprints.filter(s => s.state === 'completed').sort((a, b) => b.end.localeCompare(a.end)).slice(0, 3);
  const vel = recent.length ? Math.round(recent.reduce((a, s) => a + s.completed, 0) / recent.length) : null;
  const nextRel = db.releases.filter(r => r.status !== 'released').sort((a, b) => a.release.localeCompare(b.release))[0];
  const relItems = nextRel ? scope.filter(i => relOf(i) == nextRel.id) : [], [rt, rd] = progress(relItems);

  const B = buckets(from, T);
  const scopeLine = B.map(b => pts(scope.filter(i => createdDay(i) <= b.end)));
  const doneLine = B.map(b => pts(scope.filter(i => i.doneAt && i.doneAt <= b.end)));
  const thru = B.map(b => scope.filter(i => i.doneAt && i.doneAt >= b.start && i.doneAt <= b.end));
  const created = B.map(b => scope.filter(i => { const c = createdDay(i); return c >= b.start && c <= b.end; }).length);

  const byStatus = STATUSES.map(([s, l]) => [s, l, scope.filter(i => i.status === s)]);
  const due = open.filter(i => i.due && i.due <= addDays(T, 14)).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8);
  const kpi = (label, value, sub, cls = '') => `<div class="kpi ${cls}"><div class="kl">${label}</div><div class="kv">${value}</div><div class="ks">${sub}</div></div>`;
  const filtered = dash.epic || dash.release;

  app.innerHTML = `<h1>Dashboard</h1>
    <div class="bar" style="margin-top:16px">
      <div class="seg">${RANGES.map(([v, l]) => `<button class="${dash.range === v ? 'on' : ''}" data-range="${v}">${l}</button>`).join('')}</div>
      <select class="fsel" id="de"><option value="">Epic: All</option>${opts(db.epics.map(e => [e.id, e.name]), dash.epic)}</select>
      <select class="fsel" id="dr"><option value="">Release: All</option>${opts(db.releases.map(r => [r.id, r.name]), dash.release)}</select>
      ${filtered ? '<button class="btn g s" id="dclear">Clear filters</button>' : ''}
      <span class="flex"></span><span class="mute">${plural(scope.length, 'issue')} in view</span></div>

    <div class="kpis">
      ${kpi('Overall completion', `${pct(done, tot)}%`, `${done} of ${tot} points done`)}
      ${kpi(`Completed · ${RANGES.find(r => r[0] === dash.range)[1].toLowerCase()}`, doneIn.length, `${pts(doneIn)} points · ${scope.filter(i => createdDay(i) >= from).length} created`)}
      ${kpi('Active sprint', act ? `${pct(ad, at)}%` : '—', act ? `${esc(act.name)} · ${Math.max(0, daysBetween(T, act.end))} days left · ${ad}/${at} pts` : 'No sprint running')}
      ${kpi('Velocity', vel ?? '—', vel != null ? `avg points per sprint (last ${recent.length})` : 'Complete a sprint to measure')}
      ${kpi('Overdue', overdue.length ? `<span class="crit">⚠ ${overdue.length}</span>` : '0', overdue.length ? 'open issues past their due date' : 'Nothing overdue', overdue.length ? 'bad' : '')}
      ${kpi('Next release', nextRel ? esc(nextRel.name) : '—', nextRel ? `${pct(rd, rt)}% done · ${daysBetween(T, nextRel.release) >= 0 ? daysBetween(T, nextRel.release) + ' days left' : 'overdue'}` : 'No upcoming release')}
    </div>

    ${!scope.length ? '<div class="card-box empty">No issues match these filters yet. Create some from the Backlog.</div>' : `
    <div class="dgrid2">
      <div class="card-box wide"><div class="ch"><h3>Burn-up</h3><span class="mute">Total scope vs. completed story points</span></div>
        ${legend([[COL.scope, 'Scope', 'ln'], [COL.done, 'Completed', 'ln']])}
        ${lineChart('burn', B.map(b => b.label), [{ name: 'Scope', color: COL.scope, values: scopeLine }, { name: 'Completed', color: COL.done, values: doneLine }], full)}
        ${tableView(['Period', 'Scope (pts)', 'Completed (pts)', 'Remaining'], B.map((b, i) => [b.long, scopeLine[i], doneLine[i], scopeLine[i] - doneLine[i]]))}</div>

      <div class="card-box"><div class="ch"><h3>Throughput</h3><span class="mute">Issues completed per ${B.length && daysBetween(B[0].start, B[0].end) > 7 ? 'month' : 'week'}</span></div>
        ${barChart(B.map(b => b.label), thru.map(t => t.length), COL.done, i => [B[i].long, [{ value: plural(thru[i].length, 'issue'), label: 'Completed', color: COL.done }, { value: `${pts(thru[i])} pts`, label: 'Points' }, { value: created[i], label: 'Created' }]], half)}
        ${tableView(['Period', 'Completed', 'Points', 'Created'], B.map((b, i) => [b.long, thru[i].length, pts(thru[i]), created[i]]))}</div>

      <div class="card-box"><div class="ch"><h3>Status</h3><span class="mute">${scope.length === 1 ? '1 issue' : `All ${scope.length} issues`}</span></div>
        <div class="stack">${byStatus.map(([s, l, list]) => list.length ? `<i style="flex:${list.length};background:${COL[s]}" ${tipAttr(l, [{ value: plural(list.length, 'issue'), label: `${pct(list.length, scope.length)}%`, color: COL[s] }, { value: `${pts(list)} pts`, label: 'Points' }])}></i>` : '').join('')}</div>
        <div class="slist">${byStatus.map(([s, l, list]) => `<div><i style="background:${COL[s]}"></i><span>${l}</span><b>${list.length}</b><span class="mute">${pct(list.length, scope.length)}% · ${pts(list)} pts</span></div>`).join('')}</div>
        <h3 style="margin:20px 0 10px">Open work by priority</h3>
        ${PRIORITIES.map(p => { const c = open.filter(i => i.priority === p).length, mx = Math.max(1, ...PRIORITIES.map(q => open.filter(i => i.priority === q).length));
          return `<div class="hrow">${priIcon(p)}<span class="hl">${p}</span><span class="htrack"><i style="width:${c / mx * 100}%" ${tipAttr(p + ' priority', [{ value: `${plural(c, 'open issue')}`, label: '', color: COL.scope }])}></i></span><b>${c}</b></div>`; }).join('')}</div>

      <div class="card-box"><div class="ch"><h3>Progress by epic</h3><span class="mute">Story points</span></div>
        ${legend([[COL.done, 'Done'], [COL.inprogress, 'In progress'], ['var(--press)', 'Not started']])}
        ${db.epics.filter(e => !dash.epic || e.id == dash.epic).map(e => [e, scope.filter(i => i.epicId == e.id)]).filter(([, l]) => l.length)
          .map(([e, l]) => progressRow(`data-goepic="${e.id}"`, `<span class="dot" style="background:${esc(e.color)}"></span>`, e.name, l)).join('') || '<div class="empty">No epics in view</div>'}</div>

      <div class="card-box"><div class="ch"><h3>Progress by release</h3><span class="mute">Story points</span></div>
        ${db.releases.filter(r => !dash.release || r.id == dash.release).sort((a, b) => a.release.localeCompare(b.release)).map(r => [r, scope.filter(i => relOf(i) == r.id)]).filter(([, l]) => l.length)
          .map(([r, l]) => progressRow(`data-gorel="${r.id}"`, svg(TAG_PATH, 'var(--c-aqua)', 1.6), r.name + (r.status === 'released' ? ' (released)' : ''), l)).join('') || '<div class="empty">No releases in view</div>'}</div>

      <div class="card-box"><div class="ch"><h3>Due soon &amp; overdue</h3><span class="mute">Next 14 days</span></div>
        ${due.length ? `<div class="list">${due.map(i => `<div class="row" data-id="${i.id}">${typeIcon(i.parentId ? 'subtask' : i.type)}<span class="key">${i.key}</span>
          <span class="t">${esc(i.title)}</span><span class="${i.due < T ? 'crit' : 'mute'}" style="font-size:12px;white-space:nowrap">${i.due < T ? '⚠ Overdue · ' : ''}${fmt(i.due)}</span></div>`).join('')}</div>`
          : '<div class="empty">Nothing due in the next two weeks</div>'}</div>
    </div>`}`;

  app.querySelectorAll('[data-range]').forEach(b => b.onclick = () => setDash({ range: b.dataset.range }));
  $('#de').onchange = e => setDash({ epic: e.target.value });
  $('#dr').onchange = e => setDash({ release: e.target.value });
  if ($('#dclear')) $('#dclear').onclick = () => setDash({ epic: '', release: '' });
  app.querySelectorAll('[data-goepic]').forEach(r => r.onclick = () => { epicFilter = r.dataset.goepic; relFilter = ''; location.hash = 'backlog'; });
  app.querySelectorAll('[data-gorel]').forEach(r => r.onclick = () => { location.hash = 'releases'; });
  app.querySelectorAll('[data-id]').forEach(r => r.onclick = () => openIssue(issue(r.dataset.id)));
  bindTips(app);
}

function setDash(patch) {
  dash = { ...dash, ...patch };
  try { localStorage.setItem('dash', JSON.stringify(dash)); } catch {}
  render();
}

// ---------- tooltips (labels go in via textContent: names are user data) ----------
function showTip(x, y, { title, rows }) {
  const t = $('#tip'), el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  t.replaceChildren(el('div', 'tt', title), ...rows.map(r => {
    const d = el('div', 'tr'); const k = el('i'); if (r.color) k.style.background = r.color; else k.style.visibility = 'hidden';
    d.append(k, el('b', '', String(r.value)), el('span', '', r.label)); return d;
  }));
  t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.min(innerWidth - w - 8, x + 14) + 'px';
  t.style.top = (y + h + 20 > innerHeight ? y - h - 12 : y + 16) + 'px';
}
const hideTip = () => { $('#tip').hidden = true; };

function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach(m => {
    const data = tips[m.dataset.tip];
    m.onpointermove = e => showTip(e.clientX, e.clientY, data);
    m.onpointerleave = m.onblur = hideTip;
    m.onfocus = () => { const r = m.getBoundingClientRect(); showTip(r.left + r.width / 2, r.top, data); };
  });
  root.querySelectorAll('[data-line]').forEach(hit => {
    const L = lines[hit.dataset.line], svgEl = hit.ownerSVGElement, xh = svgEl.querySelector('.xh');
    hit.onpointermove = e => {
      const r = svgEl.getBoundingClientRect(), x = (e.clientX - r.left) * L.W / r.width;
      let i = 0; L.labels.forEach((_, k) => { if (Math.abs(L.xOf(k) - x) < Math.abs(L.xOf(i) - x)) i = k; });
      xh.setAttribute('visibility', 'visible');
      xh.querySelector('line').setAttribute('x1', L.xOf(i)); xh.querySelector('line').setAttribute('x2', L.xOf(i));
      xh.querySelectorAll('circle').forEach((c, s) => { c.setAttribute('cx', L.xOf(i)); c.setAttribute('cy', L.yOf(L.series[s].values[i])); });
      showTip(e.clientX, e.clientY, { title: L.labels[i], rows: L.series.map(s => ({ value: `${s.values[i]} pts`, label: s.name, color: s.color })) });
    };
    hit.onpointerleave = () => { xh.setAttribute('visibility', 'hidden'); hideTip(); };
  });
}

// redraw charts at the new width when the window is resized
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (db && view === 'dashboard' && !document.querySelector('.modal')) render(); }, 150);
});
