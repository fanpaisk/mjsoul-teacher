#requires -Version 5.1
<#
  编译托盘外壳。用 Windows 自带的 .NET Framework csc.exe（不需要装任何编译器）。

  用法：powershell -File build\build-tray.ps1 [-OutDir <目录>]
  默认输出到 dist\MahjongSoulCoach\CoachTray.exe
#>
param([string]$OutDir = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $OutDir) { $OutDir = Join-Path $root 'dist\MahjongSoulCoach' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$csc = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '找不到 .NET Framework 的 csc.exe（Windows 自带，通常不会缺）' }

$src = Join-Path $PSScriptRoot 'tray\CoachTray.cs'
$exe = Join-Path $OutDir 'CoachTray.exe'

# 图标：没有就现场生成（build\icon.ico），有就编译进去
$ico = Join-Path $PSScriptRoot 'icon.ico'
if (-not (Test-Path $ico)) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'make-icon.ps1')
}

Write-Host "编译 $src" -ForegroundColor Cyan
$cscArgs = @('/nologo', '/target:winexe', '/optimize+', "/out:$exe",
  '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll')
if (Test-Path $ico) { $cscArgs += "/win32icon:$ico" }
$cscArgs += $src
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc 编译失败（exit $LASTEXITCODE）" }

$size = (Get-Item $exe).Length / 1KB
Write-Host ("  → {0} ({1:N1} KB)" -f $exe, $size) -ForegroundColor Green

# 冒烟：--selftest 只做初始化并退出（不弹窗、不驻留）
$stamp = Join-Path $env:TEMP 'coachtray-selftest.txt'
if (Test-Path $stamp) { Remove-Item $stamp -Force }
$p = Start-Process $exe -ArgumentList '--selftest' -PassThru -Wait
if (Test-Path $stamp) {
  Write-Host ("  selftest: {0}" -f (Get-Content $stamp -Raw).Trim()) -ForegroundColor Green
} else {
  Write-Warning "  selftest 没写出结果文件（exit $($p.ExitCode)）"
}
