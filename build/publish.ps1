#requires -Version 5.1
<#
  把本工作目录的"该发布的文件"同步到发布仓（C:\Users\sk\Desktop\mjsoul-teacher）。
  **默认只做 dry-run 报告**，不改任何东西；加 -Apply 才真复制。

  用法：
    powershell -File build\publish.ps1            # 看会改哪些文件
    powershell -File build\publish.ps1 -Apply     # 真同步（不 commit、不 push）
    powershell -File build\publish.ps1 -Apply -Commit   # 同步后 git add+commit（仍不 push）

  为什么用白名单而不是"拷整个目录"：
    本目录里有 secrets.local.json、权重、版权素材、dev/ 垃圾、docs/（交接文档，仓里是 ignore 的），
    全量拷一次就会把不该公开的东西带进公开仓 —— 这种事故一次就够了。
#>
param(
  [string]$Repo = 'C:\Users\sk\Desktop\mjsoul-teacher',
  [switch]$Apply,
  [switch]$Commit,
  [switch]$Prune
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $Repo)) { throw "发布仓不存在：$Repo" }
$ver = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "同步 $root → $Repo（v$ver）$(if (-not $Apply) { '  [dry-run]' } else { '' })" -ForegroundColor Cyan

# 白名单：目录整体同步 + 若干单文件
# docs/images/ 是 README 首屏用的截图与 GIF（对外展示资产），单独放行；
# docs/ 其余是交接文档，仍然不同步。
$dirs = @('app', 'build', 'docs/images')
$files = @(
  'package.json', 'README.md', 'README.en.md', 'README.ja.md', 'README.ko.md', 'CHANGELOG.md', 'DEVELOPING.md', 'SECURITY.md',
  'coach.js', 'liqi_new.json', 'structure_check.js', 'make_test_actions.js',
  'live/live_coach.js', 'live/decode.js', 'live/coach_hook.user.js',
  'live/assets/pai.svg'
  'live/mjb/bot.py', 'live/mjb/model.py', 'live/mjb/meta_show.py', 'live/mjb/online_status.py',
  'live/mjb/_libriichi_loader.py', 'live/mjb/pyproject.toml', 'live/mjb/LICENSE', 'live/mjb/manifest.toml',
  'live/mjb/ot_settings.json'
)
# 明确不同步（写出来是为了让看脚本的人放心）
$never = @('secrets.local.json', 'live/mjb/mortal*.pth', 'live/mjb/s42-inference.pth', 'live/assets/bg.mp4',
  'live/assets/emo/**', 'local/**', 'live/v2/**', 'dev/**', 'docs/**', 'AGENTS.md', 'dist/**', 'config.json', '*.log')

function Should-Skip([string]$rel) {
  if ($rel -like 'docs/images/*') { return $false }
  foreach ($p in $never) {
    $pat = $p -replace '\\', '/'
    if ($rel -like $pat) { return $true }
    if ($pat.EndsWith('/**') -and $rel.StartsWith($pat.TrimEnd('*').TrimEnd('/') + '/')) { return $true }
  }
  return $false
}

# ---- README 首屏支持块守卫（用户指定，永不修改）----
# 四个 README 的第 3–7 行必须逐字一致；被改动或移位就直接失败，避免同步时冲掉用户的
# 语言链接 / star 号召 / Issue 引导。
$supportBlock = @(
  '[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)',
  '',
  '**下载了觉得还行的姥爷们，顺手点个star⭐呗，或者分享一下吧QAQ**',
  '',
  '**有什么问题都可以开 [Issue](https://github.com/fanpaisk/mjsoul-teacher/issues)哦**'
)
foreach ($rf in @('README.md','README.en.md','README.ja.md','README.ko.md')) {
  $rp = Join-Path $root $rf
  if (-not (Test-Path $rp)) { throw "README 守卫：缺少 $rf" }
  $lines = @(Get-Content $rp -Encoding UTF8)
  if ($lines.Count -lt 7) { throw "README 守卫：$rf 行数不足" }
  for ($i = 0; $i -lt $supportBlock.Count; $i++) {
    if ($lines[2 + $i] -ne $supportBlock[$i]) {
      throw "README 守卫：$rf 第 $((3 + $i)) 行被改动"
    }
  }
}

$plan = @()
foreach ($d in $dirs) {
  $srcDir = Join-Path $root $d
  if (-not (Test-Path $srcDir)) { continue }
  Get-ChildItem $srcDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    if (Should-Skip $rel) { return }
    # 发行/构建产物与本机数据不进仓
    if ($rel -match '(^|/)(node_modules|__pycache__|dist)/') { return }
    if ($rel -match '\.(log|tmp|part)$') { return }
    $plan += [pscustomobject]@{ Rel = $rel; Src = $_.FullName; Size = $_.Length }
  }
}
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (Test-Path $src) {
    $plan += [pscustomobject]@{ Rel = $f; Src = $src; Size = (Get-Item $src).Length }
  } else {
    Write-Warning "白名单里的 $f 不存在，跳过"
  }
}

$new = 0; $changed = 0; $same = 0
foreach ($p in $plan) {
  $dst = Join-Path $Repo ($p.Rel -replace '/', '\')
  if (-not (Test-Path $dst)) { $new++; Write-Host "  + $($p.Rel)" }
  elseif ((Get-FileHash $dst).Hash -ne (Get-FileHash $p.Src).Hash) { $changed++; Write-Host "  ~ $($p.Rel)" -ForegroundColor Yellow }
  else { $same++ }
}

Write-Host ("`n计划：新增 {0}、修改 {1}、未变 {2}（共 {3} 个文件）" -f $new, $changed, $same, $plan.Count) -ForegroundColor Cyan

# .gitignore 兜底：构建产物与用户配置不能进仓（这两条漏了就会把 45MB 的 dist 和本机配置推上去）
$gi = Join-Path $Repo '.gitignore'
if (Test-Path $gi) {
  $txt = Get-Content $gi -Raw
  foreach ($need in @('dist/', 'config.json', 'live/mjb/*.pth')) {
    if ($txt -notmatch [regex]::Escape($need)) {
      Write-Warning "发布仓 .gitignore 缺少 `"$need`" —— 建议先补上再 -Apply"
    }
  }
}

if (-not $Apply) {
  Write-Host "`n这是 dry-run。确认无误后加 -Apply 执行。" -ForegroundColor Gray
  exit 0
}

foreach ($p in $plan) {
  $dst = Join-Path $Repo ($p.Rel -replace '/', '\')
  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
  Copy-Item $p.Src $dst -Force
}
Write-Host "已复制 $($plan.Count) 个文件到发布仓。" -ForegroundColor Green

# -Prune：本地已删除、但仓库里还留着的"受管文件"一并删掉。
# 不写这一步就会出现"本地删了、仓库里还在"的漂移（第一次清理遗留文件时踩过）。
if ($Prune) {
  Push-Location $Repo
  try {
    $tracked = git -c core.quotepath=false ls-files
    $removed = 0
    foreach ($t in $tracked) {
      $norm = $t -replace '\\', '/'
      $managed = $norm.StartsWith('app/') -or $norm.StartsWith('build/') -or $norm.StartsWith('docs/images/') -or ($files -contains $norm)
      if (-not $managed) { continue }
      if (-not (Test-Path (Join-Path $root ($norm -replace '/', '\')))) {
        git rm -q -- $t
        Write-Host "  - $norm" -ForegroundColor DarkYellow
        $removed++
      }
    }
    Write-Host "  清理 $removed 个已删除文件" -ForegroundColor Yellow
  } finally { Pop-Location }
}

if ($Commit) {
  Push-Location $Repo
  try {
    git add -A
    git -c core.safecrlf=false commit -m "v${ver}: 标准化包装（安装器 / 托盘 / 首次向导 / 诊断 / 冒烟）" | Out-Null
    Write-Host "已提交（未 push）。检查：git -C `"$Repo`" log --oneline -1" -ForegroundColor Green
    git status --short
  } finally { Pop-Location }
}
