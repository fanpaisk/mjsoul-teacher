@echo off
chcp 65001 >nul
title Mahjong Soul Coach - mode select
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.js not found in PATH.
  pause
  exit /b 1
)

echo ============================================
echo   Mahjong Soul Coach - choose mode
echo --------------------------------------------
echo   1. Realtime  (advice while you draw)
echo   2. Review    (advice after you discard)
echo   3. Review + dark tiles (hold to peek)
echo ============================================
choice /c 123 /n /m "Select [1-3]: "
if errorlevel 3 goto m3
if errorlevel 2 goto m2
:m1
set FLAGS=
goto run
:m2
set FLAGS=--review
goto run
:m3
set FLAGS=--review --dark-tiles
goto run
:run
echo Starting with: %FLAGS%
> "%TEMP%\cjc_start.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%TEMP%\cjc_start.vbs" echo sh.CurrentDirectory = "%~dp0."
>> "%TEMP%\cjc_start.vbs" echo sh.Run "cmd /c node live\live_coach.js %FLAGS% >> server.log 2>&1", 0, False
wscript //nologo "%TEMP%\cjc_start.vbs"
echo Coach started in BACKGROUND (no window).
echo Stop it with: TingZhiJiaoLian.bat
pause
