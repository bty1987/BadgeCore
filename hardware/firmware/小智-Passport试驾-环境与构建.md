# 小智 × FoloToy AI Passport 试驾：环境、构建与身份显示定制

> 2026-09-23 首驾。上游 `78/xiaozhi-esp32` 主线**已内置 `folotoy/ai-passport` 板定义**（171 板型之一，含 ST7789P3 初始化序列/ES8311/ADC 三键/CW2017 电量计），我们只加了一层「工牌身份显示」定制。
> **状态：✅ 编译成功（xiaozhi.bin 2.35MB）→ 烧录成功（COM8，哈希校验通过）→ 串口实测启动正常（Board UUID/SKU=ai-passport、ES8311 codec 初始化、SRAM 健康）→ receiver identity 字段已验证下发。**

## 0. 本机实踩坑位（重要，重装环境前必读）

| 坑 | 真相 | 解法 |
|---|---|---|
| GitHub 443 直连不通 | 本机网络墙 | git clone 走 `https://ghfast.top/https://github.com/...` 前缀；esptool/组件包走 gitee/清华镜像 |
| gitee 镜像不全 | esp-phy-lib/esp32h2-bt-lib/esp32c3-bt-lib/esp32-wifi-lib/CMock/openthread 等 404 或缺 pinned SHA | 按 `git rev-parse HEAD:<path>` 拿 pinned SHA → `git init <path>` + 从 ghfast 代理 `fetch --depth 1 origin <sha>` 手动补（子模块逐个填，gitee 在下的先试 gitee） |
| IDF「切了分支没切真身」 | checkout 时 .gitmodules 有本地改动会静默失败，树仍在 v5.5 | 先 `git checkout -- .gitmodules` 再 checkout；切完用 `esp_idf_version.h` 宏验证 6.1 |
| MSYS 检测拒绝 idf_tools | Git Bash 的 MSYSTEM 环境变量被 PowerShell 继承 | 脚本开头清 `MSYSTEM*`/`MSYS2*` 环境变量（install-tools.ps1/build-passport.ps1 已内置） |
| Python 3.14 不被支持 | IDF venv 要求 ≤3.12 | 独立装 `D:\Espressif\py312`（华为镜像 silent install），不动机器原 Python |
| constraints 冲突 | CDN 的 v6.1 constraints 钉 idf-component-manager~=3.0，而 requirements 说 ~=2.2（分支漂移） | 先不带 constraints 装一遍，再带 v6.1 constraints 升级到 3.x（最终 manager 3.1.2 全绿） |
| v6.1 工具链重装 | 先前 3.4GB 工具链是按 v5.5 版本号装的，v6.1 视为未装 | 站在 v6.1 树上重跑 `idf_tools.py install --targets esp32c3`（riscv32-esp-elf 15.2.0 主包 963MB，慢速约 1h） |
| clangd-esp 下载失败卡死 export | 它从 github 直连下载被墙，export 又硬性要求 | curl 经 ghfast 代理下到 `tools/dist/<期望文件名>.tar.xz` → `idf_tools.py install esp-clangd` 检测到本地包只解压（秒过） |
| uart-uhci 组件编译错 | 分支 HEAD 比 xiaozhi 组件测试的 v6.1 新，GDMA API 改名 | 见 §4.1 适配代码（managed_components 不入 git，重装组件后需重打） |
| 串口抓日志反把板子搞进下载模式 | DTR+RTS 双真=USJ 下载序列 | serial-log.ps1 打开即置 DTR/RTS=true 会复位；正确姿势：不碰 RTS/DTR 安静读，或用 esptool flash-id 正常复位后读 |
| ninja 偶发 Permission denied | 上一构建进程/杀毒锁 build.ninja | 杀残留 ninja/cmake 进程重跑 |

## 4.1 uart-uhci × IDF v6.1 分支适配（managed_components/78__uart-uhci/src/uart_uhci.cc:204）

```cpp
// Get RX alignment constraints
// ESP-IDF v6.1 renamed gdma_get_alignment_constraints ->
// gdma_get_channel_alignment_constraints and packed the outputs into
// gdma_channel_alignment_info_t.
gdma_channel_alignment_info_t rx_align_info = {};
ESP_ERROR_CHECK(gdma_get_channel_alignment_constraints(rx_dma_chan_, &rx_align_info));
rx_int_mem_align_ = rx_align_info.int_mem_alignment;
rx_ext_mem_align_ = rx_align_info.ext_no_enc_mem_alignment;
```

## 4.2 补丁作者踩的坑（给自己人）

- `GetBadgeIdentityText()` 声明**必须在 `class Ota` 之外**（首版误放类体内成了成员，板级代码命名空间作用域不可见，报 not declared）
- LVGL 定时器结构体在本工程是前置声明，**别直接访问 `lv_timer_t` 成员**——项目惯用 `esp_timer`（见 AiPassportDisplay::SetupUI），回调里再拿 DisplayLockGuard

## 1. 硬件底细（官方 bsp_pins.h 实锤）

| 子系统 | 参数 |
|---|---|
| 主控 | ESP32-C3（QFN32 rev1.1，8MB 内嵌 XMC Flash，无 PSRAM），USB-Serial/JTAG（GPIO18/19） |
| 屏幕 | ST7789P3 240×320 竖屏 SPI2（MOSI=9 SCLK=8 CS=1 DC=20 RST 无软件复位），反显 INVON，背光 GPIO21（LEDC 10bit/5kHz） |
| 音频 | ES8311（I2C addr 0x18，SDA=10 SCL=7）+ I2S0 全双工（MCLK=6 BCLK=5 WS=3 DOUT=2 DIN=4） |
| 按键 | UP/DOWN/OK 三键共 GPIO0（ADC1_CH0 电阻分压：0-150 / 150-447 / 447-1900 mV） |
| 电量 | CW2017（I2C addr 0x63，可缺省） |
| NFC | NTAG213 **被动标签不连 MCU**（只能手机碰读，固件不感知） |

## 2. 本机环境（D:\Espressif，全部独立目录不动系统）

- `python312\`：Python 3.12.10（IDF 不支持本机原有 3.14）
- `esp-idf\`：**ESP-IDF release/v6.1**（xiaozhi 主线要求 ≥v6.0.1，v5.x 已弃）——gitee 镜像克隆 + 子模块混合源（gitee 优先，缺失仓库走 ghfast.top 代理）
- `tools\`：IDF_TOOLS_PATH（esp32c3 工具链，`install-tools.ps1` 安装）
- `xiaozhi-esp32\`：源码（github 经 ghfast.top 代理克隆；**github.com:443 本机直连不通**）
- 关键坑：**Git Bash 继承的 `MSYSTEM` 环境变量会让 idf_tools 拒跑**——所有脚本先清 MSYS 变量（install-tools.ps1 / build-passport.ps1 已内置）

## 3. 构建 / 烧录 / 监视（一条命令各一档）

```powershell
powershell -File D:\Espressif\build-passport.ps1 build    # = python scripts/build.py folotoy/ai-passport
powershell -File D:\Espressif\build-passport.ps1 flash    # = idf.py -p COM8 flash
powershell -File D:\Espressif\build-passport.ps1 monitor  # 串口监视
```

- 板型由 `main/boards/folotoy/ai-passport/config.json` 定义（8MB Flash + `partitions/v2/8m.csv` + USB-Serial-JTAG 控制台 + 关唤醒词），build.py 自动消费
- 烧录免手动 BOOT：esptool 经 USB-Serial/JTAG 自动复位进下载模式
- 救砖：原厂 8MB 全量备份在 `tools/firmware-backup/folotoy-ai-passport-factory-8mb-20260923.bin`，恢复 = `esptool write_flash 0x0 <备份>`

## 4. 身份显示定制（本次新增，补丁见同目录 patch 文件）

**效果**：设备空闲时屏幕居中显示身份内容（替代机器人图标）；一旦对话自动切回小智原 UI；对话结束回空闲又变回工牌面。

**数据链**：receiver OTA 接口下发 `identity` 字段 → 固件解析存 NVS（断电保持，开机先显示上次内容）→ 空闲时 LVGL 定时器渲染。**改显示内容不用重刷固件**——编辑 `hardware/receiver/badge-identity.json` 重启 receiver 即可。

```
// badge-identity.json 两种写法：
{"text": "张三\n工号 0001\n销售部"}                          // 自由文本（推荐，想显示啥显示啥）
{"name": "张三", "employee_id": "0001", "title": "销售顾问"}  // 结构化字段，固件按行拼
```

**补丁内容**（`xiaozhi-passport-badge-identity.patch`，3 文件 +111 行）：
- `main/ota.h` / `main/ota.cc`：解析 OTA 响应 `identity` 段（互斥锁保护，OTA 任务写/LVGL 任务读），NVS 持久化，`GetBadgeIdentityText()` 供板级 UI 读取
- `main/boards/folotoy/ai-passport/ai_passport_board.cc`：`AiPassportDisplay : SpiLcdDisplay` 子类，SetupUI 建身份标签 + 500ms LVGL 定时器（空闲且有身份→显示/藏机器人图标；否则还原）
- **零字体改动**：构建时 assets 分区自动打包 common 档字体（basic ∪ DeepSeek 词表字符），中文姓名开箱即渲染

## 4.3 三件套功能（2026-09-24 上线，v2.5.1 实测通过）

**① 背光自动策略**（常亮问题）：挂接框架现成的 `SetPowerSaveLevel` 钩子（对话/通知→PERFORMANCE，空闲→LOW_POWER，application.cc 十几处主动调用）→ 板级覆写调背光：**活动 100% / 空闲 25%**（`config.h` 两个常量可调），自带 PWM 渐变不闪变。附加发现：设备 MCP 工具自带 `self.screen.set_brightness`，**语音就能调亮度**。

**② 身份实时推送**：设备端 WS 消息分发（application.cc OnIncomingJson）新增 `{"type":"identity","text":...}`（也收 name/employee_id/title 结构体）→ 更新 NVS→屏幕 500ms 内换显；receiver 端：设备 hello 后即推最新身份 + **watch badge-identity.json 所在目录，保存即广播**（watch 目录不 watch 文件，防编辑器"临时文件+改名"跟丢）。离线设备由 ③ 的空闲重检兜底（≤5 分钟）。

**③ OTA 自分发**（固件迭代不再插线）：`idf.py flash` 不再是必经路——receiver 伺服 `hardware/receiver/firmware/` 目录（`xiaozhi-<版本>.bin` 命名，自动取最高版本号），OTA 响应带 `firmware{version,url}`；设备**开机时 + 空闲每 5 分钟**检一次，发现新版本自动下载升级（只在空闲态触发，不打断对话）。发版流程：改 `CMakeLists.txt` 的 `PROJECT_VER` → build → `cp build/xiaozhi.bin receiver/firmware/xiaozhi-<新版本>.bin` → 设备 ≤5 分钟自愈式升级。

> 实测记录：2.5.1 烧录后串口明示 `Current version: 2.5.1`/`Current is the latest version`/`Running partition: ota_0`；烧录完成 +5:00 整触发第一次空闲重检（receiver 日志 08:13:10）。同版本不会被误升级（IsNewVersionAvailable 严格大于才升）。

## 4.4 工牌面布局 v2 + 录音指示 + 电量百分比（2026-09-24，v2.5.2）

在 v2.5.1 三件套之上追加（用户拍板「1+2 + 删头像 + 电量百分比」）：

- **层级排版工牌面**：identity JSON 结构化字段（`name/employee_id/title/company`）渲染为层级——**姓名 30px 大字**（`font_noto_sans_basic_30_4`，字体组件 GLOB 全量编译，直接 LV_FONT_DECLARE 即用，+246KB Flash）+ 工号/职位 20px 60% 透明度 + 分隔线 + 公司名 50% 透明度；只给 `text` 则维持自由文本模式，两态兼容
- **删机器人头像**：SetupUI 里直接 `lv_obj_del(emoji_label_)` 并置空——本板无 emoji collection，SetEmotion 的 utf8 路径有 emoji_label_ 判空、GIF 路径不会触达（ClearChatMessages 同样判空），删除安全
- **录音指示**：对话态（listening/speaking）左上角红点 + `MM:SS` 计时（500ms 刷新），回空闲自动隐藏——对齐 FIRMWARE-PLAN ② 规范「录音中+时长」的合规门面
- **电量百分比**：上游 lvgl_display 加 `SetBatteryPercentEnabled(bool)`（SetupUI 前调用生效），图标旁显示 `87%`，CW2017 SOC 直读

**发版实录**：2.5.2 编译烧录时板子已被拔走（COM8 消失）→ 走 ③ OTA 自分发实战：bin 入 `receiver/firmware/` → OTA 响应自动下发 2.5.2 → 设备（运行 2.5.1）空闲 5 分钟内自检自升级，或下次开机时升级。这正是免 USB 迭代闭环的第一次真实使用。

## 4.5 v2.5.2 升级循环事故与修复（2026-09-24，重要案例）

**现象**：OTA 升级到 2.5.2「成功」→ 重启 → 又提示升级 → 无限循环（每轮 ~50 秒：2.5.1 开机 30s → 升级 → 2.5.2 崩 → 回滚）。

**定位过程**（无串口盲猜无效，USB 串口 150 秒抓完整循环实锤）：
1. 日志分段对比 8 次启动：奇数次（2.5.2）全部崩在 `Assets: checksum` 之后、`Refreshing display theme` 之前；偶数次（2.5.1）健康
2. addr2line 解码 panic：`Load access fault` @ `lv_obj_set_local_style_prop` ← `LcdDisplay::SetTheme` ← `LvglDisplay::SetTextFont` ← `Assets::LvglStrategy::Apply`
3. 读 SetTheme 源码：**第 1285 行 `lv_obj_set_style_text_color(emoji_label_, ...)` 无判空**

**根因**：2.5.2 在 SetupUI 里 `lv_obj_del(emoji_label_)` 删机器人头像 → 主题刷新时上游 SetTheme 无守卫地给这个已删除（置空）的标签设样式 → 空指针（MTVAL 0x28 = lv_obj 样式字段偏移）→ 崩溃 → 引导程序回滚 2.5.1 → 又见「新版」→ 死循环。

**修复（2.5.3）**：**不删对象，改永久隐形**——`LV_OBJ_FLAG_HIDDEN` + `LV_OPA_TRANSP`（SetEmotion 会取消隐藏，但透明度不恢复，头像任何状态都不可见）；emoji_image_ 同样处理。上游零改动。

**教训**：①删上游管理的 LVGL 对象前，必须 grep 它在全代码库的所有引用点（不只判断过的那几个）；`SetTheme` 这种低频路径（主题刷新）最容易漏。②「升级成功」只代表刷写成功，不代表新固件能活——OTA 循环 = 新固件启动即崩的标准症状。③ESP-IDF 回滚机制（PENDING_VERIFY）在这种场景下正确地保护了设备（始终能退回 2.5.1），循环不停是因为每次 2.5.1 开机都会重新看到「新版」。

## 4.6 配网锁定与受管化（2026-09-26，编译通过待上机）

**威胁**：设备配网入口当前无门槛——无 SSID 开机 / WiFi 连接超时 60s / 按键路径都会开**无密码热点** `Xiaozhi-XXXX`，任何人连上 `192.168.4.1` 即可改 WiFi、**改 OTA 服务器地址**（NVS `wifi`/`ota_url`）——工牌被指向恶意服务器=变成窃听器。受管设备必须封住这个口子。

**方案（D 依据：受管设备原则，业务配置归服务端）**：

1. **配网锁 `provision_lock`（核心）**：服务器经 identity 通道下发（WS `{"type":"identity"}` 与 OTA 响应 `identity` 段同走 `SetBadgeIdentityFromJson`，天然双路），字段三态：`true`=上锁 / `false`=解锁 / 缺失=不变。锁持久 NVS（新 namespace `badge`，key `prov_lock`）。锁定时 `WifiBoard::EnterWifiConfigMode()` 与 `StartWifiConfigMode()` 双拦截（覆盖按键/无 SSID/超时回退全部入口）：不开热点、屏显「设备已锁定，禁止重新配网」、**提前 return 不碰网络连接**（设备保持在线，服务器随时可下发解锁）。
2. **配网热点密码（防窗口期路人）**：esp-wifi-connect 增加 `ap_password` 配置，WPA2-PSK（8..63 字符，超界回退开放热点+告警日志）；密码编译进固件常量 `BADGE_CONFIG_AP_PASSWORD`（wifi_board.cc，当前 `badgecore`，改一行重编即换）。
3. **放弃**：OTA 地址白名单（保存时校验域名）——锁定已封死入口，解锁态属管理员受控窗口，不值得对组件做深度侵入。

**管理员操作流**：锁=`badge-identity.json` 加 `"provision_lock": true`（在线设备秒收，离线设备重连 OTA 检查/WS hello 时拿到，≤5 分钟）；解锁=改 `false`（必须显式，删字段不解锁）。**receiver/后台零改动**（identity JSON 字段全透传）。边界诚实声明：物理拆机 + esptool `erase_flash` 可清锁（=完全出厂），属抢夺级攻击不在防线内；锁定设备丢失不必担心数据（录音在服务器不在卡）。

**改动清单**：①fork 3 文件——`ota.h`（`IsProvisionLocked()` 声明）/`ota.cc`（identity 解析加三态处理+NVSO 读写）/`boards/common/wifi_board.cc`（双拦截+AP 密码接线+`BADGE_CONFIG_AP_PASSWORD` 常量）；**导出补丁 `xiaozhi-passport-provision-lock.patch`（⚠️ 对这三文件是累计 diff，含 2.5.7 身份定制部分，干净上游可直接 apply）**；②**managed_components/78__esp-wifi-connect 4 处（不入 git，重装组件需重打——与 §4.1 uart-uhci 同纪律）**：`include/wifi_configuration_ap.h`（`SetApPassword`+成员）、`include/wifi_manager.h`（config 加 `ap_password`）、`wifi_manager.cc` StartConfigAp 透传、`wifi_configuration_ap.cc` StartAccessPoint 按 WPA2-PSK 应用。③坑：IDF v6 的 `wifi_ap_config_t` **已删 `threshold` 成员**（IDF 5.x 写法会编译错），只设 `authmode` 即可。

**验证状态**：`build-passport.ps1 build` RC=0（2.5.8 产物在 build/ **未发布**——冻结发版攒电量数据中，发布=升版本+拷贝 receiver/firmware/ 待用户指令）。上机验收项：锁定后开机不开热点+屏显锁定；下发 `false` 后恢复配网；配网热点需密码。

## 5. 验收清单（首驾）

- [x] 刷机后开机 → 小智启动（串口实测：`Board: UUID=… SKU=ai-passport`、`AudioCodec: Set output enable`（ES8311）、free sram ~86KB 稳定）
- [ ] **配网**（待物理操作）：板子开机进 WiFi 配置模式 → 手机连 `Xiaozhi-XXXX` 热点 → 浏览器开 `192.168.4.1` → 选家里 WiFi + 「高级选项」填 OTA 地址 `http://192.168.5.93:8100/xiaozhi/ota/` → 保存重启
- [ ] 空闲 → 屏幕显示 `BadgeCore / AI 工牌 · 试驾 / FoloToy Passport`（receiver 已实测下发 identity 字段）
- [ ] 按 OK 说话 → 原小智对话 UI；说完回空闲 → 身份面回归
- [ ] 三键：UP/DOWN 音量±，OK 对话开关；电量图标（CW2017）
- [ ] 拔电重开 → 身份文字仍在（NVS）
- [ ] 改 `badge-identity.json` → 重启 receiver → 设备重连 OTA 后换显（免重刷固件验证）

> 改显示内容 = 编辑 `hardware/receiver/badge-identity.json`（照 example 填）→ 重启 receiver。receiver 已带此功能（v0.3+，OTA 响应实测含 `identity` 字段）。

## 6. 沉淀物清单

| 物 | 路径 |
|---|---|
| 身份显示+三件套补丁（对上游 xiaozhi，7 文件 +207 行） | `hardware/firmware/xiaozhi-passport-badge-identity.patch` |
| 构建产物 | `D:\Espressif\xiaozhi-esp32\build\xiaozhi.bin`（2.35MB，ota_0 @0x20000） |
| 构建/烧录/监视脚本 | `D:\Espressif\build-passport.ps1`（build/flash/monitor 三档，自动清 MSYS 环境） |
| 工具链安装脚本 | `D:\Espressif\install-tools.ps1` |
| 原厂固件备份（救砖） | `hardware/tools/firmware-backup/folotoy-ai-passport-factory-8mb-20260923.bin` |
