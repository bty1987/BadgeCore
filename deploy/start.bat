@echo off
rem BadgeCore 内网一键启动（Windows）——后台 8200 + 接收端 8100
rem 首次启动自动建库 + 创建管理员 admin/admin123 + 生成入库令牌（自动注入接收端）。
rem 如需讯飞实时转写，把 asr.config.json 放到 hardware\receiver\（已就位）。

setlocal
cd /d "%~dp0.."

rem --- 后台 ---
start "BadgeCore-Server" cmd /k "cd server && node index.js"

rem --- 接收端：自动带入库通道（录音结束自动进后台并触发 AI 分析） ---
set BADGE_SERVER=http://localhost:8200
if exist server\data\ingest-token.txt (
  set /p BADGE_TOKEN=<server\data\ingest-token.txt
) else (
  set BADGE_TOKEN=
  echo [提示] 首次运行请先启动后台一次以生成令牌，或重启本脚本。
)
start "BadgeCore-Receiver" cmd /k "cd hardware\receiver && node receiver.js"

echo 已启动：后台 http://localhost:8200 （admin/admin123）+ 接收端 8100
echo 板子配网 OTA 地址填: http://%COMPUTERNAME%:8100/xiaozhi/ota/ 或 http://<本机IP>:8100/xiaozhi/ota/
endlocal
