# BadgeCore 硬件开发日志

> 记录硬件选型、采购、到货、调试全过程。开发期载体与量产硬件分开管理。

## 一、量产硬件方案（02 册，方案商 Turnkey 路线）

- 主控首选：恒玄 BES2600（4麦阵列+BLE，音频 DSP 强）
- 备选：SiFli SF32LB52x（带屏低功耗，DayoTag 同款，全员模式强）
- 传感器：4× MEMS 数字麦（16kHz/24bit，5m 拾音）、NFC 安全单元（门禁）、2.13″ 墨水屏、六轴 IMU（佩戴检测）
- 传输：一期 BLE 5.3 桥接手机 App；二期 4G 版
- 续航目标：录音 ≥12h / 全员待机 ≥5 天；BOM ≤180 元
- 行动项：拿 02 册需求表找 3 家深圳方案商询价（固件源码交付是必要条件）——2026-09-11 D11 推迟：开发板先验证录音→转写全链路

## 二、开发期载体（本目录管理的实物）

### 已采购

| 日期 | 物品 | 价格 | 渠道 | 用途 | 状态 |
|---|---|---|---|---|---|
| 2026-09-07 | 微雪 ESP32-S3-Touch-AMOLED-1.75C（双麦阵列/1.75″圆屏AMOLED/BLE5/WiFi/锂电管理/铝壳） | ¥220 | 微雪官方 | 软件全链路开发载体：录音采集→降噪→OPUS 推流→云端管道；BLE 连 App 协议开发 | ✅ 已验收（09-10） |
| 2026-09-21 | FoloToy AI Passport（TRAE 联名③号板：ESP32-C3/8MB/ST7789 240×320 无触摸/ES8311/NTAG213 NFC/三按键/520mAh） | ¥99 | FoloToy 官方淘宝 | 第二卡片候选（P4 板级适配）+C3 路线验证机：出厂固件已全量备份，待体验原厂→试刷 | ✅ 已刷小智自编译固件（09-23） |

### ③ FoloToy AI Passport 小智试驾（2026-09-23，✅ 编译/烧录/启动全通）

- **v2.5.1 三件套上线（2026-09-24，全实测）**：①背光自动策略（挂框架 SetPowerSaveLevel：活动 100%/空闲 25%，config.h 常量可调；另发现 MCP 自带 `self.screen.set_brightness` 可语音调亮度）②身份实时推送（WS `type:"identity"` 消息秒换显 + receiver watch 配置文件目录保存即广播）③OTA 自分发（receiver 伺服 `receiver/firmware/xiaozhi-<版本>.bin`，设备开机+空闲每 5 分钟自检自动升级——2.5.1 烧录后 +5:00 整首检实测，同版本严格不重升）。发版流程=改 CMakeLists PROJECT_VER→build→bin 改名入 firmware/。补丁 7 文件 +207 行。
- **上游主线已内置 `folotoy/ai-passport` 板定义**（xiaozhi-esp32 v2.5.0，ST7789P3 init 序列/ES8311/ADC 三键/CW2017 电量计全齐），要求 IDF ≥v6.0.1
- 本机 IDF v6.1 环境落在 `D:\Espressif`（独立目录）：py312 + esp-idf release/v6.1 + 工具链 5.9GB；GitHub 走 ghfast.top 代理、pip 走清华镜像、gitee 缺失子模块按 pinned SHA 从代理手补（坑位表见试驾文档 §0）
- **身份显示定制**（我们的第一个固件补丁，`hardware/firmware/xiaozhi-passport-badge-identity.patch`，3 文件 +115 行）：OTA 响应新增 `identity` 段 → NVS 持久化 → 空闲时屏幕显示身份文字（替代机器人图标），对话自动回原 UI；**改内容只改 receiver 的 badge-identity.json，免重刷固件**；receiver v0.3+ 已带此功能（OTA 响应实测含字段）
- 实测：`xiaozhi.bin` 2.35MB 烧录成功（哈希校验过）→ 串口见 `Board: UUID=… SKU=ai-passport`、`AudioCodec`（ES8311）初始化、free sram ~86KB 稳定
- 待办：配网（Xiaozhi-XXXX 热点 → 192.168.4.1 → WiFi+OTA 填 `http://192.168.5.93:8100/xiaozhi/ota/`）→ 验证身份屏/对话/三键/电量/NVS 保持
- 救砖底线：原厂 8MB 备份在 `tools/firmware-backup/`（`esptool write_flash 0x0 <备份>` 一条命令回原厂）

### ③ FoloToy AI Passport 首连识别（2026-09-23）

- 枚举：`VID_303A&PID_1001`（ESP32-C3 内置 USB-Serial/JTAG）→ COM8；esptool 自动 RTS 复位进下载模式，**免手动 BOOT、免驱动**（Win11 即插即用）
- 芯片：ESP32-C3 QFN32 rev v1.1（Wi-Fi+BT5LE/160MHz 单核），内嵌 XMC 8MB Flash，40MHz 晶振，MAC `4c:11:ae:2f:94:38`
- 出厂固件：`trae_card` v1.0.3（ESP-IDF v5.5.3，编译于 2026-09-07），LVGL + ADC 三按键，背光 GPIO21；分区=factory 3MB + imgstore/imgframe/imguser/imgava（OTA 资源）+ cardid + audio；启动堆 ~188KB（无 PSRAM，与调研一致）
- **原厂 8MB 全量备份（刷任何东西前已完成）**：`tools/firmware-backup/folotoy-ai-passport-factory-8mb-20260923.bin`（esptool read_flash 43.5s）；救砖恢复=`esptool write_flash 0x0 <备份>`
- 新工具：`tools/serial-log.ps1`（串口日志+VID/PID 抓取，`-PortName COM8 -Seconds 10`）；esptool v5.4.0 已装（pip）
- 下一步（P4 定位，按 09-21 验收清单）：①体验出厂固件（配网/三按键/手机 NFC 读 NTAG213）②试刷小智系 C3 板定义验证麦/扬声器/按键（C3 弱核，OPUS 推流吃紧→本地录音+离线补传 REC-08）③确认 NFC 芯片（门禁 ALL-301 预演）④量整机尺寸入外壳参考库

### 评估结论备查（不采购）

| 选项 | 结论 | 原因 |
|---|---|---|
| QS668/CB08 开源录音卡（lomehong/record） | 放弃 | 电商无货；仓库无 LICENSE；其 BLE 协议文档仍可作参考 |
| DayoTag（立创开源） | 转为参考设计 | 24h 全时录音与合规定位冲突；单麦；授权禁止商用；供电树/落盘/IMU 设计可借鉴（SF32LB52x 列 02 册第二候选） |
| 百度度目工牌 | 可选对标 | 大厂闭环生态，买一套作交互对标（400-920-8999） |
| Omi Dev Kit（Based Hardware） | 待定 $79 | 形态最接近工牌，Flutter App 全开源可二开；海淘 1-2 周 |

## 三、到货执行清单（First Run）——✅ 2026-09-10 全部完成

1. ✅ **验机**：USB-C 供电开机，屏幕/触摸正常（踩坑见第五节）
2. ✅ **刷小智官方固件**：xiaozhi v2.4.2（**必须选 1.75C 专用构建**），连官方服务器语音对话验证通过
3. ✅ **搭接收端**：`receiver/receiver.js`（Node.js，自研，xiaozhi 协议）
4. ✅ **切流**：板子配网页「高级选项」填 OTA 地址 `http://<本机IP>:8100/xiaozhi/ota/` → 设备自动连自建服务（**无需重编译固件**）
5. ✅ **转写**：faster-whisper small 本地转写通过（「修复完成」「今天到这里正好…」等样本全对）
6. ✅ **接云端 ASR 全部完成**：①讯飞**听写**实测通过（2026-09-12，14.2s 中文样本零字错+数字规整）②**录音文件转写大模型**（说话人分离）实测通过（2026-09-12，34.7s 双声音样本 6s 出结果、2 角色正确分离）。⚠️ 注意：讯飞已将该服务升级为「非实时语音转写大模型」，网关 office-api-ist-dx.iflyaisol.com，签名=参数排序 URL 编码后 HMAC-SHA1 放请求头（signature 只放 header，放 URL 会 100009），上传为二进制流、getResult 需空 JSON body 与沿用上传 signatureRandom；老 lfasr 接口对新用户不可用。免费额度 5 小时按音频时长计，`BADGE_LFASR=off` 可关闭自动分离
7. ✂️ **BLE 侧**：一期取消（D12，内部版 WiFi 直连；BLE GATT 转量产期）

## 四、当前固件与服务

- 固件：xiaozhi v2.4.2（esp32-s3-touch-amoled-1.75c 专用构建）
- 服务端：`receiver/receiver.js` v0.3（Node.js + ws + opusscript），OTA 接口 + WS 音频通道 + Ogg 落盘 + 实时转写（有凭据自动启用，无凭据仅录制），端口 8100
  - 实时转写链路：OPUS 帧 → opusscript 解码 16k PCM → `asr-live.js`（55s 自动换段/断线重连/连续 3 败停用）→ `xfyun-iat.js`（讯飞听写会话）→ 控制台实时出字 + 会话结束写 `<录音>.xf.txt`
  - 模块：`xfyun-iat.js`（讯飞 v2 iat 共享客户端：鉴权/分片/wpgs 拼装）、`asr-xunfei.js`（文件转写 CLI）、`asr-live.js`（实时转写器）、`sim-device.js`（模拟设备，无板子联调）
- 启动：`cd hardware/receiver && npm i && node receiver.js`
- 联调（无板子）：`node sim-device.js --seconds 5 --pace realtime`（模拟设备连本机 receiver 推正弦音）
- 转写（本地）：`python transcribe.py sessions/<文件>.ogg small`（faster-whisper，HF_ENDPOINT 镜像 + HF_HUB_DISABLE_XET=1）
- 转写（云端·讯飞听写，文件版）：`node asr-xunfei.js sessions/<文件>.ogg`——自动 PyAV 解码→16k PCM→40ms 分片推流→超 55s 自动分段→写 `<文件>.xf.txt`；凭据放 `asr.config.json`（照 `asr.config.example.json` 填，已 gitignore，严禁入库）或环境变量 XF_APPID/XF_API_KEY/XF_API_SECRET
- 转写（云端·讯飞转写 lfasr，**说话人分离**）：`node asr-xf-transcribe.js sessions/<文件>.ogg [--speakers 0]`——ogg 自动转 WAV 上传（lfasr 不收 ogg）→轮询→写 `<文件>.spk.txt`（说话人对话体）+ `.spk.json`（bg/ed/speaker 句子数组，后台分析用）；⚠️ 需单独订阅「语音转写」并领取/购买时长；短音频可能排队
- 自动入库：receiver 设 `BADGE_SERVER`+`BADGE_TOKEN`（令牌见后台设置页）→ 会话结束自动 POST /api/ingest（含转写文本），后台按设置自动跑 LLM 分析（D13）
- 录音产物：`receiver/sessions/*.ogg`（标准 Ogg Opus，可直接播放/转写）+ `*.xf.txt`（实时转写全文）

## 五、踩坑实录（2026-09-10 首次刷机）

| # | 坑 | 现象 | 排查/解法 |
|---|---|---|---|
| 1 | 纯充电线 ×2 | 电脑零枚举 USB 设备（板子亮屏=有电，但无数据） | 手机插电脑 10 秒验线法：出现 WPD 便携设备 → 线才可用 |
| 2 | USB 枚举时序 | 下载模式偶发不识别 | 插稳后重做「按住 BOOT→轻点 RST→松 BOOT」；成功标志=`USB JTAG/serial debug unit (VID_303A)` + COM 口 |
| 3 | **1.75 vs 1.75C 固件差异（核心坑）** | 烧 1.75 版固件后无限重启、屏幕显示"出厂页面"残影 | 串口日志实锤：`TCA9554 IO 扩展器 I2C 初始化失败 → abort 循环`。1.75C 的 TCA9554 地址与 1.75 不同。**解法：烧 `1.75c` 专用固件**（官方 v2.2.4 起提供） |
| 4 | AMOLED 残影误导 | 固件崩溃循环中屏幕仍显示上电前画面，误以为"出厂固件还在跑" | 串口日志才是真相来源；AMOLED 断驱动前保持最后一帧 |
| 5 | PyAV 18 (Win) 无法写输出文件 | `av.open('x.ogg','w')` 编码正常但不落盘（读正常） | 编码验证改走 Node opusscript；PyAV 只用于解码（decode-pcm.py） |
| 6 | PyAV 18 逐帧 resample 累积填充 | 小帧（512 样本）逐帧重采样输出比期望多 8%~20% | 先拼成单个大帧再 resample + 末尾 `resample(None)` flush；planes[0] 有对齐填充必须按 `samples×2` 截断 |
| 7 | Git Bash `kill $!` 杀不掉 node | 后台起的 node receiver.js 端口 8100 一直被占（EADDRINUSE） | `netstat -ano \| grep :8100` 找 PID → `taskkill //PID <pid> //F` |
| 8 | 讯飞 EOS 静默提前结束听写会话 | 2.5min 三人会议仅转写前 14s（44 字），后续音频滞留 pending 全丢 | ①听写 business 加 eos=10000 放宽静默门限 ②asr-live onFinal 时设备未结束 → 立即重建会话续录（tools/test-asr-live.js 回归覆盖）；同场会议大模型分离转写 60+ 句/3 角色全部还原 |
| 9 | 后台长驻进程代码陈旧 | 新端点（lfasr 回填等）报 401「未登录」/404 | 后台为长驻进程，**每次功能发版必须重启**；已重启并回填 comm#13/14 分离转写 |

**串口日志方法**：PowerShell `System.IO.Ports.SerialPort` 打开 COM 口（115200），DTR/RTS 置真，监听重启输出。

## 六、xiaozhi v2 协议实测要点（写自研服务端必读）

- OTA 响应 JSON 必含 `websocket:{url,token,version}` / `firmware:{version}` / `server_time:{timestamp,timezone_offset}`；固件将 websocket 键值对写入 NVS
- 设备**待机不连 WS**，触发对话（唤醒词/按 BOOT）才建立音频通道；重进配网：RST 重启后**启动画面阶段按一下 BOOT**（源码：kDeviceStateStarting 时 OnClick → EnterWifiConfigMode）
- 设备 hello：`{"type":"hello","version":2,"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}`；服务端响应必须含 `transport:"websocket"` + `session_id`
- **v2 二进制帧头实测 16 字节**：version(u16BE) type(u8) reserved(u8) timestamp(u64BE, 偏移4-11) payload_size(u32BE, 偏移12-15)——固件源码 struct 推断为 12 字节是错的，timestamp 是 u64
- OpusTags 最小 16 字节（Magic8+vendor_len4+comment_count4），写 15 会越界
- 会话生命周期：hello → listen start → OPUS 帧流 → close；帧数×60ms=语音时长
