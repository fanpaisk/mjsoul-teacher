# 开发与打包

面向要改代码或自己出包的人。只想用的话看 [README.md](README.md)。

## 环境

- Windows 10/11 x64、Node.js ≥ 18
- 推理运行时（二选一）：
  - 把 Akagi 的 `akagi-3.7.1-windows-x64` 解压到 `engine/akagi/`（服务端会自动探测版本目录）
  - 或自带 Python 3.12 + torch，在 `config.json` 里设 `pythonExe`（或环境变量 `COACH_PYTHON`）

## 跑起来

```bash
node live/live_coach.js                  # 实时模式
node live/live_coach.js --review         # 复盘模式（公共版默认）
node live/live_coach.js --review --dark-tiles
node live/live_coach.js --test-actions=live/test_call_op.jsonl   # 离线回归
```

`node structure_check.js` 检查油猴脚本里的函数唯一性（`pollBusy×4` / `蝶引×2` 是已知误报）。

## 目录

```
app/            标准化外壳（与业务解耦，见下）
  version.js      版本号唯一来源（只认 package.json）
  paths.js        路径解析（唯一允许拼 __dirname 找文件的地方）
  config.js       配置（默认值 → 安装目录 config.json → %APPDATA% → 环境变量 → 命令行）
  errors.js       面向用户的中文错误文案
  update.js       更新检查（手动触发）
  diag.js         日志轮转 + 诊断包
  model.js        模型下载（双源 + SHA256）
  web/            设置向导与设置页（纯静态，无构建步骤）
build/          打包、裁剪运行时、编译托盘、Inno Setup、冒烟、发布同步
live/           服务端主链路、油猴脚本、引擎（mjb/）
dev/            开发期临时文件与已退役工具（不进发行包）
docs/           内部交接文档（STATUS / DECISIONS / 验收清单）
```

## 打包

```powershell
powershell -File build\package.ps1                 # 代码 + 模型 + 托盘
powershell -File build\package.ps1 -Wallpaper "D:\wp.mp4"   # 顺带把本地壁纸打进包（个人构建用，别公开发）
powershell -File build\package.ps1 -WithRuntime    # 再带裁剪后的 Python 运行时（+503 MB）
powershell -File build\package.ps1 -WithRuntime -Installer   # 再出安装器
powershell -File build\smoke.ps1                   # 32 项冒烟（全过才算能发）
```

安装器需要 Inno Setup 6：`winget install JRSoftware.InnoSetup`。

产物：

- `dist\MahjongSoulCoach\` —— 便携目录（约 640 MB）
- `dist\MahjongSoulCoach-Setup-<ver>.exe` —— 安装包（约 150 MB）

## 发布

```powershell
powershell -File build\publish.ps1              # dry-run：看会同步哪些文件
powershell -File build\publish.ps1 -Apply -Commit   # 同步并提交（不 push）
```

白名单同步，`secrets.local.json`、权重、版权素材、`docs/`、`dev/` 永不同步。
push 之后在 GitHub 建 Release，附上 `dist\*.exe`，正文用 CHANGELOG 对应版本。

## 已知的坑（踩过，别再踩）

- **`.ps1` 必须是 UTF-8 with BOM**：Windows PowerShell 5.1 否则按 ANSI 读，中文变乱码
- **JSON 文件不能带 BOM**：`JSON.parse` 会直接抛，配置被静默忽略
- **裁剪运行时不能删 `torchgen` / `_distutils_hack`**：一个是 `torch.utils._python_dispatch` 的依赖，
  一个是 `distutils-precedence.pth` 的依赖；删了 import 就炸（`curate-runtime.ps1` 里有冒烟兜底）
- **油猴脚本禁止贪婪正则锚点**：大改用"定位-重建"或整块重写
- **加参数必须同时改全部调用点**：尾插参数会导致实参错位且不报错
- **跨进程文本协议显式 UTF-8**：Windows 上 Python 默认 cp936
- **打包本身就是路径测试**：根目录的 `coach.js`、`liqi_new.json` 少带一个就起不来，
  开发目录里永远发现不了
