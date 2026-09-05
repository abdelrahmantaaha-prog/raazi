// Corpus launcher.
//
// Double-click, and it starts the Next server hidden, waits for the port to
// answer, opens your browser, and sits in the notification area. Right-click the
// tray icon to reopen or quit. Quitting stops the server; closing the browser
// does not, so a long ingest keeps running while you get on with something else.
//
// Compiled with the C# compiler that ships with Windows — see build.ps1. No
// Electron, no extra runtime, about 15 KB.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

static class Corpus
{
    const int Port = 5400;
    static Process server;
    static NotifyIcon tray;
    static readonly string Root =
        Path.GetDirectoryName(Application.ExecutablePath);

    [STAThread]
    static void Main(string[] args)
    {
        // One instance only — a second server on the same port would just fail.
        bool isNew;
        using (var mutex = new Mutex(true, "Corpus.Launcher.SingleInstance", out isNew))
        {
            if (!isNew)
            {
                if (Healthy()) Open();
                else Error("Corpus is already starting up. Give it a moment.");
                return;
            }

            Application.EnableVisualStyles();

            string node = FindNode();
            if (node == null)
            {
                Error("Node.js isn't installed, or isn't where I expected.\n\n" +
                      "Install the LTS build from nodejs.org, then run Corpus again.");
                return;
            }

            string nextBin = Path.Combine(Root, "node_modules", "next", "dist", "bin", "next");
            if (!File.Exists(nextBin))
            {
                Error("Corpus isn't set up yet.\n\nOpen a terminal in\n" + Root +
                      "\nand run:  npm install\n\nThen run Corpus again.");
                return;
            }

            bool alreadyRunning = ClaimPort();
            if (!alreadyRunning && !Start(node, nextBin)) return;

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

            Open();
            Notify(alreadyRunning
                ? "Corpus was already running — opened it for you."
                : "Corpus is running. It stays up if you close the browser.");

            Application.Run();
            Stop();
        }
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
     *                                alternative is a browser window served by a
     *                                dead build and a Quit button that quits
     *                                nothing.
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
     * JSON parser: this file is 15 KB of framework-free C# and the question is
     * "does the object have lan.enabled true", which survives the formatting
     * writeStore produces. A file we cannot read means off, which is the
     * setting that keeps the server on this machine only.
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
            var packed = new System.Text.StringBuilder();
            foreach (var c in section) if (!char.IsWhiteSpace(c)) packed.Append(c);
            return packed.ToString().Contains("\"enabled\":true");
        }
        catch { return false; }
    }

    static bool lanMode;

    static bool Start(string node, string nextBin)
    {
        // A production build is faster and quieter; fall back to dev if the
        // build output isn't there, so the launcher works either way.
        //
        // BUILD_ID rather than the .next/server directory, because `next dev`
        // creates that directory too. Checking for it meant that after anyone
        // ran the dev server even once, the launcher would confidently start in
        // production mode against a development .next and die with "Could not
        // find a production build" — a real failure with a misleading message,
        // since the build had in fact succeeded and then been overwritten.
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

        try
        {
            server = Process.Start(psi);
            // The pipes must be drained or a chatty server fills the buffer and
            // blocks. Since we are reading them anyway, keep the last run's
            // output — without it a 500 in the browser has nowhere to be
            // explained, and there is no console to look at.
            OpenLog();
            server.OutputDataReceived += (s, e) => Log(e.Data);
            server.ErrorDataReceived += (s, e) => Log(e.Data);
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

            // If the server dies, say so and go. A tray icon that stays put
            // while nothing is listening is worse than no tray icon: every
            // click opens a browser tab that cannot connect, and the only clue
            // is in a log nobody has been told to read.
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
                // kill — but Quit still has to mean quit. Without this the tray
                // vanished and the node process carried on holding the port,
                // which is precisely how the orphans get made.
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

    // A *Corpus* is listening, and it is answering requests.
    //
    // This distinction is the whole point. The launcher used to treat "the TCP
    // port accepts a connection" as "Corpus is running", so an orphaned server
    // left over from a previous session — which happens whenever the launcher is
    // killed rather than quit, since nothing else ever stops its node child —
    // made every subsequent launch silently attach to the old process. You got a
    // browser window served by a stale build, no log, and a tray icon whose Quit
    // stopped nothing. Asking the server to identify itself costs one request
    // and removes the entire class of problem.
    static bool Healthy()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/api/hello");
            // Generous, because the *first* request is the expensive one: it is
            // what opens the database, which runs migrations and any one-off
            // repairs over ten thousand entities. Two seconds was enough to make
            // a perfectly healthy server look dead on the launch that mattered.
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream()))
            {
                return reader.ReadToEnd().Contains("\"app\":\"corpus\"");
            }
        }
        catch { return false; }
    }

    /**
     * Sets the worker going once the server is up.
     *
     * GET /api/hello used to do this as a side effect, which meant a phone
     * sweeping the subnet — or anything else that could reach the port —
     * started token-spending work. It is a POST now, and this is its caller.
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

    static void Open()
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                // 127.0.0.1, not localhost. The server binds IPv4 only, and on
                // Windows "localhost" resolves to ::1 first — so the browser's
                // first connection is refused and you are relying on it to fall
                // back. Most do, some sulk, and the failure looks exactly like
                // a dead server while the tray insists it is running.
                FileName = "http://127.0.0.1:" + Port + "/",
                UseShellExecute = true,
            });
        }
        catch (Exception ex) { Error("Couldn't open your browser:\n\n" + ex.Message); }
    }

    // -- tray --------------------------------------------------------------

    static NotifyIcon BuildTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Corpus", null, (s, e) => Open());
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
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit (stops ingesting)", null, (s, e) =>
        {
            Stop();
            Application.Exit();
        });

        var icon = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = lanMode
                ? "Corpus — on this network, port " + Port + " (token required)"
                : "Corpus — running on localhost:" + Port,
            ContextMenuStrip = menu,
            Visible = true,
        };
        icon.DoubleClick += (s, e) => Open();
        return icon;
    }

    static Icon LoadIcon()
    {
        var path = Path.Combine(Root, "launcher", "corpus.ico");
        if (File.Exists(path))
        {
            try { return new Icon(path); } catch { }
        }
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

