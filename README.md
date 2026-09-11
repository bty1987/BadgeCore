# BadgeCore · 员工数字工牌

> 软硬一体的全员工牌产品：对全员是「身份 + 考勤 + 门禁 + 通知」智能终端，对销售/服务团队是「AI 沟通赋能」工具。
> 命名沿用项目惯例（EcoCore / EyeCore → BadgeCore）。
> 仓库：https://gitee.com/bty1987/BadgeCore.git

## 当前进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| 对标拆解 | ✅ 完成 | SaleSmart 逆向 + 实测，9 册 PRD；2026-09-11 代码包重抓（121 路由/43 命名页，pages-inventory.md） |
| PRD v0.1 | ✅ 完成 | `prd/` 目录；企业内部使用，v0.1 即工作基线（D11，不做正式评审） |
| 硬件选型 | ✅ 完成 | 开发载体微雪 ESP32-S3-Touch-AMOLED-1.75C 已验收 |
| 软件管道 | ✅ 打通 | 录音推流 → 服务端 → OPUS → 转写；receiver v0.3 含实时转写（`hardware/receiver/`） |
| 云 ASR 接入 | ⏳ 待 Key | 讯飞听写（实时+文件）与语音转写（说话人分离）客户端均已交付，待 Key 实测（D11/D12） |
| LLM 分析管道 | ✅ Mock 通过 | 06 册 AI-04~06 报告管道（`server/analysis.js`），换真实供应商仅需设置页填 Key |
| 管理后台 | ✅ v0.2 | 对标菜单树补齐（D16）+ 数据看板/团队报告（D17 重抓后补，冒烟 90/90） |
| Ask AI | ✅ 简版 RAG | 关键词检索+权限过滤+来源引用（AI-08，升级路径=向量库，D14） |
| AI 智能体 | ✅ Mock 版 | 访前准备清单（AI-10）+ 定时报告推送→站内信（AI-11），D15 |
| 合规功能 | ✅ 最小批次 | 脱敏双层（CMP-07）/ 留存清理+下限（CMP-08）/ 导出水印（CMP-13），D15；缓期项见 D15 |
| 实时辅助 | ✅ 规则层 | 竞品/风险词自动告警：入库告警+receiver 实时关键词（AI-09 一期，D14） |
| 全员考勤 | ✅ 服务端 | ALL-201 判定算法/补卡/记录（05 册，待信标网关实物接入，D14） |
| 产品硬件 | ⏳ 暂缓 | 开发板验证全链路后再启动方案商询价（D11） |

## 目录导航

```
BadgeCore/
├── README.md              ← 本文件
├── DECISIONS.md           ← 决策日志（为什么这么定，重要）
├── prd/                   ← 9 册 PRD（00 导读必读）
├── research/              ← SaleSmart 拆解档案 + DayoTag 评估
│   └── code/              ← 对标产品前端代码包 + 文案库1531条
├── evidence/              ← 实测证据（截图 + 页面文本）
├── hardware/              ← 硬件开发日志（选型/采购/到货清单/协议要点）
│   └── receiver/          ← 接收服务端（录制+实时转写+模拟设备，Node.js）
├── server/                ← 管理后台 + LLM 分析管道（零依赖栈 D13）
│   ├── index.js           ← API + 静态页服务 + AI-11 调度器（8200）
│   ├── analysis.js        ← 沟通分析管道（OpenAI 兼容 + Mock）
│   ├── redact.js · retention.js · attendance.js ← 合规与算法模块（含 CLI 自测）
│   ├── smoke-test.js      ← 冒烟测试（58 项）
│   └── public/            ← Web 前端（登录/沟通报告/配置/设置）
├── deploy/                ← 部署（Windows start.bat / Docker compose）
└── tools/                 ← 工具脚本
```

> 浏览器抓取工具暂存于旧工作区 `xmate-research/browser/`（driver.js + send.sh，playwright-core 驱动 Edge），其 `profile/` 目录含登录态，**严禁提交仓库**（已在 .gitignore 排除）。

## 关键结论速查

1. **产品定位**：全员模式（低功耗身份/考勤/门禁/通知）+ 业务模式（录音分析），双模式硬件级隔离
2. **对标基线**：SaleSmart 功能面 1:1 纳入 P0（沟通配置九大域 / 违规语义检测 / Ask AI）
3. **差异化**：市面无「全员工牌」产品，这是采购决策升级的核心卖点
4. **硬件路线**：一期方案商 Turnkey（务实自研），演进全自研；开发载体 ESP32-S3 生态
5. **合规一票否决**：录音双告知 / 员工数据分域 / AI 生成标识（07 册）

## 快速开始（开发）

```bash
# ① 后台（http://localhost:8200，admin/admin123；首次启动自动建库+生成入库令牌）
cd server && node index.js                          # 零依赖，Node ≥22.5 即可

# ② 接收端（板子配网高级选项 OTA 地址指向本机即可切流）
cd hardware/receiver && npm i && node receiver.js   # 监听 8100；配了讯飞凭据则边录边出字

# ③ 打通自动入库（receiver 环境变量，令牌见后台「设置」页）
set BADGE_SERVER=http://localhost:8200
set BADGE_TOKEN=<后台设置页的入库令牌>
#   → 设备录音结束自动进后台，配了 LLM（或 mock）即自动出分析报告

# 没有板子也能全链路联调
node sim-device.js --seconds 5                      # 模拟设备推音频流

# 转写录音
python transcribe.py sessions/<xxx>.ogg small       # 本地 faster-whisper
node asr-xunfei.js sessions/<xxx>.ogg               # 云端·讯飞听写（需 asr.config.json）
node asr-xf-transcribe.js sessions/<xxx>.ogg        # 云端·讯飞转写（说话人分离，需订阅转写时长）

# 后台冒烟测试（自包含临时库）
cd server && node smoke-test.js
```

内网部署：Windows 双击 `deploy/start.bat`；Linux 用 `deploy/docker-compose.yml`。

## 隐私与安全提示

- `evidence/` 内截图含本人真实姓名与组织信息，仓库仅限内部，转公开前必须脱敏
- 对标产品的账号凭证、登录态（browser-drive/profile）永不入库
