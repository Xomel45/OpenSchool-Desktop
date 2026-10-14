'use strict';
// ---------- «В календарь»: the week on the screen and all the following published weeks as an .ics file (src-tauri/src/ics.rs) ----------

/** The events of the weeks from `monday` up to the last published day; lessons only (no weekends without lessons). */
function icsEvents(monday) {
  const out = [];
  for (let d = new Date(monday); d <= S.max; d = addDays(d, 1)) {
    for (const r of buildDay(d).rows) {
      const l = r.l, test = lessonTest(r);
      const lines = [];
      if (test) lines.push(test);
      if (l.theme) lines.push(`Тема: ${l.theme}`);
      for (const h of r.hw) lines.push(`Д/з: ${h.description || 'без текста'}`);
      for (const n of notesOf(l.id)) if (!n.done) lines.push(`Заметка: ${n.t}`);
      const t = teacherName(l.teacher);
      if (t) lines.push(`Ведёт: ${t}`);
      out.push({ uid: `${l.id}`, start: l.start, end: l.end, summary: test ? `${l.subject_name} · ${test}` : l.subject_name, location: l.room ? `Каб. ${l.room}` : '', description: lines.join('\n') });
    }
  }
  return out;
}

$('wics').onclick = async () => {
  if (!invoke) { attNote('Экспорт работает только в приложении.'); return; }
  const btn = $('wics');
  btn.disabled = true;
  try {
    const weeks = [];
    for (let m = new Date(S.week); m <= S.max; m = addDays(m, 7)) weeks.push(m);
    await Promise.all(weeks.map((m) => loadWeek(m)));
    const events = icsEvents(S.week);
    if (!events.length) { attNote('В этих неделях нет уроков: экспортировать нечего.'); return; }
    const a = S.week, b = addDays(weeks[weeks.length - 1], 6);
    const path = await invoke('export_ics', { events, name: `uroki_${isoDate(a)}_${isoDate(b < S.max ? b : S.max)}.ics` });
    if (path) attNote(`Сохранено уроков: ${events.length}. Файл: ${path}. Откройте его календарём (Google Календарь: «Импорт»). Повторный импорт обновит те же уроки.`, 12000);
  } catch (e) { attNote(`Не удалось: ${e && e.message ? e.message : e}`); }
  finally { btn.disabled = false; }
};
