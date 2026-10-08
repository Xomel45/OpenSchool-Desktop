// ---- fake backend: same JSON shapes as the Rust commands (snake_case fields) ----
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const mondayOf = (year, week) => { const j4 = new Date(year, 0, 4); const m = new Date(j4); m.setDate(j4.getDate() - ((j4.getDay() || 7) - 1) + (week - 1) * 7); return m; };
  const PLAN = { 1: ['Алгебра', 'Английский язык', 'География', 'Биология', 'История', 'Литература'], 2: ['Русский язык', 'Геометрия', 'Физика', 'Информатика', 'Английский язык'], 3: ['Алгебра', 'Труд', 'История', 'Вер. статистика', 'Русский язык', 'География'], 4: ['Литература', 'Физика', 'История', 'Алгебра', 'Химия'], 5: ['Русский язык', 'Алгебра', 'География', 'Физкультура', 'Вер. статистика'] };
  const BELLS = [['08:30', '09:10'], ['09:25', '10:05'], ['10:20', '11:00'], ['11:15', '11:55'], ['12:10', '12:50'], ['13:05', '13:45']];
  const MARKS = ['5', '4', '4', '3', '2', '5'];
  const hash = (s) => { let x = 7; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
  const subjId = (s) => 'S' + (hash(s) % 1000);
  const weeks = {};
  function week(year, isoWeek) {
    const lessons = [], homeworks = [], marks = [];
    const mon = mondayOf(year, isoWeek);
    if (mon > new Date(Date.now() + 14 * 864e5)) return { year, iso_week: isoWeek, lessons, homeworks, marks };
    for (let wd = 1; wd <= 5; wd++) {
      const d = new Date(mon); d.setDate(mon.getDate() + wd - 1); const k = iso(d);
      (PLAN[wd] || []).forEach((sub, i) => {
        const id = `L-${k}-${i}`, past = d < new Date(new Date().setHours(0, 0, 0, 0)), h = hash(id);
        lessons.push({ id, subject_id: subjId(sub), subject_name: sub, teacher: { first_name: 'ИВАН', last_name: 'ПЕТРОВ', patronymic: 'СЕРГЕЕВИЧ' },
          start: `${k} ${BELLS[i][0]}:00`, end: `${k} ${BELLS[i][1]}:00`, room: h % 3 ? String(100 + h % 200) : '', theme: h % 2 ? 'Тема урока: ' + sub : null,
          absence: h % 29 === 0 ? { code: 'notallowded', description: 'Без уважительной причины' } : null });
        if (h % 10 < 7) homeworks.push({ id: 'H-' + id, subject_id: subjId(sub), subject_name: sub, description: ['§5, ответить на вопросы', 'Упражнения 12–15', '№40, №42, №45'][h % 3], issue_date: k, due_date: k, due_lesson_id: id, materials: h % 7 === 0 ? [{ name: 'файл.docx', link: 'https://example.test/f' }] : [] });
        if (past && h % 10 < 4 && sub !== 'Физкультура') marks.push({ id: 'M-' + id, subject_id: subjId(sub), subject_name: sub, value: h % 13 === 0 ? 'н' : MARKS[h % 6], value2: h % 17 === 0 ? '3' : null, date: k, work_type_code: 'Ordinary', work_type: h % 5 === 0 ? 'Контрольная работа' : 'Обычная отметка', work_name: null, comment: null, lesson_id: id });
      });
    }
    return { year, iso_week: isoWeek, lessons, homeworks, marks };
  }
  const y = (new Date().getMonth() >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1);
  const mode = (location.hash.match(/mode=(\w+)/) || [])[1] || 'ok';
  // notifications: the Rust side is replaced by a feed kept in memory; `#news=1` starts with three items (two unread), `#toast=1` fires a "new" event after 3 s
  const listeners = {};
  const nowS = Math.floor(Date.now() / 1000);
  let feed = /news=1/.test(location.hash) ? [
    { id: 'm:1', kind: 'mark', title: 'Алгебра', text: 'Контрольная работа · 8 октября', value: '5', date: '2026-10-08', ts: nowS - 600, read: false },
    { id: 'h:2', kind: 'homework', title: 'Литература', text: 'Прочитать главу 5, пересказ · на 9 октября', value: null, date: '2026-10-09', ts: nowS - 3 * 3600, read: false },
    { id: 'm:3', kind: 'mark', title: 'История', text: 'Устный ответ · 7 октября', value: '3', date: '2026-10-07', ts: nowS - 30 * 3600, read: true }] : [];
  let notify = { marks: true, homework: true, absences: false, interval_min: 15, detail: true, close_to_tray: false };
  window.__fakeEmit = (name, payload) => (listeners[name] || []).forEach((cb) => cb({ payload }));
  if (/toast=1/.test(location.hash)) setTimeout(() => window.__fakeEmit('news-new', { title: 'Новая оценка: Физика — 4', body: 'Обычная отметка · 8 октября', kinds: ['mark'], value: '4' }), 3000);
  let fakeBg = null; // the "stored" background: a blob URL, shown through the fake convertFileSrc
  window.__TAURI__ = { event: { listen: async (name, cb) => { (listeners[name] = listeners[name] || []).push(cb); return () => {}; } }, core: { convertFileSrc: (p) => p, invoke: async (cmd, a, opts) => {
    if (cmd === 'set_background') { const ext = opts && opts.headers && opts.headers.ext; if (!/^(png|jpe?g|webp|gif|avif|mp4|webm)$/.test(ext)) throw 'Этот формат не поддерживается'; fakeBg = URL.createObjectURL(new Blob([a])); return fakeBg; }
    if (cmd === 'background_path') return /bg=none/.test(location.hash) ? null : fakeBg;
    if (cmd === 'clear_background') { fakeBg = null; return null; }
    if (cmd === 'news_feed') return { items: feed, unread: feed.filter((i) => !i.read).length };
    if (cmd === 'news_read') { feed.forEach((i) => { if (!a.ids.length || a.ids.includes(i.id)) i.read = true; }); const u = feed.filter((i) => !i.read).length; window.__fakeEmit('news-updated', { unread: u }); return u; }
    if (cmd === 'notify_get') return notify;
    if (cmd === 'notify_set') { window.__notifySaved = a.settings; notify = a.settings; return notify; }
    if (cmd === 'news_check_now') return /checkfail=1/.test(location.hash) ? Promise.reject('нет сети') : 2;
    if (cmd === 'export_config') { window.__exported = a.config; return '/tmp/openschool.cfg'; }
    if (cmd === 'import_config') { const m = (location.hash.match(/imp=(\w+)/) || [])[1]; if (m === 'cancel') return null; if (m === 'bad') return { config: '{"format":"nope"}', background: null };
      return { config: JSON.stringify({ format: 'openschool-config', version: 1, style: 'sunrise', scheme: 'dark', accent: '#aa3355', bg: { mode: 'gradient', a: '#2193B0', b: '#6DD5ED', angle: 90, dim: 999, blur: -4 } }), background: null }; }
    await new Promise((r) => setTimeout(r, /slow=1/.test(location.hash) ? 400 : 30)); // `#slow=1` makes the fake server slow
    if (cmd === 'restore_session') return mode !== 'login';
    if (cmd === 'login') return true;
    if (cmd === 'logout') return null;
    if (cmd === 'eyedropper_available') return (location.hash.match(/eye=(\w+)/) || [])[1] !== 'none';
    if (cmd === 'pick_color') { const m = (location.hash.match(/pick=(\w+)/) || [])[1]; if (m === 'cancel') return null; if (m === 'err') throw 'KWin не отвечает'; return '#3366CC'; }
    if (cmd === 'student') return { id: 'demo', first_name: 'ИВАН', last_name: 'ИВАНОВ', middle_name: 'ИВАНОВИЧ', region: '41' };
    if (cmd === 'class_info') return { school_name: 'Школа №1', class_number: '8', class_letter: 'Б', academic_year: y, quarters: [
      { number: 1, start_date: `${y}-09-01`, end_date: `${y}-10-27` }, { number: 2, start_date: `${y}-11-03`, end_date: `${y}-12-29` }, { number: 3, start_date: `${y + 1}-01-11`, end_date: `${y + 1}-03-18` }, { number: 4, start_date: `${y + 1}-03-25`, end_date: `${y + 1}-05-30` }] };
    if (cmd === 'week') { window.__calls = (window.__calls || 0) + 1; if (mode === 'fail') throw 'сеть недоступна'; return week(a.year, a.isoWeek); }
    throw 'unknown command ' + cmd;
  } },
  // Clipboard plugin: remembers the last text; `#clip=fail` makes it reject.
  clipboardManager: { writeText: async (t) => { if (/clip=fail/.test(location.hash)) throw 'denied'; window.__clip = t; } },
  // Window API: the OS theme reported by Tauri. Hash `#sys=dark|light|none` picks the answer;
  // `window.__fireTheme('dark')` simulates the user changing the OS theme.
  window: { getCurrentWindow: () => ({
    theme: async () => { const m = (location.hash.match(/sys=(\w+)/) || [])[1]; return m === 'dark' || m === 'light' ? m : null; },
    onThemeChanged: async (cb) => { window.__fireTheme = (t) => cb({ payload: t }); return () => {}; },
  }) } };
})();
