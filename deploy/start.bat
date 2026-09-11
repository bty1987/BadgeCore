@echo off
rem BadgeCore 内网一键启动（Windows）——后台 8200 + 接收端 8100
rem 首次启动会自动建库并创建管理员 admin/admin123，入库令牌见后台「设置」页。
rem 如需讯飞实时转写，把 asr.config.json 放到 hardware\receiver\ 再启动。

setlocal
cd /d "%~dp0.."

rem --- 后台（必改：首次启动后到 设置 页复制令牌填到下面 BADGE_TOKEN） ---
start "BadgeCore-Server" cmd /k "cd server && node index.js"

rem --- 接收端（设备 OTA 指向 http://<本机IP>:8100/xiaozhi/ota/） ---
rem set BADGE_SERVER=http://localhost:8200
rem set BADGE_TOKEN=<后台设置页的入库令牌>
start "BadgeCore-Receiver" cmd /k "cd hardware\receiver && node receiver.js"

echo 已启动两个窗口：后台 http://localhost:8200 （admin/admin123）+ 接收端 8100
endlocal
