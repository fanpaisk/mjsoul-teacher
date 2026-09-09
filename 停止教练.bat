@echo off
setlocal enabledelayedexpansion
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":18766" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1 && set FOUND=1
)
if "!FOUND!"=="1" (
  echo Coach stopped.
) else (
  echo Coach was not running.
)
pause
