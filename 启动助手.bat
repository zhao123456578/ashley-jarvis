@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Ashley 桌面助手 —— 关掉这个窗口就退出程序
echo.
echo   正在启动 Ashley 桌面语音助手 ...
echo   启动需要几秒到十几秒，之后请看屏幕右下角的托盘图标（黑金头盔）。
echo   想关闭程序：关掉这个窗口，或右键托盘图标选「退出」。
echo.
call pnpm dev
echo.
echo   程序已退出。按任意键关闭本窗口。
pause >nul
