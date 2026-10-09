#!/usr/bin/env python3
"""Generate dev/mock.html from ui/index.html so the test page never drifts from the real markup.
Run from anywhere: python3 dev/make-mock.py"""
import os
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, "..", "ui", "index.html"), encoding="utf-8").read()
out = (src.replace('href="style.css"', 'href="../ui/style.css"')
          .replace('<script src="js/core.js">', '<script src="fake-backend.js"></script>\n<script src="../ui/js/core.js">')
          .replace('<script src="js/', '<script src="../ui/js/')
          .replace("<title>OpenSchool</title>", "<title>OpenSchool UI with a fake backend (dev only)</title>"))
open(os.path.join(here, "mock.html"), "w", encoding="utf-8").write(out)
print("wrote dev/mock.html")
