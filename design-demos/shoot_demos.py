# -*- coding: utf-8 -*-
"""对本地 HTML 文件截图（缩略图页 + 三方向完整版）"""
import sys, io, time, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

JOBS = [
    ('design-demos/thumbs.html',            'design-demos/thumbs.png',            1620, 1250, False),
    ('design-demos/dir-1.html',             'design-demos/dir-1.png',             1440, 900,  True),
    ('design-demos/dir-2.html',             'design-demos/dir-2.png',             1440, 900,  True),
    ('design-demos/dir-3.html',             'design-demos/dir-3.png',             1440, 900,  True),
]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge', headless=True)
    for src, out, w, h, interactive in JOBS:
        pg = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1.5).new_page()
        pg.goto('file:///' + os.path.join(ROOT, src).replace('\\', '/'))
        time.sleep(0.9)
        if interactive:
            # 截销售工作台状态
            pg.screenshot(path=out.replace('.png', '-sales.png'))
            # 点开切换器浮层截一张
            try:
                pg.click('#ws-btn'); time.sleep(0.35)
                pg.screenshot(path=out.replace('.png', '-switcher.png'))
                # 切到管理后台再截
                pg.click('[data-ws="admin"]'); time.sleep(2.6)
                pg.screenshot(path=out.replace('.png', '-admin.png'))
                pg.keyboard.press('Escape')
            except Exception as e:
                print('  [warn]', src, e)
        else:
            pg.screenshot(path=out, full_page=True)
        print('shot', out)
    b.close()
print('done')
