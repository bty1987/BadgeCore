@echo off
rem BadgeCore 防火墙放行：允许局域网设备（工牌/手机）访问 8100 接收端与 8200 后台
rem 首次运行会弹 UAC 授权框，点「是」即可。

fltmc >nul 2>&1
if errorlevel 1 (
  echo 正在请求管理员权限…
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall add rule name=BadgeCore-8100 dir=in action=allow protocol=TCP localport=8100 profile=any
netsh advfirewall firewall add rule name=BadgeCore-8200 dir=in action=allow protocol=TCP localport=8200 profile=any

echo.
echo 完成：已放行 TCP 8100（接收端）与 8200（后台）。
echo 局域网设备现在可以访问 http://本机IP:8100/xiaozhi/ota/ 与 http://本机IP:8200
pause
