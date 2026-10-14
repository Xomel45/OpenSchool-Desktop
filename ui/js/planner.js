'use strict';
// ---------- «Скоро контрольная»: tests found in lesson topics and homework texts; ticks sent to the evening summary ----------
// The word list is the same as in src-tauri/src/planner.rs (a Rust test compares them): [stem, label, whole word only].

const TEST_WORDS = [
  ['контрольн', 'Контрольная', false],
  ['к/р', 'Контрольная', false],
  ['самостоятельн', 'Самостоятельная', false],
  ['с/р', 'Самостоятельная', false],
  ['проверочн', 'Проверочная', false],
  ['диктант', 'Диктант', false],
  ['зачёт', 'Зачёт', false],
  ['зачет', 'Зачёт', false],
  ['впр', 'ВПР', true],
  ['тест', 'Тест', false],
  ['срез', 'Срез', true],
  ['диагностическ', 'Диагностическая', false],
  ['экзамен', 'Экзамен', false],
];
const isWordChar = (c) => !!c && /[\p{L}\p{N}]/u.test(c);

/** The label of the first test word in the text, or null. */
function testLabel(text) {
  const t = String(text || '').toLowerCase();
  for (const [stem, label, whole] of TEST_WORDS) {
    let i = t.indexOf(stem);
    while (i >= 0) {
      if (!whole || (!isWordChar(t[i - 1]) && !isWordChar(t[i + stem.length]))) return label;
      i = t.indexOf(stem, i + 1);
    }
  }
  return null;
}

/** A row of `buildDay`: is this lesson a test? From its topic first, then from a homework due on it. */
function lessonTest(r) {
  return testLabel(r.l.theme) || r.hw.map((h) => testLabel(h.description)).find(Boolean) || null;
}
function testBadge(r) {
  const t = lessonTest(r);
  return t ? `<span class="testb" title="${esc(t)}">${esc(t)}</span>` : '';
}

/** Tests of the coming days (today included) in the weeks loaded so far, nearest first. */
function upcomingTests(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(S.today, i);
    for (const r of buildDay(d).rows) {
      const t = lessonTest(r);
      if (t && status(r.l) !== 'past') out.push({ d, r, t });
    }
  }
  return out;
}
function testsHtml() {
  const list = upcomingTests(14);
  const body = list.length
    ? list.map(({ d, r, t }) => { const w = dayWord(d); return `<button class="up-test" data-date="${isoDate(d)}" data-lid="${esc(r.l.id)}"><span class="testb">${esc(t)}</span><b>${esc(r.l.subject_name)}</b><span class="muted">${w ? w + ', ' : ''}${esc(WD[d.getDay()])}, ${d.getDate()} ${esc(MON[d.getMonth()])}, ${r.n}-й урок</span></button>`; }).join('')
    : '<span class="muted">В ближайшие две недели не найдено. Контрольные узнаются по теме урока и тексту задания.</span>';
  return `<div class="block"><h3>Скоро контрольные</h3>${body}</div>`;
}

// The home panel's test list opens the lesson.
$('main').addEventListener('click', (e) => {
  const b = e.target.closest('.up-test');
  if (b) showLessonDialog(b.dataset.date, b.dataset.lid, b);
});

/** The evening summary counts open homework: it needs the ticks, which live here. */
function syncDone() {
  if (invoke) invoke('planner_done', { ids: Object.keys(done), notes: typeof openNotes === 'function' ? openNotes() : [] }).catch(() => {});
}
