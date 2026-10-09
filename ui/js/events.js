'use strict';
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
