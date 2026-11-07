# build/ —— 打包脚本

对应 docs/PLAN-packaging.md 的 M2/M3。目标：一条命令出可运行目录，再出安装器。

## 一条命令

```powershell
powershell -File build\package.ps1                 # 代码 + 模型 + 托盘 exe → dist\MahjongSoulCoach\
powershell -File build\package.ps1 -Installer      # 额外出 dist\MahjongSoulCoach-Setup-<ver>.exe（需 Inno Setup 6）
powershell -File build\package.ps1 -WithRuntime    # 再带上裁剪后的 Python 运行时（+503 MB）
```

> 目录里所有 `.ps1` 都是 **UTF-8 with BOM**（Windows PowerShell 5.1 才能正确读中文）。
> 改完用 `build\*.ps1` 时会自动校验；新脚本记得存 BOM，否则中文注释会变乱码。

## 分步

| 脚本 | 作用 | 实测 |
|---|---|---|
| `assemble.ps1` | 挑文件：剔 v2/日志/版权素材，libriichi 只留 win+3.12（87.7→2.7 MB），带 S42 权重 | 45.4 MB / 69 文件 |
| `curate-runtime.ps1` | 把 Akagi 的 691.6 MB / 20407 文件裁成 503.3 MB / 6982 文件，并 `import torch` 冒烟 | ✓ torch 2.14.0+cpu |
| `build-tray.ps1` | 用系统自带 `csc.exe` 编译托盘（不需要任何编译器），自动带上 `icon.ico` | 21.5 KB，`--selftest` 通过 |
| `make-icon.ps1` | 画 `build\icon.ico`（16/32/48/256 四尺寸，胡桃色） | 8.0 KB |
| `installer.iss` | Inno Setup：装到 `%LOCALAPPDATA%`、免 UAC、桌面/开始菜单、卸载 | ✅ 已实测装→跑→卸全流程 |
| `package.ps1` | 串起来 | `-WithRuntime -Installer` → 整包 640.8 MB、安装包 150.7 MB |
| `smoke.ps1` | **发行目录冒烟**：文件齐全 / 包内 node 起服务 / 默认 review / 三个页面 / 脚本版本注入 / 诊断包 / 版本握手 / 退出不留监听 | 每次出包后跑一遍 |

> **安装器需要 Inno Setup 6**：`winget install JRSoftware.InnoSetup`（装到用户目录，免管理员）。
> 简体中文语言文件已随包放在 `build\ChineseSimplified.isl`（Inno 默认不带）。

## 裁剪删了什么（都在 `curate-runtime.ps1` 里，可复核）

`*.pdb`（18MB 调试符号）、`__pycache__`（27MB）、`include/`、`tcl/`（tkinter 用的）、
`pip`、`torch\include`（38MB 头文件）、`torch\lib\*.lib`（42MB 链接期库，运行时只要 .dll）。

**加了两样**：`torchgen` 与 `_distutils_hack` 保留（删了 import 会炸），
4 个 VC++ DLL（msvcp140 / vcruntime140 / vcruntime140_1 / concrt140）从 System32 拷到运行时根 ——
干净机器没装 VC++ redist 时靠它们。

**踩过的两个坑（别删回去）**：
- `torchgen` 不能删 —— `torch.utils._python_dispatch` 会 import 它
- `_distutils_hack` 不能删 —— `site-packages\distutils-precedence.pth` 会 import 它

## 还差

- 安装器实编（要在装了 Inno Setup 的机器上跑一次 `-Installer`）
- 运行时换 python-build-standalone（可再省几十 MB，且不依赖 Akagi 的安装目录）
- 图标（现在是代码画的圆点，没有 .ico）
