'use strict';
// ---------- updates of the app itself (src-tauri/src/update.rs) ----------
// The program checks at start and every 6 hours (when «Автообновление» is on) and sends `update-available`; this window offers the
// update. «Не сейчас» (or ×, Esc) only hides it: the same version is not offered again until the next start. Nothing is installed
// without «Обновить». Copies from a package manager (AUR, Nix, .deb, .rpm) only get a link to the release page.

const KIND_TEXT = { appimage: 'AppImage', nsis: 'установщик Windows', msi: 'установщик Windows (MSI)', deb: 'пакет .deb', rpm: 'пакет .rpm', other: 'сборка из исходников или менеджера пакетов' };
let upFound = null, upInfo = null;

function upErr(e) { return String(e && e.message ? e.message : e); }

async function upLoadInfo() {
  if (!invoke) return null;
  try { upInfo = await invoke('update_info'); } catch (_) { return null; }
  $('up-auto').checked = upInfo.auto;
  $('up-off').hidden = true;
  $('up-sub').textContent = `Установлена версия ${upInfo.current} · ${KIND_TEXT[upInfo.kind] || upInfo.kind}`;
  $('up-how').textContent = !upInfo.configured ? 'В этой сборке обновления не настроены: новые версии ищите на странице релизов.'
    : upInfo.can_install ? 'Проверка при запуске и каждые 6 часов. Без вашего нажатия ничего не устанавливается.'
      : 'Проверка при запуске и каждые 6 часов. Эта копия обновляется через менеджер пакетов (или вручную): приложение только сообщит о новой версии.';
  $('up-check').disabled = !upInfo.configured;
  return upInfo;
}

function upShow(f) {
  upFound = f;
  $('updlg-title').textContent = `Доступна версия ${f.version}`;
  $('updlg-sub').textContent = `У вас ${f.current}${f.date ? ` · выпущена ${f.date}` : ''}`;
  $('updlg-notes').textContent = f.notes || '';
  $('updlg-prog').hidden = true;
  $('updlg-msg').textContent = f.can_install ? 'Приложение скачает обновление, проверит подпись и перезапустится.' : 'Эта копия обновляется через менеджер пакетов (pacman, apt, dnf, nix) или вручную со страницы релиза.';
  $('updlg-go').textContent = f.can_install ? 'Обновить' : 'Открыть страницу релиза';
  $('updlg-go').disabled = false;
  $('updlg-later').disabled = false;
  const dlg = $('updlg');
  if (!dlg.open) dlg.showModal();
}

/** «Не сейчас»: no questions, the window just goes away. */
function upLater() {
  const dlg = $('updlg');
  if (S.upInstalling) return; // the download is running: the window stays until it ends
  if (dlg.open) dlg.close();
  if (upFound && invoke) invoke('dismiss_update', { version: upFound.version }).catch(() => {});
}

async function upGo() {
  if (!upFound || !invoke) return;
  if (!upFound.can_install) { invoke('open_release_page').catch((e) => { $('updlg-msg').textContent = upErr(e); }); return; }
  S.upInstalling = true;
  $('updlg-go').disabled = true; $('updlg-later').disabled = true;
  $('updlg-prog').hidden = false; $('updlg-bar').style.width = '0%'; $('updlg-pct').textContent = 'Скачиваю…';
  $('updlg-msg').textContent = '';
  try {
    await invoke('install_update'); // on success the app restarts and this line is never passed
  } catch (e) {
    $('updlg-msg').textContent = upErr(e);
    $('updlg-prog').hidden = true;
    $('updlg-go').disabled = false; $('updlg-later').disabled = false;
  }
  S.upInstalling = false;
}

$('updlg-later').onclick = upLater;
$('updlg-close').onclick = upLater;
$('updlg').addEventListener('cancel', (e) => { e.preventDefault(); upLater(); }); // Esc
$('updlg-go').onclick = upGo;

if (tauriEvent && tauriEvent.listen) {
  tauriEvent.listen('update-available', (e) => upShow(e.payload));
  tauriEvent.listen('update-progress', (e) => {
    const { done, total } = e.payload;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    $('updlg-bar').style.width = total ? `${pct}%` : '100%';
    $('updlg-pct').textContent = total ? `${pct}% · ${fmtSize(done)} из ${fmtSize(total)}` : fmtSize(done);
  });
}

// ---------- settings: «Обновления» ----------
// Turning the switch off asks for the responsibility note first; until «Отключить» the switch stays on.
$('up-auto').addEventListener('change', async (e) => {
  if (!e.target.checked) {
    e.target.checked = true;
    $('up-accept').checked = false; $('up-off-yes').disabled = true;
    $('up-off').hidden = false;
    return;
  }
  $('up-off').hidden = true;
  try { await invoke('set_update_auto', { auto: true, accepted: false }); $('up-msg').textContent = 'Автообновление включено.'; } catch (err) { $('up-msg').textContent = upErr(err); upLoadInfo(); }
});
$('up-accept').addEventListener('change', (e) => { $('up-off-yes').disabled = !e.target.checked; });
$('up-off-no').onclick = () => { $('up-off').hidden = true; };
$('up-off-yes').onclick = async () => {
  try {
    await invoke('set_update_auto', { auto: false, accepted: $('up-accept').checked });
    $('up-auto').checked = false; $('up-off').hidden = true;
    $('up-msg').textContent = 'Автообновление отключено. Проверить вручную можно кнопкой ниже.';
  } catch (err) { $('up-msg').textContent = upErr(err); }
};
$('up-check').onclick = async () => {
  if (!invoke) return;
  $('up-check').disabled = true; $('up-msg').textContent = 'Проверяю…';
  try {
    const f = await invoke('check_update');
    $('up-msg').textContent = f ? `Есть версия ${f.version}.` : 'У вас последняя версия.';
    if (f) upShow(f);
  } catch (err) { $('up-msg').textContent = upErr(err); }
  $('up-check').disabled = !(upInfo && upInfo.configured);
};
$('up-page').onclick = () => invoke && invoke('open_release_page').catch((e) => { $('up-msg').textContent = upErr(e); });
document.querySelector('.setnav [data-sec="updates"]').addEventListener('click', () => upLoadInfo());
upLoadInfo();
