# Mahjong Soul Coach

[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

**下载了觉得还行的姥爷们，顺手点个star⭐呗，或者分享一下吧QAQ**

**有什么问题和修改建议都可以开 [Issue](https://github.com/fanpaisk/mjsoul-teacher/issues)哦**

**Available in Chinese / English / Japanese / Korean** — switch it in Settings


**Let's be honest: this is cheating.**

It reads your game data and tells you the answer before you commit to a discard. With **live mode** on, it suggests a tile the moment you draw. That's cheating. I'm not going to pretend otherwise.

So it ships with two modes:

- **Live mode** — suggests on draw. Use it in a match at your own risk.
- **Review mode (default)** — speaks only after you discard. For practice.

Runs locally. No telemetry. No auto-play. No certificate install.

![overlay](docs/images/panel.png)

## Why install this one

1. **It just works.** No Python, no MITM certificate, no system proxy, no bundled browser. One installer, four-step wizard.
2. **It doesn't touch your table.** Reads data, draws an overlay. Never clicks, never injects, never patches the client.
3. **Real strength.** Full Mortal-S42 weights (192×40), not the lite model. Tens of milliseconds per decision, all on your CPU.

Compared with auto-play tools (e.g. MahjongCopilot):

| | This | Auto-play tools |
|---|---|---|
| Plays for you | No | Yes |
| MITM certificate | No | Yes |
| System proxy | No | Yes |
| Default timing | After your discard | Live, step-by-step |

That's not "safe" — it just means three fewer things that can break on your machine.

## Which servers

Tested: the Global Chinese client (`game.maj-soul.com`) and the Japanese client (`game.mahjongsoul.com`).

The English client (`mahjongsoul.game.yo-star.com`) is matched by the userscript but **has not been tested end to end**. If the panel shows no frames there, please open an issue — that is useful information, not a complaint.

## Install
1. [Download](https://github.com/fanpaisk/mjsoul-teacher/releases/latest) `MahjongSoulCoach-Setup-1.2.0.exe`
2. Double-click (unsigned; SmartScreen → More info → Run anyway)
3. Tray icon → wizard (4 clicks)

## Risk

Reading game data sits at the edge of the Mahjong Soul ToS. **I can't promise you won't get banned.** My advice: don't use it in ranked. Practice in a friend room.

---

Mortal-S42 (Apache-2.0) · libriichi · PyTorch · open source
