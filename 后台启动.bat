@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.js not found in PATH.
  pause
  exit /b 1
)

rem generate a temp vbs that launches node in a HIDDEN window
> "%TEMP%\cjc_start.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%TEMP%\cjc_start.vbs" echo sh.CurrentDirectory = "%~dp0."
>> "%TEMP%\cjc_start.vbs" echo sh.Run "cmd /c node live\live_coach.js >> server.log 2>&1", 0, False
wscript //nologo "%TEMP%\cjc_start.vbs"

echo ============================================
echo   Coach started in BACKGROUND (no window).
echo   Logs: server.log  Status: in-game badge
echo   Stop it with: TingZhiJiaoLian.bat (stop)
echo ============================================
pause
