# -*- coding: utf-8 -*-
"""REC-05 录音回放对照实页验证：#14 真实 154s 会议（时间戳精确）+ #4 近似定位兜底"""
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
    pg.wait_for_url('**/index.html'); time.sleep(1.2)

    # #14：带时间戳的会议录音
    pg.goto(BASE + '/communication.html?id=14'); time.sleep(2.2)
    lines = pg.locator('.tr-line')
    print('#14 句子数：', lines.count(), '；音频条：', pg.locator('#audio').count())
    t5 = lines.nth(5).get_attribute('data-t')
    lines.nth(5).click(); time.sleep(1.2)
    ct = pg.evaluate("document.getElementById('audio').currentTime")
    paused = pg.evaluate("document.getElementById('audio').paused")
    print(f'点击第 6 句（data-t={t5}）→ currentTime={ct:.1f}s playing={not paused}')
    hl = pg.evaluate("document.querySelectorAll('.tr-line[style*=\"background\"]').length")
    print('当前句高亮行数：', hl)
    pg.screenshot(path='design-demos/live/audio-detail-14.png')

    # #4：无时间戳纯文本（mock 数据无音频，音频条应隐藏）
    pg.goto(BASE + '/communication.html?id=4'); time.sleep(1.8)
    print('#4 音频条（无 audio_path 应无）：', pg.locator('#audio').count(), '；句子数：', pg.locator('.tr-line').count())

    print('errors:', errors or '(none)')
    b.close()
print('done')
