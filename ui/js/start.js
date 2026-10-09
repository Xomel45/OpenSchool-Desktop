'use strict';
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

function show(which, fade) {
  $('boot').hidden = which !== 'boot';
  $('login').hidden = which !== 'login';
  $('app').hidden = which !== 'app';
  if (which === 'app') {
    movePill(true);
    const app = $('app');
    app.classList.remove('fadein');
    if (fade) { void app.offsetWidth; app.classList.add('fadein'); }
  }
}

async function start() {
  S.student = await invoke('student');
  S.today = new Date(); S.today.setHours(0, 0, 0, 0);
  S.cls = await invoke('class_info', { studentId: S.student.id, year: academicYear(S.today) }).catch(() => null);
  const q = S.cls && S.cls.quarters.length ? S.cls.quarters : null;
  S.min = q ? parseDate(q[0].start_date) : new Date(academicYear(S.today), 8, 1);
  S.max = addDays(S.today, 21); // how far ahead the server publishes lessons is unknown
  initNews();
  renderStudent();
  await setDay(S.today); // the boot screen stays until today's lessons are ready, so the page does not jump
  show('app', true);
  // Fill the "recent marks" strip from the previous weeks too (a week holds only a few marks).
  await Promise.all([1, 2, 3, 4, 5].map((i) => loadWeek(addDays(S.today, -7 * i)).catch(() => null)));
  renderMarks();
  $('marks').classList.remove('arrive'); void $('marks').offsetWidth; $('marks').classList.add('arrive');
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

const BOOT_HTML = '<span class="spin" aria-hidden="true"></span><span>Загрузка…</span>';
async function boot() {
  if (!invoke) { $('boot-msg').textContent = 'Запустите приложение через Tauri: это окно открыто вне его.'; return; }
  try {
    if (await invoke('restore_session')) await start(); else showLogin();
  } catch (e) {
    renderLoadError($('boot-msg'), e, () => { $('boot-msg').innerHTML = BOOT_HTML; boot(); });
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
