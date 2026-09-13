# mjsoul-teacher

一个**完全本地运行**的实时 AI 教练：

-  **超大师级决策**：内置 [Mortal](https://github.com/Equim-chan/Mortal) 架构神经网络（默认使用社区完整版权重 [Mortal-S42](https://huggingface.co/haor/Mortal-S42)，Apache-2.0），所有推理在本机 CPU 完成，零云端依赖、零 token 消耗
-  **全时机评分**：自己摸牌、他人切牌时可吃/碰/杠/荣和、加杠抢杠——每个合法操作（含"跳过"）都有期望值评分
-  **游戏内悬浮面板**：天凤风格真实牌面渲染，可拖动/折叠，不用盯着别的窗口
-  **对局审计**：打完一局用 akochan 逐手复盘，给出"损失最大的手"，还能交叉验证两个独立 AI 的判断
-  **自我校验**：漏帧守恒检测（牌山剩余数守恒），数据流不完整时自动警告并重启引擎，杜绝"引擎看到错误世界"式的离谱建议
-  **往生堂主题面板**：胡桃配色皮肤 + 视频/图片动态背景（把任意 mp4/webm/png/gif 丢进 live/assets 即换肤）+ 天凤风格牌面渲染
-  **三档隐私开关**：F9 整面板隐藏 / 默认黑牌模式（按住牌面临时查看）/ 点击牌面全部变黑——直播、录屏、被围观时保护你的手牌信息
-  **面板自由调整**：拖左边缘改宽度（高度按背景媒体比例自适应）、拖标题栏移动、F9 一键隐藏，全部状态记忆
-  **断线自愈**：断网/切页重连后按牌山计数自动去重重放事件，引擎状态无缝续上

> **⚠️ 免责声明**：使用第三方工具读取游戏数据可能违反《雀魂用户协议》。本项目仅供学习研究，请勿在段位场使用，一切风险自负。项目不含任何自动化操作——所有出牌决策均由玩家本人完成。

---

## 架构

```
雀魂服务器 ⇄ WebSocket ⇄ 浏览器（游戏页面）
                              │ 油猴脚本复制每一帧（GM 通道 → 本地）
                              ▼
                 本地服务端 (node live/live_coach.js, 端口 18766)
                   ├─ protobuf 解码 + XOR 去混淆 → Action* 消息
                   ├─ 对局状态机 → mjai 事件流（增量）
                   └─ Mortal 引擎子进程 (Python + libriichi + 神经网络)
                              │
                   Top3 候选 + 概率 → 游戏内悬浮面板 / live_coach.md
```

离线复盘：`review.js` → 抓取牌谱 → 转天凤格式 → akochan 逐手精确审计 → `review_*.md`

---

## 安装

### 0. 前置要求

- [Node.js](https://nodejs.org/) ≥ 18
- Windows 10/11
- Chrome / Edge 浏览器 + [Tampermonkey](https://www.tampermonkey.net/) 扩展

### 1. 引擎运行时（三选一，推荐 a）

决策引擎需要一个能跑 PyTorch 的 Python 环境和 `libriichi`（Rust 麻将规则库的 Python 扩展）：

**a) Akagi 3.7.1 运行时（最省事）**
1. 从 [Akagi 发布页](https://github.com/StarDoor/Akagi/releases) 下载 `akagi-3.7.1-windows-x64.zip` 并解压
2. 把解压出的 `akagi-3.7.1-windows-x64` 整个文件夹放到本项目的 `engine/` 下，最终结构：
   ```
   engine/akagi/akagi-3.7.1-windows-x64/runtime/python/x86_64-pc-windows-msvc/python.exe
   ```
   （该运行时自带 Python 3.12 + CPU 版 PyTorch，无需再装任何 Python 环境）

**b) 自备 Python 3.12 + PyTorch + libriichi**：改一行 `live/live_coach.js` 顶部的 `MORTAL_PY` 指向你的 python.exe，并确保 `live/mjb/libriichi/` 里有对应版本的预编译扩展（libriichi 源码见 Mortal 官方仓库）。

### 2. 模型权重

默认使用完整版 **Mortal-S42**（192 通道 × 40 残差块，远强于 Akagi 捆绑的精简版）：

1. 下载 <https://huggingface.co/haor/Mortal-S42/resolve/main/weights/s42-inference.pth>（国内可用 <https://hf-mirror.com/haor/Mortal-S42/resolve/main/weights/s42-inference.pth>）
2. 放到 `live/mjb/` 并重命名为 **`mortal_full.pth`**
3. 校验（可选但推荐）：
   ```powershell
   Get-FileHash mortal_full.pth -Algorithm SHA256
   # 应为 e5f6955b6f19007fd65315e53291b36994493046bc118b991b959e9dc596d660
   ```

> 没有 `mortal_full.pth` 时引擎自动回退到 Akagi 捆绑的精简模型（需自行放入为 `mortal.pth`），教练不会停摆。

### 3. `libriichi` 预编译扩展

把 Akagi 3.7.1 解压目录中的 `mjb/libriichi/`（内含各 Python 版本的 `.pyd`）复制到本项目的 `live/mjb/libriichi/`。

### 4. 油猴脚本

1. 浏览器安装 Tampermonkey，并在扩展详情页打开 **"允许用户脚本"** 开关（新版浏览器必需），且开启浏览器的**开发者模式**
2. Tampermonkey 管理面板 → 新建脚本 → 粘贴 `live/coach_hook.user.js` 全部内容 → 保存
3. 打开 <https://game.maj-soul.com/1/>，页面左下角出现 `教练 N帧` 角标即注入成功

---

## 使用

1. **启动服务端**：双击 `后台启动.bat`（无窗口运行）；`启动教练.bat` 则会弹出一个日志窗口（关掉窗口 = 停止）；`停止教练.bat` 停止服务
2. **打开雀魂页面**（若已打开则刷新一次）——角标帧数开始增长说明数据链路通了
3. **打牌**。每次你摸牌、或出现吃/碰/杠/荣和机会时，面板会给出带概率的候选（首选金色高亮）；你切牌后会显示该选择在 Mortal 排名第几
4. **盯一眼角标**：错误数持续上涨 = 服务端没开或数据链路异常；面板出现"⚠ 牌数不齐"= 检测到漏帧（引擎已自动校正）
5. **复盘**（可选）：打完一局后双击 `复盘最近一局.bat`，输入座位号，几分钟后得到 `review_*.md` 报告。也可以审计任意牌谱：`node review.js <牌谱链接或uuid> [座位]`
   - 复盘需要 akochan-reviewer：从 [Equim-chan/akochan-reviewer releases](https://github.com/Equim-chan/akochan-reviewer/releases) 下载，`akochan-reviewer.exe` 放 `engine/reviewer/`、其余文件放 `engine/reviewer/akochan/`（详见 `engine/README.md`）

第一次决策前引擎要加载模型（约 2 秒），之后每次评估仅几十毫秒。

### 模式选择（启动时决定）

教练有两种提醒时机 + 一个牌面显示选项，均由**服务端启动方式**决定（面板上不可切换）：

| 启动方式 | 效果 |
|---|---|
| `后台启动.bat` | ⚡ 实时模式：摸牌瞬间给提醒（默认） |
| `复盘模式后台启动.bat` 或 `后台启动.bat --review` | 📖 复盘模式：**切完牌后**才出现该手提醒与对比（当场复盘） |
| `黑牌模式后台启动.bat` 或 `后台启动.bat --dark-tiles` | 🖤 牌面默认全黑，按住某张牌可临时查看 |
| `复盘黑牌后台启动.bat` 或 `后台启动.bat --review --dark-tiles` | 两者同时开启 |

也可以双击 `后台启动-选模式.bat`，按数字键选模式。不习惯命令行的话，用专用启动器即可。

### 面板操作

| 操作 | 方式 |
|---|---|
| 移动面板 | 按住标题栏拖动 |
| 调整宽度 | 鼠标悬停面板左边缘，出现橙色把手后左右拖动（高度按背景比例自适应） |
| 隐藏/显示面板 | 按 **F9**（游戏中也能响应） |
| 换背景视频/图片 | 把 mp4/webm/png/gif 丢进 live/assets 文件夹，刷新页面（多个文件时取最新的） |
| 默认黑牌模式 | 点标题栏 🀄/🖤 切换：开启后牌面默认全黑，按住某张牌可临时查看，松手恢复 |
| 隐藏所有牌面 | 点任意一个牌面：全部变黑；再点恢复（直播防偷看） |

---

## 工作原理

| 环节 | 说明 |
|---|---|
| 帧捕获 | 油猴脚本包装 `WebSocket.prototype`，把游戏收发的每一帧以 hex POST 到本地 |
| 协议解码 | 帧格式 `[类型][seq][Wrapper protobuf]`；对局动作经 `ActionPrototype` 携带并做字节异或混淆，服务端解码后还原为 `.lq.Action*` 消息 |
| 事件翻译 | Action* 消息 → [mjai](https://gimite.net/pukiwiki/index.php?mjai) 标准事件流（他人手牌以 `"?"` 表示），增量喂给引擎 |
| 决策 | libriichi 维护状态与合法动作掩码，Mortal 网络输出 q_values，`meta_show.py` 转成 Top3 候选 |
| 安全机制 | 牌山剩余数守恒校验（防漏帧）、引擎崩溃自动重放、决策点 promise 链串行化 |

## 目录结构

```
├── 启动教练.bat / 后台启动.bat / 停止教练.bat / 复盘最近一局.bat
├── live/
│   ├── live_coach.js        # 本地服务端（帧解码、状态机、决策调度、HTTP）
│   ├── decode.js            # protobuf 解码器
│   ├── coach_hook.user.js   # 油猴脚本（帧捕获 + 悬浮面板）
│   ├── injector.js          # 无 Tampermonkey 时的手动注入版钩子
│   ├── assets/pai.svg       # 天凤风格牌面（WarL0ckNet/tile-art）
│   └── mjb/                 # Mortal 决策引擎（Python）
│       ├── bot.py  model.py  meta_show.py  _libriichi_loader.py
│       └── mortal_full.pth  # ← 你下载的权重放这里（不入库）
├── review.js                # 复盘编排器
├── fetch_record2.js         # 牌谱抓取（雀魂大厅网关 oauth2 协议）
├── to_tenhou.js / convert_adapted.js / tensoul_convert.js  # 转天凤格式
├── coach.js                 # 向听数/牌 ID 数学工具
├── liqi_new.json            # 雀魂 protobuf 描述文件
└── engine/                  # 第三方二进制放这里（不入库，见 README）
```

## 更新日志

### v1.19.0
- **组三栏布局**：每组输出（两条蝶引分界之间）重构为「左预留位 + 居中内容 + 右侧表情」三栏结构
- **程度表情包**：切牌反馈右侧按正确度显示四档二次元表情（完美/不错/一般/失误），用户可自备图片放入 live/assets/emo/
- **等比缩放**：拖拽调整面板宽度时，文字、牌面、表情、背景整体等比缩放（CSS zoom，保持锐利）
- **模式参数化**：⚡/📖、🀄/🖤 面板按钮移除，复盘/黑牌模式改为服务端启动参数（--review / --dark-tiles）

### v1.18.0
- 修复面板渲染函数被补丁误删导致的面板空白问题

### v1.14 ~ v1.17
- 断线重连自愈（牌山计数去重重放事件，引擎无缝续上）
- 服务端每次启动清空输出文件
- 背景媒体支持图片（mp4/webm/png/jpg/webp/gif 任一，自动取最新）

## 故障排查

| 现象 | 处理 |
|---|---|
| 角标错误数持续上涨 | 服务端没启动（双击 `后台启动.bat`） |
| 左下角没有角标 | 检查 Tampermonkey 开关、"允许用户脚本"开关、开发者模式；F12 控制台执行 `window.__liveHook` 应返回对象 |
| 建议"引擎无响应" | 引擎子进程问题，看服务端窗口/`server.log`；确认模型与 libriichi 已按上文放置 |
| "⚠ 牌数不齐"警告 | 网络抖动导致漏帧，引擎已自动重启校正；若频繁出现请检查网络 |
| 牌谱抓取失败 | 令牌过期：保持服务端运行，刷新一次雀魂页面即可自动重新捕获 |
| 复盘报 akochan 错误 | 确认 akochan-reviewer 版本与放置路径，详见 `engine/README.md` |

## 致谢

- [Mortal](https://github.com/Equim-chan/Mortal) — Equim-chan 的麻将 AI（本项目决策网络架构）
- [Mortal-S42](https://huggingface.co/haor/Mortal-S42) — 社区继续训练的完整版权重（Apache-2.0）
- [akochan](https://github.com/estie/akochan) / [akochan-reviewer](https://github.com/Equim-chan/akochan-reviewer) — 精确复盘引擎
- [libriichi](https://github.com/Equim-chan/Mortal/tree/master/libriichi) — Rust 麻将规则库
- [WarL0ckNet/tile-art](https://github.com/WarL0ckNet/tile-art) — 天凤风格牌面素材
- [MahjongCopilot](https://github.com/MahjongCopilot/MahjongCopilot) — liqi 协议描述文件
- [Akagi](https://github.com/StarDoor/Akagi) — 引擎运行时打包方式参考

## 许可证

本项目自身代码以 [MIT](LICENSE) 发布。第三方组件遵循各自许可证；模型权重使用限制见原发布页。

---
*本仓库与雀魂官方、天凤官方均无关联。*
"# mjsoul-teacher" 
