'use strict';
// ---------- homework attachments: the file list of each homework, download/open, and the list of downloaded files ----------
// The program does the work (src-tauri/src/attach.rs and the Bridge): it checks the address, the size and the kind of answer, saves the
// file in the Downloads folder (OpenSchool/), keeps the list of saved files and opens documents, pictures and media with the system's
// default program. The page names a saved file only by the id of its entry in that list.

S.dl = new Map(); // attachment link -> the newest downloaded copy (an entry of `list_downloads`)
S.dlList = [];

// Kinds the program opens itself (the same list as `can_open` in the Bridge); everything else is only saved.
const OPENABLE_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp3', 'wav', 'ogg', 'mp4', 'webm']);
const fileExt = (name) => { const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || ''); return m && m.index > 0 ? m[1].toLowerCase() : ''; };
const canOpenName = (name) => OPENABLE_EXT.has(fileExt(name));

/** The coloured badge of a file: what kind of file it is at a glance. */
function fileKind(name) {
  const e = fileExt(name);
  const k = [['pdf', ['pdf']], ['doc', ['doc', 'docx', 'odt', 'rtf', 'txt']], ['xls', ['xls', 'xlsx', 'ods', 'csv']], ['ppt', ['ppt', 'pptx', 'odp']],
    ['img', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic']], ['aud', ['mp3', 'wav', 'ogg', 'm4a', 'flac']], ['vid', ['mp4', 'webm', 'mkv', 'avi', 'mov']],
    ['zip', ['zip', 'rar', '7z', 'tar', 'gz']]].find(([, list]) => list.includes(e));
  const label = { pdf: 'PDF', doc: 'DOC', xls: 'XLS', ppt: 'PPT', img: 'IMG', aud: 'AUD', vid: 'VID', zip: 'ZIP' };
  return k ? { cls: k[0], label: label[k[0]] } : { cls: 'other', label: e ? e.slice(0, 4).toUpperCase() : 'ФАЙЛ' };
}

function fmtSize(b) {
  if (!(b >= 0)) return '';
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}
const fmtWhen = (sec) => { const d = new Date(sec * 1000); return `${d.getDate()} ${MON_SHORT[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** One row of a homework's file list. */
function fileRow(h, m, i) {
  const name = m.name || 'файл', k = fileKind(name), got = S.dl.get(m.link), busy = attBusy.has(m.link);
  const openable = canOpenName(got ? got.name : name);
  const sub = busy ? 'Скачиваю…' : got ? `Скачан · ${fmtSize(got.size)}` : m.link ? 'Не скачан' : 'Нет ссылки';
  const btns = !m.link ? ''
    : got ? `${openable ? `<button type="button" class="fbtn" data-act="open" title="Открыть скачанный файл">Открыть</button>` : ''}<button type="button" class="fbtn" data-act="reveal" title="Показать файл в папке">В папке</button>`
      : `${openable ? `<button type="button" class="fbtn" data-act="get-open" title="Скачать и открыть"${busy ? ' disabled' : ''}>Открыть</button>` : ''}<button type="button" class="fbtn" data-act="get" title="Скачать в Загрузки/OpenSchool"${busy ? ' disabled' : ''}>Скачать</button>`;
  return `<div class="file${got ? ' got' : ''}" role="listitem" data-i="${i}"><i class="fk k-${k.cls}" aria-hidden="true">${esc(k.label)}</i><div class="fn"><b title="${esc(name)}">${esc(name)}</b><small>${esc(sub)}</small></div><div class="fa">${btns}</div></div>`;
}

/** The file list of one homework (empty when it has none). */
function attHtml(h) {
  if (!h.materials || !h.materials.length) return '';
  const n = h.materials.length;
  return `<div class="files" role="list" aria-label="Файлы задания: ${n}" data-hw="${esc(h.id)}">${h.materials.map((m, i) => fileRow(h, m, i)).join('')}</div>`;
}

/** For the narrow week columns: a «📎 N» button that unfolds the same list. */
function attCompact(h) {
  if (!h.materials || !h.materials.length) return '';
  const n = h.materials.length, got = h.materials.filter((m) => S.dl.has(m.link)).length;
  return `<div class="attc"><button type="button" class="att-more" aria-expanded="false" title="Файлы задания">📎 ${n}${got ? ` <small>· скачано ${got}</small>` : ''}</button><div class="attc-list" hidden>${attHtml(h)}</div></div>`;
}

/** Redraw every file list on the screen in place (the pages around them stay as they are). */
function attRefresh() {
  document.querySelectorAll('.files[data-hw]').forEach((el) => {
    const h = S.hw.get(el.dataset.hw);
    if (h) el.innerHTML = h.materials.map((m, i) => fileRow(h, m, i)).join('');
  });
  document.querySelectorAll('.attc').forEach((el) => {
    const list = el.querySelector('.files[data-hw]'), h = list && S.hw.get(list.dataset.hw), more = el.querySelector('.att-more');
    if (!h || !more) return;
    const got = h.materials.filter((m) => S.dl.has(m.link)).length;
    more.innerHTML = `📎 ${h.materials.length}${got ? ` <small>· скачано ${got}</small>` : ''}`;
  });
  if (S.tp === 'files' && !$('tasksview').hidden) renderDownloads();
}

async function refreshDownloads() {
  if (!invoke) return;
  try { S.dlList = await invoke('list_downloads'); } catch (_) { return; }
  S.dl = new Map();
  for (const d of S.dlList) if (!S.dl.has(d.link)) S.dl.set(d.link, d); // the list comes newest first
  attRefresh();
}
function downloadsReset() { S.dlList = []; S.dl = new Map(); }

let attNoteTimer = 0;
function attNote(text, ms) {
  const t = $('attnote');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(attNoteTimer);
  attNoteTimer = setTimeout(() => { t.hidden = true; }, ms || 7000);
}

/** What the user reads for a failure (the program's error texts are matched by their markers). */
function attErrorText(e) {
  const s = String(e && e.message ? e.message : e);
  if (s === 'OFFLINE') return 'Нет связи с Госуслугами: файл не скачать.';
  if (s.includes('file too big')) return 'Файл больше 50 МБ: не скачиваю.';
  if (s.includes('not a file')) return 'Сервер вернул веб-страницу вместо файла. Возможно, нужно войти заново.';
  if (s.includes('not https') || s.includes('bad link') || s.includes('user name')) return 'Ссылка вложения выглядит небезопасной: не открываю.';
  if (s.includes('HTTP 403') || s.includes('HTTP 404')) return `Сервер не отдаёт файл (${s.match(/HTTP \d+/)[0]}).`;
  return /^(Не |Файла )/.test(s) ? s : `Не удалось скачать: ${s}`;
}

const attBusy = new Set(); // links being downloaded right now

async function attDownload(h, m, open) {
  if (attBusy.has(m.link)) return;
  attBusy.add(m.link);
  attRefresh();
  attNote(`Скачиваю «${m.name || 'файл'}»…`, 60000);
  try {
    const r = await invoke('download_material', { link: m.link, name: m.name || '', open, subject: h.subject_name || '', due: h.due_date || '', hw: h.id });
    attNote(r.opened ? `Открыто. Файл сохранён: ${r.file.shown}` : open && !r.file.openable ? `Сохранено: ${r.file.shown}. Этот тип файла сам не открывается.` : `Сохранено: ${r.file.shown}`, 9000);
  } catch (e) { attNote(attErrorText(e)); }
  attBusy.delete(m.link);
  await refreshDownloads();
  attRefresh();
}

/** Open / show in the folder / delete one downloaded file by its id. */
async function attLocal(act, id) {
  try {
    if (act === 'open') { const opened = await invoke('open_download', { id }); if (!opened) attNote('Этот тип файла сам не открывается: показываю его в папке.'); }
    else if (act === 'reveal') await invoke('reveal_download', { id });
    else if (act === 'delete') { await invoke('delete_download', { id }); attNote('Файл удалён.', 4000); await refreshDownloads(); }
  } catch (e) { attNote(attErrorText(e)); await refreshDownloads(); }
}

// A capture listener: the lists sit inside the homework's <label>, a click there must not tick the homework.
document.addEventListener('click', (ev) => {
  const t = ev.target.closest && ev.target;
  if (!t) return;
  const more = t.closest('.att-more');
  if (more) {
    ev.preventDefault(); ev.stopPropagation();
    const list = more.nextElementSibling, open = list.hidden;
    list.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
    return;
  }
  if (!t.closest('.files')) return;
  ev.preventDefault();
  ev.stopPropagation();
  const b = t.closest('.fbtn');
  if (!b || b.disabled) return;
  const list = b.closest('.files'), h = S.hw.get(list.dataset.hw), m = h && h.materials[Number(b.closest('.file').dataset.i)];
  if (!m || !m.link) { attNote('У этого вложения нет ссылки.'); return; }
  if (!invoke) { attNote('Скачивание работает только в приложении.'); return; }
  const act = b.dataset.act;
  if (act === 'get' || act === 'get-open') attDownload(h, m, act === 'get-open');
  else { const got = S.dl.get(m.link); if (got) attLocal(act, got.id); }
}, true);

// ---------- «Файлы»: the downloaded files (a tab of the tasks page) ----------

function renderDownloads() {
  const L = S.dlList;
  const total = L.reduce((a, d) => a + (d.size || 0), 0);
  $('tk-sum').innerHTML = L.length ? `Файлов <b>${L.length}</b> · ${esc(fmtSize(total))}` : '';
  const head = `<div class="dl-head"><span class="muted">Сохраняются в папку Загрузки/OpenSchool. Удалённые там пропадают и отсюда.</span><button type="button" class="btn ghost" id="dl-folder">Открыть папку</button></div>`;
  if (!L.length) { $('tk-body').innerHTML = `${head}<div class="empty">Скачанных файлов пока нет. Нажмите «Скачать» или «Открыть» у файла задания: он появится здесь.</div>`; return; }
  const rows = L.map((d) => {
    const k = fileKind(d.name), hw = S.hw.get(d.hw);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(d.due) ? parseDate(d.due) : null;
    const what = [d.subject, due ? `задание на ${due.getDate()} ${MON_SHORT[due.getMonth()]}` : ''].filter(Boolean).join(' · ');
    return `<div class="file dl" role="listitem" data-id="${esc(d.id)}"><i class="fk k-${k.cls}" aria-hidden="true">${esc(k.label)}</i>
      <div class="fn"><b title="${esc(d.shown)}">${esc(d.name)}</b><small>${esc(what || 'Без задания')}${hw && hw.description ? ` — ${esc(hw.description)}` : ''}</small><small class="muted">${esc(fmtSize(d.size))} · скачан ${esc(fmtWhen(d.at))}</small></div>
      <div class="fa">${d.openable ? '<button type="button" class="fbtn" data-act="open">Открыть</button>' : ''}<button type="button" class="fbtn" data-act="reveal">В папке</button><button type="button" class="fbtn del" data-act="delete" title="Удалить файл с диска">Удалить</button></div></div>`;
  }).join('');
  $('tk-body').innerHTML = `${head}<div class="dl-list" role="list" aria-label="Скачанные файлы">${rows}</div>`;
}

async function showDownloads() {
  $('tk-body').innerHTML = '<div class="gr-note">Загрузка списка…</div>';
  await refreshDownloads();
  if (S.tp === 'files') renderDownloads();
}

$('tk-body').addEventListener('click', (e) => {
  if (e.target.closest('#dl-folder')) { invoke && invoke('open_downloads_folder').catch((err) => attNote(attErrorText(err))); return; }
  const b = e.target.closest('.dl .fbtn');
  if (!b || !invoke) return;
  const id = b.closest('.dl').dataset.id;
  if (b.dataset.act === 'delete' && !b.dataset.armed) {
    // Two clicks, no browser dialog (it would block the window).
    b.dataset.armed = '1'; b.textContent = 'Точно удалить?'; b.classList.add('armed');
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Удалить'; b.classList.remove('armed'); } }, 4000);
    return;
  }
  attLocal(b.dataset.act, id);
});
