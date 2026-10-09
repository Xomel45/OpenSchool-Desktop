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

// ---------- rendering ----------
function renderStudent() {
  const s = S.student;
  const name = `${titleCase(s.first_name)} ${titleCase(s.last_name)}`.trim();
  $('sname').textContent = name;
  $('ava').textContent = ((s.first_name || '')[0] || '') + ((s.last_name || '')[0] || '');
  const c = S.cls;
  $('sclass').textContent = c ? `${c.class_number} «${c.class_letter}»${c.school_name ? ' · ' + c.school_name : ''}` : '';
}

function marksSorted() {
  const todayKey = isoDate(S.today);
  return [...S.marks.values()].filter((m) => m.date <= todayKey)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
}

function renderMarks() {
  const list = marksSorted().slice(0, 16);
  S.recent = list;
  $('marks').innerHTML = list.length
    ? list.map((m, i) => `<div class="mk" data-i="${i}"><span class="chip ${cls(m.value)}">${esc(m.value)}</span><b>${esc(m.subject_name)}</b><span class="d">${esc(shortDate(m.date))}</span></div>`).join('')
    : '<div class="muted" style="padding:6px 8px 12px">Оценок пока нет</div>';
}

function renderSched() {
  const el = $('sched');
  const { rows, orphanHw } = S.dayData;
  if (!rows.length) {
    const wd = S.cur.getDay();
    el.innerHTML = `<div class="empty">${wd === 0 || wd === 6 ? 'Выходной день' : S.cur > S.today ? 'Расписание на этот день ещё не опубликовано' : 'Уроков нет'}</div>`;
    return;
  }
  const card = (r, i) => {
    const hw = r.hw.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc(h.description || 'Без текста')}</span></label>`).join('');
    const mk = r.marks.map((m) => `<span class="chip ${cls(m.value)}" style="min-width:26px;height:26px;font-size:13px">${esc(m.value)}</span>`).join(' ');
    const st = status(r.l);
    return `<div class="ls ${st}" data-i="${i}" data-sel="${S.sel === i}"><button class="lh" aria-pressed="${S.sel === i}"><div class="row"><span class="n">${r.n}</span><span class="nm">${esc(r.l.subject_name)}</span>${mk}<span class="tm">${esc(hm(r.l.start))}–${esc(hm(r.l.end))}</span></div></button>${hw}</div>`;
  };
  const extra = orphanHw.length
    ? `<div class="ls"><div class="lh" style="cursor:default"><div class="row"><span class="nm">Задания без урока</span></div></div>${orphanHw.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc((h.subject_name ? h.subject_name + ': ' : '') + (h.description || ''))}</span></label>`).join('')}</div>`
    : '';
  el.innerHTML = rows.map(card).join('') + extra;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV'];
function infoHtml() {
  let q = '';
  const quarters = S.cls ? S.cls.quarters : [];
  const t = isoDate(S.today);
  const cur = quarters.find((p) => p.start_date <= t && t <= p.end_date) || quarters.find((p) => p.start_date > t);
  if (cur) {
    const a = parseDate(cur.start_date), b = parseDate(cur.end_date);
    const running = cur.start_date <= t;
    const pct = running ? Math.min(100, Math.max(0, Math.round(((S.today - a) / (b - a)) * 100))) : 0;
    const left = Math.max(0, Math.ceil((b - S.today) / 864e5));
    q = `<div class="block"><h3>Четверть</h3>${ROMAN[cur.number] || cur.number} четверть: ${a.getDate()} ${MON[a.getMonth()]} – ${b.getDate()} ${MON[b.getMonth()]}<div class="meter"><i style="width:${pct}%"></i></div><span class="muted">${running ? `прошло ${pct}%, осталось ${left} дн.` : 'ещё не началась'}</span></div>`;
  }
  return `<h1>Информация</h1><div class="sub">Четверть и школьные события</div>${q}<div class="block"><h3>Школьные мероприятия</h3><span class="muted">Пока не подключены: источник этих данных ещё не найден.</span></div>`;
}

const lessonStatusText = (l) => { const st = status(l); return st === 'now' ? 'Идёт сейчас' : st === 'past' ? 'Урок прошёл' : 'Ещё впереди'; };

/** The lesson card: used by the home panel and by the pop-up on the schedule page. */
function lessonCardHtml(r, sub) {
  const l = r.l;
  const mk = r.marks.length
    ? r.marks.map((m) => `<span class="big ${cls(m.value)}">${esc(m.value)}</span> <span style="margin:0 14px 0 8px" class="muted">${esc(m.work_name || m.work_type || '')}</span>`).join('')
    : '<span class="muted">Пока нет</span>';
  const hw = r.hw.length
    ? r.hw.map((h) => `<div>${esc(h.description || 'Без текста')}${h.materials.length ? `<div class="muted">${h.materials.map((x) => '📎 ' + esc(x.name)).join(', ')}</div>` : ''}</div>`).join('')
    : '<span class="muted">Не задано</span>';
  return `<h1>${esc(l.subject_name)}</h1><div class="sub">${esc(sub)}</div>
  <dl class="facts"><div><dt>Номер урока</dt><dd>${r.n}-й</dd></div><div><dt>Время</dt><dd>${esc(hm(l.start))}–${esc(hm(l.end))}</dd></div><div><dt>Ведёт</dt><dd>${esc(teacherName(l.teacher) || '—')}</dd></div><div><dt>Кабинет</dt><dd>${esc(l.room || '—')}</dd></div></dl>
  <div class="block"><h3>Тема урока</h3>${l.theme ? esc(l.theme) : '<span class="muted">Не указана</span>'}</div>
  <div class="block"><h3>Домашнее задание</h3>${hw}</div>
  <div class="block"><h3>Оценка</h3>${mk}${l.absence ? `<div class="abs">Пропуск: ${esc(l.absence.description || l.absence.code || 'без пояснения')}</div>` : ''}</div>`;
}

function renderMain() {
  const el = $('main');
  if (S.sel === null) { el.innerHTML = infoHtml(); return; }
  const r = S.dayData.rows[S.sel];
  if (!r) { S.sel = null; el.innerHTML = infoHtml(); return; }
  el.innerHTML = `<button class="back" id="back">← Информация</button>${lessonCardHtml(r, lessonStatusText(r.l))}`;
  $('back').onclick = () => { S.sel = null; renderSched(); renderMain(); };
}

// ---------- day navigation ----------
function renderNavLabel() {
  const c = S.cur, diff = Math.round((c - S.today) / 864e5);
  $('dlabel').textContent = `${WD[c.getDay()][0].toUpperCase()}${WD[c.getDay()].slice(1)}, ${c.getDate()} ${MON[c.getMonth()]}`;
  $('dsub').textContent = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === -1 ? 'вчера' : diff > 0 ? `через ${diff} дн.` : `${-diff} дн. назад`;
  $('prev').disabled = c <= S.min;
  $('next').disabled = c >= S.max;
  $('gotoday').style.visibility = diff === 0 ? 'hidden' : 'visible';
}

async function setDay(d) {
  if (d < S.min || d > S.max) return;
  const dir = S.cur ? Math.sign(d - S.cur) : 0;
  S.cur = new Date(d);
  S.sel = null;
  const token = ++S.token;
  renderNavLabel();
  S.dayData = buildDay(S.cur);
  if (!S.weekReqs.has(`${isoWeek(S.cur).year}-${isoWeek(S.cur).week}`)) {
    $('sched').innerHTML = '<div class="empty">Загрузка…</div>';
  }
  try {
    await loadWeek(S.cur);
  } catch (e) {
    if (token !== S.token) return;
    S.dayError = true;
    renderLoadError($('sched'), e, () => setDay(S.cur), true);
    return;
  }
  if (token !== S.token) return; // the user moved on while loading
  S.dayError = false;
  S.dayData = buildDay(S.cur);
  renderSched();
  renderMain();
  renderMarks();
  slideIn($('sched'), dir);
}
const step = (n) => setDay(addDays(S.cur, n));

// ---------- start-up ----------
/** Put the sliding pill under the active menu button; `instant` places it without animation (first show, resize). */
function movePill(instant) {
  const pill = $('nav-pill'), cur = document.querySelector('.bar nav button[aria-current="page"]');
  if (!pill || !cur || !cur.offsetWidth) { if (pill) { pill.classList.remove('on'); pill.parentElement.classList.remove('pilled'); } return; } // hidden page: nothing to measure yet
  if (instant) pill.classList.add('still');
  pill.style.setProperty('--x', `${cur.offsetLeft}px`);
  pill.style.setProperty('--w', `${cur.offsetWidth}px`);
  pill.classList.add('on'); pill.parentElement.classList.add('pilled');
  if (instant) { void pill.offsetWidth; pill.classList.remove('still'); } // flush the jump, then animations are back on
}
window.addEventListener('resize', () => movePill(true));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => movePill(true));

function show(which) {
  $('boot').hidden = which !== 'boot';
  $('login').hidden = which !== 'login';
  $('app').hidden = which !== 'app';
  if (which === 'app') movePill(true);
}

async function start() {
  S.student = await invoke('student');
  S.today = new Date(); S.today.setHours(0, 0, 0, 0);
  S.cls = await invoke('class_info', { studentId: S.student.id, year: academicYear(S.today) }).catch(() => null);
  const q = S.cls && S.cls.quarters.length ? S.cls.quarters : null;
  S.min = q ? parseDate(q[0].start_date) : new Date(academicYear(S.today), 8, 1);
  S.max = addDays(S.today, 21); // how far ahead the server publishes lessons is unknown
  show('app');
  initNews();
  renderStudent();
  await setDay(S.today);
  // Fill the "recent marks" strip from the previous weeks too (a week holds only a few marks).
  await Promise.all([1, 2, 3, 4, 5].map((i) => loadWeek(addDays(S.today, -7 * i)).catch(() => null)));
  renderMarks();
  if (!S.dayError) {
    S.dayData = buildDay(S.cur);
    renderSched();
    if (S.sel === null) renderMain();
  }
}

/** The session is dead: forget it, drop everything shown, ask for a new login. Safe to call many times in a row. */
async function sessionExpired() {
  if (S.expiredHandled) return;
  S.expiredHandled = true;
  try { await rawInvoke('forget_session'); } catch (_) { /* the login screen is what matters */ }
  S.weekReqs.clear(); S.lessonsById.clear(); S.byDate.clear(); S.marks.clear(); S.hw.clear();
  const dlg = $('lessondlg');
  if (dlg.open) dlg.close();
  closeCalendar(false); closeFeed(false);
  $('toast').hidden = true;
  showLogin('Сессия истекла. Войдите через Госуслуги снова.');
}

function showLogin(msg) {
  show('login');
  $('loginerr').textContent = msg || '';
  $('loginbtn').disabled = false;
  $('loginnote').textContent = '';
  // If the system secret store is not there (KWallet not running, no keyring), say so: the login will not be remembered.
  if (invoke) invoke('secret_store').then((s) => { if (!s.available) $('loginnote').textContent = 'Хранилище секретов недоступно (KWallet, GNOME Keyring или Диспетчер учётных данных): после входа сессия не запомнится, и при каждом запуске придётся входить заново.'; }).catch(() => {});
}

async function boot() {
  if (!invoke) { $('boot-msg').textContent = 'Запустите приложение через Tauri: это окно открыто вне его.'; return; }
  try {
    if (await invoke('restore_session')) await start(); else showLogin();
  } catch (e) {
    renderLoadError($('boot-msg'), e, () => { $('boot-msg').textContent = 'Загрузка…'; boot(); });
  }
}

// ---------- views (home / settings) ----------
function view(v) {
  closeFeed(false);
  if (v !== 'schedule') closeCalendar(false); // the calendar is outside the page, so hiding the page does not hide it
  $('homeview').hidden = v !== 'home';
  $('schedule').hidden = v !== 'schedule';
  $('marksview').hidden = v !== 'marks';
  $('tasksview').hidden = v !== 'tasks';
  $('settings').hidden = v !== 'settings';
  const on = { home: $('nav-home'), schedule: $('nav-schedule'), tasks: $('nav-tasks'), marks: $('nav-marks'), settings: $('nav-settings') };
  for (const k of Object.keys(on)) { if (k === v) on[k].setAttribute('aria-current', 'page'); else on[k].removeAttribute('aria-current'); }
  movePill(false);
  if (v === 'settings') renderSettings();
  if (v === 'marks') showMarks();
  if (v === 'tasks') showTasks();
  if (v === 'schedule') showWeek(S.week || mondayOf(S.cur || S.today));
}

// ---------- schedule: one week, seven day columns ----------
const mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const WD_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function weekLabel(monday) {
  const a = monday, b = addDays(monday, 6);
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()} – ${b.getDate()} ${MON[b.getMonth()]}`
    : `${a.getDate()} ${MON_SHORT[a.getMonth()]} – ${b.getDate()} ${MON_SHORT[b.getMonth()]}`;
}
function renderWeekHead() {
  const diff = Math.round((S.week - mondayOf(S.today)) / (7 * 864e5));
  $('wlabel').textContent = weekLabel(S.week);
  $('wsub').textContent = diff === 0 ? 'эта неделя' : diff === 1 ? 'следующая неделя' : diff === -1 ? 'прошлая неделя' : diff > 0 ? `через ${diff} нед.` : `${-diff} нед. назад`;
  $('wprev').disabled = S.week <= mondayOf(S.min);
  $('wnext').disabled = S.week >= mondayOf(S.max);
  $('wtoday').style.visibility = diff === 0 ? 'hidden' : 'visible';
}

function weekCard(r, dateKey) {
  const hw = r.hw.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc(h.description || 'Без текста')}${h.materials.length ? ' 📎' : ''}</span></label>`).join('');
  const mk = r.marks.map((m) => `<span class="chip ${cls(m.value)}" style="min-width:24px;height:24px;font-size:12px">${esc(m.value)}</span>`).join(' ');
  return `<div class="ls ${status(r.l)}" data-date="${esc(dateKey)}" data-lid="${esc(r.l.id)}"><button class="lh"><div class="row"><span class="n">${r.n}</span><span class="nm">${esc(r.l.subject_name)}</span>${mk}</div><div class="when">${esc(hm(r.l.start))}–${esc(hm(r.l.end))}</div></button>${hw}</div>`;
}

function renderWeek() {
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(S.week, i), key = isoDate(d), { rows, orphanHw } = buildDay(d);
    const isToday = sameDay(d, S.today), weekend = i >= 5;
    let body;
    if (rows.length) {
      body = rows.map((r) => weekCard(r, key)).join('');
      if (orphanHw.length) body += `<div class="ls"><div class="lh" style="cursor:default"><div class="row"><span class="nm">Задания без урока</span></div></div>${orphanHw.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc((h.subject_name ? h.subject_name + ': ' : '') + (h.description || ''))}</span></label>`).join('')}</div>`;
    } else {
      body = `<div class="empty">${weekend ? 'Выходной день' : d > S.today ? 'Не опубликовано' : 'Уроков нет'}</div>`;
    }
    const isPicked = !!S.picked && sameDay(d, S.picked);
    cols.push(`<section class="dcol${isToday ? ' today' : ''}${isPicked ? ' picked' : ''}${!rows.length && weekend ? ' off' : ''}"${isPicked ? ' aria-current="date"' : ''} aria-label="${esc(WD[(i + 1) % 7])}, ${d.getDate()} ${esc(MON[d.getMonth()])}"><h3>${WD_SHORT[i]}, ${d.getDate()} ${MON_SHORT[d.getMonth()]}${isToday ? '<small>сегодня</small>' : isPicked ? '<small>выбрано</small>' : ''}</h3>${body}</section>`);
  }
  $('wgrid').innerHTML = cols.join('');
}

async function showWeek(monday) {
  if (monday < mondayOf(S.min) || monday > mondayOf(S.max)) return;
  const dir = S.week ? Math.sign(monday - S.week) : 0;
  S.week = monday;
  const token = ++S.wtoken;
  renderWeekHead();
  const cached = [monday, addDays(monday, -7)].every((m) => S.weekReqs.has(`${isoWeek(m).year}-${isoWeek(m).week}`));
  if (!cached) $('wgrid').innerHTML = '<div class="empty" style="grid-column:1/-1">Загрузка…</div>';
  try {
    // The previous week is loaded too: homework due this week is sometimes sent with the week it was issued in.
    await Promise.all([loadWeek(monday), loadWeek(addDays(monday, -7))]);
  } catch (e) {
    if (token !== S.wtoken) return;
    renderLoadError($('wgrid'), e, () => showWeek(S.week));
    return;
  }
  if (token !== S.wtoken) return;
  renderWeek();
  slideIn($('wgrid'), dir);
}
// ---------- calendar: pick a date, see its week ----------
const MONTH_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const cal = { month: null, focus: null };
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const inRange = (d) => d >= S.min && d <= S.max;
const clampRange = (d) => (d < S.min ? new Date(S.min) : d > S.max ? new Date(S.max) : d);
/** Same day-of-month in another month, or its last day when that month is shorter. */
function addMonths(d, n) {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  t.setDate(Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
  return t;
}

function renderCalendar() {
  const m = cal.month, first = mondayOf(m), weekEnd = addDays(S.week, 6);
  $('cal-title').textContent = `${MONTH_NOM[m.getMonth()]} ${m.getFullYear()}`;
  $('cal-prev').disabled = monthStart(m) <= monthStart(S.min);
  $('cal-next').disabled = monthStart(m) >= monthStart(S.max);
  let html = WD_SHORT.map((x) => `<span class="cal-dow" aria-hidden="true">${x}</span>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i), picked = !!S.picked && sameDay(d, S.picked);
    const c = ['cal-day'];
    if (d.getMonth() !== m.getMonth()) c.push('dim');
    if (sameDay(d, S.today)) c.push('today');
    if (d >= S.week && d <= weekEnd) c.push('inweek');
    if (picked) c.push('picked');
    html += `<button class="${c.join(' ')}" data-date="${isoDate(d)}" tabindex="${sameDay(d, cal.focus) ? 0 : -1}"${inRange(d) ? '' : ' disabled'}${picked ? ' aria-pressed="true"' : ''} aria-label="${d.getDate()} ${esc(MON[d.getMonth()])} ${d.getFullYear()}, ${esc(WD[d.getDay()])}">${d.getDate()}</button>`;
  }
  $('cal-grid').innerHTML = html;
}
function focusCalendarDay(d) {
  cal.focus = d;
  cal.month = monthStart(d);
  renderCalendar();
  const b = $('cal-grid').querySelector(`[data-date="${isoDate(d)}"]`);
  if (b) b.focus();
}
/** The calendar is a fixed layer: put it under its button, or above when there is no room below, always inside the window. */
function positionCalendar() {
  const c = $('cal'), b = $('wcal').getBoundingClientRect(), w = c.offsetWidth, h = c.offsetHeight;
  c.style.left = `${Math.round(Math.min(Math.max(8, b.left), Math.max(8, innerWidth - w - 8)))}px`;
  let top = b.bottom + 8;
  if (top + h > innerHeight - 8) top = Math.max(8, b.top - h - 8);
  c.style.top = `${Math.round(top)}px`;
}
function openCalendar() {
  const start = S.picked || (S.week <= S.today && S.today <= addDays(S.week, 6) ? S.today : S.week);
  cal.focus = clampRange(start);
  cal.month = monthStart(cal.focus);
  $('cal').hidden = false;
  $('wcal').setAttribute('aria-expanded', 'true');
  renderCalendar();
  positionCalendar();
  focusCalendarDay(cal.focus);
}
function closeCalendar(returnFocus) {
  if ($('cal').hidden) return;
  $('cal').hidden = true;
  $('wcal').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('wcal').focus();
}
async function pickDate(d) {
  closeCalendar(false);
  S.picked = d;
  await showWeek(mondayOf(d));
  // In a narrow window the week scrolls sideways: bring the picked column into view, sideways only (the page must not jump).
  const grid = $('wgrid'), col = grid.querySelector('.dcol.picked');
  if (col && grid.scrollWidth > grid.clientWidth) grid.scrollLeft = col.offsetLeft - (grid.clientWidth - col.offsetWidth) / 2;
}

const stepWeek = (n) => { S.picked = null; return showWeek(addDays(S.week, 7 * n)); };

/** The lesson card as a pop-up over the schedule: the page behind stays exactly where it is. */
function showLessonDialog(dateKey, lessonId, opener) {
  const d = parseDate(dateKey), r = buildDay(d).rows.find((x) => x.l.id === lessonId);
  if (!r) return;
  const day = `${WD[d.getDay()][0].toUpperCase()}${WD[d.getDay()].slice(1)}, ${d.getDate()} ${MON[d.getMonth()]}`;
  const dlg = $('lessondlg');
  $('lessondlg-body').innerHTML = lessonCardHtml(r, `${day} · ${lessonStatusText(r.l).toLowerCase()}`);
  dlg.setAttribute('aria-label', r.l.subject_name);
  S.opener = opener || null; // focus goes back here when the pop-up closes
  if (!dlg.open) dlg.showModal();
}

// ---------- tasks: homework by the day it is due ----------
const TASK_DAYS = 4; // days on one page; the arrows turn the page by the same amount
S.tp = 'up'; S.ttoken = 0; S.tpage = { up: 0, past: 0 };
let tasksOpenOnly = false; // restored from storage below, once `pref` exists

/** The days of one page: upcoming pages go forward from today, past pages go back from yesterday (newest first). Days the server does not cover are left out. */
function taskDays(p, page) {
  const days = [];
  for (let i = 0; i < TASK_DAYS; i++) days.push(addDays(S.today, p === 'up' ? page * TASK_DAYS + i : -1 - page * TASK_DAYS - i));
  return days.filter((d) => d >= S.min && d <= S.max);
}
const dayWord = (d) => { const diff = Math.round((d - S.today) / 864e5); return diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === -1 ? 'вчера' : ''; };

function taskCard(r, key) {
  const hw = r.hw.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc(h.description || 'Без текста')}${h.materials.length ? `<div class="muted">${h.materials.map((x) => '📎 ' + esc(x.name)).join(', ')}</div>` : ''}</span></label>`).join('');
  return `<div class="ls" data-date="${esc(key)}" data-lid="${esc(r.l.id)}"><button class="lh"><div class="row"><span class="n">${r.n}</span><span class="nm">${esc(r.l.subject_name)}</span></div><div class="when">${esc(hm(r.l.start))}–${esc(hm(r.l.end))}</div></button>${hw}</div>`;
}

function renderTasks() {
  const days = taskDays(S.tp, S.tpage[S.tp]);
  const html = days.map((d) => {
    const key = isoDate(d), { rows, orphanHw } = buildDay(d);
    const cards = rows.filter((r) => r.hw.length).filter((r) => !tasksOpenOnly || r.hw.some((h) => !done[h.id]));
    const orphans = orphanHw.filter((h) => !tasksOpenOnly || !done[h.id]);
    const any = rows.some((r) => r.hw.length) || orphanHw.length;
    let body = cards.map((r) => taskCard(r, key)).join('')
      + (orphans.length ? `<div class="ls"><div class="lh" style="cursor:default"><div class="row"><span class="nm">Задания без урока</span></div></div>${orphans.map((h) => `<label class="hw${done[h.id] ? ' done' : ''}"><input type="checkbox" data-id="${esc(h.id)}"${done[h.id] ? ' checked' : ''}><span>${esc((h.subject_name ? h.subject_name + ': ' : '') + (h.description || ''))}</span></label>`).join('')}</div>` : '');
    if (!body) body = `<div class="empty">${any ? 'Всё выполнено' : !rows.length ? (d.getDay() === 0 || d.getDay() === 6 ? 'Выходной день' : d > S.today ? 'Расписание ещё не опубликовано' : 'Уроков нет') : 'Заданий нет'}</div>`;
    const w = dayWord(d);
    return `<section class="tk-day${sameDay(d, S.today) ? ' today' : ''}" aria-label="${esc(WD[d.getDay()])}, ${d.getDate()} ${esc(MON[d.getMonth()])}"><h3>${esc(WD[d.getDay()][0].toUpperCase() + WD[d.getDay()].slice(1))}, ${d.getDate()} ${esc(MON[d.getMonth()])}${w ? `<small>${w}</small>` : ''}</h3>${body}</section>`;
  }).join('');
  $('tk-body').innerHTML = html || '<div class="gr-note">Нет данных за этот период.</div>';
  updateTasksSummary();
}
function renderTasksNav() {
  const days = taskDays(S.tp, S.tpage[S.tp]);
  if (days.length) {
    const lo = S.tp === 'up' ? days[0] : days[days.length - 1], hi = S.tp === 'up' ? days[days.length - 1] : days[0]; // earliest / latest day of the page
    $('tk-label').textContent = sameDay(lo, hi) ? `${lo.getDate()} ${MON[lo.getMonth()]}` : lo.getMonth() === hi.getMonth() ? `${lo.getDate()} – ${hi.getDate()} ${MON[hi.getMonth()]}` : `${lo.getDate()} ${MON_SHORT[lo.getMonth()]} – ${hi.getDate()} ${MON_SHORT[hi.getMonth()]}`;
  } else $('tk-label').textContent = '';
  $('tk-lsub').textContent = S.tp === 'up' ? (S.tpage.up === 0 ? 'ближайшие дни' : `через ${S.tpage.up * TASK_DAYS} дн. и позже`) : (S.tpage.past === 0 ? 'последние дни' : `${S.tpage.past * TASK_DAYS + 1} дн. назад и раньше`);
  $('tk-prev').disabled = S.tp === 'up' ? taskDays('past', 0).length === 0 && S.tpage.up === 0 : taskDays('past', S.tpage.past + 1).length === 0;
  $('tk-next').disabled = S.tp === 'up' ? taskDays('up', S.tpage.up + 1).length === 0 : false;
}
/** «‹» goes towards the past, «›» towards the future; from the first upcoming page «‹» continues into the past and back. */
function tasksStep(dir) {
  if (S.tp === 'up') {
    if (dir < 0 && S.tpage.up === 0) return showTasks('past', 0);
    return showTasks('up', S.tpage.up + dir);
  }
  if (dir > 0 && S.tpage.past === 0) return showTasks('up', 0);
  return showTasks('past', S.tpage.past - dir);
}
/** Counted from the page itself, so ticking a box updates it without redrawing (the list must not jump under the cursor). */
function updateTasksSummary() {
  const boxes = [...$('tk-body').querySelectorAll('input[type=checkbox]')], left = boxes.filter((b) => !b.checked).length;
  $('tk-sum').innerHTML = boxes.length ? `Не выполнено <b>${left}</b> из <b>${boxes.length}</b>` : '';
}

async function showTasks(p, page) {
  if (p) { S.tpage[p] = page === undefined ? 0 : page; S.tp = p; } // switching tabs starts from the first page
  else if (page !== undefined) S.tpage[S.tp] = page;
  const token = ++S.ttoken;
  document.querySelectorAll('#tk-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === S.tp)));
  $('tk-open').checked = tasksOpenOnly;
  renderTasksNav();
  const days = taskDays(S.tp, S.tpage[S.tp]);
  if (!days.length) { $('tk-body').innerHTML = '<div class="gr-note">Нет данных за этот период.</div>'; $('tk-sum').textContent = ''; return; }
  const first = days.reduce((a, b) => (a < b ? a : b)), last = days.reduce((a, b) => (a > b ? a : b));
  const weeks = [];
  // One week before the first day too: homework due this week is sometimes sent with the week it was issued in.
  for (let m = addDays(mondayOf(first), -7); m <= last; m = addDays(m, 7)) weeks.push(m);
  const missing = weeks.some((m) => !S.weekReqs.has(`${isoWeek(m).year}-${isoWeek(m).week}`));
  if (missing) { $('tk-body').innerHTML = '<div class="gr-note">Загрузка заданий…</div>'; $('tk-sum').textContent = ''; }
  try {
    for (let i = 0; i < weeks.length; i += 4) await Promise.all(weeks.slice(i, i + 4).map((m) => loadWeek(m)));
  } catch (e) {
    if (token !== S.ttoken) return;
    renderLoadError($('tk-body'), e, () => showTasks());
    return;
  }
  if (token !== S.ttoken) return; // the user switched the tab while this one was loading
  renderTasks();
  // Position on one time line: past pages are 0, -1, ... and upcoming pages are 1, 2, ...
  const pos = S.tp === 'up' ? S.tpage.up + 1 : -S.tpage.past;
  slideIn($('tk-body'), S.tpos === undefined ? 0 : Math.sign(pos - S.tpos));
  S.tpos = pos;
}
$('tk-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (b) showTasks(b.dataset.p); });
$('tk-prev').onclick = () => tasksStep(-1);
$('tk-next').onclick = () => tasksStep(1);
$('tk-open').addEventListener('change', (e) => { tasksOpenOnly = e.target.checked; pref.set('tasksopen', tasksOpenOnly ? '1' : ''); renderTasks(); });
$('tk-body').addEventListener('change', (e) => { onHwChange(e); updateTasksSummary(); });
// The same rule as everywhere: homework text and checkbox only toggle "done", the rest of the card opens the lesson.
$('tk-body').addEventListener('click', (e) => {
  if (e.target.closest('.hw')) return;
  const card = e.target.closest('.ls[data-lid]');
  if (card) showLessonDialog(card.dataset.date, card.dataset.lid, card.querySelector('.lh'));
});

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

// ---------- notifications: bell, feed, toast and their settings (the checking itself runs in Rust, see src-tauri/src/news.rs) ----------
const tauriEvent = window.__TAURI__ && window.__TAURI__.event;
S.feed = []; S.notify = null; S.newsReady = false;

function renderBell(unread) {
  const n = $('bell-n');
  n.hidden = !unread;
  n.textContent = unread > 99 ? '99+' : String(unread);
  $('bell').setAttribute('aria-label', unread ? `Что нового, непрочитанных: ${unread}` : 'Что нового');
}
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч`;
  return h < 48 ? 'вчера' : `${Math.round(h / 24)} дн.`;
}
function feedChip(it) {
  if (it.kind === 'mark') return `<span class="chip ${cls(it.value || '')}">${esc(it.value || '')}</span>`;
  return `<span class="chip cn small">${it.kind === 'homework' ? 'ДЗ' : 'Н'}</span>`;
}
function renderFeed() {
  $('feed-list').innerHTML = S.feed.length
    ? S.feed.map((it) => `<button class="fi${it.read ? '' : ' new'}" data-id="${esc(it.id)}" data-kind="${esc(it.kind)}">${feedChip(it)}<div class="t"><b>${esc(it.title)}</b><span>${esc(it.text)}</span></div><small>${esc(ago(it.ts))}</small>${it.read ? '' : '<i class="dot" aria-label="не прочитано"></i>'}</button>`).join('')
    : '<div class="fempty">Пока ничего нового</div>';
}
async function loadFeed() {
  try {
    const f = await invoke('news_feed');
    S.feed = f.items; renderBell(f.unread);
  } catch (_) { S.feed = []; renderBell(0); }
  renderFeed();
}
function positionFeed() {
  const b = $('bell').getBoundingClientRect(), f = $('feed'), w = f.offsetWidth || 380;
  f.style.top = `${Math.round(b.bottom + 8)}px`;
  f.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, b.right - w)))}px`;
}
function openFeed() {
  $('feed').hidden = false;
  $('bell').setAttribute('aria-expanded', 'true');
  positionFeed();
  loadFeed();
}
function closeFeed(returnFocus) {
  if ($('feed').hidden) return;
  $('feed').hidden = true;
  $('bell').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('bell').focus();
}
$('bell').onclick = () => { if ($('feed').hidden) openFeed(); else closeFeed(true); };
$('feed-readall').onclick = async () => { try { await invoke('news_read', { ids: [] }); } catch (_) { /* offline: nothing to do */ } loadFeed(); };
$('feed-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.fi');
  if (!b) return;
  try { await invoke('news_read', { ids: [b.dataset.id] }); } catch (_) { /* ignore */ }
  closeFeed(false);
  view(b.dataset.kind === 'mark' ? 'marks' : b.dataset.kind === 'homework' ? 'tasks' : 'schedule');
  loadFeed();
});
$('feed').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeFeed(true); e.stopPropagation(); } });
document.addEventListener('click', (e) => { if (!$('feed').hidden && !e.target.closest('#feed') && !e.target.closest('#bell')) closeFeed(false); });
window.addEventListener('resize', () => { if (!$('feed').hidden) positionFeed(); });

let toastTimer = 0;
function showToast(p, ms) {
  const mark = p.kinds && p.kinds.length === 1 && p.kinds[0] === 'mark' && p.value;
  const t = $('toast');
  t.innerHTML = `${mark ? `<span class="chip ${cls(p.value)}">${esc(p.value)}</span>` : '<span class="chip cn small">!</span>'}<div class="t"><b>${esc(p.title)}</b><span class="m">${esc(p.body)}</span></div>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 6000);
}
$('toast').onclick = (e) => { e.stopPropagation(); $('toast').hidden = true; openFeed(); }; // stopPropagation: the "click outside the feed" handler would close it at once

/** Called once the app is shown: restores the unread count and listens to what Rust finds. */
async function initNews() {
  if (!invoke) return;
  loadFeed();
  try { S.notify = await invoke('notify_get'); } catch (_) { S.notify = null; }
  renderNotifySettings();
  if (S.newsReady || !tauriEvent || !tauriEvent.listen) return;
  S.newsReady = true;
  tauriEvent.listen('news-updated', (e) => { renderBell(e.payload.unread); if (!$('feed').hidden) loadFeed(); });
  tauriEvent.listen('news-new', (e) => showToast(e.payload));
  tauriEvent.listen('session-expired', () => sessionExpired()); // the background check found the session dead
}

function renderNotifySettings() {
  const s = S.notify;
  if (!s) return;
  $('nt-marks').checked = s.marks; $('nt-homework').checked = s.homework; $('nt-absences').checked = s.absences; $('nt-tray').checked = s.close_to_tray;
  if (invoke) invoke('tray_ready').then((ok) => { $('nt-tray-warn').hidden = ok; }).catch(() => {});
  document.querySelectorAll('#nt-interval button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === s.interval_min)));
  document.querySelectorAll('#nt-detail button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === '1') === s.detail)));
}
async function saveNotify(patch) {
  const next = { ...(S.notify || {}), ...patch };
  try { S.notify = await invoke('notify_set', { settings: next }); } catch (e) { $('nt-msg').textContent = `Не удалось сохранить: ${e}`; }
  renderNotifySettings();
}
$('nt-marks').onchange = (e) => saveNotify({ marks: e.target.checked });
$('nt-homework').onchange = (e) => saveNotify({ homework: e.target.checked });
$('nt-absences').onchange = (e) => saveNotify({ absences: e.target.checked });
$('nt-tray').onchange = (e) => saveNotify({ close_to_tray: e.target.checked });
$('nt-interval').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) saveNotify({ interval_min: Number(b.dataset.v) }); });
$('nt-detail').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) saveNotify({ detail: b.dataset.v === '1' }); });
$('nt-check').onclick = async () => {
  $('nt-check').disabled = true; $('nt-msg').textContent = 'Проверяю…';
  try {
    const n = await invoke('news_check_now');
    $('nt-msg').textContent = n ? `Найдено нового: ${n}.` : 'Ничего нового.';
  } catch (e) { $('nt-msg').textContent = e === 'OFFLINE' ? 'Нет связи с Госуслугами.' : `Не удалось проверить: ${e}`; }
  $('nt-check').disabled = false;
};

// ---------- events ----------
$('loginbtn').onclick = async () => {
  $('loginbtn').disabled = true;
  $('loginerr').textContent = '';
  try {
    if (await invoke('login')) {
      S.expiredHandled = false; show('boot'); await start();
      // The login worked, but was it saved? If not, the next start asks for it again, and the user should know why.
      invoke('secret_store').then((s) => { if (!s.has_session) showToast({ title: 'Вход не сохранён', body: 'Хранилище секретов недоступно: при следующем запуске придётся войти снова.', kinds: [] }, 12000); }).catch(() => {});
    } else showLogin('Окно входа закрыто');
  } catch (e) { showLogin(String(e)); }
};
async function logout() { await invoke('logout'); closeFeed(false); S.feed = []; renderBell(0); S.weekReqs.clear(); S.lessonsById.clear(); S.byDate.clear(); S.marks.clear(); S.hw.clear(); view('home'); showLogin(); }
$('logout').onclick = logout;
$('set-logout').onclick = logout;
$('nav-home').onclick = () => view('home');
$('nav-settings').onclick = () => view('settings');
$('nav-schedule').onclick = () => view('schedule');
$('nav-marks').onclick = () => view('marks');
$('nav-tasks').onclick = () => view('tasks');
$('gr-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-p]'); if (b) showMarks(b.dataset.p); });
// Hover card of a mark in the table (the same card as on the home screen).
$('gr-body').addEventListener('mouseover', (e) => {
  const c = e.target.closest('.gr-marks .chip[data-id]');
  const m = c && S.marks.get(c.dataset.id);
  if (m) showMarkTip(m, c.getBoundingClientRect());
});
$('gr-body').addEventListener('mouseleave', () => tip.classList.remove('on'));
$('gr-body').addEventListener('mouseout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.gr-marks .chip')) tip.classList.remove('on'); });
// Focus goes back to the lesson that opened the pop-up. Our own close paths do it right away (the `close`
// event arrives later); Esc is closed by the browser itself, so the event covers that path.
function restoreOpenerFocus() { if (S.opener && document.contains(S.opener)) S.opener.focus(); S.opener = null; }
function closeLessonDialog() { const dlg = $('lessondlg'); if (dlg.open) dlg.close(); restoreOpenerFocus(); }
$('lessondlg-close').onclick = closeLessonDialog;
$('lessondlg').addEventListener('close', restoreOpenerFocus);
// A click on the dimmed area outside the card closes it.
$('lessondlg').addEventListener('click', (e) => { if (e.target === $('lessondlg')) closeLessonDialog(); });
$('wprev').onclick = () => stepWeek(-1);
$('wnext').onclick = () => stepWeek(1);
$('wtoday').onclick = () => { S.picked = null; showWeek(mondayOf(S.today)); };
$('wcal').onclick = () => { if ($('cal').hidden) openCalendar(); else closeCalendar(true); };
$('cal-prev').onclick = () => { cal.focus = clampRange(addMonths(cal.focus, -1)); cal.month = monthStart(cal.focus); renderCalendar(); };
$('cal-next').onclick = () => { cal.focus = clampRange(addMonths(cal.focus, 1)); cal.month = monthStart(cal.focus); renderCalendar(); };
$('cal-today').onclick = () => pickDate(S.today);
$('cal-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.cal-day');
  if (b && !b.disabled) pickDate(parseDate(b.dataset.date));
});
$('cal-grid').addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  let target;
  if (step) target = addDays(cal.focus, step);
  else if (e.key === 'PageUp') target = addMonths(cal.focus, -1);
  else if (e.key === 'PageDown') target = addMonths(cal.focus, 1);
  else if (e.key === 'Home') target = mondayOf(cal.focus);
  else if (e.key === 'End') target = addDays(mondayOf(cal.focus), 6);
  else return;
  e.preventDefault();
  e.stopPropagation(); // the arrows move inside the calendar, they must not turn the week behind it
  focusCalendarDay(clampRange(target));
});
$('cal').addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCalendar(true); e.stopPropagation(); } });
window.addEventListener('resize', () => { if (!$('cal').hidden) positionCalendar(); });
$('schedule').addEventListener('scroll', () => { if (!$('cal').hidden) positionCalendar(); }, { passive: true });
// A click anywhere outside the calendar and its button closes it.
document.addEventListener('click', (e) => { if (!$('cal').hidden && !e.target.closest('#cal') && !e.target.closest('#wcal')) closeCalendar(false); });
$('wgrid').addEventListener('change', onHwChange);
// A click on the homework (checkbox or text) only toggles "done"; a click anywhere else on a lesson opens its pop-up.
$('wgrid').addEventListener('click', (e) => {
  if (e.target.closest('.hw')) return;
  const card = e.target.closest('.ls[data-lid]');
  if (card) showLessonDialog(card.dataset.date, card.dataset.lid, card.querySelector('.lh'));
});
$('schedule').addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT' || e.target.closest('#cal')) return;
  if (e.key === 'ArrowLeft') { stepWeek(-1); e.preventDefault(); } else if (e.key === 'ArrowRight') { stepWeek(1); e.preventDefault(); }
});
document.querySelectorAll('.setnav button').forEach((b) => { b.onclick = () => settingsSection(b.dataset.sec); });
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('gotoday').onclick = () => setDay(S.today);

// Homework: a click on the checkbox or its text only toggles "done";
// a click anywhere else on the lesson card only opens the lesson.
function onHwChange(e) {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  setDone(cb.dataset.id, cb.checked);
  cb.closest('.hw').classList.toggle('done', cb.checked);
}
$('sched').addEventListener('change', onHwChange);
$('sched').addEventListener('click', (e) => {
  if (e.target.closest('.hw')) return;
  const card = e.target.closest('.ls[data-i]');
  if (!card) return;
  const i = Number(card.dataset.i);
  S.sel = S.sel === i ? null : i;
  renderSched();
  renderMain();
});
$('schedbox').addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); } else if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
});

// Marks strip: hover card below the mark; the wheel scrolls the strip sideways.
const tip = $('tip'), marksEl = $('marks');
marksEl.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { marksEl.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
/** The hover card of a mark: what for, when, who gave it. `b` is the rectangle of the element it belongs to. */
function showMarkTip(m, b) {
  const lesson = S.lessonsById.get(m.lesson_id);
  const who = lesson ? teacherName(lesson.teacher) : '';
  const rows = [['За что', m.work_name || m.work_type || '—'], ['Дата', shortDate(m.date)]];
  if (who) rows.push(['Поставил', who]);
  if (m.value2) rows.push(['Вторая оценка', m.value2]);
  if (m.comment) rows.push(['Комментарий', m.comment]);
  tip.innerHTML = `<div class="h"><span class="chip ${cls(m.value)}">${esc(m.value)}</span><b>${esc(m.subject_name)}</b></div><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  tip.style.left = Math.min(Math.max(8, b.left - 16), innerWidth - 306) + 'px';
  tip.style.top = Math.min(b.bottom + 6, innerHeight - 190) + 'px';
  tip.classList.add('on');
}
marksEl.addEventListener('mouseover', (e) => {
  const r = e.target.closest('.mk');
  if (!r || !S.recent) return;
  showMarkTip(S.recent[Number(r.dataset.i)], r.getBoundingClientRect());
});
marksEl.addEventListener('mouseleave', () => tip.classList.remove('on'));
marksEl.addEventListener('mouseout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.mk')) tip.classList.remove('on'); });

// ---------- appearance: style (classic / terminal / sunrise) and theme (system / light / dark) ----------
const STYLES = ['classic', 'terminal', 'sunrise'];
const SCHEMES = ['system', 'light', 'dark'];
const pref = {
  get(k, d) { try { return localStorage.getItem('openschool.' + k) || d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('openschool.' + k, v); } catch (_) { /* storage may be unavailable */ } },
};
tasksOpenOnly = pref.get('tasksopen', '') === '1';
let style = pref.get('style', '');
if (!style) { const old = pref.get('theme', 'classic'); style = old === 'light' ? 'classic' : old; } // the old single "theme"
if (!STYLES.includes(style)) style = 'classic';
let schemePref = pref.get('scheme', 'system');
if (!SCHEMES.includes(schemePref)) schemePref = 'system';
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let webDark = !!(mq && mq.matches);
let nativeTheme = null; // the OS theme as the window reports it; more reliable than the web view on Linux

const systemIsDark = () => (nativeTheme ? nativeTheme === 'dark' : webDark);
/** The theme the user chose (the system one resolved). Previews of the other styles use it. */
const userScheme = () => (schemePref === 'system' ? (systemIsDark() ? 'dark' : 'light') : schemePref);
/** Terminal ignores the theme: it is always dark. */
const resolvedScheme = () => (style === 'terminal' ? 'dark' : userScheme());

// Accent colour: [name, colour on light themes, colour on dark themes]. Custom colours are used as they are.
const ACCENTS = {
  blue: ['Синий', '#2563EB', '#5B8CFF'], teal: ['Бирюзовый', '#0D9488', '#2DD4BF'], green: ['Зелёный', '#16A34A', '#4ADE80'],
  amber: ['Янтарный', '#D97706', '#FBBF24'], red: ['Красный', '#DC2626', '#F87171'], pink: ['Розовый', '#DB2777', '#F472B6'],
  purple: ['Фиолетовый', '#7C3AED', '#A78BFA'],
};
const HEX = /^#[0-9a-f]{6}$/i;
let accentPref = pref.get('accent', 'default');
if (accentPref !== 'default' && !ACCENTS[accentPref] && !HEX.test(accentPref)) accentPref = 'default'; // ignore junk in storage

function luminance(hex) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
/** Black or white, whichever reads better on the accent (WCAG contrast). */
function inkFor(hex) {
  const l = luminance(hex);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
}
function accentHex() {
  if (accentPref === 'default') return null;
  if (ACCENTS[accentPref]) return ACCENTS[accentPref][resolvedScheme() === 'dark' ? 2 : 1];
  return accentPref;
}
function applyAccent() {
  const root = document.documentElement, hex = accentHex();
  if (hex) { root.style.setProperty('--accent', hex); root.style.setProperty('--accent-ink', inkFor(hex)); }
  else { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-ink'); }
  const dark = resolvedScheme() === 'dark';
  document.querySelectorAll('#accent .sw[data-a]').forEach((b) => {
    b.style.setProperty('--sw', ACCENTS[b.dataset.a][dark ? 2 : 1]);
    b.setAttribute('aria-pressed', String(b.dataset.a === accentPref));
  });
  $('accent').querySelector('.sw-default').setAttribute('aria-pressed', String(accentPref === 'default'));
  const custom = HEX.test(accentPref);
  const label = $('accent-custom-btn');
  label.classList.toggle('on', custom);
  if (custom) label.style.setProperty('--sw', accentPref); else label.style.removeProperty('--sw');
  $('accent-hint').textContent = accentPref === 'default' ? 'Цвет задаёт выбранный стиль.' : ACCENTS[accentPref] ? ACCENTS[accentPref][0] : `Свой цвет ${accentPref.toLowerCase()}`;
}

function applyAppearance() {
  const scheme = resolvedScheme(), root = document.documentElement, locked = style === 'terminal';
  root.setAttribute('data-style', style);
  root.setAttribute('data-scheme', scheme);
  // The previews show each style the way it looks right now (terminal is always dark).
  document.querySelectorAll('.tprev').forEach((p) => p.setAttribute('data-scheme', p.dataset.style === 'terminal' ? 'dark' : userScheme()));
  document.querySelectorAll('.tcard').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === style)));
  document.querySelectorAll('#scheme button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.p === schemePref)); b.disabled = locked; });
  $('scheme-hint').textContent = locked ? 'В стиле «Терминал» тема не меняется: он всегда тёмный.'
    : schemePref === 'system' ? `Сейчас по системе: ${systemIsDark() ? 'тёмная' : 'светлая'}.` : '';
  applyAccent();
}

document.querySelectorAll('.tcard').forEach((b) => { b.onclick = () => { style = b.dataset.s; pref.set('style', style); applyAppearance(); }; });
document.querySelectorAll('#scheme button').forEach((b) => { b.onclick = () => { schemePref = b.dataset.p; pref.set('scheme', schemePref); applyAppearance(); }; });
document.querySelectorAll('#accent [data-a]').forEach((b) => { b.onclick = () => { accentPref = b.dataset.a; pref.set('accent', accentPref); applyAppearance(); }; });
// ---------- custom colour picker, drawn by the app: the native GTK dialog and its pipette are broken on Plasma 6 ----------
const cp = { hex: '#2563eb', h: 210, s: 0.8, v: 0.9, open: false, eyeChecked: false, target: 'accent', opener: null };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
}
const rgbToHex = (rgb) => '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
/** `#rgb`, `#rrggbb`, with or without `#`. `strict` accepts only six digits (used while typing). */
function parseHex(text, strict) {
  let t = String(text).trim().replace(/^#/, '');
  if (!strict && /^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(t) ? [0, 2, 4].map((i) => parseInt(t.slice(i, i + 2), 16)) : null;
}

function cpRender(skipHexField) {
  $('cp-plane').style.setProperty('--hue', cp.h);
  const knob = $('cp-knob').style;
  knob.left = `${cp.s * 100}%`; knob.top = `${(1 - cp.v) * 100}%`;
  $('cp-plane').setAttribute('aria-valuetext', `насыщенность ${Math.round(cp.s * 100)}%, яркость ${Math.round(cp.v * 100)}%`);
  $('cp-hue').value = String(Math.round(cp.h));
  $('cp-preview').style.background = cp.hex;
  if (!skipHexField) $('cp-hex').value = cp.hex;
}
/** The hex string is the truth: picking, pasting or typing a colour never goes through HSV, so it cannot drift. */
function cpSetHex(hex, apply, skipHexField) {
  cp.hex = hex.toLowerCase();
  const [h, s, v] = rgbToHsv(...parseHex(cp.hex));
  if (s > 0 && v > 0) cp.h = h; // keep the hue on greys
  cp.s = s; cp.v = v;
  cpRender(skipHexField);
  if (apply) cpApply();
}
/** Dragging works in HSV, and only then is a hex computed from it. */
function cpSetHsv() {
  cp.hex = rgbToHex(hsvToRgb(cp.h, cp.s, cp.v));
  cpRender(false);
  cpApply();
}
/** The picker serves the accent colour and the background colours; `cp.target` says which one the colour goes to. */
function cpApply() {
  if (cp.target === 'accent') { accentPref = cp.hex; pref.set('accent', accentPref); applyAppearance(); return; }
  if (cp.target === 'solid') { bgPref.mode = 'solid'; bgPref.color = cp.hex; }
  else { bgPref.mode = 'gradient'; bgPref[cp.target === 'a' ? 'a' : 'b'] = cp.hex; }
  saveBackground(); applyBackground();
}
function cpStartColor() {
  if (cp.target === 'accent') return HEX.test(accentPref) ? accentPref : getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return cp.target === 'solid' ? bgPref.color : bgPref[cp.target];
}
function cpMessage(text) { $('cp-msg').textContent = text; }

async function cpOpen(open, target, opener, host) {
  if (cp.opener) cp.opener.setAttribute('aria-expanded', 'false');
  cp.open = open;
  $('cpicker').hidden = !open;
  if (!open) { cp.opener = null; return; }
  cp.target = target; cp.opener = opener;
  opener.setAttribute('aria-expanded', 'true');
  host.after($('cpicker')); // one picker, shown under the block that opened it
  // Start from the colour being edited, or from what is on screen now; opening changes nothing by itself.
  let start = cpStartColor();
  if (!parseHex(start, true)) start = '#2563eb';
  cpSetHex(start, false);
  cpMessage('');
  if (!cp.eyeChecked) {
    cp.eyeChecked = true;
    try { $('cp-eye').hidden = !(invoke && await invoke('eyedropper_available')); } catch (_) { $('cp-eye').hidden = true; }
  }
}

const plane = $('cp-plane');
function planeAt(e) {
  const r = plane.getBoundingClientRect();
  cp.s = clamp01((e.clientX - r.left) / r.width);
  cp.v = clamp01(1 - (e.clientY - r.top) / r.height);
  cpSetHsv();
}
plane.addEventListener('pointerdown', (e) => { try { plane.setPointerCapture(e.pointerId); } catch (_) { /* not an active pointer */ } planeAt(e); });
plane.addEventListener('pointermove', (e) => { if (plane.hasPointerCapture && plane.hasPointerCapture(e.pointerId)) planeAt(e); });
plane.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.1 : 0.01, k = e.key;
  if (k === 'ArrowLeft') cp.s = clamp01(cp.s - step); else if (k === 'ArrowRight') cp.s = clamp01(cp.s + step);
  else if (k === 'ArrowUp') cp.v = clamp01(cp.v + step); else if (k === 'ArrowDown') cp.v = clamp01(cp.v - step);
  else return;
  e.preventDefault(); cpSetHsv();
});
$('cp-hue').addEventListener('input', (e) => { cp.h = Number(e.target.value); cpSetHsv(); });
$('cp-hex').addEventListener('input', (e) => {
  const text = e.target.value.trim(), rgb = parseHex(text, true);
  // Complain only once six characters are in and they are still not a colour.
  const bad = !rgb && text.replace('#', '').length >= 6;
  e.target.setAttribute('aria-invalid', String(bad));
  cpMessage(bad ? 'Введите цвет как #rrggbb' : '');
  if (rgb) cpSetHex(rgbToHex(rgb), true, true); // live only for complete six-digit colours; the field is not rewritten while typing
});
function cpCommitHexField() {
  const f = $('cp-hex'), rgb = parseHex(f.value, false);
  if (rgb) cpSetHex(rgbToHex(rgb), true, false); else f.value = cp.hex; // junk: go back to the last good colour
  f.setAttribute('aria-invalid', 'false');
  cpMessage('');
}
$('cp-hex').addEventListener('blur', cpCommitHexField);
$('cp-hex').addEventListener('keydown', (e) => { if (e.key === 'Enter') { cpCommitHexField(); e.preventDefault(); } });

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
/** The system clipboard through the Tauri plugin; the web API is only a fallback and can hang, hence the timeouts. */
async function copyText(text) {
  try { await withTimeout(window.__TAURI__.clipboardManager.writeText(text), 2000); return true; } catch (_) { /* fall back */ }
  try { await withTimeout(navigator.clipboard.writeText(text), 1500); return true; } catch (_) { return false; }
}
$('cp-copy').onclick = async () => { cpMessage((await copyText(cp.hex)) ? `Скопировано: ${cp.hex}` : 'Не удалось скопировать'); };
$('cp-eye').onclick = async () => {
  cpMessage('Кликните по любому месту экрана. Esc: отмена.');
  try {
    const hex = await invoke('pick_color');
    if (hex) { cpSetHex(hex, true); cpMessage(`Взят цвет ${cp.hex}`); } else cpMessage('Отменено');
  } catch (e) { cpMessage(`Пипетка не сработала: ${e}`); }
};
$('cp-close').onclick = () => { const o = cp.opener; cpOpen(false); if (o) o.focus(); };
$('cpicker').addEventListener('keydown', (e) => { if (e.key === 'Escape') { const o = cp.opener; cpOpen(false); if (o) o.focus(); e.stopPropagation(); } });
$('accent-custom-btn').onclick = () => cpOpen(!(cp.open && cp.opener === $('accent-custom-btn')), 'accent', $('accent-custom-btn'), $('accent'));

// ---------- background: the style's own, one colour, or a two-colour gradient ----------
const BG_SOLIDS = ['#F8FAFC', '#E2E8F0', '#FDE68A', '#FBCFE8', '#BAE6FD', '#BBF7D0', '#1E293B', '#0F172A', '#312E81', '#4C1D95', '#14532D', '#000000'];
const BG_GRADS = [ // [name, from, to, angle]
  ['Закат', '#FF9966', '#FF5E62', 160], ['Океан', '#2193B0', '#6DD5ED', 160], ['Лес', '#134E5E', '#71B280', 160], ['Ночь', '#0F2027', '#2C5364', 160],
  ['Сирень', '#C471F5', '#FA71CD', 135], ['Мята', '#D4FC79', '#96E6A1', 135], ['Туман', '#E0EAFC', '#CFDEF3', 180], ['Космос', '#1B1F3B', '#4B3C62', 160],
];
const BG_DEFAULT = { mode: 'default', color: '#E2E8F0', a: '#FF9966', b: '#FF5E62', angle: 160, kind: 'image', name: '', dim: 35, blur: 0 };
/** Background settings from storage or from an imported file: anything unexpected falls back to the default. */
function cleanBg(saved) {
  const b = { ...BG_DEFAULT };
  if (!saved || typeof saved !== 'object') return b;
  if (['default', 'solid', 'gradient', 'media'].includes(saved.mode)) b.mode = saved.mode;
  for (const k of ['color', 'a', 'b']) if (typeof saved[k] === 'string' && HEX.test(saved[k])) b[k] = saved[k];
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  b.angle = num(saved.angle, 0, 360, b.angle); b.dim = num(saved.dim, 0, 80, b.dim); b.blur = num(saved.blur, 0, 20, b.blur);
  if (saved.kind === 'video') b.kind = 'video';
  if (typeof saved.name === 'string') b.name = saved.name.slice(0, 120);
  return b;
}
let bgPref = { ...BG_DEFAULT };
try { bgPref = cleanBg(JSON.parse(pref.get('bg', '{}'))); } catch (_) { /* junk in storage: defaults */ }
const saveBackground = () => pref.set('bg', JSON.stringify(bgPref));
const gradCss = (a, b, angle) => `linear-gradient(${angle}deg, ${a}, ${b})`;

/** The stored file (path from the app), shown in the fixed layer; null while none is chosen. */
let bgFile = null;
let bgShown = null; // what the layer currently holds, to avoid reloading a video on every slider move
function showMedia(on) {
  const layer = $('bglayer');
  if (!on || !bgFile) { layer.classList.remove('on'); layer.textContent = ''; bgShown = null; return; }
  const root = document.documentElement.style;
  root.setProperty('--bgdim', String(bgPref.dim / 100));
  root.setProperty('--bgblur', `${bgPref.blur}px`);
  root.setProperty('--bgscale', String(1 + 0.008 * bgPref.blur)); // hides the soft edges blur leaves; grows with the blur, so the first step does not jump
  layer.classList.add('on');
  if (bgShown === bgFile) return;
  bgShown = bgFile;
  layer.textContent = '';
  const src = bgFile; // a http://127.0.0.1 URL from the app (a blob URL in the dev mock)
  const el = document.createElement(bgPref.kind === 'video' ? 'video' : 'img');
  el.className = 'bgm';
  if (bgPref.kind === 'video') { el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; el.preload = 'auto'; }
  el.onerror = () => {
    const code = el.error ? el.error.code : 0; // MediaError: 1 aborted, 2 network, 3 decode, 4 source not supported
    console.warn('background failed', code, el.error && el.error.message);
    bgNote = `Не удалось показать файл (код ошибки ${code || '?'}). ${code === 4 ? 'Формат или кодек не поддерживается системой, либо файл недоступен.' : code === 3 ? 'Файл повреждён или не декодируется.' : ''} Для видео попробуйте WebM (VP8/VP9).`;
    bgFile = null; bgShown = null; layer.classList.remove('on'); layer.textContent = ''; applyBackground();
  };
  el.src = src;
  layer.appendChild(el);
  if (bgPref.kind === 'video') { // some web views never report an error for a video they cannot open: give up after a few seconds and say why
    const file = bgFile;
    setTimeout(() => {
      if (bgFile !== file || el.readyState >= 2) return;
      console.warn('background video never started', el.readyState, el.networkState, el.canPlayType('video/mp4'), el.canPlayType('video/webm'));
      bgNote = `Видео не запустилось за 5 с: readyState ${el.readyState}, networkState ${el.networkState} (3 = источник не найден), MP4: «${el.canPlayType('video/mp4') || 'нет'}», WebM: «${el.canPlayType('video/webm') || 'нет'}».`;
      bgFile = null; bgShown = null; layer.classList.remove('on'); layer.textContent = ''; applyBackground();
    }, 5000);
  }
}
document.addEventListener('visibilitychange', () => { // no point in decoding video nobody sees
  const v = $('bglayer').querySelector('video');
  if (v) { if (document.hidden) v.pause(); else v.play().catch(() => {}); }
});
let bgNote = ''; // the last problem; it stays in the hint until the user does something else
function bgMessage(text) { bgNote = text; $('bg-hint').textContent = text; }

function applyBackground() {
  const root = document.documentElement.style, m = bgPref.mode;
  showMedia(m === 'media');
  if (m === 'solid') { root.setProperty('--ubg', bgPref.color); root.setProperty('--ubgi', 'none'); }
  else if (m === 'gradient') { root.setProperty('--ubg', bgPref.b); root.setProperty('--ubgi', gradCss(bgPref.a, bgPref.b, bgPref.angle)); }
  else { root.removeProperty('--ubg'); root.removeProperty('--ubgi'); }
  document.querySelectorAll('#bgmode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
  $('bg-solid').hidden = m !== 'solid';
  $('bg-grad').hidden = m !== 'gradient';
  $('bg-media').hidden = m !== 'media';
  $('bg-dim').value = String(bgPref.dim); $('bg-blur').value = String(bgPref.blur);
  $('bg-name').textContent = bgFile ? bgPref.name : '';
  $('bg-remove').hidden = !bgFile;
  document.querySelectorAll('#bg-solid .sw[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c.toLowerCase() === bgPref.color.toLowerCase())));
  document.querySelectorAll('#bg-presets .sw').forEach((b) => {
    const g = BG_GRADS[Number(b.dataset.i)];
    b.setAttribute('aria-pressed', String(g[1].toLowerCase() === bgPref.a.toLowerCase() && g[2].toLowerCase() === bgPref.b.toLowerCase() && g[3] === bgPref.angle));
  });
  $('bg-a').style.setProperty('--sw', bgPref.a); $('bg-b').style.setProperty('--sw', bgPref.b);
  $('bg-bar').style.setProperty('--swg', gradCss(bgPref.a, bgPref.b, bgPref.angle));
  $('bg-angle').value = String(bgPref.angle);
  $('bg-hint').textContent = bgNote ? bgNote : m === 'default' ? 'Фон задаёт выбранный стиль.' : m === 'solid' ? `Сплошной ${bgPref.color.toUpperCase()}` : m === 'media' ? (bgFile ? `${bgPref.kind === 'video' ? 'Видео' : 'Картинка'}: затемнение ${bgPref.dim}%, размытие ${bgPref.blur} px` : 'Файл не выбран.') : `Градиент ${bgPref.a.toUpperCase()} → ${bgPref.b.toUpperCase()}, ${bgPref.angle}°`;
}
(function buildBackgroundControls() {
  $('bg-solid').innerHTML = BG_SOLIDS.map((c) => `<button class="sw" data-c="${c}" style="--sw:${c}" aria-pressed="false" aria-label="Цвет ${c}" title="${c}"></button>`).join('')
    + '<button class="sw sw-custom" id="bg-solid-custom" aria-label="Свой цвет фона" title="Свой цвет" aria-expanded="false"></button>';
  $('bg-presets').innerHTML = BG_GRADS.map((g, i) => `<button class="sw grad" data-i="${i}" style="--swg:${gradCss(g[1], g[2], g[3])}" aria-pressed="false" aria-label="Градиент «${g[0]}»" title="${g[0]}"></button>`).join('');
})();
document.querySelectorAll('#bgmode button').forEach((b) => { b.onclick = () => { bgNote = ''; if (b.dataset.m !== bgPref.mode) cpOpen(false); bgPref.mode = b.dataset.m; saveBackground(); applyBackground(); }; });
$('bg-solid').addEventListener('click', (e) => {
  const b = e.target.closest('.sw[data-c]');
  if (b) { bgPref.mode = 'solid'; bgPref.color = b.dataset.c; saveBackground(); applyBackground(); }
});
$('bg-solid-custom').onclick = (e) => cpOpen(!(cp.open && cp.opener === e.currentTarget), 'solid', e.currentTarget, $('bg-picker-host'));
$('bg-presets').addEventListener('click', (e) => {
  const b = e.target.closest('.sw[data-i]');
  if (!b) return;
  const g = BG_GRADS[Number(b.dataset.i)];
  Object.assign(bgPref, { mode: 'gradient', a: g[1], b: g[2], angle: g[3] });
  saveBackground(); applyBackground();
});
$('bg-a').onclick = (e) => cpOpen(!(cp.open && cp.opener === e.currentTarget), 'a', e.currentTarget, $('bg-picker-host'));
$('bg-b').onclick = (e) => cpOpen(!(cp.open && cp.opener === e.currentTarget), 'b', e.currentTarget, $('bg-picker-host'));
// ---------- export / import of the whole look as one .cfg (a zip made by the app) ----------
const configObject = () => ({ format: 'openschool-config', version: 1, style, scheme: schemePref, accent: accentPref, bg: bgPref });
/** Take over an imported configuration; every field is checked, nothing is trusted. `url` is the imported background, if any. */
function applyConfig(c, url) {
  if (!c || typeof c !== 'object' || c.format !== 'openschool-config') throw new Error('это не файл настроек OpenSchool');
  if (STYLES.includes(c.style)) style = c.style;
  if (SCHEMES.includes(c.scheme)) schemePref = c.scheme;
  if (typeof c.accent === 'string' && (c.accent === 'default' || ACCENTS[c.accent] || HEX.test(c.accent))) accentPref = c.accent;
  bgPref = cleanBg(c.bg);
  if (url) { bgFile = url; bgShown = null; }
  if (bgPref.mode === 'media' && !bgFile) bgPref.mode = 'default'; // the archive had no file and none is stored
  if (bgPref.kind === 'image' && url && /\.(mp4|webm)$/i.test(url)) bgPref.kind = 'video'; // trust the real file, not the claim
  if (bgPref.kind === 'video' && url && !/\.(mp4|webm)$/i.test(url)) bgPref.kind = 'image';
  pref.set('style', style); pref.set('scheme', schemePref); pref.set('accent', accentPref); saveBackground();
  cpOpen(false);
  bgShown = null;
  applyAppearance(); applyBackground();
}
$('cfg-export').onclick = async () => {
  $('cfg-msg').textContent = 'Выберите, куда сохранить…';
  try {
    const path = await invoke('export_config', { config: JSON.stringify(configObject(), null, 2) });
    $('cfg-msg').textContent = path ? `Сохранено: ${path}` : 'Отменено.';
  } catch (e) { $('cfg-msg').textContent = `Не удалось сохранить: ${e}`; }
};
$('cfg-import').onclick = async () => {
  $('cfg-msg').textContent = 'Выберите файл…';
  try {
    const got = await invoke('import_config');
    if (!got) { $('cfg-msg').textContent = 'Отменено.'; return; }
    applyConfig(JSON.parse(got.config), got.background);
    $('cfg-msg').textContent = 'Настройки импортированы.';
  } catch (e) { $('cfg-msg').textContent = `Не удалось импортировать: ${e instanceof Error ? e.message : e}`; }
};

const VIDEO_EXT = ['mp4', 'webm'];
$('bg-pick').onclick = () => $('bg-file').click();
$('bg-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  bgNote = '';
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (f.size > 300 * 1024 * 1024) { bgMessage('Файл больше 300 МБ.'); return; }
  bgMessage('Копирую файл…');
  try {
    const path = await invoke('set_background', new Uint8Array(await f.arrayBuffer()), { headers: { ext } });
    bgFile = path; bgShown = null;
    Object.assign(bgPref, { mode: 'media', kind: VIDEO_EXT.includes(ext) ? 'video' : 'image', name: f.name.slice(0, 120) });
    saveBackground(); applyBackground();
  } catch (err) { bgMessage(`Не удалось: ${err}`); }
});
$('bg-remove').onclick = async () => {
  bgNote = '';
  try { await invoke('clear_background'); } catch (_) { /* nothing stored */ }
  bgFile = null; bgShown = null; bgPref.mode = 'default'; bgPref.name = ''; saveBackground(); applyBackground();
};
$('bg-dim').addEventListener('input', (e) => { bgPref.dim = Number(e.target.value); saveBackground(); applyBackground(); });
$('bg-blur').addEventListener('input', (e) => { bgPref.blur = Number(e.target.value); saveBackground(); applyBackground(); });
$('bg-angle').addEventListener('input', (e) => { bgPref.mode = 'gradient'; bgPref.angle = Number(e.target.value); saveBackground(); applyBackground(); });
applyBackground();
(async () => { // the stored file is looked up once at start; if it is gone, the media mode falls back to the style's background
  try { bgFile = invoke ? await invoke('background_path') : null; } catch (_) { bgFile = null; }
  if (!bgFile && bgPref.mode === 'media') { bgPref.mode = 'default'; saveBackground(); }
  applyBackground();
})();
if (mq) {
  const onChange = (e) => { webDark = e.matches; applyAppearance(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange); else mq.addListener(onChange);
}
try {
  const win = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow();
  if (win) {
    win.theme().then((t) => { nativeTheme = t || null; applyAppearance(); }).catch(() => {});
    win.onThemeChanged((e) => { nativeTheme = e.payload || null; applyAppearance(); }).catch(() => {});
  }
} catch (_) { /* no window API: the web view's own preference is used */ }
applyAppearance();

boot();
