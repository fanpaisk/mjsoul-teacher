# 第三方引擎/二进制（本目录不入库）

本目录存放第三方引擎二进制，体积大且授权各自独立，请按需自行获取：

## 1. Mortal 决策引擎运行时（必需）

推荐使用 Akagi 3.7.1 自带的嵌入式运行时（Python 3.12 + CPU PyTorch，免安装）：

1. 下载：<https://github.com/StarDoor/Akagi/releases> → `akagi-3.7.1-windows-x64.zip`
2. 解压后放到本目录，最终结构：
   ```
   engine/akagi/akagi-3.7.1-windows-x64/runtime/python/x86_64-pc-windows-msvc/python.exe
   ```
3. 同时把解压包中 `mjb/libriichi/`（各 Python 版本的预编译扩展）复制到
   `live/mjb/libriichi/`

也可以自备 Python 3.12 + CPU PyTorch，并从
[Mortal 官方仓库](https://github.com/Equim-chan/Mortal)构建 libriichi。

## 2. 模型权重（必需，二选一）

- **完整版（推荐）** [Mortal-S42](https://huggingface.co/haor/Mortal-S42)（Apache-2.0）
  下载 `weights/s42-inference.pth` → 重命名为 `live/mjb/mortal_full.pth`
  SHA-256：`e5f6955b6f19007fd65315e53291b36994493046bc118b991b959e9dc596d660`
- 精简版：Akagi 3.7.1 解压包中的 `mjb/mortal.pth` → 放到 `live/mjb/mortal.pth`（可选回退）

## 3. akochan-reviewer（仅复盘功能需要）

1. 下载：<https://github.com/Equim-chan/akochan-reviewer/releases>
2. `akochan-reviewer.exe` 放到 `engine/reviewer/`
3. 其余文件（`akochan/system.exe`、`akochan/*.dll`、`akochan/params/`、`tactics.json` 等）
   放到 `engine/reviewer/akochan/`，最终结构：
   ```
   engine/reviewer/akochan-reviewer.exe
   engine/reviewer/akochan/system.exe
   engine/reviewer/akochan/tactics.json
   ```

## 授权提示

- Akagi 运行时与精简模型的授权请自行确认，本仓库不分发它们
- akochan-reviewer：MIT；akochan：见其仓库 LICENSE
- Mortal-S42 权重：Apache-2.0
