# -*- coding: utf-8 -*-
"""实页验证：登录 → 销售/管理关键页 → 切换器往返 → 控制台报错收集"""
import sys, io, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8200'
OUT = 'design-demos/live'
errors = []

with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge', headless=True)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1.5)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'[pageerror] {e}'))
    pg.on('console', lambda m: errors.append(f'[console.{m.type}] {m.text} @ {m.location.get("url","?")}') if m.type == 'error' else None)
    pg.on('response', lambda r: errors.append(f'[http {r.status}] {r.url}') if r.status >= 400 else None)

    # 登录
    pg.goto(BASE + '/login.html'); time.sleep(0.6)
    pg.screenshot(path=f'{OUT}/login.png')
    pg.fill('#name', 'admin'); pg.fill('#pass', 'admin123')
    pg.click('button.primary')
    pg.wait_for_url('**/index.html', timeout=8000); time.sleep(1.5)
    pg.screenshot(path=f'{OUT}/sales-home.png')

    # 切换器：下拉 → 截图 → 切管理后台
    pg.click('#ws-btn'); time.sleep(0.35)
    pg.screenshot(path=f'{OUT}/sales-switcher.png')
    pg.click('.ws-opt[data-ws="admin"]')
    pg.wait_for_url('**/dashboard.html', timeout=8000); time.sleep(1.8)
    pg.screenshot(path=f'{OUT}/admin-dashboard.png')

    # 管理端几个代表页
    for path, name in [('/config.html?domain=violations', 'admin-config'),
                       ('/settings.html', 'admin-settings'),
                       ('/devices.html', 'admin-devices'),
                       ('/org.html', 'admin-org'),
                       ('/notifications.html', 'notifications')]:
        pg.goto(BASE + path); time.sleep(1.4)
        pg.screenshot(path=f'{OUT}/{name}.png')

    # notifications 是销售壳页：从它切回管理端验证另一方向
    pg.click('#ws-btn'); time.sleep(0.3)
    pg.screenshot(path=f'{OUT}/notifications-switcher.png')
    pg.click('.ws-opt[data-ws="admin"]'); time.sleep(2)
    print('notifications -> admin:', pg.url)
    # 管理端切回销售
    pg.click('#ws-btn'); time.sleep(0.3)
    pg.screenshot(path=f'{OUT}/admin-switcher.png')
    pg.click('.ws-opt[data-ws="sales"]')
    pg.wait_for_url('**/index.html', timeout=8000); time.sleep(1.2)

    # 销售端代表页
    for path, name in [('/communications.html', 'sales-comms'),
                       ('/customers.html', 'sales-cust'),
                       ('/cases.html', 'sales-cases')]:
        pg.goto(BASE + path); time.sleep(1.6)
        pg.screenshot(path=f'{OUT}/{name}.png')

    # Ctrl+Shift+S 快速切换（admin 用户在销售端 → 应回管理端上次页）
    time.sleep(1.5)
    pg.keyboard.press('Control+Shift+S'); time.sleep(2.5)
    print('after hotkey url:', pg.url)
    b.close()

print('--- errors ---')
print('\n'.join(errors) if errors else '(none)')
print('done')
