@echo off
chcp 65001 >nul
title Mahjong Soul Coach - dark tiles mode
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.js not found in PATH.
  pause
  exit /b 1
)
netstat -ano | findstr ":18766" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo Coach is ALREADY running. Stop it first: TingZhiJiaoLian.bat
  pause
  exit /b 0
)
echo ============================================
echo   Mode: DARK TILES (realtime advice,
echo   tile faces hidden by default, hold to peek)
echo   Starting in background (no window)...
echo   Stop it with: TingZhiJiaoLian.bat
echo ============================================
> "%TEMP%\cjc_start.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%TEMP%\cjc_start.vbs" echo sh.CurrentDirectory = "%~dp0."
>> "%TEMP%\cjc_start.vbs" echo sh.Run "cmd /c node live\live_coach.js --dark-tiles >> server.log 2>&1", 0, False
wscript //nologo "%TEMP%\cjc_start.vbs"
echo Coach started in BACKGROUND (no window).
pause
