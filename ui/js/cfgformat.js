'use strict';
// ---------- the settings file (.cfg): reading and writing config.json ----------
// The format is shared by every OpenSchool app (Linux, Windows, Android): see OpenSchool-Bridge/docs/cfg/format.md.
// Reading is tolerant: a value that is not allowed is skipped, the rest still applies; nothing in the file is trusted.

const CFG_INTERVALS = [5, 15, 30, 60];
const CFG_NET_MODES = ['auto', 'direct', 'system'];

/** What an imported config.json may change, checked field by field. Throws only if it is not a settings file at all. */
function cfgParse(c) {
  if (!c || typeof c !== 'object' || c.format !== 'openschool-config') throw new Error('это не файл настроек OpenSchool');
  const out = {};
  if (STYLES.includes(c.style)) out.style = c.style;
  if (SCHEMES.includes(c.scheme)) out.scheme = c.scheme;
  if (typeof c.accent === 'string' && (c.accent === 'default' || ACCENTS[c.accent] || HEX.test(c.accent))) out.accent = c.accent;
  // compared with a tolerance: another app may have written 1.3 as 1.2999999523162842
  const z = typeof c.zoom === 'number' ? ZOOMS.find((v) => Math.abs(v - c.zoom) < 0.001) : undefined;
  if (z !== undefined) out.zoom = z;
  if (typeof c.icon === 'string' && APP_ICONS.some((i) => i.id === c.icon)) out.icon = c.icon;
  if (c.bg && typeof c.bg === 'object') out.bg = cleanBg(c.bg);
  const n = c.notifications;
  if (n && typeof n === 'object') {
    const o = {};
    for (const k of ['marks', 'homework', 'absences', 'detail']) if (typeof n[k] === 'boolean') o[k] = n[k];
    if (CFG_INTERVALS.includes(n.interval_min)) o.interval_min = n.interval_min;
    const q = n.quiet;
    if (q && typeof q === 'object') {
      if (typeof q.on === 'boolean') o.quiet = q.on;
      const from = hmToMin(q.from), to = hmToMin(q.to);
      if (from !== null) o.quiet_from = from;
      if (to !== null) o.quiet_to = to;
    }
    if (Object.keys(o).length) out.notifications = o;
  }
  if (c.network && typeof c.network === 'object' && CFG_NET_MODES.includes(c.network.mode)) out.network = { mode: c.network.mode };
  return out;
}

/** The config.json of this device's current choices. */
async function cfgBuild() {
  const o = { format: 'openschool-config', version: 1, style, scheme: schemePref, accent: accentPref, zoom: zoomPref, icon: iconPref, bg: bgPref };
  if (S.notify) o.notifications = { marks: S.notify.marks, homework: S.notify.homework, absences: S.notify.absences, interval_min: S.notify.interval_min, detail: S.notify.detail, quiet: { on: !!S.notify.quiet, from: minToHm(S.notify.quiet_from ?? 1320), to: minToHm(S.notify.quiet_to ?? 420) } };
  try { const n = await invoke('net_get'); if (n && CFG_NET_MODES.includes(n.mode)) o.network = { mode: n.mode }; } catch (_) { /* the mode is just left out */ }
  return o;
}
