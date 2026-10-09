'use strict';
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
