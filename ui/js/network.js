'use strict';
// ---------- network: proxy or direct (decided in Rust, see src-tauri/src/net.rs) ----------
const NET_HINTS = {
  auto: 'Если выходной адрес прокси находится не в России, приложение само идёт к Госуслугам напрямую. Российский адрес и обычное подключение остаются как есть.',
  direct: 'Запросы к Госуслугам и окно входа идут напрямую, настройки прокси системы игнорируются.',
  system: 'Всё идёт так, как настроено в системе, без проверок.',
};
function renderNet(st) {
  if (!st) return;
  document.querySelectorAll('#net-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === st.mode)));
  $('net-hint').textContent = NET_HINTS[st.mode] || '';
  const way = st.direct ? 'напрямую' : 'через прокси системы (или без него, если он не настроен)';
  const where = st.country ? ` Выходной адрес системного подключения: ${st.country}.` : '';
  $('net-msg').textContent = st.reachable === false ? 'Госуслуги не отвечают ни напрямую, ни через прокси системы. Проверьте интернет.' : `Сейчас подключение идёт ${way}.${where}`;
}
async function netCall(cmd, args) {
  $('net-test').disabled = true; $('net-msg').textContent = 'Проверяю…';
  try { renderNet(await invoke(cmd, args)); } catch (e) { $('net-msg').textContent = `Не удалось: ${e}`; }
  $('net-test').disabled = false;
}
$('net-mode').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) netCall('net_set', { mode: b.dataset.v }); });
$('net-test').onclick = () => netCall('net_test');
if (invoke) invoke('net_get').then(renderNet).catch(() => {});
