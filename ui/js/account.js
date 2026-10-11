'use strict';
// ---------- account page: who is signed in, which student, the session, what is kept on this computer ----------
function renderAccount() {
  const s = devStudent(), c = devClass();
  if (!s) return;
  devAvatar($('acc-ava'), ((s.first_name || '')[0] || '') + ((s.last_name || '')[0] || ''));
  $('acc-name').textContent = [s.last_name, s.first_name, s.middle_name].filter(Boolean).map(titleCase).join(' ');
  $('acc-class').textContent = c ? `${c.class_number} «${c.class_letter}»${c.school_name ? ' · ' + c.school_name : ''}` : '';
  const t = isoDate(S.today), qs = c ? c.quarters : [];
  const cur = qs.find((q) => q.start_date <= t && t <= q.end_date), next = qs.find((q) => q.start_date > t);
  const short = (d) => { const x = parseDate(d); return `${x.getDate()} ${MON_SHORT[x.getMonth()]}`; };
  const rows = [
    ['Учебный год', c ? `${c.academic_year}/${c.academic_year + 1}` : '—'],
    ['Сейчас', cur ? `${cur.number} четверть: ${short(cur.start_date)} – ${short(cur.end_date)}` : next ? `Ближайшая: ${next.number} четверть с ${parseDate(next.start_date).getDate()} ${MON[parseDate(next.start_date).getMonth()]}` : '—'],
  ];
  if (s.region) rows.push(['Код региона', s.region]);
  rows.push(['Вход', 'через Госуслуги']);
  $('acc-facts').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  if (!invoke) return;
  invoke('students').then((all) => {
    $('acc-pickbox').hidden = all.length < 2;
    $('acc-pick').innerHTML = all.map((x) => `<button data-id="${esc(x.id)}" aria-pressed="${x.id === s.id}">${esc(titleCase(x.first_name))}</button>`).join('');
  }).catch(() => { $('acc-pickbox').hidden = true; });
}

$('acc-pick').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b || b.getAttribute('aria-pressed') === 'true') return;
  try {
    await invoke('select_student', { id: b.dataset.id });
    // Everything shown belongs to the old student: forget it and start again from the home page.
    S.rawWeeks.clear(); S.weekReqs.clear(); S.lessonsById.clear(); S.byDate.clear(); S.marks.clear(); S.hw.clear(); S.gp = null; S.week = null;
    show('boot'); await start(); view('settings'); settingsSection('account');
  } catch (err) { $('acc-msg').textContent = `Не удалось переключить: ${err}`; }
});

$('acc-check').onclick = async () => {
  $('acc-check').disabled = true; $('acc-msg').textContent = 'Проверяю…';
  try {
    $('acc-msg').textContent = (await invoke('session_status')) ? 'Сессия действует.' : 'Сессия не принимается сервером. Выйдите и войдите снова.';
  } catch (e) { if (e !== 'SESSION_EXPIRED') $('acc-msg').textContent = e === 'OFFLINE' ? 'Нет связи с Госуслугами.' : `Не удалось проверить: ${e}`; }
  $('acc-check').disabled = false;
};

$('acc-resetdone').onclick = () => {
  for (const k of Object.keys(done)) delete done[k];
  try { localStorage.removeItem('openschool.hwdone'); } catch (_) { /* storage may be unavailable */ }
  $('acc-datamsg').textContent = 'Отметки «сделано» сброшены.';
};
$('acc-clearfeed').onclick = async () => {
  try { await invoke('news_clear'); S.feed = []; renderBell(0); $('acc-datamsg').textContent = 'Лента очищена.'; } catch (e) { $('acc-datamsg').textContent = `Не удалось очистить: ${e}`; }
};
