// Corpus launcher.
//
// Double-click, and it starts the Next server hidden, waits for it to answer,
// opens Corpus in its own app window, and sits in the notification area.
// Right-click the tray icon to reopen, to connect to a Corpus on another
// computer, or to quit. Quitting stops the server; closing the window does not,
// so a long ingest keeps running while you get on with something else.
//
// One window. Opening Corpus again — from the tray, the desktop shortcut, or a
// second double-click — brings the window already open to the front instead
// of opening another. The window is the browser in app mode (Brave first, then
// Chrome, then Edge), so it has no tabs or address bar but keeps your sign-ins,
// the Corpus Inbox extension, and the Page view.
//
// Local, or remote. "Connect to another Corpus" points this launcher at a
// Corpus running on another machine — the other laptop, over the LAN or
// Tailscale — and then it starts no server of its own and opens that one
// instead. The choice lives in data\launcher.ini.
//
// Compiled with the C# compiler that ships with Windows — see build.ps1. No
// Electron, no extra runtime, a few dozen KB.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Corpus
{
    const int Port = 5400;
    static Process server;
    static NotifyIcon tray;
    static readonly string Root =
        Path.GetDirectoryName(Application.ExecutablePath);
    static Settings settings;

    [STAThread]
    static void Main(string[] args)
    {
        // A restart after changing where to connect waits for the old launcher
        // to let go; anything else that finds one running hands over to it.
        bool restarted = Array.IndexOf(args, "--restarted") >= 0;
        settings = Settings.Load(Path.Combine(Root, "data", "launcher.ini"));

        using (var mutex = new Mutex(false, "Corpus.Launcher.SingleInstance"))
        {
            bool owned;
            try { owned = mutex.WaitOne(restarted ? 15000 : 0, false); }
            catch (AbandonedMutexException) { owned = true; }

            if (!owned)
            {
                // Already running: bring its window forward rather than start
                // a second of anything.
                if (settings.Remote || Healthy()) Open(false);
                else Error("Corpus is already starting up. Give it a moment.");
                return;
            }

            try
            {
                Application.EnableVisualStyles();
                if (settings.Remote) RunRemote();
                else RunLocal();
            }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { }
            }
        }
    }

    static void RunLocal()
    {
        string node = FindNode();
        if (node == null)
        {
            Error("Node.js isn't installed, or isn't where I expected.\n\n" +
                  "Install the LTS build from nodejs.org, then run Corpus again.\n\n" +
                  "To use a Corpus running on another computer instead, this copy doesn't need Node — " +
                  "but it needs to be told where that Corpus is. Run it once with Node installed and use " +
                  "Connect to another Corpus in the tray.");
            return;
        }

        // A packaged copy carries a self-contained server instead of a
        // checkout: no node_modules/next to point at, just server.js.
        string standalone = Path.Combine(Root, "server", "server.js");
        bool packaged = File.Exists(standalone);

        string nextBin = Path.Combine(Root, "node_modules", "next", "dist", "bin", "next");
        if (!packaged && !File.Exists(nextBin))
        {
            Error("Corpus isn't set up yet.\n\nOpen a terminal in\n" + Root +
                  "\nand run:  npm install\n\nThen run Corpus again.");
            return;
        }

        bool alreadyRunning = ClaimPort();
        if (!alreadyRunning &&
            !(packaged ? StartStandalone(node, standalone) : Start(node, nextBin))) return;

        tray = BuildTray();

        if (!WaitForServer(60))
        {
            tray.Visible = false;
            Error("The server didn't come up in time.\n\nRun  npm run dev  in\n" + Root +
                  "\nto see what it's complaining about.");
            Stop();
            return;
        }

        // The health probe is a plain GET now: it reports what the library
        // holds and starts nothing. Resuming pending work on a headless
        // start is this call, once, from the one client that is entitled
        // to make it.
        KickWorker();

        Open(false);
        Notify(alreadyRunning
            ? "Corpus was already running — opened it for you."
            : "Corpus is running. It stays up if you close its window; quit from here.");

        Application.Run();
        Stop();
    }

    /**
     * Uses a Corpus on another machine: no server here, just the window.
     *
     * The tray stays up even when the other Corpus cannot be reached, because
     * the tray is where you change your mind — back to this computer, or to a
     * corrected address.
     */
    static void RunRemote()
    {
        tray = BuildTray();
        if (RemoteHealthy(settings.RemoteUrl))
        {
            Open(false);
            Notify("Using the Corpus at " + HostOf(settings.RemoteUrl) + ".");
        }
        else
        {
            Error("Couldn't reach a Corpus at " + settings.RemoteUrl + ".\n\n" +
                  "Check that Corpus is running there with LAN mode on (Settings → LAN mode), " +
                  "and that this computer can reach it.\n\n" +
                  "Right-click the Corpus icon in the notification area to try another address, " +
                  "or to use the Corpus on this computer.");
        }
        Application.Run();
        if (tray != null) tray.Visible = false;
    }

    // -- server ------------------------------------------------------------

    /**
     * Works out what to do about whatever is already on the port.
     *
     * Returns true if there is a healthy Corpus we should simply adopt, false if
     * the port is now ours to start on. Three cases, and telling them apart is
     * what stops the launcher lying to you:
     *
     *   - nothing there            → start normally.
     *   - a healthy Corpus         → adopt it, and say so.
     *   - something else, or a
     *     Corpus that has stopped
     *     answering                → almost always our own orphaned node, left
     *                                behind when the launcher was killed rather
     *                                than quit. Offer to end it, because the
     *                                alternative is a window served by a dead
     *                                build and a Quit button that quits nothing.
     */
    static bool ClaimPort()
    {
        if (!PortBusy()) return false;
        if (Healthy()) return true;

        // A server that is still booting will start answering shortly; give it
        // a moment before accusing it of being dead.
        for (int i = 0; i < 10; i++)
        {
            Thread.Sleep(500);
            if (Healthy()) return true;
        }

        int pid = PortOwner();
        string who = "another program";
        try { if (pid > 0) who = Process.GetProcessById(pid).ProcessName + " (PID " + pid + ")"; }
        catch { }

        var answer = MessageBox.Show(
            "Port " + Port + " is taken by " + who + ", but it isn't answering as Corpus.\n\n" +
            "This is usually a leftover Corpus server from a session that didn't close cleanly. " +
            "Ending it and starting fresh is safe — ingestion resumes where it stopped.\n\n" +
            "End it and start Corpus?",
            "Corpus", MessageBoxButtons.YesNo, MessageBoxIcon.Question);

        if (answer != DialogResult.Yes)
        {
            Error("Left it alone. Corpus needs port " + Port + ", so it can't start.");
            Environment.Exit(0);
        }

        KillTree(pid);
        for (int i = 0; i < 20 && PortBusy(); i++) Thread.Sleep(250);

        if (PortBusy())
        {
            Error("Couldn't free port " + Port + ". Restarting the machine will clear it.");
            Environment.Exit(0);
        }
        return false;
    }

    static string FindNode()
    {
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
        };
        foreach (var c in candidates) if (File.Exists(c)) return c;

        // Fall back to PATH.
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(';'))
        {
            if (dir.Length == 0) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { /* malformed PATH entry */ }
        }
        return null;
    }

    /**
     * Whether data/config.json asks for LAN mode.
     *
     * Read here rather than passed in because the setting is changed from the
     * Settings page, in the running app, and takes effect the next time the
     * launcher starts the server. Deliberately a substring test rather than a
     * JSON parser: the question is "does the object have lan.enabled true",
     * which survives the formatting writeStore produces. A file we cannot read
     * means off, which is the setting that keeps the server on this machine only.
     */
    static bool LanWanted()
    {
        try
        {
            var path = Path.Combine(Root, "data", "config.json");
            if (!File.Exists(path)) return false;
            var text = File.ReadAllText(path);
            int at = text.IndexOf("\"lan\"", StringComparison.Ordinal);
            if (at < 0) return false;
            int end = text.IndexOf('}', at);
            if (end < 0) end = text.Length;
            var section = text.Substring(at, end - at);
            // Whitespace out, so the check does not depend on how the JSON
            // happened to be formatted when it was written.
            var packed = new StringBuilder();
            foreach (var c in section) if (!char.IsWhiteSpace(c)) packed.Append(c);
            return packed.ToString().Contains("\"enabled\":true");
        }
        catch { return false; }
    }

    static bool lanMode;

    /**
     * Starts a packaged copy: Next's standalone server, which carries the
     * node_modules it needs and takes its port and hostname from the
     * environment rather than the command line.
     *
     * The data directory is pinned to the folder the exe sits in, so a copy on
     * a USB stick keeps its own library beside it instead of writing into
     * wherever the process happened to start. LAN mode is still read from
     * data/config.json and still means the same two things — bind every
     * interface, and set CORPUS_LAN so middleware.ts demands the token — but
     * without scripts/lan.mjs, which a handed-over copy does not carry.
     */
    static bool StartStandalone(string node, string serverJs)
    {
        lanMode = LanWanted();

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "\"" + serverJs + "\"",
            WorkingDirectory = Path.GetDirectoryName(serverJs),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.EnvironmentVariables["NODE_ENV"] = "production";
        psi.EnvironmentVariables["PORT"] = Port.ToString();
        psi.EnvironmentVariables["HOSTNAME"] = lanMode ? "0.0.0.0" : "127.0.0.1";
        psi.EnvironmentVariables["CORPUS_DATA_DIR"] = Path.Combine(Root, "data");
        if (lanMode) psi.EnvironmentVariables["CORPUS_LAN"] = "1";

        return Launch(psi);
    }

    static bool Start(string node, string nextBin)
    {
        // A production build is faster and quieter; fall back to dev if the
        // build output isn't there, so the launcher works either way.
        //
        // BUILD_ID rather than the .next/server directory, because `next dev`
        // creates that directory too. Checking for it meant that after anyone
        // ran the dev server even once, the launcher would confidently start in
        // production mode against a development .next and die with "Could not
        // find a production build" — a real failure with a misleading message.
        bool built = File.Exists(Path.Combine(Root, ".next", "BUILD_ID"));
        string mode = built ? "start" : "dev";

        // LAN mode binds every interface AND demands a token; the two must
        // never come apart, so both live in one script rather than in a
        // hostname flag here. See scripts/lan.mjs and middleware.ts.
        lanMode = LanWanted();
        string arguments = lanMode
            ? "\"" + Path.Combine(Root, "scripts", "lan.mjs") + "\" " + mode
            : "\"" + nextBin + "\" " + mode + " --port " + Port + " --hostname 127.0.0.1";

        var psi = new ProcessStartInfo
        {
            FileName = node,
            Arguments = arguments,
            WorkingDirectory = Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.EnvironmentVariables["NODE_ENV"] = built ? "production" : "development";
        psi.EnvironmentVariables["PORT"] = Port.ToString();

        return Launch(psi);
    }

    static bool Launch(ProcessStartInfo psi)
    {
        try
        {
            server = Process.Start(psi);
            // The pipes must be drained or a chatty server fills the buffer and
            // blocks. Since we are reading them anyway, keep the last run's
            // output — without it a 500 in the window has nowhere to be
            // explained, and there is no console to look at.
            OpenLog();
            server.OutputDataReceived += (s, e) => Log(e.Data);
            server.ErrorDataReceived += (s, e) => Log(e.Data);
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

            // If the server dies, say so and go. A tray icon that stays put
            // while nothing is listening is worse than no tray icon.
            server.EnableRaisingEvents = true;
            server.Exited += (s, e) => OnServerExit();
            return true;
        }
        catch (Exception ex)
        {
            Error("Couldn't start the server:\n\n" + ex.Message);
            return false;
        }
    }

    static bool quitting;

    static void OnServerExit()
    {
        if (quitting) return;
        int code = -1;
        try { code = server.ExitCode; } catch { }

        // Marshalled onto the UI thread: Process.Exited fires on a pool thread,
        // and touching the tray or ending the message loop from there is how you
        // get a launcher that hangs instead of closing.
        Action report = () =>
        {
            if (quitting) return;
            quitting = true;
            Error("The Corpus server stopped unexpectedly (exit code " + code + ").\n\n" +
                  "The log has the details:\n" + LogPath + "\n\n" +
                  "Nothing is lost — ingestion resumes where it stopped when you start Corpus again.");
            CloseLog();
            if (tray != null) tray.Visible = false;
            Application.Exit();
        };

        try
        {
            if (tray != null && tray.ContextMenuStrip != null && tray.ContextMenuStrip.InvokeRequired)
                tray.ContextMenuStrip.BeginInvoke(report);
            else
                report();
        }
        catch { }
    }

    // -- logging -----------------------------------------------------------

    static StreamWriter log;
    static readonly object logLock = new object();

    static string LogPath { get { return Path.Combine(Root, "data", "server.log"); } }

    static void OpenLog()
    {
        try
        {
            Directory.CreateDirectory(Path.Combine(Root, "data"));
            // Fresh file each launch; the previous run's log is rarely what you
            // want and an ever-growing one is worse.
            log = new StreamWriter(LogPath, false) { AutoFlush = true };
            log.WriteLine("--- Corpus started " + DateTime.Now + " ---");
        }
        catch { log = null; }
    }

    static void Log(string line)
    {
        if (line == null || log == null) return;
        lock (logLock)
        {
            try { log.WriteLine(line); } catch { }
        }
    }

    static void CloseLog()
    {
        lock (logLock)
        {
            try { if (log != null) { log.Dispose(); log = null; } } catch { }
        }
    }

    static void Stop()
    {
        quitting = true;
        try
        {
            if (server != null && !server.HasExited)
            {
                // next spawns a child; killing the tree is the only reliable way.
                KillTree(server.Id);
            }
            else if (server == null)
            {
                // We adopted a server we did not start, so there is no handle to
                // kill — but Quit still has to mean quit.
                KillTree(PortOwner());
            }
        }
        catch { /* already gone */ }

        CloseLog();
        if (tray != null) tray.Visible = false;
    }

    // Something is listening on the port. Says nothing about what it is.
    static bool PortBusy()
    {
        using (var client = new TcpClient())
        {
            try
            {
                var result = client.BeginConnect("127.0.0.1", Port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(400))) return false;
                client.EndConnect(result);
                return true;
            }
            catch { return false; }
        }
    }

    // A *Corpus* is listening on this machine, and it is answering requests.
    // Asking the server to identify itself costs one request and removes a
    // whole class of problem: an orphaned server that merely holds the port.
    static bool Healthy()
    {
        return Hello("http://127.0.0.1:" + Port, 15000) != null;
    }

    static bool RemoteHealthy(string baseUrl)
    {
        return !string.IsNullOrEmpty(baseUrl) && Hello(baseUrl, 6000) != null;
    }

    /** What /api/hello says at an address, or null when it is not Corpus answering. */
    static string Hello(string baseUrl, int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(baseUrl.TrimEnd('/') + "/api/hello");
            // Generous locally, because the first request is the expensive one:
            // it opens the database, which runs migrations.
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
            {
                var body = reader.ReadToEnd();
                return body.Contains("\"app\":\"corpus\"") ? body : null;
            }
        }
        catch { return null; }
    }

    /**
     * Sets the worker going once the server is up.
     *
     * A failure is not worth reporting: the first action in the app kicks the
     * worker too, so the cost of missing it is a delay, not lost work.
     */
    static void KickWorker()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/api/worker/kick");
            req.Method = "POST";
            req.ContentLength = 0;
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            // In LAN mode every route but /api/hello wants the token. We are on
            // the machine that owns it, so read it from the same file.
            var token = LanToken();
            if (token != null) req.Headers.Add("x-corpus-token", token);
            using (var res = (HttpWebResponse)req.GetResponse()) { }
        }
        catch { }
    }

    /** The LAN token from data/config.json, or null when there is none yet. */
    static string LanToken()
    {
        try
        {
            var path = Path.Combine(Root, "data", "config.json");
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path);
            int at = text.IndexOf("\"token\"", StringComparison.Ordinal);
            if (at < 0) return null;
            int open = text.IndexOf('"', text.IndexOf(':', at) + 1);
            int close = open < 0 ? -1 : text.IndexOf('"', open + 1);
            if (open < 0 || close < 0) return null;
            return text.Substring(open + 1, close - open - 1);
        }
        catch { return null; }
    }

    // Whoever is holding the port, so we can name them or end them.
    static int PortOwner()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "netstat",
                Arguments = "-ano -p TCP",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            };
            using (var p = Process.Start(psi))
            {
                string line;
                while ((line = p.StandardOutput.ReadLine()) != null)
                {
                    if (line.IndexOf(":" + Port, StringComparison.Ordinal) < 0) continue;
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    int pid;
                    if (parts.Length > 0 && int.TryParse(parts[parts.Length - 1], out pid)) return pid;
                }
            }
        }
        catch { }
        return 0;
    }

    static void KillTree(int pid)
    {
        if (pid <= 0) return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "taskkill",
                Arguments = "/PID " + pid + " /T /F",
                CreateNoWindow = true,
                UseShellExecute = false,
            }).WaitForExit(5000);
        }
        catch { }
    }

    // Waits for our own server to start answering — not merely to bind.
    static bool WaitForServer(int seconds)
    {
        for (int i = 0; i < seconds * 2; i++)
        {
            if (Healthy()) return true;
            if (server != null && server.HasExited) return false;
            Thread.Sleep(500);
        }
        return false;
    }

    // -- the window ----------------------------------------------------------

    /** The Corpus this launcher uses. 127.0.0.1 rather than localhost: the server binds IPv4 only, and Windows tries ::1 first. */
    static string BaseUrl()
    {
        return settings.Remote ? settings.RemoteUrl : "http://127.0.0.1:" + Port;
    }

    /**
     * Where a new window starts. In LAN mode that is the sign-in link, so the
     * window arrives signed in rather than at a page asking for a token: this
     * machine's own token when the Corpus is local, the one saved with the
     * address when it is remote.
     */
    static string EntryUrl()
    {
        string token = settings.Remote ? settings.Token : (LanWanted() ? LanToken() : null);
        return string.IsNullOrEmpty(token)
            ? BaseUrl() + "/"
            : BaseUrl() + "/login?token=" + Uri.EscapeDataString(token);
    }

    /**
     * Brings Corpus up: the window already open, if there is one, else a new
     * app window, else — no Chromium browser found, or tabs asked for — a tab
     * in the default browser.
     */
    static void Open(bool inTab)
    {
        if (!inTab && settings.Window != "tab")
        {
            if (FocusCorpusWindow()) return;
            var browser = FindAppBrowser();
            if (browser != null)
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = browser,
                        Arguments = "--app=\"" + EntryUrl() + "\"",
                        UseShellExecute = false,
                    });
                    return;
                }
                catch { /* an ordinary tab, then */ }
            }
        }
        try
        {
            Process.Start(new ProcessStartInfo { FileName = EntryUrl(), UseShellExecute = true });
        }
        catch (Exception ex) { Error("Couldn't open your browser:\n\n" + ex.Message); }
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);

    static readonly string[] Chromium = { "brave", "chrome", "msedge" };

    /**
     * Finds an app window already showing Corpus and brings it forward.
     *
     * Every page in Corpus is titled "Corpus", and an app window's title is the
     * page's title and nothing else; a browser window whose tab happens to be
     * Corpus appends the browser's name. So an app window is one owned by a
     * Chromium browser whose title starts with Corpus and names no browser.
     */
    static bool FocusCorpusWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            var text = new StringBuilder(256);
            GetWindowText(hWnd, text, text.Capacity);
            var title = text.ToString();
            if (!title.StartsWith("Corpus", StringComparison.Ordinal)) return true;
            if (title.Contains(" - Brave") || title.Contains(" - Google Chrome") || title.Contains(" - Microsoft")) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            try
            {
                var name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                if (Array.IndexOf(Chromium, name) < 0) return true;
            }
            catch { return true; }
            found = hWnd;
            return false;
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) return false;
        if (IsIconic(found)) ShowWindow(found, 9 /* SW_RESTORE */);
        SetForegroundWindow(found);
        return true;
    }

    /** A browser that can open an app window: the default one if it can, else Brave, Chrome, Edge. */
    static string FindAppBrowser()
    {
        var order = new List<string>();
        var progId = DefaultBrowserProgId();
        if (progId.StartsWith("Brave", StringComparison.OrdinalIgnoreCase)) order.Add("brave.exe");
        else if (progId.StartsWith("Chrome", StringComparison.OrdinalIgnoreCase)) order.Add("chrome.exe");
        else if (progId.StartsWith("MSEdge", StringComparison.OrdinalIgnoreCase)) order.Add("msedge.exe");
        foreach (var exe in new[] { "brave.exe", "chrome.exe", "msedge.exe" })
            if (!order.Contains(exe)) order.Add(exe);

        foreach (var exe in order)
        {
            var path = BrowserPath(exe);
            if (path != null) return path;
        }
        return null;
    }

    static string DefaultBrowserProgId()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"))
            {
                var value = key == null ? null : key.GetValue("ProgId") as string;
                return value ?? "";
            }
        }
        catch { return ""; }
    }

    static string BrowserPath(string exe)
    {
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            try
            {
                using (var key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exe))
                {
                    var value = key == null ? null : key.GetValue("") as string;
                    if (!string.IsNullOrEmpty(value))
                    {
                        value = value.Trim('"');
                        if (File.Exists(value)) return value;
                    }
                }
            }
            catch { }
        }

        string sub = exe == "brave.exe" ? @"BraveSoftware\Brave-Browser\Application"
                   : exe == "chrome.exe" ? @"Google\Chrome\Application"
                   : @"Microsoft\Edge\Application";
        foreach (var folder in new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        })
        {
            var candidate = Path.Combine(Path.Combine(folder, sub), exe);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    // -- where to connect ------------------------------------------------------

    static string HostOf(string url)
    {
        try { return new Uri(url).Authority; } catch { return url; }
    }

    /**
     * An address as typed, made into what the launcher uses: a scheme, a host,
     * and Corpus's port when none was given. Null when it is not an address.
     */
    static string NormaliseUrl(string typed)
    {
        var text = (typed ?? "").Trim();
        if (text.Length == 0 || text == "http://" || text == "https://") return null;
        bool schemed = text.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                       text.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
        if (!schemed) text = "http://" + text;
        Uri uri;
        if (!Uri.TryCreate(text, UriKind.Absolute, out uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;
        if (string.IsNullOrEmpty(uri.Host)) return null;
        // "192.168.1.20" means Corpus on that machine, not a web server on port 80.
        bool portTyped = text.IndexOf(':', text.IndexOf("//", StringComparison.Ordinal) + 2) >= 0;
        var port = portTyped ? uri.Port : Port;
        return uri.Scheme + "://" + uri.Host + ":" + port;
    }

    /** What an address answers, in words for the Test button. */
    static string Probe(string baseUrl, string token)
    {
        var hello = Hello(baseUrl, 6000);
        if (hello == null)
            return "Nothing answered as Corpus at " + baseUrl + ". Is it running there, with LAN mode on?";

        string host = HostOf(baseUrl);
        int at = hello.IndexOf("\"host\":\"", StringComparison.Ordinal);
        if (at >= 0)
        {
            int start = at + 8;
            int end = hello.IndexOf('"', start);
            if (end > start) host = hello.Substring(start, end - start);
        }

        try
        {
            var req = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/drafts");
            req.Timeout = 6000;
            req.ReadWriteTimeout = 6000;
            if (!string.IsNullOrEmpty(token)) req.Headers.Add("x-corpus-token", token);
            using (var res = (HttpWebResponse)req.GetResponse()) { }
            return "Found Corpus on " + host + ", and it let this computer in.";
        }
        catch (WebException ex)
        {
            var res = ex.Response as HttpWebResponse;
            if (res != null && (int)res.StatusCode == 401)
                return string.IsNullOrEmpty(token)
                    ? "Found Corpus on " + host + ". It needs its token — copy it from Settings → LAN mode there."
                    : "Found Corpus on " + host + ", but that token isn't the one it uses.";
            return "Found Corpus on " + host + ", but it didn't answer properly: " + ex.Message;
        }
    }

    /**
     * Chooses between this computer's Corpus and one on another machine.
     *
     * Switching restarts the launcher, and switching away from this computer
     * stops its server first — say so before doing it.
     */
    static void ShowConnect()
    {
        using (var form = new Form())
        {
            form.Text = "Corpus — where to connect";
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = new Size(460, 318);
            form.Icon = LoadIcon();
            form.Font = SystemFonts.MessageBoxFont;

            var local = new RadioButton { Text = "This computer — start Corpus here", Left = 16, Top = 16, Width = 420, Checked = !settings.Remote };
            var remote = new RadioButton { Text = "A Corpus on another computer", Left = 16, Top = 44, Width = 420, Checked = settings.Remote };
            var addressLabel = new Label { Text = "Its address, as Settings → LAN mode shows it there:", Left = 36, Top = 76, Width = 404 };
            var address = new TextBox { Left = 36, Top = 96, Width = 404, Text = settings.RemoteUrl.Length > 0 ? settings.RemoteUrl : "http://" };
            var tokenLabel = new Label { Text = "Its token, from the same place:", Left = 36, Top = 128, Width = 404 };
            var token = new TextBox { Left = 36, Top = 148, Width = 404, Text = settings.Token, UseSystemPasswordChar = true };
            var status = new Label { Left = 16, Top = 186, Width = 428, Height = 58, ForeColor = Color.DimGray };
            var hint = new Label
            {
                Left = 16, Top = 244, Width = 428, Height = 30, ForeColor = Color.DimGray,
                Text = "On another computer Corpus runs there: this one only opens its window. Point the browser extension's options at the same address.",
            };
            var test = new Button { Text = "Test", Left = 16, Top = 280, Width = 90 };
            var connect = new Button { Text = "Connect", Left = 256, Top = 280, Width = 90 };
            var cancel = new Button { Text = "Cancel", Left = 352, Top = 280, Width = 90, DialogResult = DialogResult.Cancel };

            Action sync = () =>
            {
                address.Enabled = token.Enabled = addressLabel.Enabled = tokenLabel.Enabled = test.Enabled = remote.Checked;
            };
            local.CheckedChanged += (s, e) => sync();
            remote.CheckedChanged += (s, e) => sync();
            sync();

            test.Click += (s, e) =>
            {
                var url = NormaliseUrl(address.Text);
                if (url == null) { status.Text = "That doesn't look like an address. It should look like http://192.168.1.20:5400"; return; }
                status.Text = "Asking " + url + " …";
                status.Refresh();
                form.Cursor = Cursors.WaitCursor;
                status.Text = Probe(url, token.Text.Trim());
                form.Cursor = Cursors.Default;
            };

            connect.Click += (s, e) =>
            {
                if (remote.Checked && NormaliseUrl(address.Text) == null)
                {
                    status.Text = "That doesn't look like an address. It should look like http://192.168.1.20:5400";
                    return;
                }
                form.DialogResult = DialogResult.OK;
                form.Close();
            };

            form.Controls.AddRange(new Control[] { local, remote, addressLabel, address, tokenLabel, token, status, hint, test, connect, cancel });
            form.AcceptButton = connect;
            form.CancelButton = cancel;

            if (form.ShowDialog() != DialogResult.OK) return;

            bool wasRemote = settings.Remote;
            string connectTo = remote.Checked ? "remote" : "local";
            string url2 = remote.Checked ? NormaliseUrl(address.Text) : settings.RemoteUrl;
            string token2 = remote.Checked ? token.Text.Trim() : settings.Token;
            bool changed = connectTo != settings.Connect ||
                           (remote.Checked && (url2 != settings.RemoteUrl || token2 != settings.Token));
            if (!changed) return;

            if (!wasRemote)
            {
                var sure = MessageBox.Show(
                    "Using another computer's Corpus stops the Corpus server on this one.\n\n" +
                    "Anything it was reading resumes the next time you switch back.\n\nSwitch?",
                    "Corpus", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (sure != DialogResult.Yes) return;
            }

            settings.Connect = connectTo;
            settings.RemoteUrl = url2 ?? "";
            settings.Token = token2 ?? "";
            if (!TrySave()) return;
            Restart(wasRemote);
        }
    }

    static bool TrySave()
    {
        try { settings.Save(); return true; }
        catch (Exception ex) { Error("Couldn't save the setting:\n\n" + ex.Message); return false; }
    }

    /** Starts a fresh launcher with the new setting, and gets out of its way. */
    static void Restart(bool wasRemote)
    {
        if (wasRemote) { if (tray != null) tray.Visible = false; }
        else Stop();
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = Application.ExecutablePath,
                Arguments = "--restarted",
                UseShellExecute = false,
            });
        }
        catch (Exception ex) { Error("Couldn't restart Corpus:\n\n" + ex.Message); }
        Application.Exit();
    }

    // -- tray --------------------------------------------------------------

    static NotifyIcon BuildTray()
    {
        var menu = new ContextMenuStrip();
        var open = menu.Items.Add("Open Corpus", null, (s, e) => Open(false));
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add("Open in a browser tab", null, (s, e) => Open(true));
        menu.Items.Add(new ToolStripSeparator());

        menu.Items.Add(settings.Remote
            ? "Using " + HostOf(settings.RemoteUrl) + " — change…"
            : "Connect to another Corpus…", null, (s, e) => ShowConnect());

        var appWindow = new ToolStripMenuItem("Open in its own window") { Checked = settings.Window != "tab", CheckOnClick = true };
        appWindow.CheckedChanged += (s, e) =>
        {
            settings.Window = appWindow.Checked ? "app" : "tab";
            TrySave();
        };
        menu.Items.Add(appWindow);

        if (!settings.Remote)
        {
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Open the data folder", null, (s, e) =>
            {
                var dir = Path.Combine(Root, "data");
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo { FileName = dir, UseShellExecute = true });
            });
            menu.Items.Add("View the server log", null, (s, e) =>
            {
                if (File.Exists(LogPath))
                    Process.Start(new ProcessStartInfo { FileName = "notepad.exe", Arguments = "\"" + LogPath + "\"" });
                else
                    Error("No log yet — the server was already running when Corpus started.");
            });
        }

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(settings.Remote ? "Quit" : "Quit (stops ingesting)", null, (s, e) =>
        {
            if (settings.Remote) { if (tray != null) tray.Visible = false; }
            else Stop();
            Application.Exit();
        });

        string text = settings.Remote
            ? "Corpus — using " + HostOf(settings.RemoteUrl)
            : LanWanted()
                ? "Corpus — on this network, port " + Port + " (token required)"
                : "Corpus — running on localhost:" + Port;

        var icon = new NotifyIcon
        {
            Icon = LoadIcon(),
            // The notification area refuses a tooltip over 63 characters.
            Text = text.Length > 63 ? text.Substring(0, 63) : text,
            ContextMenuStrip = menu,
            Visible = true,
        };
        icon.DoubleClick += (s, e) => Open(false);
        return icon;
    }

    static Icon LoadIcon()
    {
        var path = Path.Combine(Root, "launcher", "corpus.ico");
        if (File.Exists(path))
        {
            try { return new Icon(path); } catch { }
        }
        // A packaged copy has no launcher folder; its own exe carries the icon.
        try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        return SystemIcons.Application;
    }

    static void Notify(string message)
    {
        if (tray == null) return;
        tray.BalloonTipTitle = "Corpus";
        tray.BalloonTipText = message;
        tray.ShowBalloonTip(4000);
    }

    static void Error(string message)
    {
        MessageBox.Show(message, "Corpus", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}

/**
 * The launcher's own settings, in data\launcher.ini: where to connect, and how
 * to open. Key=value lines rather than JSON because this is framework-free C#
 * and four keys do not need a parser.
 */
sealed class Settings
{
    public string Connect = "local";   // local | remote
    public string RemoteUrl = "";
    public string Token = "";
    public string Window = "app";      // app | tab
    string path;

    public bool Remote { get { return Connect == "remote" && RemoteUrl.Length > 0; } }

    public static Settings Load(string path)
    {
        var s = new Settings { path = path };
        try
        {
            if (!File.Exists(path)) return s;
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                var key = line.Substring(0, eq).Trim();
                var value = line.Substring(eq + 1).Trim();
                if (key == "connect") s.Connect = value;
                else if (key == "remote") s.RemoteUrl = value;
                else if (key == "token") s.Token = value;
                else if (key == "window") s.Window = value;
            }
        }
        catch { }
        return s;
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllLines(path, new[]
        {
            "# Corpus launcher: where this copy connects, and how it opens.",
            "# Changed from the tray icon (right-click, Connect to another Corpus).",
            "connect=" + Connect,
            "remote=" + RemoteUrl,
            "token=" + Token,
            "window=" + Window,
        });
    }
}
