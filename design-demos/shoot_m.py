# -*- coding: utf-8 -*-
"""截取移动端 H5 界面截图（public/m/ 六页核心五图，390x844 移动视口）

前置：本地起服务（PORT=8211 + 演示数据），并已完成：
  ①李明(lm123456)/王芳 两个销售账号 ②两台设备（BC-8827A1 绑李明）③4 条沟通已 mock 分析
  ④2 个会议（周一例会含归属沟通）⑤今日日程 2 条 ⑥todos 3 条
用法：python shoot_m.py
"""
import sys, io, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8211'
PAGES = [
    ('m-home',     '/m/index.html'),   # 首页：待办+今日日程+我的设备
    ('m-comms',    '/m/comms.html'),   # 沟通列表：搜索+状态 chips+卡片流
    ('m-comm',     '/m/comm.html?id=1'),  # 沟通详情：信息头+AI 摘要+行动项+待办
    ('m-meetings', '/m/meetings.html'),   # 会议列表
    ('m-me',       '/m/me.html'),         # 我的：用户卡+工牌状态+退出
]

with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge', headless=True)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    pg = ctx.new_page()
    # 登录一次（login.html 支持 ?next= 回跳，这里手动进 index）
    pg.goto(BASE + '/login.html?next=%2Fm%2Findex.html')
    pg.fill('#name', '李明')
    pg.fill('#pass', 'lm123456')
    pg.click('button.primary')
    pg.wait_for_url('**/m/index.html', timeout=8000)
    pg.screenshot(path='design-demos/live/m-home.png', full_page=True)
    print('shot m-home')
    for name, path in PAGES[1:]:
        pg.goto(BASE + path)
        time.sleep(1.4)
        pg.screenshot(path=f'design-demos/live/{name}.png', full_page=True)
        print('shot', name)
    b.close()
print('done')
