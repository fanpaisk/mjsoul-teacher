@echo off
chcp 65001 >nul
title Mahjong Soul Coach Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.js not found in PATH. Please install node.js first.
  pause
  exit /b 1
)

echo ============================================
echo   Mahjong Soul Coach - local server
echo   Close this window = stop the coach
echo   If it says "already running", just close
echo ============================================
node live\live_coach.js
echo.
echo Server exited.
pause
