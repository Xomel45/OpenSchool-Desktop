'use strict';
// ---------- my notes for a lesson («взять форму на физру»): only on this computer, shown next to the homework ----------
// Kept in localStorage as { lessonId: [{ id, t, done }] }. The evening summary gets the open ones through `syncDone`.

let notes = {};
try { notes = JSON.parse(localStorage.getItem('openschool.notes') || '{}') || {}; } catch (_) { notes = {}; }
const NOTE_MAX = 300;

function saveNotes() {
  for (const k of Object.keys(notes)) if (!notes[k].length) delete notes[k];
  try { localStorage.setItem('openschool.notes', JSON.stringify(notes)); } catch (_) { /* storage may be unavailable */ }
  syncDone();
}
const notesOf = (lessonId) => notes[lessonId] || [];

/** The notes of a lesson as rows under its homework (a tick, the text, ×). */
function noteRows(lessonId) {
  return notesOf(lessonId).map((n) => `<label class="hw note${n.done ? ' done' : ''}"><input type="checkbox" data-note="${esc(n.id)}" data-lid="${esc(lessonId)}"${n.done ? ' checked' : ''}><span>${esc(n.t)}</span><button type="button" class="note-del" data-note="${esc(n.id)}" data-lid="${esc(lessonId)}" aria-label="Удалить заметку" title="Удалить заметку">×</button></label>`).join('');
}

/** The block of the lesson card: the list and a field to add one. */
function notesBlock(lessonId) {
  return `<div class="block notes" data-lid="${esc(lessonId)}"><h3>Мои заметки</h3>${noteRows(lessonId) || '<span class="muted note-empty">Пока нет. Например: «взять форму» или «сдать тетрадь».</span>'}
    <form class="note-add" data-lid="${esc(lessonId)}"><input type="text" maxlength="${NOTE_MAX}" placeholder="Новая заметка к этому уроку" aria-label="Новая заметка"><button class="btn ghost" type="submit">Добавить</button></form></div>`;
}

/** Everything that shows lessons is drawn again (the pages keep where they are). */
function notesRerender() {
  if (S.dayData && S.cur) { S.dayData = buildDay(S.cur); renderSched(); if (S.sel !== null) renderMain(); }
  if (!$('schedule').hidden && S.week) renderWeek();
  if (!$('tasksview').hidden && S.tp !== 'files') renderTasks();
  const dlg = $('lessondlg'), box = $('lessondlg-body').querySelector('.notes');
  if (dlg.open && box) { const d = $('lessondlg-body').dataset.date; if (d) showLessonDialog(d, box.dataset.lid, S.opener); }
}

function addNote(lessonId, text) {
  const t = text.trim().slice(0, NOTE_MAX);
  if (!t) return;
  (notes[lessonId] = notes[lessonId] || []).push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, t, done: false });
  saveNotes();
  notesRerender();
  // keep typing: the field of the redrawn card gets the focus back
  const f = document.querySelector(`.note-add[data-lid="${CSS.escape(lessonId)}"] input`);
  if (f) f.focus();
}

document.addEventListener('submit', (e) => {
  const f = e.target.closest('.note-add');
  if (!f) return;
  e.preventDefault();
  addNote(f.dataset.lid, f.querySelector('input').value);
});
// A capture listener: a note sits in a homework <label>; its tick must not reach the homework handlers.
document.addEventListener('change', (e) => {
  const cb = e.target.closest && e.target.closest('input[data-note]');
  if (!cb) return;
  e.stopPropagation();
  const n = notesOf(cb.dataset.lid).find((x) => x.id === cb.dataset.note);
  if (!n) return;
  n.done = cb.checked;
  cb.closest('.hw').classList.toggle('done', cb.checked);
  saveNotes();
}, true);
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.note-del');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  notes[b.dataset.lid] = notesOf(b.dataset.lid).filter((x) => x.id !== b.dataset.note);
  saveNotes();
  notesRerender();
}, true);

/** For the evening summary: the open notes with their lesson. */
function openNotes() {
  const out = [];
  for (const [lesson, list] of Object.entries(notes)) for (const n of list) if (!n.done) out.push({ lesson, text: n.t });
  return out;
}
