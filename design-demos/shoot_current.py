# -*- coding: utf-8 -*-
"""截取 BadgeCore 当前 UI 基线截图（设计改版前的现状留底）"""
import sys, io, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8200'
PAGES = [
    ('login',          '/login.html',                    False),
    ('sales-home',     '/index.html',                    True),
    ('sales-comms',    '/communications.html',           True),
    ('sales-cust',     '/customers.html',                True),
    ('admin-config',   '/config.html?domain=violations', True),
    ('admin-settings', '/settings.html',                 True),
    ('admin-dash',     '/dashboard.html',                True),
]

with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge', headless=True)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1.5)
    pg = ctx.new_page()
    for name, path, need_auth in PAGES:
        if need_auth and name == PAGES[1][0]:  # first auth page: login once
            pg.goto(BASE + '/login.html')
            pg.fill('#name', 'admin')
            pg.fill('#pass', 'admin123')
            pg.click('button.primary')
            pg.wait_for_url('**/index.html', timeout=8000)
            time.sleep(1.2)
            pg.screenshot(path=f'design-demos/current/{name}.png', full_page=True)
            continue
        pg.goto(BASE + path)
        time.sleep(1.6)
        pg.screenshot(path=f'design-demos/current/{name}.png', full_page=True)
        print('shot', name)
    b.close()
print('done')
