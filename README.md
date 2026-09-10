# BadgeCore · 员工数字工牌

> 软硬一体的全员工牌产品：对全员是「身份 + 考勤 + 门禁 + 通知」智能终端，对销售/服务团队是「AI 沟通赋能」工具。
> 命名沿用项目惯例（EcoCore / EyeCore → BadgeCore）。
> 仓库：https://gitee.com/bty1987/BadgeCore.git

## 当前进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| 对标拆解 | ✅ 完成 | SaleSmart（x-mate.com）逆向 + 实测，9 册 PRD 输出 |
| PRD v0.1 | ✅ 完成 | `prd/` 目录，待内部评审 |
| 硬件选型 | ✅ 完成 | 开发载体微雪 ESP32-S3-Touch-AMOLED-1.75C 已验收 |
| 软件管道 | ✅ 打通 | 录音推流 → 自研服务端 → OPUS → 转写（`hardware/receiver/`） |
| 云 ASR 接入 | ⏳ 进行中 | 讯飞/火山对比本地 whisper（06 册 POC） |
| 产品硬件 | ⏳ 未启动 | 方案商 Turnkey 路线（02 册 B 路线） |

## 目录导航

```
BadgeCore/
├── README.md              ← 本文件
├── DECISIONS.md           ← 决策日志（为什么这么定，重要）
├── prd/                   ← 9 册 PRD（00 导航必读）
├── research/              ← SaleSmart 拆解档案 + DayoTag 评估
│   └── code/              ← 对标产品前端代码包 + 文案库1531条
├── evidence/              ← 实测证据（截图 + 页面文本）
├── hardware/              ← 硬件开发日志（选型/采购/到货清单/协议要点）
│   └── receiver/          ← 自研接收服务端（Node.js）
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
# 启动接收服务端（板子配网高级选项 OTA 地址指向本机即可切流）
cd hardware/receiver && npm i && node receiver.js   # 监听 8100

# 转写录音
python transcribe.py sessions/<xxx>.ogg small       # faster-whisper
```

## 隐私与安全提示

- `evidence/` 内截图含本人真实姓名与组织信息，仓库仅限内部，转公开前必须脱敏
- 对标产品的账号凭证、登录态（browser-drive/profile）永不入库
