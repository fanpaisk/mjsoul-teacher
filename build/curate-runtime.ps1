#requires -Version 5.1
<#
  把 Akagi 自带的 691MB / 20407 文件 Python 运行时，裁成能跑 Mortal 的最小集合。

  删的都不是运行时需要的：
    · *.pdb                 调试符号 18 MB
    · __pycache__           .pyc 缓存 27 MB（首次导入会重建）
    · include/              C 头文件（编译扩展才要）
    · tcl/                  tkinter 的 Tcl 运行时（无界面脚本不用）
    · pip / setuptools      安装器，运行不需要
    · torch/include         C++ 头文件 38 MB
    · torch/lib/*.lib       链接期导入库 42 MB（运行时只要 .dll）
    · torchgen / torch/testing

  用法：powershell -File build\curate-runtime.ps1 [-Out <目录>]
        默认输出 dist\MahjongSoulCoach\runtime\python
#>
param([string]$Out = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root 'dist\MahjongSoulCoach\runtime\python' }

# 找源：开发目录里的 Akagi（版本号不写死）
$src = Get-ChildItem (Join-Path $root 'engine\akagi') -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'runtime\python' } |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $src) { throw '找不到 engine/akagi/*/runtime/python（先解压 Akagi 运行时）' }
$arch = Get-ChildItem $src -Directory | Select-Object -First 1
$srcPython = $arch.FullName
Write-Host "源: $srcPython" -ForegroundColor Cyan

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null

Write-Host '复制（约 690 MB，需要几十秒）…' -ForegroundColor Cyan
$t0 = Get-Date
# robocopy 比 Copy-Item 快得多；退出码 <8 都算成功
& robocopy $srcPython $Out /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（$LASTEXITCODE）" }

Write-Host '裁剪…' -ForegroundColor Cyan
# VC++ 运行库：torch 的 DLL 依赖 msvcp140/vcruntime140。
# 本机装了 VC++  redist 所以 System32 里有，但**干净机器可能没有** —— 随包放一份（微软允许随分发）。
foreach ($dll in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll')) {
  $src2 = Join-Path $env:WINDIR "System32\$dll"
  if (Test-Path $src2) {
    Copy-Item $src2 (Join-Path $Out $dll) -Force
  } else {
    Write-Warning "  System32 里没有 $dll —— 干净机器上可能加载失败"
  }
}
function Strip([string[]]$patterns) {
  foreach ($p in $patterns) {
    Get-ChildItem $Out -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like $p } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Strip @(
  "$Out\**\*.pdb",
  "$Out\**\__pycache__",
  "$Out\include",
  "$Out\tcl",
  # _distutils_hack 不能删：site-packages\distutils-precedence.pth 会 import 它（删了每次都报错）
  "$Out\Lib\site-packages\pip",
  # 注意：torchgen 不能删 —— torch.utils._python_dispatch 会 import 它（首轮裁剪就踩到）
  "$Out\Lib\site-packages\torch\include",
  "$Out\Lib\site-packages\torch\lib\*.lib"
)

$sum = (Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum)
$cnt = (Get-ChildItem $Out -Recurse -File).Count
Write-Host ("  → {0:N1} MB / {1} 文件（原 691.6 MB / 20407）用时 {2:N0}s" -f ($sum.Sum / 1MB), $cnt, ((Get-Date) - $t0).TotalSeconds) -ForegroundColor Green

# 冒烟：真的 import torch（裁剪掉的东西如果被依赖，这里会立刻炸）
Write-Host '冒烟：import torch' -ForegroundColor Cyan
$py = Join-Path $Out 'python.exe'
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
& $py -c "import torch, numpy, requests; print('torch', torch.__version__, '| numpy', numpy.__version__)"
if ($LASTEXITCODE -ne 0) { throw '裁剪后的运行时无法 import torch —— 上面有缺失模块' }
Write-Host '  ✓ 运行时可用' -ForegroundColor Green
