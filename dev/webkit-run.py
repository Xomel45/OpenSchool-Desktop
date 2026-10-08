#!/usr/bin/env python3
"""Run a dev page in a real WebKitGTK web view (the engine the Tauri app uses on Linux), off screen.

    python3 dev/webkit-run.py PAGE.html[#hash] [--size 1368x897] [--shot out.png] [--timeout 90]

The page reports by setting document.title to "RESULT|..." (and, for long results, window.__result). Prints it, optionally saves a snapshot.
Nothing is shown on the desktop."""
import argparse, os, sys
import gi
gi.require_version('Gtk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, GLib, WebKit2

ap = argparse.ArgumentParser()
ap.add_argument('page'); ap.add_argument('--size', default='1368x897'); ap.add_argument('--shot'); ap.add_argument('--timeout', type=int, default=90)
a = ap.parse_args()
w, h = (int(x) for x in a.size.split('x'))
path, _, frag = a.page.partition('#')
url = 'file://' + os.path.abspath(path) + ('#' + frag if frag else '')

win = Gtk.OffscreenWindow(); win.set_default_size(w, h)
view = WebKit2.WebView(); view.set_size_request(w, h)
view.get_settings().set_property('enable-write-console-messages-to-stdout', False)
win.add(view); win.show_all()
state = {'result': None}

def finish(code=0):
    Gtk.main_quit()

def on_title(v, _):
    t = v.get_title() or ''
    if not t.startswith('RESULT|') or state['result'] is not None:
        return
    state['result'] = t[len('RESULT|'):]  # WebKit truncates long titles, so ask the page for the full text
    def got(view_, res):
        try:
            value = view_.evaluate_javascript_finish(res)
            full = value.to_string() if value is not None and not value.is_undefined() else None
            if full:
                state['result'] = full
        except Exception:
            pass
        if a.shot:
            GLib.timeout_add(400, snap)
        else:
            finish()
    v.evaluate_javascript("typeof window.__result === 'string' ? window.__result : ''", -1, None, None, None, got)

def snap():
    def done(v, res):
        surf = v.get_snapshot_finish(res)
        surf.write_to_png(a.shot)
        finish()
    view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)
    return False

view.connect('notify::title', on_title)
GLib.timeout_add_seconds(a.timeout, lambda: (print('TIMEOUT: the page never reported a result', file=sys.stderr), finish(), False)[-1])
view.load_uri(url)
Gtk.main()
if state['result'] is None:
    sys.exit(2)
print(state['result'].replace(' | ', '\n'))
