# BadgeCore 硬件开发日志

> 记录硬件选型、采购、到货、调试全过程。开发期载体与量产硬件分开管理。

## 一、量产硬件方案（02 册，方案商 Turnkey 路线）

- 主控首选：恒玄 BES2600（4麦阵列+BLE，音频 DSP 强）
- 备选：SiFli SF32LB52x（带屏低功耗，DayoTag 同款，全员模式强）
- 传感器：4× MEMS 数字麦（16kHz/24bit，5m 拾音）、NFC 安全单元（门禁）、2.13″ 墨水屏、六轴 IMU（佩戴检测）
- 传输：一期 BLE 5.3 桥接手机 App；二期 4G 版
- 续航目标：录音 ≥12h / 全员待机 ≥5 天；BOM ≤180 元
- 行动项：拿 02 册需求表找 3 家深圳方案商询价（固件源码交付是必要条件）

## 二、开发期载体（本目录管理的实物）

### 已采购

| 日期 | 物品 | 价格 | 渠道 | 用途 | 状态 |
|---|---|---|---|---|---|
| 2026-09-07 | 微雪 ESP32-S3-Touch-AMOLED-1.75C（双麦阵列/1.75″圆屏AMOLED/BLE5/WiFi/锂电管理/铝壳） | ¥220 | 微雪官方 | 软件全链路开发载体：录音采集→降噪→OPUS 推流→云端管道；BLE 连 App 协议开发 | ✅ 已验收（09-10） |

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
6. ⏳ **接云端 ASR**：讯飞/火山对比（下一步）
7. ⏳ **BLE 侧**：GATT 协议定义，伴生 App 连调

## 四、当前固件与服务

- 固件：xiaozhi v2.4.2（esp32-s3-touch-amoled-1.75c 专用构建）
- 服务端：`receiver/receiver.js`（Node.js + ws），OTA 接口 + WS 音频通道 + Ogg 落盘，端口 8100
- 启动：`cd hardware/receiver && npm i && node receiver.js`
- 转写：`python transcribe.py sessions/<文件>.ogg small`（faster-whisper，HF_ENDPOINT 镜像 + HF_HUB_DISABLE_XET=1）
- 录音产物：`receiver/sessions/*.ogg`（标准 Ogg Opus，可直接播放/转写）

## 五、踩坑实录（2026-09-10 首次刷机）

| # | 坑 | 现象 | 排查/解法 |
|---|---|---|---|
| 1 | 纯充电线 ×2 | 电脑零枚举 USB 设备（板子亮屏=有电，但无数据） | 手机插电脑 10 秒验线法：出现 WPD 便携设备 → 线才可用 |
| 2 | USB 枚举时序 | 下载模式偶发不识别 | 插稳后重做「按住 BOOT→轻点 RST→松 BOOT」；成功标志=`USB JTAG/serial debug unit (VID_303A)` + COM 口 |
| 3 | **1.75 vs 1.75C 固件差异（核心坑）** | 烧 1.75 版固件后无限重启、屏幕显示"出厂页面"残影 | 串口日志实锤：`TCA9554 IO 扩展器 I2C 初始化失败 → abort 循环`。1.75C 的 TCA9554 地址与 1.75 不同。**解法：烧 `1.75c` 专用固件**（官方 v2.2.4 起提供） |
| 4 | AMOLED 残影误导 | 固件崩溃循环中屏幕仍显示上电前画面，误以为"出厂固件还在跑" | 串口日志才是真相来源；AMOLED 断驱动前保持最后一帧 |

**串口日志方法**：PowerShell `System.IO.Ports.SerialPort` 打开 COM 口（115200），DTR/RTS 置真，监听重启输出。

## 六、xiaozhi v2 协议实测要点（写自研服务端必读）

- OTA 响应 JSON 必含 `websocket:{url,token,version}` / `firmware:{version}` / `server_time:{timestamp,timezone_offset}`；固件将 websocket 键值对写入 NVS
- 设备**待机不连 WS**，触发对话（唤醒词/按 BOOT）才建立音频通道；重进配网：RST 重启后**启动画面阶段按一下 BOOT**（源码：kDeviceStateStarting 时 OnClick → EnterWifiConfigMode）
- 设备 hello：`{"type":"hello","version":2,"transport":"websocket","audio_params":{"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}}`；服务端响应必须含 `transport:"websocket"` + `session_id`
- **v2 二进制帧头实测 16 字节**：version(u16BE) type(u8) reserved(u8) timestamp(u64BE, 偏移4-11) payload_size(u32BE, 偏移12-15)——固件源码 struct 推断为 12 字节是错的，timestamp 是 u64
- OpusTags 最小 16 字节（Magic8+vendor_len4+comment_count4），写 15 会越界
- 会话生命周期：hello → listen start → OPUS 帧流 → close；帧数×60ms=语音时长
