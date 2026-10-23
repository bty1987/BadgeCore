# -*- coding: utf-8 -*-
"""渲染 README 图表：能力全景 + 系统架构 → docs/images/*.png"""
import sys, io, time, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath('.')
with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge', headless=True)
    pg = b.new_context(viewport={'width': 1200, 'height': 900}, device_scale_factor=2).new_page()
    pg.goto('file:///' + os.path.join(ROOT, 'design-demos', 'diagrams.html').replace(os.sep, '/'))
    time.sleep(0.8)
    pg.locator('#cap').screenshot(path='docs/images/capability-map.png')
    pg.locator('#arch').screenshot(path='docs/images/architecture.png')
    b.close()
for f in ['docs/images/capability-map.png', 'docs/images/architecture.png']:
    print(f, os.path.getsize(f) // 1024, 'KB')
print('done')
