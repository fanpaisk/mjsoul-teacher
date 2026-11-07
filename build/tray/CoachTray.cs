// 雀魂教练 · 托盘外壳（.NET Framework 4.x / WinForms）
// ---------------------------------------------------------------------------
// 为什么用 C# + 系统自带 csc.exe：本机没有任何 C/C++/Rust 编译器（见 DECISIONS D20），
// 而 .NET Framework 4.8 的 csc.exe 是 Windows 自带的 —— 直接编译出 ~50KB 的托盘 exe，
// 不用拖进 150MB 的 Electron。
//
// 编译（见 build/build-tray.ps1）：
//   csc /target:winexe /out:dist\MahjongSoulCoach\CoachTray.exe /win32icon:... build\tray\CoachTray.cs
//
// 行为：
//   · 双击 = 启动服务端并常驻托盘（已经在跑则直接挂上）
//   · 右键菜单：打开设置 / 打开游戏 / 查看日志 / 停止 / 启动 / 关于 / 退出
//   · 图标颜色 = 运行状态（绿=在跑，红=停了，黄=在启动）
//   · 单实例：第二个实例只激活第一个的托盘提示，不重复起服务
//   · --selftest：只做初始化检查后退出（给 CI/构建脚本用，不弹窗）
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace MahjongSoulCoach
{
    static class Program
    {
        const string MutexName = "MahjongSoulCoach.Tray.SingleInstance";
        const string UrlBase = "http://127.0.0.1:18766";

        static string Root { get { return AppDomain.CurrentDomain.BaseDirectory; } }
        static Process server;
        static NotifyIcon tray;
        static ToolStripMenuItem miStatus, miStart, miStop;
        static Icon icoRun, icoStop, icoBusy;
        static System.Windows.Forms.Timer poll;

        [STAThread]
        static void Main(string[] args)
        {
            bool selftest = Array.IndexOf(args, "--selftest") >= 0;

            bool created;
            var mutex = new Mutex(true, MutexName, out created);
            if (!created)
            {
                if (selftest) { SelfTestResult("already-running"); return; }
                MessageBox.Show("雀魂教练已经在运行（看任务栏右下角的托盘图标）。", "雀魂教练");
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            icoRun = MakeIcon(Color.FromArgb(74, 222, 128));
            icoStop = MakeIcon(Color.FromArgb(148, 155, 166));
            icoBusy = MakeIcon(Color.FromArgb(251, 191, 36));

            tray = new NotifyIcon();
            tray.Icon = icoStop;
            tray.Text = "雀魂教练 · 已停止";
            tray.Visible = true;

            var menu = new ContextMenuStrip();
            miStatus = new ToolStripMenuItem("状态：已停止") { Enabled = false };
            miStart = new ToolStripMenuItem("启动教练", null, (s, e) => StartServer());
            miStop = new ToolStripMenuItem("停止教练", null, (s, e) => StopServer());
            var miSetup = new ToolStripMenuItem("打开设置向导", null, (s, e) => Open(UrlBase + "/setup"));
            var miSettings = new ToolStripMenuItem("打开设置", null, (s, e) => Open(UrlBase + "/settings"));
            var miGame = new ToolStripMenuItem("打开雀魂", null, (s, e) => Open("https://game.maj-soul.com/1/"));
            var miLog = new ToolStripMenuItem("查看日志", null, (s, e) => OpenLog());
            var miAbout = new ToolStripMenuItem("关于", null, (s, e) => About());
            var miExit = new ToolStripMenuItem("退出", null, (s, e) => Quit());
            menu.Items.AddRange(new ToolStripItem[] {
                miStatus, new ToolStripSeparator(), miStart, miStop, new ToolStripSeparator(),
                miSetup, miSettings, miGame, miLog, new ToolStripSeparator(), miAbout, miExit });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (s, e) => Open(UrlBase + "/setup");

            if (selftest)
            {
                // winexe 没有控制台，Console.WriteLine 会丢；写临时文件给构建脚本读
                SelfTestResult("ok root=" + Root);
                tray.Visible = false;
                return;
            }

            poll = new System.Windows.Forms.Timer();
            poll.Interval = 3000;
            poll.Tick += (s, e) => RefreshStatus();
            poll.Start();

            if (!Ping()) StartServer();
            RefreshStatus();

            // 首次运行：没有用户配置就自动打开向导（不然用户装完不知道下一步干什么）
            string userCfg = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "MahjongSoulCoach", "config.json");
            if (!File.Exists(userCfg))
            {
                var t = new System.Threading.Timer(_ =>
                {
                    for (int i = 0; i < 10; i++)
                    {
                        if (Ping()) { Open(UrlBase + "/setup"); return; }
                        Thread.Sleep(500);
                    }
                }, null, 600, Timeout.Infinite);
                GC.KeepAlive(t);
            }

            Application.Run();
        }

        static bool Ping()
        {
            try
            {
                using (var wc = new WebClient())
                {
                    wc.Encoding = System.Text.Encoding.UTF8;
                    wc.DownloadString(UrlBase + "/config");
                    return true;
                }
            }
            catch { return false; }
        }

        static void RefreshStatus()
        {
            bool up = Ping();
            miStart.Enabled = !up;
            miStop.Enabled = up;
            if (up)
            {
                miStatus.Text = "状态：运行中";
                tray.Icon = icoRun;
                tray.Text = "雀魂教练 · 运行中";
            }
            else
            {
                miStatus.Text = "状态：已停止";
                tray.Icon = icoStop;
                tray.Text = "雀魂教练 · 已停止";
            }
        }

        static string NodePath()
        {
            // 安装版：<根>\runtime\node\node.exe；开发版：PATH 里的 node
            string[] cands = {
                Path.Combine(Root, @"runtime\node\node.exe"),
                Path.Combine(Root, "node.exe"),
            };
            foreach (var c in cands) if (File.Exists(c)) return c;
            return "node.exe";
        }

        static void StartServer()
        {
            if (Ping()) { RefreshStatus(); return; }
            try
            {
                var psi = new ProcessStartInfo(NodePath(), "live/live_coach.js");
                psi.WorkingDirectory = Root;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = false;
                var log = new StreamWriter(Path.Combine(Root, @"live\server.log"), true);
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                server = new Process { StartInfo = psi };
                server.OutputDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
                server.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
                server.Start();
                server.BeginOutputReadLine();
                server.BeginErrorReadLine();
                tray.Icon = icoBusy;
                tray.Text = "雀魂教练 · 启动中…";
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    for (int i = 0; i < 20; i++)
                    {
                        Thread.Sleep(500);
                        if (Ping()) return;
                    }
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show("启动失败：" + ex.Message + "\n\n请确认安装完整（runtime\\node\\node.exe 或系统 Node.js）。", "雀魂教练");
            }
        }

        static void StopServer()
        {
            try
            {
                if (server != null && !server.HasExited)
                {
                    // 杀整棵树：node 会拉起 python 引擎子进程
                    Process.Start(new ProcessStartInfo("taskkill", "/PID " + server.Id + " /T /F")
                    { UseShellExecute = false, CreateNoWindow = true });
                    server.WaitForExit(3000);
                }
                // 兜底：按端口找残留进程。**只杀自己目录下的 node.exe**，
                // 以前这里是无条件 taskkill —— 端口被别的程序占用时会误杀别人的进程。
                KillStaleNode();
            }
            catch (Exception ex) { MessageBox.Show("停止失败：" + ex.Message); }
            Thread.Sleep(300);
            RefreshStatus();
        }

        static void KillStaleNode()
        {
            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c netstat -ano | findstr :18766 | findstr LISTENING")
                { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
                var p = Process.Start(psi);
                string outp = p.StandardOutput.ReadToEnd();
                p.WaitForExit(2000);
                foreach (var line in outp.Split('\n'))
                {
                    var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 5) continue;
                    int pid;
                    if (!int.TryParse(parts[parts.Length - 1], out pid) || pid <= 4) continue;
                    try
                    {
                        var proc = Process.GetProcessById(pid);
                        if (!string.Equals(proc.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) continue;
                        string exePath = null;
                        try { exePath = proc.MainModule.FileName; } catch { }
                        if (exePath == null || !exePath.StartsWith(Root, StringComparison.OrdinalIgnoreCase)) continue;
                        proc.Kill();
                    }
                    catch { }
                }
            }
            catch { }
        }

        static void OpenLog()
        {
            string p = Path.Combine(Root, @"live\live_observed.log");
            try { if (File.Exists(p)) Process.Start("notepad.exe", "\"" + p + "\""); else MessageBox.Show("还没有日志（先打一局）。"); }
            catch { }
        }

        static void About()
        {
            string v = "?";
            try
            {
                using (var wc = new WebClient())
                {
                    wc.Encoding = System.Text.Encoding.UTF8;
                    string json = wc.DownloadString(UrlBase + "/config");
                    int i = json.IndexOf("\"version\":\"");
                    if (i > 0) { int j = json.IndexOf('"', i + 11); v = json.Substring(i + 11, j - i - 11); }
                }
            }
            catch { }
            MessageBox.Show("雀魂教练 v" + v + "\n\n本地 AI 教练：WebSocket 捕获对局 → Mortal 神经网络评估 → 游戏内悬浮面板。\n所有推理在本机完成，不联网。\n\n仅供学习研究，风险自负。",
                "关于");
        }

        static void Open(string url) { try { Process.Start(url); } catch (Exception ex) { MessageBox.Show("打不开：" + ex.Message); } }

        static void SelfTestResult(string text)
        {
            try
            {
                File.WriteAllText(Path.Combine(Path.GetTempPath(), "coachtray-selftest.txt"),
                    text, System.Text.Encoding.UTF8);
            }
            catch { }
        }

        static void Quit()
        {
            try { StopServer(); } catch { }
            if (tray != null) tray.Visible = false;
            Application.Exit();
        }

        /// <summary>画一个圆形托盘图标（不依赖外部 .ico 文件）</summary>
        static Icon MakeIcon(Color c)
        {
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var b = new SolidBrush(c)) g.FillEllipse(b, 3, 3, 26, 26);
                using (var p = new Pen(Color.FromArgb(30, 30, 30), 2)) g.DrawEllipse(p, 3, 3, 26, 26);
            }
            return Icon.FromHandle(bmp.GetHicon());
        }
    }
}
