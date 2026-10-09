'use strict';
// ---------- grades: a quarter (or the year) as a table with one row per subject ----------
const toNum = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmtAvg = (x) => String(Math.round(x * 100) / 100).replace('.', ',');
/** An average is coloured like a mark: from 4.5 a five, from 3.5 a four, from 2.6 a three, below that a two. */
const avgClass = (x) => (x >= 4.5 ? 'c5' : x >= 3.5 ? 'c4' : x >= 2.6 ? 'c3' : 'c2');
const quartersOf = () => (S.cls ? S.cls.quarters : []);

function periodRange(p) {
  const qs = quartersOf();
  if (!qs.length) return null;
  if (p === 'year') return { start: qs[0].start_date, end: qs[qs.length - 1].end_date };
  const q = qs.find((x) => String(x.number) === p);
  return q ? { start: q.start_date, end: q.end_date } : null;
}
/** The quarter that is running now; between quarters, the last one that has started. */
function defaultPeriod() {
  const t = isoDate(S.today), qs = quartersOf();
  const cur = qs.find((q) => q.start_date <= t && t <= q.end_date) || [...qs].reverse().find((q) => q.start_date <= t);
  return cur ? String(cur.number) : '1';
}

/** Load every week of the period that has already begun, four at a time (be gentle with the server). */
async function loadRange(start, end, progress) {
  const today = isoDate(S.today), last = end < today ? end : today;
  if (start > last) return;
  const weeks = [];
  for (let m = mondayOf(parseDate(start)); isoDate(m) <= last; m = addDays(m, 7)) weeks.push(m);
  let done = 0;
  for (let i = 0; i < weeks.length; i += 4) {
    await Promise.all(weeks.slice(i, i + 4).map((m) => loadWeek(m).then(() => progress && progress(++done, weeks.length))));
  }
}

/** One entry per subject seen in the period: its marks by date and their average (only numeric marks count). */
function gradeRows(start, end) {
  const subjects = new Map();
  const entry = (o) => {
    const k = o.subject_id || `n:${o.subject_name}`;
    if (!subjects.has(k)) subjects.set(k, { name: o.subject_name, marks: [] });
    return subjects.get(k);
  };
  for (const l of S.lessonsById.values()) { const d = l.start.slice(0, 10); if (l.subject_name && d >= start && d <= end) entry(l); }
  for (const m of S.marks.values()) if (m.subject_name && m.date >= start && m.date <= end) entry(m).marks.push(m);
  const rows = [...subjects.values()];
  for (const r of rows) {
    r.marks.sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
    r.avg = meanOf(r.marks.map((m) => toNum(m.value)).filter((n) => n !== null));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

const avgChip = (x) => (x === null ? '<span class="gr-dash">–</span>' : `<span class="chip ${avgClass(x)}">${fmtAvg(x)}</span>`);
const markChip = (m) => `<span class="chip ${cls(m.value)}" data-id="${esc(m.id)}" title="${esc(shortDate(m.date) + ' · ' + (m.work_name || m.work_type || ''))}">${esc(m.value)}</span>`;

function renderQuarterTable(rows) {
  if (!rows.length) return '<div class="gr-note">В этой четверти пока нет уроков.</div>';
  const body = rows.map((r) => `<tr><th scope="row">${esc(r.name)}</th><td>${r.marks.length ? `<div class="gr-marks">${r.marks.map(markChip).join('')}</div>` : '<span class="gr-dash">–</span>'}</td><td class="gr-avg">${avgChip(r.avg)}</td></tr>`).join('');
  return `<table class="gr-table gr-grid"><thead><tr><th>Предмет</th><th>Оценки</th><th class="gr-avg">Ср. балл</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** Year view: a grid like the old diary. Quarters that have not begun are greyed out; "Экзамен" and "Итог" have no data source yet. */
function renderYearTable() {
  const qs = quartersOf(), today = isoDate(S.today), year = periodRange('year');
  const started = qs.map((q) => q.start_date <= today);
  const perQuarter = qs.map((q, i) => (started[i] ? gradeRows(q.start_date, q.end_date) : []));
  const yearRows = gradeRows(year.start, year.end);
  const dash = '<span class="gr-dash">–</span>';
  const body = yearRows.map((yr) => {
    const cells = qs.map((q, i) => {
      if (!started[i]) return `<td class="num off">${dash}</td>`;
      const r = perQuarter[i].find((x) => x.name === yr.name);
      return `<td class="num">${avgChip(r ? r.avg : null)}</td>`;
    }).join('');
    return `<tr><th scope="row">${esc(yr.name)}</th>${cells}<td class="num">${avgChip(yr.avg)}</td><td class="num off">${dash}</td><td class="num off">${dash}</td></tr>`;
  }).join('');
  const head = qs.map((q, i) => `<th class="num${started[i] ? '' : ' off'}">${q.number} чтв</th>`).join('');
  return `<table class="gr-table gr-grid"><thead><tr><th>Предмет</th>${head}<th class="num">Год</th><th class="num off">Экзамен</th><th class="num off">Итог</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderSummary(range) {
  const marks = [...S.marks.values()].filter((m) => m.date >= range.start && m.date <= range.end);
  const nums = marks.map((m) => toNum(m.value)).filter((n) => n !== null);
  if (!marks.length) { $('gr-sum').textContent = ''; return; }
  const count = (g) => nums.filter((n) => Math.round(n) === g).length;
  const dist = [5, 4, 3, 2].map((g) => `<span><span class="chip ${cls(String(g))}">${g}</span>×${count(g)}</span>`).join('');
  $('gr-sum').innerHTML = `<span title="Среднее всех оценок периода, а не среднее по предметам">Средний балл <b>${nums.length ? fmtAvg(meanOf(nums)) : '–'}</b></span><span>Оценок <b>${marks.length}</b></span>${dist}`;
}

async function showMarks(p) {
  p = p || S.gp || defaultPeriod();
  const order = ['1', '2', '3', '4', 'year'];
  const dir = S.gp && S.gp !== p ? Math.sign(order.indexOf(p) - order.indexOf(S.gp)) : 0; // later period: slides from the right
  S.gp = p;
  const token = ++S.gtoken;
  document.querySelectorAll('#gr-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === p)));
  const range = periodRange(p), body = $('gr-body');
  $('gr-sum').textContent = '';
  if (!range) { body.innerHTML = '<div class="gr-note">Нет данных о четвертях этого года.</div>'; return; }
  if (range.start > isoDate(S.today)) { body.innerHTML = '<div class="gr-note">Эта четверть ещё не началась.</div>'; return; }
  body.innerHTML = '<div class="gr-note" id="gr-load">Загрузка оценок…</div>';
  try {
    await loadRange(range.start, range.end, (done, total) => { if (token === S.gtoken && $('gr-load')) $('gr-load').textContent = `Загрузка оценок… ${done} из ${total} нед.`; });
  } catch (e) {
    if (token !== S.gtoken) return;
    renderLoadError(body, e, () => showMarks(p));
    return;
  }
  if (token !== S.gtoken) return; // the user switched the period while this one was loading
  body.innerHTML = p === 'year' ? renderYearTable() : renderQuarterTable(gradeRows(range.start, range.end));
  renderSummary(range);
  slideIn(body, dir);
}

function settingsSection(name) {
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  document.querySelectorAll('.setnav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.sec === name)));
}

async function renderSettings() {
  const s = S.student, c = S.cls;
  $('set-acc').textContent = s ? `${titleCase(s.first_name)} ${titleCase(s.last_name)}${c ? ` · ${c.class_number} «${c.class_letter}»` : ''}`.trim() : '';
  let ver = 'dev';
  try { if (window.__TAURI__ && window.__TAURI__.app) ver = await window.__TAURI__.app.getVersion(); } catch (_) { /* keep "dev" */ }
  $('set-about').textContent = `OpenSchool ${ver}. Неофициальный клиент «Моя школа» (Госуслуги).`;
}
