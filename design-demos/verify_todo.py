# -*- coding: utf-8 -*-
"""M4 待办流转实页验证：首页勾选 → 大数字/侧栏联动 → 详情页状态"""
import sys, io, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8200'
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge', headless=True)
    pg = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1.5).new_page()
    pg.on('pageerror', lambda e: errors.append(f'[pageerror] {e}'))
    pg.on('console', lambda m: errors.append(f'[console.{m.type}] {m.text}') if m.type == 'error' else None)

    pg.goto(BASE + '/login.html'); time.sleep(0.8)
    pg.fill('#name', 'admin'); pg.fill('#pass', 'admin123'); pg.click('button.primary')
    pg.wait_for_url('**/index.html', timeout=8000); time.sleep(2)
    pg.screenshot(path='design-demos/live/todo-home-before.png')

    n0 = pg.text_content('#punch-n').strip()
    side0 = pg.text_content('#td-n').strip()
    boxes = pg.locator('.td-ck')
    print(f'勾选前：大数字={n0} 侧栏={side0} 勾选框={boxes.count()} 个')
    assert boxes.count() > 0, '首页无勾选框'

    boxes.first.check(); time.sleep(1.6)  # 触发 toggle + 重新加载
    n1 = pg.text_content('#punch-n').strip()
    side1 = pg.text_content('#td-n').strip()
    print(f'勾选后：大数字={n1} 侧栏={side1}')
    pg.screenshot(path='design-demos/live/todo-home-after.png')
    assert int(n1) == int(n0) - 1, f'大数字未减：{n0}->{n1}'

    # 详情页待办 tab（回看刚勾掉的那条 comm）——从首页待办行文本拿 comm id 不可得，直接开沟通#4
    pg.goto(BASE + '/communication.html?id=4'); time.sleep(1.6)
    pg.click('.tabbar a:nth-child(4)'); time.sleep(0.4)
    pg.screenshot(path='design-demos/live/todo-detail.png')
    print('详情页待办 tab 勾选框：', pg.locator('.td-ck').count(), '个')

    print('errors:', errors or '(none)')
    b.close()
print('done')
