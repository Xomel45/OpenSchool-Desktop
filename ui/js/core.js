'use strict';
// OpenSchool UI. All data comes from Rust through Tauri commands (see src-tauri/src/commands.rs).

const rawInvoke = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core.invoke : null;
/** Every command goes through here: the Rust side answers "SESSION_EXPIRED" when the server rejects the session (HTTP 401/403),
 *  and wherever that happens the user is sent to the login screen instead of staring at a retry button. */
const invoke = rawInvoke ? (cmd, args, opts) => rawInvoke(cmd, args, opts).catch((e) => { if (e === 'SESSION_EXPIRED') sessionExpired(); throw e; }) : null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- dates (all local time) ----------
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const parseDT = (s) => { const [dt, tm] = s.split(' '); const [y, mo, d] = dt.split('-').map(Number); const [h, mi] = tm.split(':').map(Number); return new Date(y, mo - 1, d, h, mi); };
const hm = (s) => s.slice(11, 16).replace(/^0/, '');
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a, b) => isoDate(a) === isoDate(b);
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const shortDate = (s) => { const d = parseDate(s); return `${d.getDate()} ${MON_SHORT[d.getMonth()]}`; };

/** ISO-8601 week; the server's interval id is `{week}{year}`. */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
  return { year, week };
}
/** Academic year is named after the year it starts in (2026 for 2026/2027). */
const academicYear = (d) => (d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1);

// ---------- state ----------
const S = {
  student: null, cls: null, today: null, cur: null, sel: null, day: [], min: null, max: null,
  weekReqs: new Map(), lessonsById: new Map(), byDate: new Map(), marks: new Map(), hw: new Map(), token: 0, wtoken: 0, week: null, picked: null, gp: null, gtoken: 0,
};

let done = {};
try { done = JSON.parse(localStorage.getItem('openschool.hwdone') || '{}'); } catch (_) { done = {}; }
function setDone(id, v) {
  if (v) done[id] = 1; else delete done[id];
  try { localStorage.setItem('openschool.hwdone', JSON.stringify(done)); } catch (_) { /* storage may be unavailable */ }
}

function merge(w) {
  for (const l of w.lessons) {
    S.lessonsById.set(l.id, l);
    const k = l.start.slice(0, 10);
    if (!S.byDate.has(k)) S.byDate.set(k, new Map());
    S.byDate.get(k).set(l.id, l);
  }
  for (const m of w.marks) S.marks.set(m.id, m);
  for (const h of w.homeworks) S.hw.set(h.id, h);
}

function loadWeek(d) {
  const { year, week } = isoWeek(d);
  const k = `${year}-${week}`;
  if (!S.weekReqs.has(k)) {
    S.weekReqs.set(k, invoke('week', { studentId: S.student.id, year, isoWeek: week })
      .then((w) => { merge(w); return w; })
      .catch((e) => { S.weekReqs.delete(k); throw e; }));
  }
  return S.weekReqs.get(k);
}

// ---------- load errors: one friendly card instead of a technical message ----------
const NET_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 18.5h9a4 4 0 0 0 .7-7.94A5.5 5.5 0 0 0 6.6 9.3 4.6 4.6 0 0 0 7.5 18.5Z"/><path d="M4 4l16 16"/></svg>';
/** What a failed request means for the user. `OFFLINE` and `HTTP <code>` come from the Rust side (commands::err). */
function describeError(e) {
  const s = String((e && e.message) || e);
  if (s === 'OFFLINE') return { title: 'Не удалось связаться с Госуслугами', text: 'Проверьте подключение к интернету. Если интернет есть, возможно, сайт Госуслуг сейчас недоступен.' };
  const m = s.match(/HTTP (\d{3})/);
  if (m) return { title: 'Госуслуги ответили ошибкой', text: `Сервер вернул ошибку ${m[1]}. Обычно это временно: попробуйте чуть позже.` };
  return { title: 'Не удалось загрузить данные', text: 'Что-то пошло не так. Если повторится, сообщите об этом с текстом ниже.', detail: s };
}
/** Fill `el` with the error card and retry by itself: every 20 s and as soon as the system reports that the network is back. */
function renderLoadError(el, e, retry, compact) {
  const d = describeError(e);
  el.innerHTML = `<div class="neterr${compact ? ' compact' : ''}" role="alert"><div class="ne-ic">${NET_ICON}</div><b>${esc(d.title)}</b><p>${esc(d.text)}</p>${d.detail ? `<code>${esc(d.detail)}</code>` : ''}<button class="btn" data-retry>Повторить</button><small>Попробуем снова сами, как только появится связь.</small></div>`;
  const block = el.querySelector('.neterr');
  const visible = () => document.contains(block) && block.getClientRects().length > 0;
  const again = () => { if (document.contains(block)) retry(); };
  block.querySelector('[data-retry]').onclick = again;
  S.errBlock = { block, visible, again };
  clearTimeout(S.errTimer);
  S.errTimer = setTimeout(() => { if (visible()) again(); }, 20000);
}
window.addEventListener('online', () => { if (S.errBlock && S.errBlock.visible()) S.errBlock.again(); });

// ---------- helpers ----------
const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
/** New content slides in from the side we are moving towards (dir 1: forward / later, -1: back / earlier) and fades in.
 *  Nothing slides out: the old content is replaced after loading, so only the arrival is animated. */
function slideIn(el, dir) {
  if (!dir || !el || !el.animate || (reduceMotion && reduceMotion.matches)) return;
  el.getAnimations().forEach((a) => a.cancel());
  const host = el.closest('.box'); // the card that holds the content: it clips the 24 px of travel, so nothing pokes out of its border
  if (host) host.classList.add('sliding');
  const anim = el.animate([{ opacity: 0, transform: `translateX(${dir * 24}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)' });
  const end = () => { if (host) host.classList.remove('sliding'); };
  anim.onfinish = end; anim.oncancel = end;
}

const cls = (v) => { const x = String(v).toLowerCase(); return x === '5' ? 'c5' : x === '4' ? 'c4' : x === '3' ? 'c3' : x === '2' ? 'c2' : 'cn'; };
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])(\S)/g, (_, a, b) => a + b.toUpperCase());
function teacherName(t) {
  if (!t || !t.last_name) return '';
  const ini = (x) => (x ? x[0].toUpperCase() + '.' : '');
  return `${titleCase(t.last_name)} ${ini(t.first_name)}${ini(t.patronymic)}`.trim();
}

/** Lessons of one day with their homework (by the lesson it is due on) and marks. */
function buildDay(d) {
  const key = isoDate(d);
  const lessons = [...(S.byDate.get(key) ? S.byDate.get(key).values() : [])].sort((a, b) => a.start.localeCompare(b.start));
  const rows = lessons.map((l, i) => ({ n: i + 1, l, hw: [], marks: [] }));
  const byId = new Map(rows.map((r) => [r.l.id, r]));

  const hws = [...S.hw.values()].filter((h) => h.due_date === key);
  const orphanHw = [];
  for (const h of hws) {
    const r = byId.get(h.due_lesson_id) || rows.find((x) => h.subject_id && x.l.subject_id === h.subject_id);
    if (r) r.hw.push(h); else orphanHw.push(h);
  }
  for (const m of S.marks.values()) {
    const r = byId.get(m.lesson_id) || (m.date === key ? rows.find((x) => m.subject_id && x.l.subject_id === m.subject_id) : null);
    if (r) r.marks.push(m);
  }
  return { rows, orphanHw };
}

function status(l) {
  const now = new Date();
  if (parseDT(l.end) < now) return 'past';
  if (parseDT(l.start) <= now) return 'now';
  return '';
}
