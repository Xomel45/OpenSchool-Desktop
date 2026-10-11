'use strict';
// ---------- developer mode (started with --dev or --develop) ----------
// A layer of changes on top of what the server says. It only changes what this window shows: nothing is sent anywhere, the real
// data is not touched, and without the flag the changes are ignored. Marks are never changed (only the subject name is replaced).
const DEV = { on: false, o: devLoad() };
function devEmptyOverlay() { return { profile: {}, subjects: {}, teachers: {}, lessons: {}, homework: {}, addedLessons: [], addedHomework: [], photo: '' }; }
function devLoad() {
  try {
    const o = JSON.parse(localStorage.getItem('openschool.dev') || '{}');
    return { ...devEmptyOverlay(), ...(o && typeof o === 'object' ? o : {}) };
  } catch (_) { return devEmptyOverlay(); }
}
function devSave() { try { localStorage.setItem('openschool.dev', JSON.stringify(DEV.o)); } catch (_) { /* storage may be unavailable (a big photo) */ } }
const devIsEmpty = () => JSON.stringify(DEV.o) === JSON.stringify(devEmptyOverlay());

const teacherKey = (t) => `${t.last_name}|${t.first_name}|${t.patronymic}`;
/** "Last First Patronymic" -> the teacher record (the patronymic may be several words, or missing). */
function parseTeacher(text) {
  const p = String(text).trim().split(/\s+/).filter(Boolean);
  return { last_name: p[0] || '', first_name: p[1] || '', patronymic: p.slice(2).join(' ') };
}
const teacherText = (t) => [t.last_name, t.first_name, t.patronymic].filter((x) => x && x.trim()).join(' ');
const isoKeyOf = (dateStr) => { const { year, week } = isoWeek(parseDate(dateStr)); return `${year}-${week}`; };

function devStudent() {
  const s = S.student;
  if (!DEV.on || !s) return s;
  const p = DEV.o.profile;
  return { ...s, first_name: p.firstName ?? s.first_name, last_name: p.lastName ?? s.last_name, middle_name: p.middleName ?? s.middle_name, region: p.region ?? s.region };
}
function devClass() {
  const c = S.cls;
  if (!DEV.on || !c) return c;
  const p = DEV.o.profile;
  return { ...c, school_name: p.schoolName ?? c.school_name, class_number: p.classNumber ?? c.class_number, class_letter: p.classLetter ?? c.class_letter };
}
/** The avatar shows the developer photo when there is one, the initials otherwise. */
function devAvatar(el, initials) {
  if (DEV.on && DEV.o.photo) { el.textContent = ''; el.style.backgroundImage = `url(${DEV.o.photo})`; el.classList.add('photo'); }
  else { el.textContent = initials; el.style.backgroundImage = ''; el.classList.remove('photo'); }
}

/** One week as the page should show it: the server's week with the changes applied. */
function devApplyWeek(w) {
  if (!DEV.on || devIsEmpty()) return w;
  const o = DEV.o, key = `${w.year}-${w.iso_week}`, subj = (n) => o.subjects[n] || n;
  const lessons = w.lessons.filter((l) => !(o.lessons[l.id] && o.lessons[l.id].deleted)).map((l) => {
    const e = o.lessons[l.id] || {}, date = l.start.slice(0, 10), tn = e.teacher ?? o.teachers[teacherKey(l.teacher)];
    return {
      ...l, subject_name: e.subject ?? subj(l.subject_name), teacher: tn != null ? parseTeacher(tn) : l.teacher,
      start: e.start ? `${date} ${e.start}` : l.start, end: e.end ? `${date} ${e.end}` : l.end, room: e.room ?? l.room, theme: e.theme ?? l.theme,
    };
  }).concat(o.addedLessons.filter((a) => isoKeyOf(a.date) === key).map((a) => ({
    id: a.id, subject_id: `dev-s-${a.subject}`, subject_name: a.subject, teacher: parseTeacher(a.teacher), start: `${a.date} ${a.start}`, end: `${a.date} ${a.end}`,
    room: a.room, theme: a.theme || null, absence: null,
  })));
  const homeworks = w.homeworks.filter((h) => !(o.homework[h.id] && o.homework[h.id].deleted)).map((h) => ({
    ...h, subject_name: subj(h.subject_name), description: (o.homework[h.id] && o.homework[h.id].text) ?? h.description,
  })).concat(o.addedHomework.filter((a) => isoKeyOf(a.due) === key).map((a) => ({
    id: a.id, subject_id: `dev-s-${a.subject}`, subject_name: a.subject, description: a.text, issue_date: a.due, due_date: a.due, due_lesson_id: a.lessonId || null, materials: [],
  })));
  return { ...w, lessons, homeworks, marks: w.marks.map((m) => ({ ...m, subject_name: subj(m.subject_name) })) };
}

/** Save, rebuild what the pages read and redraw whatever is on screen. */
function devChanged() {
  devSave();
  rebuildMaps();
  renderStudent();
  redrawAll();
  renderAccount();
  devRenderBanner();
  if (!$('settings').hidden) devRenderPane();
}

function devRenderBanner() {
  const b = $('devbar');
  b.hidden = !DEV.on;
  b.textContent = devIsEmpty() ? 'Режим разработчика (--dev)' : 'Режим разработчика (--dev): часть данных изменена и показана только здесь';
}

// ---------- the settings page ----------
function devKnownSubjects() {
  const set = new Set();
  for (const w of S.rawWeeks.values()) { w.lessons.forEach((l) => set.add(l.subject_name)); w.marks.forEach((m) => set.add(m.subject_name)); w.homeworks.forEach((h) => set.add(h.subject_name)); }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
}
function devKnownTeachers() {
  const map = new Map();
  for (const w of S.rawWeeks.values()) w.lessons.forEach((l) => { if (l.teacher && l.teacher.last_name) map.set(teacherKey(l.teacher), l.teacher); });
  return [...map.values()].sort((a, b) => a.last_name.localeCompare(b.last_name, 'ru'));
}
const devField = (label, attrs, value) => `<label class="devf"><span>${esc(label)}</span><input ${attrs} value="${esc(value)}"></label>`;

function devRenderPane() {
  const real = { firstName: S.student.first_name, lastName: S.student.last_name, middleName: S.student.middle_name, region: S.student.region, schoolName: S.cls ? S.cls.school_name : '', classNumber: S.cls ? S.cls.class_number : '', classLetter: S.cls ? S.cls.class_letter : '' };
  const p = DEV.o.profile, labels = [['lastName', 'Фамилия'], ['firstName', 'Имя'], ['middleName', 'Отчество'], ['schoolName', 'Школа'], ['classNumber', 'Класс (номер)'], ['classLetter', 'Буква класса'], ['region', 'Код региона']];
  const subjects = devKnownSubjects(), teachers = devKnownTeachers(), o = DEV.o;
  $('dev-body').innerHTML = `
    <div class="block"><h3>Профиль</h3>${labels.map(([k, l]) => devField(l, `data-dprof="${k}"`, p[k] ?? real[k] ?? '')).join('')}
      <div class="bg-own"><label class="btn ghost" for="dev-photo">${o.photo ? 'Другое фото' : 'Выбрать фото'}</label><input type="file" id="dev-photo" accept="image/*" hidden>${o.photo ? '<button class="btn ghost" id="dev-photo-x">Убрать фото</button>' : ''}</div>
      <div class="hint muted" id="dev-photo-msg"></div></div>
    <div class="block"><h3>Предметы</h3>${subjects.length ? subjects.map((n) => devField(n, `data-dsubj="${esc(n)}"`, o.subjects[n] ?? n)).join('') : '<div class="hint muted">Пока ни один предмет не загружен: откройте расписание.</div>'}</div>
    <div class="block"><h3>Учителя</h3>${teachers.length ? teachers.map((t) => devField(teacherText(t), `data-dteach="${esc(teacherKey(t))}" data-orig="${esc(teacherText(t))}"`, o.teachers[teacherKey(t)] ?? teacherText(t))).join('') : '<div class="hint muted">Учителя ещё не загружены.</div>'}
      <div class="hint muted">Фамилия Имя Отчество, через пробел.</div></div>
    <div class="block"><h3>Уроки и задания</h3><div class="hint muted">Правятся прямо в расписании: откройте урок, там кнопки «Изменить урок» и «Добавить задание». Рядом с домашним заданием появляется карандаш, под днём кнопка «+ Урок».</div>
      <div>Изменено уроков: ${Object.keys(o.lessons).length}, добавлено: ${o.addedLessons.length}. Заданий изменено: ${Object.keys(o.homework).length}, добавлено: ${o.addedHomework.length}.</div></div>
    <div class="block"><button class="btn ghost danger" id="dev-reset">Сбросить все изменения</button></div>`;
}

// typing in the page: only what differs from the server's value is stored
$('dev-body').addEventListener('change', (e) => {
  const t = e.target, o = DEV.o;
  if (t.dataset.dprof) {
    const real = { firstName: S.student.first_name, lastName: S.student.last_name, middleName: S.student.middle_name, region: S.student.region, schoolName: S.cls ? S.cls.school_name : '', classNumber: S.cls ? S.cls.class_number : '', classLetter: S.cls ? S.cls.class_letter : '' };
    if (t.value === (real[t.dataset.dprof] ?? '')) delete o.profile[t.dataset.dprof]; else o.profile[t.dataset.dprof] = t.value;
  } else if (t.dataset.dsubj) {
    if (!t.value.trim() || t.value === t.dataset.dsubj) delete o.subjects[t.dataset.dsubj]; else o.subjects[t.dataset.dsubj] = t.value.trim();
  } else if (t.dataset.dteach) {
    if (!t.value.trim() || t.value === t.dataset.orig) delete o.teachers[t.dataset.dteach]; else o.teachers[t.dataset.dteach] = t.value.trim();
  } else if (t.id === 'dev-photo' && t.files[0]) {
    devSetPhoto(t.files[0]);
    return;
  } else return;
  devChanged();
});
$('dev-body').addEventListener('click', (e) => {
  if (e.target.id === 'dev-photo-x') { DEV.o.photo = ''; devChanged(); }
  if (e.target.id === 'dev-reset') {
    const b = e.target;
    if (b.dataset.armed) { DEV.o = devEmptyOverlay(); devChanged(); return; }
    b.dataset.armed = '1'; b.textContent = 'Точно сбросить? Нажмите ещё раз';
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Сбросить все изменения'; } }, 5000);
  }
});
/** A photo is cut to a 256 px square and kept as a small data URL (it lives in the browser storage next to the other changes). */
function devSetPhoto(file) {
  const msg = $('dev-photo-msg');
  if (file.size > 10 * 1024 * 1024) { msg.textContent = 'Файл больше 10 МБ.'; return; }
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const c = document.createElement('canvas'), n = 256, side = Math.min(img.width, img.height);
    c.width = c.height = n;
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, n, n);
    URL.revokeObjectURL(url);
    DEV.o.photo = c.toDataURL('image/jpeg', 0.85);
    devChanged();
  };
  img.onerror = () => { URL.revokeObjectURL(url); msg.textContent = 'Это не картинка.'; };
  img.src = url;
}

// ---------- editing a lesson / homework ----------
const DEV_TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const padTime = (s) => { s = s.trim(); return s.length === 4 ? `0${s}` : s; };
const devTimeOf = (s) => padTime(s.slice(11, 16));

function devLessonButtons(l) {
  if (!DEV.on) return '';
  return `<div class="block devacts"><button class="btn ghost" data-devlesson="${esc(l.id)}">Изменить урок</button><button class="btn ghost" data-devaddhw="${esc(l.id)}">Добавить задание</button></div>`;
}

/** Open the small form dialog: `fields` are [key, label, value, attrs], `onSave(values)` returns an error text or nothing. */
function devForm(title, fields, onSave, extraButtons) {
  const dlg = $('devdlg'), form = $('devdlg-form');
  form.innerHTML = `<h2>${esc(title)}</h2>${fields.map(([k, l, v, multi]) => `<label class="devf"><span>${esc(l)}</span>${multi ? `<textarea name="${k}" rows="3">${esc(v)}</textarea>` : `<input name="${k}" value="${esc(v)}">`}</label>`).join('')}
    <div class="err" id="devdlg-err" role="alert"></div>
    <div class="devbtns"><button type="button" class="btn" id="devdlg-ok">Сохранить</button>${(extraButtons || []).map(([id, label]) => `<button type="button" class="btn ghost danger" id="${id}">${esc(label)}</button>`).join('')}<button type="button" class="btn ghost" id="devdlg-cancel">Отмена</button></div>`;
  const values = () => Object.fromEntries(fields.map(([k]) => [k, form.elements[k].value]));
  $('devdlg-cancel').onclick = () => dlg.close();
  $('devdlg-ok').onclick = () => { const err = onSave(values()); if (err) $('devdlg-err').textContent = err; else { dlg.close(); devChanged(); } };
  if (!dlg.open) dlg.showModal();
  return { values, close: () => { dlg.close(); devChanged(); } };
}

function devEditLesson(id) {
  const l = S.lessonsById.get(id);
  if (!l) return;
  const o = DEV.o, added = o.addedLessons.find((a) => a.id === id);
  const f = devForm('Изменить урок', [['subject', 'Предмет', l.subject_name], ['start', 'Начало, чч:мм', devTimeOf(l.start)], ['end', 'Конец, чч:мм', devTimeOf(l.end)], ['room', 'Кабинет', l.room || ''], ['teacher', 'Учитель', teacherText(l.teacher)], ['theme', 'Тема урока', l.theme || '', true]], (v) => {
    if (!v.subject.trim()) return 'Укажите предмет.';
    if (!DEV_TIME.test(v.start.trim()) || !DEV_TIME.test(v.end.trim())) return 'Время в виде чч:мм.';
    if (added) Object.assign(added, { subject: v.subject.trim(), start: padTime(v.start), end: padTime(v.end), room: v.room, teacher: v.teacher, theme: v.theme });
    else {
      // only what differs from what the server said is stored
      const real = S.rawWeeks.get(`${isoWeek(parseDate(l.start.slice(0, 10))).year}-${isoWeek(parseDate(l.start.slice(0, 10))).week}`);
      const orig = real && real.lessons.find((x) => x.id === id);
      if (!orig) return 'Не нашёл исходный урок.';
      // The baseline is what the server said with the page-wide renaming rules: a value equal to it needs no lesson-level change.
      const diff = (n, base) => (n !== base ? n : undefined);
      const e = {
        subject: diff(v.subject.trim(), o.subjects[orig.subject_name] || orig.subject_name), start: diff(padTime(v.start), devTimeOf(orig.start)), end: diff(padTime(v.end), devTimeOf(orig.end)),
        room: diff(v.room, orig.room || ''), teacher: diff(v.teacher.trim(), o.teachers[teacherKey(orig.teacher)] || teacherText(orig.teacher)), theme: diff(v.theme, orig.theme || ''),
      };
      const kept = { ...(o.lessons[id] || {}) };
      ['subject', 'start', 'end', 'room', 'teacher', 'theme'].forEach((k) => { if (e[k] === undefined) delete kept[k]; else kept[k] = e[k]; });
      if (Object.keys(kept).length) o.lessons[id] = kept; else delete o.lessons[id];
    }
  }, [['devdlg-del', added ? 'Удалить' : 'Скрыть урок']]);
  $('devdlg-del').onclick = () => {
    if (added) o.addedLessons = o.addedLessons.filter((a) => a.id !== id); else o.lessons[id] = { ...(o.lessons[id] || {}), deleted: true };
    f.close(); $('lessondlg').open && $('lessondlg').close();
  };
}

function devAddLesson(dateKey) {
  const d = parseDate(dateKey);
  devForm(`Новый урок, ${d.getDate()} ${MON[d.getMonth()]}`, [['subject', 'Предмет', ''], ['start', 'Начало, чч:мм', '08:30'], ['end', 'Конец, чч:мм', '09:15'], ['room', 'Кабинет', ''], ['teacher', 'Учитель', '']], (v) => {
    if (!v.subject.trim()) return 'Укажите предмет.';
    if (!DEV_TIME.test(v.start.trim()) || !DEV_TIME.test(v.end.trim())) return 'Время в виде чч:мм.';
    DEV.o.addedLessons.push({ id: `dev-l-${Date.now()}`, date: dateKey, start: padTime(v.start), end: padTime(v.end), subject: v.subject.trim(), room: v.room, teacher: v.teacher, theme: '' });
  });
}

function devAddHomework(lessonId) {
  const l = S.lessonsById.get(lessonId);
  if (!l) return;
  devForm(`Новое задание: ${l.subject_name}`, [['text', 'Текст', '', true]], (v) => {
    if (!v.text.trim()) return 'Введите текст.';
    DEV.o.addedHomework.push({ id: `dev-h-${Date.now()}`, due: l.start.slice(0, 10), subject: l.subject_name, text: v.text, lessonId });
    $('lessondlg').open && $('lessondlg').close();
  });
}

function devEditHomework(id) {
  const h = S.hw.get(id);
  if (!h) return;
  const o = DEV.o, added = o.addedHomework.find((a) => a.id === id);
  const f = devForm('Изменить задание', [['text', 'Текст', h.description || '', true]], (v) => {
    if (added) added.text = v.text;
    else {
      const orig = [...S.rawWeeks.values()].flatMap((w) => w.homeworks).find((x) => x.id === id);
      if (orig && v.text === orig.description) delete o.homework[id]; else o.homework[id] = { text: v.text };
    }
  }, [['devdlg-del', 'Удалить']]);
  $('devdlg-del').onclick = () => {
    if (added) o.addedHomework = o.addedHomework.filter((a) => a.id !== id); else o.homework[id] = { deleted: true };
    f.close();
  };
}

// buttons are caught before the page's own click rules (a pencil inside a homework row must not toggle "done")
document.addEventListener('click', (e) => {
  if (!DEV.on) return;
  const b = e.target.closest('[data-devlesson],[data-devaddhw],[data-devhw],[data-devaddlesson]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  if (b.dataset.devlesson) devEditLesson(b.dataset.devlesson);
  else if (b.dataset.devaddhw) devAddHomework(b.dataset.devaddhw);
  else if (b.dataset.devhw) devEditHomework(b.dataset.devhw);
  else if (b.dataset.devaddlesson) devAddLesson(b.dataset.devaddlesson);
}, true);

// pencils and "+ Урок" are added to whatever the pages draw
let devDecorating = false;
function devDecorate() {
  if (!DEV.on || devDecorating) return;
  devDecorating = true;
  document.querySelectorAll('.hw input[data-id]').forEach((i) => {
    const label = i.closest('.hw');
    if (label && !label.querySelector('[data-devhw]')) label.insertAdjacentHTML('beforeend', `<button type="button" class="hw-edit" data-devhw="${esc(i.dataset.id)}" title="Изменить задание" aria-label="Изменить задание">✎</button>`);
  });
  const addTo = (el, date) => { if (el && date && !el.querySelector(':scope > [data-devaddlesson]')) el.insertAdjacentHTML('beforeend', `<button type="button" class="btn ghost dev-add" data-devaddlesson="${esc(date)}">+ Урок</button>`); };
  if (S.cur && !$('homeview').hidden) addTo($('sched'), isoDate(S.cur));
  document.querySelectorAll('#wgrid .dcol[data-date]').forEach((c) => addTo(c, c.dataset.date));
  devDecorating = false;
}
new MutationObserver(devDecorate).observe(document.body, { childList: true, subtree: true });

async function initDev() {
  try { DEV.on = !!(invoke && await invoke('dev_mode')); } catch (_) { DEV.on = false; }
  $('dev-nav').hidden = !DEV.on;
  renderIcons(); // the developer-only icons show (or the choice falls back) now that the flag is known
  applyIcon();
  if (!DEV.on) return;
  devRenderBanner();
  rebuildMaps();
  devDecorate();
}
