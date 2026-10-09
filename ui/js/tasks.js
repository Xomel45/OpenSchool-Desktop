'use strict';
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
