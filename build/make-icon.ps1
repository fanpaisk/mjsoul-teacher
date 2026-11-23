#requires -Version 5.1
<#
  生成托盘图标 build\icon.ico（一个胡桃色的圆点 + 内圈）。

  为什么用脚本画而不是塞个 png：项目里不该出现来源不明的图标文件，
  而且换配色只改两个 RGB 值。

  用法：powershell -File build\make-icon.ps1
#>
param([string]$Out = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $PSScriptRoot 'icon.ico' }

Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $r = [int]($size * 0.46)
  $cx = [int]($size / 2)
  $cy = [int]($size / 2)
  $rect = New-Object System.Drawing.Rectangle(($cx - $r), ($cy - $r), (2 * $r), (2 * $r))

  # 外圈深色底 + 内圈胡桃色（跟面板主题一致）
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 26, 24))
  $g.FillEllipse($bg, $rect)
  $inner = New-Object System.Drawing.Rectangle(($cx - [int]($r * 0.72)), ($cy - [int]($r * 0.72)), (2 * [int]($r * 0.72)), (2 * [int]($r * 0.72)))
  $fg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 224, 169, 109))
  $g.FillEllipse($fg, $inner)

  # 中间一道竖线，像一张牌
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 30, 26, 24), [Math]::Max(2, $size / 12))
  $g.DrawLine($pen, $cx, ($cy - [int]($r * 0.45)), $cx, ($cy + [int]($r * 0.45)))

  $g.Dispose()
  return $bmp
}

# .ico 里塞 16/32/48/256 四个尺寸（Windows 会按 DPI 选）
$sizes = @(16, 32, 48, 256)
$bitmaps = $sizes | ForEach-Object { New-IconBitmap $_ }

$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type = icon
$bw.Write([UInt16]$sizes.Count)

$pngs = @()
foreach ($b in $bitmaps) {
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , $ms.ToArray()
}

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([Byte]0)                 # colors
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # planes
  $bw.Write([UInt16]32)              # bpp
  $bw.Write([UInt32]$pngs[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush(); $bw.Close(); $fs.Close()

Write-Host ("图标已生成：{0}（{1:N1} KB）" -f $Out, ((Get-Item $Out).Length / 1KB)) -ForegroundColor Green
