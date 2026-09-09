@echo off
chcp 65001 >nul
title Mahjong Soul Coach - Review last game
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.js not found in PATH. Please install node.js first.
  pause
  exit /b 1
)

echo ============================================
echo   Review the last game (coach must be on
echo   while you played). Report: review_*.md
echo ============================================
set /p SEAT=Your seat 0/1/2/3 (press Enter for 0):
if "%SEAT%"=="" set SEAT=0
node review.js --last %SEAT%
pause
