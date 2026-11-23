#requires -Version 5.1
<#
  发行目录冒烟测试：不装、不连游戏，只验"这个包放到别人机器上会不会当场坏"。

  用法：powershell -File build\smoke.ps1 [-Dir <发行目录>]
  退出码 0 = 全过；非 0 = 有失败项（失败项会逐条打印）

  覆盖：文件齐全 / 包内 node 能起服务 / 配置默认值 / 三个页面 / 脚本分发版本 /
        诊断包可导出 / 版本握手告警 / 退出后不留监听
#>
param([string]$Dir = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Dir) { $Dir = Join-Path $root 'dist\MahjongSoulCoach' }
if (-not (Test-Path $Dir)) { throw "发行目录不存在：$Dir（先跑 build\package.ps1）" }

$pass = 0; $fail = 0
function Check([bool]$cond, [string]$name, [string]$detail = '') {
  if ($cond) { $script:pass++; Write-Host "  ✓ $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  ✗ $name  $detail" -ForegroundColor Red }
}

Write-Host "冒烟：$Dir" -ForegroundColor Cyan

Write-Host "`n[1] 文件齐全" -ForegroundColor Cyan
foreach ($rel in @('CoachTray.exe', 'config.json', 'package.json', 'coach.js', 'liqi_new.json',
                   'app\web\setup.html', 'app\web\settings.html', 'live\live_coach.js',
                   'live\coach_hook.user.js', 'live\mjb\bot.py', 'live\mjb\mortal_full.pth',
                   'runtime\node\node.exe')) {
  Check (Test-Path (Join-Path $Dir $rel)) "存在 $rel"
}

$ver = (Get-Content (Join-Path $Dir 'package.json') -Raw | ConvertFrom-Json).version
Check ($ver -match '^\d+\.\d+\.\d+$') "版本号合法（$ver）"

# 包内 node；没有就用 PATH 的
$node = Join-Path $Dir 'runtime\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }

Write-Host "`n[2] 启动服务（用包内 node）" -ForegroundColor Cyan
# 端口被占用时不要硬跑：否则冒烟会打到**别人的实例**上，得出一堆假失败
$Base = 'http://127.0.0.1:18766'
$occupied = @(Get-NetTCPConnection -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
if ($occupied) {
  # 端口被正在用的教练占着时，换 18799 跑，避免打到别人的实例上（那会产生一堆假失败）
  $env:COACH_PORT = '18799'
  $Base = 'http://127.0.0.1:18799'
  Write-Host '  18766 被占用，改用 18799 跑冒烟' -ForegroundColor Yellow
}
$proc = Start-Process $node -ArgumentList 'live/live_coach.js' -WorkingDirectory $Dir -PassThru -WindowStyle Hidden
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 400
  try { Invoke-WebRequest "$Base/config" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true; break } catch {}
}
Check $up '服务端在 12 秒内就绪'
if (-not $up) { try { Stop-Process -Id $proc.Id -Force } catch {}; exit 1 }

try {
  $cfg = (Invoke-WebRequest "$Base/config" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  Check ($cfg.version -eq $ver) '/config 版本一致' "包 $ver / 服务端 $($cfg.version)"
  Check ($cfg.mode -eq 'review') '默认模式 = review（公共版边界）' "实际 $($cfg.mode)"
  Check ($cfg.engine.model -eq 'full') '模型 = S42 完整版' "实际 $($cfg.engine.model)"

  Write-Host "`n[3] 页面与接口" -ForegroundColor Cyan
  $setup = Invoke-WebRequest "$Base/setup" -UseBasicParsing -TimeoutSec 5
  Check ($setup.StatusCode -eq 200 -and $setup.Content -match '首次设置') '/setup 可打开'
  Check ((Invoke-WebRequest "$Base/settings" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) '/settings 可打开'
  $us = Invoke-WebRequest "$Base/coach.user.js" -UseBasicParsing -TimeoutSec 5
  Check ($us.Content -match "@version\s+$([regex]::Escape($ver))") '/coach.user.js 注入了当前版本'
  Check ((Invoke-WebRequest "$Base/api/model/status" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) '/api/model/status 可用'

  Write-Host "`n[4] 诊断包" -ForegroundColor Cyan
  $diag = (Invoke-WebRequest "$Base/api/diag/export" -Method POST -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json
  Check ($diag.ok -eq $true) '导出成功' $diag.error
  if ($diag.ok) {
    Check (Test-Path $diag.file) 'zip 落盘'
    Remove-Item $diag.file -Force -ErrorAction SilentlyContinue
  }

  Write-Host "`n[5] 版本握手" -ForegroundColor Cyan
  Invoke-WebRequest "$Base/frame" -Method POST -Body '{"dir":"out","url":"x","hex":"00","v":"0.0.1"}' -UseBasicParsing -TimeoutSec 5 | Out-Null
  Start-Sleep -Milliseconds 300
  $cfg2 = (Invoke-WebRequest "$Base/config" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  Check ($cfg2.scriptVersion -eq '0.0.1') '记录脚本版本'
  $panel = (Invoke-WebRequest "$Base/panel?since=0" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
  $warned = @($panel.items | Where-Object { $_.text -match '脚本版本过旧' }).Count -gt 0
  Check $warned '脚本版本不一致时面板给出提示'

  Write-Host "`n[6] 安全边界（P0 回归）" -ForegroundColor Cyan
  function StatusOf($block) {
    try { (& $block).StatusCode } catch { $_.Exception.Response.StatusCode.value__ }
  }
  Check ((StatusOf { Invoke-WebRequest "$Base/config" -Headers @{Origin='https://evil.example'} -UseBasicParsing -TimeoutSec 5 }) -eq 403) `
    '恶意 Origin 被拒（403）'
  Check ((StatusOf { Invoke-WebRequest "$Base/config" -Headers @{Host='evil.example'} -UseBasicParsing -TimeoutSec 5 }) -eq 403) `
    '非法 Host 被拒（403，防 DNS rebinding）'
  Check ((StatusOf { Invoke-WebRequest "$Base/api/settings" -Method POST -Headers @{Origin='null'} -Body '{"tileDark":true}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 }) -eq 403) `
    'Origin:null 不能写设置（403）'
  Check ((StatusOf { Invoke-WebRequest "$Base/api/settings" -Method POST -Body '{"pythonExe":"C:\Windows\System32\calc.exe"}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 }) -eq 400) `
    'pythonExe 越界被拒（400）'
  Check ((StatusOf { Invoke-WebRequest "$Base/api/settings" -Method POST -Body '{"port":80}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 }) -eq 400) `
    '非法端口被拒（400）'
  Check ((StatusOf { Invoke-WebRequest "$Base/frame" -Method POST -Body ('{"hex":"' + ('a' * 700000) + '"}') -UseBasicParsing -TimeoutSec 10 }) -eq 400) `
    '超长帧被拒（400）'
  $setupResp = Invoke-WebRequest "$Base/setup" -UseBasicParsing -TimeoutSec 5
  Check ($setupResp.Headers['Content-Security-Policy'] -match "default-src 'self'") '本地页面带 CSP'
}
finally {
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Milliseconds 800
}

Write-Host "`n[7] 退出后不留监听" -ForegroundColor Cyan
$smokePort = ([uri]$Base).Port
$left = @(Get-NetTCPConnection -LocalPort $smokePort -State Listen -ErrorAction SilentlyContinue).Count
Check ($left -eq 0) "端口 $smokePort 已释放" "仍有 $left 个监听"
Write-Host "`n$('=' * 48)"
Write-Host "通过 $pass / 失败 $fail"
if ($fail) { Write-Host '有失败项 —— 这个包还不能发。' -ForegroundColor Red; exit 1 }
Write-Host '全部通过 ✓' -ForegroundColor Green
