#requires -Version 5.1
<#
  一条命令出包：代码 + 权重 + 托盘 exe（+ 安装器，如果装了 Inno Setup）

  用法：
    powershell -File build\package.ps1              # 出 dist\MahjongSoulCoach\
    powershell -File build\package.ps1 -Installer   # 额外出 dist\MahjongSoulCoach-Setup-<ver>.exe
    powershell -File build\package.ps1 -WithRuntime # 带上 Python 运行时（慢，690MB）
#>
param(
  [switch]$Installer,
  [switch]$WithRuntime,
  [switch]$Zip
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ver = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "雀魂教练 v$ver 打包" -ForegroundColor Cyan

$assembleArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'assemble.ps1'), '-WithModel')
& powershell @assembleArgs
if ($LASTEXITCODE -ne 0) { throw 'assemble 失败' }

# 运行时用裁剪后的版本（不是 assemble 的整拷）：
# 691.6 MB/20407 文件 → 503.3 MB/6982 文件，脚本里带 import torch 冒烟
if ($WithRuntime) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'curate-runtime.ps1')
  if ($LASTEXITCODE -ne 0) { throw '运行时裁剪失败（看上面的 import 报错）' }
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-tray.ps1')
if ($LASTEXITCODE -ne 0) { throw '托盘编译失败' }

if ($Installer) {
  $iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"    # winget 装到用户目录
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $iscc) {
    Write-Warning '没装 Inno Setup 6。装一次即可：winget install JRSoftware.InnoSetup'
    Write-Warning '跳过安装器；dist\MahjongSoulCoach\ 已经可用。'
  } else {
    Write-Host "编译安装器（$iscc）…" -ForegroundColor Cyan
    & $iscc "/DMyVersion=$ver" (Join-Path $PSScriptRoot 'installer.iss')
    if ($LASTEXITCODE -ne 0) { throw 'ISCC 编译失败' }
  }
}

if ($Zip) {
  $outDir = Join-Path $root 'dist\MahjongSoulCoach'
  $zipPath = Join-Path $root ("dist\MahjongSoulCoach-{0}-portable.zip" -f $ver)
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Write-Host '压缩便携版…' -ForegroundColor Cyan
  Compress-Archive -Path $outDir -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host ("便携版：{0}（{1:N1} MB）" -f $zipPath, ((Get-Item $zipPath).Length / 1MB)) -ForegroundColor Green
}

$out = Join-Path $root 'dist\MahjongSoulCoach'
$sum = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum)
Write-Host ("完成：{0}（{1:N1} MB / {2} 文件）" -f $out, ($sum.Sum / 1MB), (Get-ChildItem $out -Recurse -File).Count) -ForegroundColor Green
