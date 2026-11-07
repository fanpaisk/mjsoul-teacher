#requires -Version 5.1
<#
  组装发行目录：dist/MahjongSoulCoach/

  用法：
    pwsh -File build/assemble.ps1                      # 只打代码（不含运行时/模型），秒级
    pwsh -File build/assemble.ps1 -WithModel           # 带上 mortal_full.pth（约 42 MB）
    pwsh -File build/assemble.ps1 -WithRuntime         # 带上 Python 运行时（约 690 MB，慢）
    pwsh -File build/assemble.ps1 -Zip                 # 额外产出 dist/MahjongSoulCoach-<ver>.zip

  这里只做"把该带的文件挑出来放对位置"，不下载任何东西。
  M2 会把 -WithRuntime 换成打包好的精简运行时（runtime/python/），届时这个开关的语义不变。
#>
param(
  [switch]$WithRuntime,
  [switch]$WithModel,
  [switch]$Zip
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$out = Join-Path $dist 'MahjongSoulCoach'

function Copy-Tree($from, $to, $excludeDirs = @(), $excludeFiles = @()) {
  if (-not (Test-Path $from)) { return }
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  Get-ChildItem $from -Force | ForEach-Object {
    $name = $_.Name
    if ($_.PSIsContainer -and ($excludeDirs -contains $name)) { return }
    if (-not $_.PSIsContainer -and ($excludeFiles -contains $name)) { return }
    $dest = Join-Path $to $name
    if ($_.PSIsContainer) { Copy-Tree $_.FullName $dest $excludeDirs $excludeFiles }
    else { Copy-Item $_.FullName $dest -Force }
  }
}

Write-Host "[1/5] 清理 dist/" -ForegroundColor Cyan
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "[2/5] 复制代码" -ForegroundColor Cyan
Copy-Item (Join-Path $root 'package.json') $out -Force
# 根目录的两个数据依赖（服务端 require('../coach.js')、decode.js 读 liqi_new.json 的 protobuf 描述）
foreach ($f in @('coach.js', 'liqi_new.json')) {
  if (Test-Path (Join-Path $root $f)) { Copy-Item (Join-Path $root $f) $out -Force }
  else { Write-Warning "缺少根文件 $f —— 打包后的服务端会启动失败" }
}
# 发行包默认配置（基线）：公共版锁定复盘模式（DECISIONS D5）。
# 用户改动写到 %APPDATA%\MahjongSoulCoach\config.json，覆盖这里的默认值（app/config.js 按 ROOT→APPDATA 叠加）。
$defaultCfg = [ordered]@{ mode = 'review'; tileDark = $false } | ConvertTo-Json
# 必须写**无 BOM** UTF-8：带 BOM 的 JSON 会让 JSON.parse 抛错，配置被静默忽略
[System.IO.File]::WriteAllText((Join-Path $out 'config.json'), $defaultCfg, (New-Object System.Text.UTF8Encoding($false)))

Copy-Tree (Join-Path $root 'app') (Join-Path $out 'app') @('node_modules') @()
Copy-Tree (Join-Path $root 'live') (Join-Path $out 'live') `
  @('v2', '__pycache__', 'games', 'assets', 'node_modules') `
  @('live_coach.md', 'live_test_output.md', 'live_observed.log', 'server.log',
    'mjb_bot.zip', 'crash_context.json', 'fed_bisect.jsonl', 'fed_live.jsonl',
    'game_frames_short.jsonl', 'live_last_game_actions.json',
    's42-inference.pth', 'mortal.pth')   # 与 mortal_full.pth 重复 / lite 兜底，公共包只认 S42

# 夹带的前端素材：只保留面板必须的 pai.svg（bg.mp4 / emo/ 是用户版权素材，不入包）
New-Item -ItemType Directory -Force -Path (Join-Path $out 'live/assets') | Out-Null
if (Test-Path (Join-Path $root 'live/assets/pai.svg')) {
  Copy-Item (Join-Path $root 'live/assets/pai.svg') (Join-Path $out 'live/assets') -Force
}

Write-Host "[3/5] 裁剪 libriichi（只留 Windows + Python 3.12）" -ForegroundColor Cyan
$lib = Join-Path $out 'live/mjb/libriichi'
if (Test-Path $lib) {
  Get-ChildItem $lib -File | Where-Object { $_.Name -notlike '*3.12-x86_64-pc-windows-msvc*' } | Remove-Item -Force
  $kept = Get-ChildItem $lib -File | Measure-Object Length -Sum
  Write-Host ("      保留 {0} 个文件 / {1:N1} MB" -f $kept.Count, ($kept.Sum / 1MB))
}

Write-Host "[4/5] 运行时与模型" -ForegroundColor Cyan
# Node 运行时：必须自带。托盘会优先用 runtime\node\node.exe，
# 否则"干净机器上没装 Node"这个最基本的产品要求就不成立。
$nodeSrc = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($nodeSrc -and (Test-Path $nodeSrc)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $out 'runtime\node') | Out-Null
  Copy-Item $nodeSrc (Join-Path $out 'runtime\node\node.exe') -Force
  $mb = [math]::Round((Get-Item (Join-Path $out 'runtime\node\node.exe')).Length / 1MB, 1)
  Write-Host ("      已带 Node 运行时 {0}（{1} MB）" -f (Split-Path $nodeSrc -Leaf), $mb)
} else {
  Write-Warning '没在 PATH 里找到 node.exe —— 发行包在没装 Node 的机器上会起不来'
}
if ($WithModel) {
  $pth = Join-Path $root 'live/mjb/mortal_full.pth'
  if (Test-Path $pth) { Copy-Item $pth (Join-Path $out 'live/mjb') -Force; Write-Host '      已带模型 mortal_full.pth' }
  else { Write-Warning '没找到 live/mjb/mortal_full.pth，跳过' }
}
if ($WithRuntime) {
  # 开发环境：找 engine/akagi/<任意版本>/runtime/python/<arch>/
  $py = Get-ChildItem (Join-Path $root 'engine/akagi') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'runtime/python' } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $py) { throw '找不到 engine/akagi/*/runtime/python/' }
  $arch = Get-ChildItem $py -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path (Join-Path $out 'runtime/python') | Out-Null
  Write-Host "      复制 $($arch.FullName) （约 600 MB，需要几分钟）"
  Copy-Item (Join-Path $arch.FullName '*') (Join-Path $out 'runtime/python') -Recurse -Force
}

Write-Host "[5/5] 统计" -ForegroundColor Cyan
$sum = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum)
$cnt = (Get-ChildItem $out -Recurse -File).Count
Write-Host ("      产物: {0}" -f $out)
Write-Host ("      体积: {0:N1} MB / {1} 个文件" -f ($sum.Sum / 1MB), $cnt)

if ($Zip) {
  $ver = (Get-Content (Join-Path $out 'package.json') -Raw | ConvertFrom-Json).version
  $zipPath = Join-Path $dist ("MahjongSoulCoach-{0}.zip" -f $ver)
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path $out -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host ("      zip: {0} ({1:N1} MB)" -f $zipPath, ((Get-Item $zipPath).Length / 1MB))
}
