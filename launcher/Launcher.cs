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
// Local, or following another. "Connect to another Corpus" points this
// launcher at a Corpus running on another machine — the other laptop, over the
// LAN or Tailscale. The window opens on that one, and a quiet copy of it runs
// here beside it (a follower: lib/follow.ts), kept in step every few minutes.
// When that machine stops answering, the launcher says so and moves the window
// to the copy; when it answers again, what was done here goes back to it
// first, and the window goes back to it after. The choice lives in
// data\launcher.ini.
//
// With Windows. "Start when Windows starts" in the tray menu puts the launcher
// under the user's Run key with --at-sign-in, and started that way it brings
// the server (or the follower's copy) up in the tray and opens no window:
// feeds are polled and parked runs resume before you ask for anything.
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
    const string CopyTitle = "Corpus · this computer's copy";
    const string SignInArg = "--at-sign-in";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    /** Started by Windows at sign-in: up in the tray, no window until asked. */
    static bool atSignIn;
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
        atSignIn = Array.IndexOf(args, SignInArg) >= 0;
        settings = Settings.Load(Path.Combine(Root, "data", "launcher.ini"));

        using (var mutex = new Mutex(false, "Corpus.Launcher.SingleInstance"))
        {
            bool owned;
            try { owned = mutex.WaitOne(restarted ? 15000 : 0, false); }
            catch (AbandonedMutexException) { owned = true; }

            if (!owned)
            {
                // Windows starting a launcher you had already opened by hand
                // asked for nothing to be shown.
                if (atSignIn) return;
                // Already running: bring its window forward rather than start
                // a second of anything. A follower's launcher knows which
                // window that is; this process does not, so it asks for the
                // primary's, which is right unless the primary is down — and
                // then the running launcher has already opened the copy.
                if (settings.Remote || Healthy()) Open(false);
                else Error("Corpus is already starting up. Give it a moment.");
                return;
            }

            try
            {
                Application.EnableVisualStyles();
                ui = new Control();
                var handle = ui.Handle; // created now, on this thread, so others can marshal onto it
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
                  "Install the LTS build from nodejs.org, then run Corpus again.");
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

        // Before this library starts working or opens: if another computer
        // follows it and did work while this one was off, that comes back first.
        AwaitFollowers();

        // Resuming pending work on a headless start is this call, once, from
        // the one client that is entitled to make it.
        KickWorker();

        // At sign-in the point is the server — feeds polled and parked runs
        // resumed before you sit down — not a window you did not ask for.
        if (atSignIn)
        {
            Notify("Corpus started with Windows and is running in the background. Double-click here to open it.");
        }
        else
        {
            Open(false);
            Notify(alreadyRunning
                ? "Corpus was already running — opened it for you."
                : "Corpus is running. It stays up if you close its window; quit from here.");
        }

        Application.Run();
        Stop();
    }

    // -- following another Corpus ---------------------------------------------

    static Control ui;
    static volatile bool offline;
    static volatile bool conflict;
    static volatile bool hasCopy;
    static volatile bool tickNow;
    static volatile string pendingResolve;
    static bool follower;          // start the local server as a follower's copy
    static bool adoptedFollower;   // a follower already running from a launcher that did not close cleanly
    static bool windowOpened;
    static string lastSyncText = "";
    static Form downForm;
    static Form conflictForm;
    static ToolStripItem resolveItem;

    /**
     * Uses a Corpus on another machine, with a copy of it kept here.
     *
     * The window opens on the other machine at once, if it answers; the copy is
     * started and kept in step on a background thread, so a first copy that
     * takes minutes never holds up the window. The tray stays up even when the
     * other Corpus cannot be reached, because the tray is where you change your
     * mind.
     */
    static void RunRemote()
    {
        tray = BuildTray();
        // At sign-in, count the window as already dealt with, so the follower
        // loop keeps the copy in step without opening one when it first connects.
        if (atSignIn) windowOpened = true;
        if (!atSignIn && RemoteHealthy(settings.RemoteUrl))
        {
            Open(false);
            windowOpened = true;
            Notify("Using the Corpus at " + HostOf(settings.RemoteUrl) + ". A copy is kept on this computer in case it goes down.");
        }

        var thread = new Thread(FollowLoop) { IsBackground = true, Name = "Corpus follower" };
        thread.Start();

        Application.Run();
        Stop();
    }

    static string LocalBase() { return "http://127.0.0.1:" + Port; }

    static void FollowLoop()
    {
        hasCopy = StartFollower();
        if (!hasCopy)
        {
            WatchOnly();
            return;
        }

        Http("POST", LocalBase() + "/api/sync/follow",
            "{\"action\":\"configure\",\"url\":\"" + JsonEscape(settings.RemoteUrl) + "\",\"token\":\"" + JsonEscape(settings.Token) + "\"}",
            15000);

        while (!quitting)
        {
            string resolve = pendingResolve;
            pendingResolve = null;
            string body = resolve == null
                ? "{\"action\":\"tick\"}"
                : "{\"action\":\"tick\",\"resolve\":\"" + resolve + "\"}";
            // A tick may take a whole copy of a library across the network.
            var json = Http("POST", LocalBase() + "/api/sync/follow", body, 60 * 60 * 1000);
            string state = JsonString(json, "state") ?? "error";
            string message = JsonString(json, "message") ?? "This computer's copy isn't answering.";
            string lastSync = JsonString(json, "lastSyncAt");
            Ui(() => OnFollowState(state, message, lastSync));

            // Every twenty seconds while it answers; every ten while it doesn't,
            // so its return is noticed quickly.
            int quarterSeconds = (offline ? 10 : 20) * 4;
            for (int i = 0; i < quarterSeconds && !quitting && !tickNow; i++) Thread.Sleep(250);
            tickNow = false;
        }
    }

    /** No copy here: all that can be done is to say when the other one is down, and when it is back. */
    static void WatchOnly()
    {
        while (!quitting)
        {
            bool up = RemoteHealthy(settings.RemoteUrl);
            if (!up && !offline)
            {
                offline = true;
                Ui(() => { ShowDown(false); UpdateTip(); });
            }
            else if (up && offline)
            {
                offline = false;
                Ui(() =>
                {
                    CloseForm(downForm);
                    Notify(HostOf(settings.RemoteUrl) + " is back.");
                    UpdateTip();
                    Open(false);
                    windowOpened = true;
                });
            }
            else if (up && !windowOpened)
            {
                Ui(() => { Open(false); windowOpened = true; });
            }
            for (int i = 0; i < 60 && !quitting; i++) Thread.Sleep(250);
        }
    }

    /** Starts this computer's copy, as a follower. False when there cannot be one. */
    static bool StartFollower()
    {
        string node = FindNode();
        string standalone = Path.Combine(Root, "server", "server.js");
        bool packaged = File.Exists(standalone);
        string nextBin = Path.Combine(Root, "node_modules", "next", "dist", "bin", "next");
        if (node == null || (!packaged && !File.Exists(nextBin)))
        {
            Ui(() => Notify("No copy is kept on this computer: " +
                (node == null ? "Node.js isn't installed." : "Corpus isn't set up here.") +
                " If " + HostOf(settings.RemoteUrl) + " goes down there is nothing to work from."));
            return false;
        }

        if (PortBusy())
        {
            if (Healthy())
            {
                if (IsFollowerServer())
                {
                    adoptedFollower = true;
                    return true;
                }
                // A Corpus running here as its own library would keep reading and
                // spending, and drift from the one being followed.
                var answer = MessageBox.Show(
                    "A Corpus is already running on this computer as its own library.\n\n" +
                    "Keeping a copy of " + HostOf(settings.RemoteUrl) + " here needs it stopped. Stop it?",
                    "Corpus", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return false;
            }
            KillTree(PortOwner());
            for (int i = 0; i < 20 && PortBusy(); i++) Thread.Sleep(250);
            if (PortBusy())
            {
                Ui(() => Notify("Port " + Port + " is taken, so no copy is kept on this computer."));
                return false;
            }
        }

        follower = true;
        if (!(packaged ? StartStandalone(node, standalone) : Start(node, nextBin))) return false;
        return WaitForServer(90);
    }

    static bool IsFollowerServer()
    {
        var json = Http("GET", LocalBase() + "/api/sync/follow", null, 10000);
        return json != null && json.IndexOf("\"follower\":true", StringComparison.Ordinal) >= 0;
    }

    static void OnFollowState(string state, string message, string lastSync)
    {
        if (!string.IsNullOrEmpty(lastSync)) lastSyncText = FormatWhen(lastSync);
        string host = HostOf(settings.RemoteUrl);

        if (state == "offline")
        {
            if (!offline)
            {
                offline = true;
                ShowDown(true);
            }
        }
        else if (state == "conflict")
        {
            offline = false;
            CloseForm(downForm);
            if (!conflict)
            {
                conflict = true;
                if (resolveItem != null) resolveItem.Visible = true;
                ShowConflict(message);
            }
        }
        else if (state == "in-step" || state == "pulled" || state == "behind" || state == "pushed")
        {
            bool wasAway = offline || conflict;
            offline = false;
            conflict = false;
            if (resolveItem != null) resolveItem.Visible = false;
            CloseForm(downForm);
            CloseForm(conflictForm);
            if (state == "pushed")
                Notify("What you did on this computer is on " + host + " now. Back to using " + host + ".");
            else if (wasAway)
                Notify(host + " is back. Using it again.");
            if (wasAway || !windowOpened)
            {
                Open(false);
                windowOpened = true;
            }
        }
        UpdateTip();
    }

    /**
     * The warning, when the Corpus this computer follows stops answering.
     *
     * A window of its own rather than a balloon, because a balloon is gone in
     * four seconds and this is the moment your changes stop saving.
     */
    static void ShowDown(bool withCopy)
    {
        string host = HostOf(settings.RemoteUrl);
        Notify("The Corpus server at " + host + " is down.");
        if (downForm != null && !downForm.IsDisposed)
        {
            downForm.Activate();
            return;
        }
        string text = "The Corpus server at " + host + " is down. Anything you change in its window now will not be saved.\n\n" +
            (withCopy
                ? "You can keep working from this computer's copy" +
                  (lastSyncText.Length > 0 ? ", which has everything up to " + lastSyncText : "") +
                  ". What you change on it goes back to " + host + " as soon as it answers again, before you are switched back."
                : "This computer keeps no copy of it, so there is nothing to work from until it answers again.");
        downForm = Prompt("Corpus — the server is down", text,
            withCopy ? new[] { "Work on this computer", "Wait for it" } : new[] { "OK" },
            choice =>
            {
                if (withCopy && choice == 0)
                {
                    Open(false);
                    windowOpened = true;
                }
            });
    }

    /** Both libraries changed while apart. A library is copied whole, so this is a choice, not a merge. */
    static void ShowConflict(string message)
    {
        string host = HostOf(settings.RemoteUrl);
        if (conflictForm != null && !conflictForm.IsDisposed)
        {
            conflictForm.Activate();
            return;
        }
        conflictForm = Prompt("Corpus — both copies changed",
            host + " and this computer both changed while they were apart.\n\n" + message + "\n\n" +
            "Corpus copies a library whole; it can't merge two of them. Choose which to keep. " +
            "The other is not deleted: it is saved as a backup on its own machine, in data\\backups.\n\n" +
            "Until you choose, you are working on this computer's copy.",
            new[] { "Keep this computer's", "Keep " + host + "'s", "Decide later" },
            choice =>
            {
                if (choice == 0) Resolve("keep-local");
                else if (choice == 1) Resolve("keep-primary");
                else
                {
                    Open(false);
                    windowOpened = true;
                }
            });
    }

    static void Resolve(string which)
    {
        string host = HostOf(settings.RemoteUrl);
        pendingResolve = which;
        tickNow = true;
        Notify(which == "keep-local"
            ? "Sending this computer's copy to " + host + "…"
            : "Taking " + host + "'s copy; this computer's is kept as a backup…");
    }

    static void UpdateTip()
    {
        if (tray == null) return;
        string host = HostOf(settings.RemoteUrl);
        string text = !settings.Remote
            ? (LanWanted() ? "Corpus — on this network, port " + Port + " (token required)" : "Corpus — running on localhost:" + Port)
            : offline
                ? "Corpus — " + host + " is down; using this computer's copy"
                : conflict
                    ? "Corpus — both copies changed; choose which to keep"
                    : "Corpus — using " + host + (hasCopy && lastSyncText.Length > 0 ? ", copy " + lastSyncText : "");
        // The notification area refuses a tooltip over 63 characters.
        tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
    }

    static string FormatWhen(string iso)
    {
        DateTime when;
        if (!DateTime.TryParse(iso, null, System.Globalization.DateTimeStyles.RoundtripKind, out when)) return "";
        when = when.ToLocalTime();
        return when.Date == DateTime.Today ? when.ToString("HH:mm") : when.ToString("d MMM HH:mm");
    }

    /**
     * On the primary, before it starts its worker and opens: a computer that
     * follows this one may have done work while this one was off, and that has
     * to come back before this library does anything of its own.
     *
     * Waits a short while for a follower seen before to check in, and for as
     * long as it takes once one says it is bringing work. "Open now" skips it.
     */
    static void AwaitFollowers()
    {
        var json = Http("GET", LocalBase() + "/api/sync/followers", null, 10000);
        if (json == null || json.IndexOf("\"expect\":true", StringComparison.Ordinal) < 0) return;

        string host = JsonString(json, "host") ?? "your other computer";
        bool skip = false;
        var form = Prompt("Corpus",
            "Checking with " + host + " for anything done on it while this computer was off…",
            new[] { "Open now" }, c => skip = true);

        DateTime until = DateTime.Now.AddSeconds(25);
        DateTime nextPoll = DateTime.Now;
        while (!skip && DateTime.Now < until && !form.IsDisposed)
        {
            Application.DoEvents();
            Thread.Sleep(100);
            if (DateTime.Now < nextPoll) continue;
            nextPoll = DateTime.Now.AddSeconds(1.5);

            json = Http("GET", LocalBase() + "/api/sync/followers", null, 10000);
            if (json == null) continue;
            bool receiving = json.IndexOf("\"receiving\":true", StringComparison.Ordinal) >= 0;
            bool bringing = json.IndexOf("\"bringingWork\":true", StringComparison.Ordinal) >= 0;
            if (receiving || bringing)
            {
                until = DateTime.Now.AddMinutes(20);
                var label = form.Tag as Label;
                if (label != null)
                    label.Text = "Bringing back what was done on " + host + " while this computer was off. Corpus opens as soon as it has it.";
            }
            else if (json.IndexOf("\"checkedIn\":true", StringComparison.Ordinal) >= 0)
            {
                break;
            }
        }
        CloseForm(form);
    }

    /** Runs on the UI thread, from any thread. */
    static void Ui(Action action)
    {
        try
        {
            if (ui != null && ui.IsHandleCreated) ui.BeginInvoke(action);
        }
        catch { }
    }

    static void CloseForm(Form form)
    {
        try { if (form != null && !form.IsDisposed) form.Close(); } catch { }
    }

    /**
     * A small window that stays on top with a message and a row of buttons.
     * Not modal, so the tray and the follower carry on while it is up. The
     * message label is left in Tag for callers that update it.
     */
    static Form Prompt(string title, string text, string[] buttons, Action<int> onChoice)
    {
        var form = new Form
        {
            Text = title,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
            TopMost = true,
            ShowInTaskbar = true,
            Icon = LoadIcon(),
            Font = SystemFonts.MessageBoxFont,
            ClientSize = new Size(500, 200),
        };
        var picture = new PictureBox { Image = SystemIcons.Warning.ToBitmap(), Left = 18, Top = 18, Width = 32, Height = 32 };
        var label = new Label { Text = text, Left = 64, Top = 16, Width = 420, AutoSize = false };
        using (var g = form.CreateGraphics())
        {
            var size = g.MeasureString(text, form.Font, 420);
            label.Height = (int)Math.Ceiling(size.Height) + 10;
        }
        form.Controls.Add(picture);
        form.Controls.Add(label);
        form.Tag = label;

        int top = Math.Max(label.Bottom, 56) + 14;
        int right = 486;
        for (int i = buttons.Length - 1; i >= 0; i--)
        {
            int index = i;
            var button = new Button { Text = buttons[i], Top = top, Height = 30 };
            button.Width = Math.Max(96, TextRenderer.MeasureText(buttons[i], form.Font).Width + 28);
            button.Left = right - button.Width;
            right = button.Left - 8;
            button.Click += (s, e) =>
            {
                form.Close();
                if (onChoice != null) onChoice(index);
            };
            form.Controls.Add(button);
            if (i == 0) form.AcceptButton = button;
        }
        form.ClientSize = new Size(500, top + 30 + 16);
        form.Show();
        form.Activate();
        return form;
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
     *                                than quit. Offer to end it.
     */
    static bool ClaimPort()
    {
        if (!PortBusy()) return false;
        if (Healthy())
        {
            // A follower's copy left behind is not this machine's own library
            // running; it has no worker and is not what should be opened.
            if (!IsFollowerServer()) return true;
            KillTree(PortOwner());
            for (int i = 0; i < 20 && PortBusy(); i++) Thread.Sleep(250);
            return false;
        }

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
     * JSON parser. A file we cannot read means off, which is the setting that
     * keeps the server on this machine only.
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
        // The root that holds every discipline and the shared keys. Not
        // CORPUS_DATA_DIR: that names one library and turns disciplines off,
        // which is what a test run wants and a person never does.
        psi.EnvironmentVariables["CORPUS_ROOT_DIR"] = Path.Combine(Root, "data");
        if (lanMode) psi.EnvironmentVariables["CORPUS_LAN"] = "1";
        if (follower) psi.EnvironmentVariables["CORPUS_FOLLOWER"] = "1";

        return Launch(psi);
    }

    static bool Start(string node, string nextBin)
    {
        // A production build is faster and quieter; fall back to dev if the
        // build output isn't there, so the launcher works either way.
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
        if (follower) psi.EnvironmentVariables["CORPUS_FOLLOWER"] = "1";

        return Launch(psi);
    }

    static bool Launch(ProcessStartInfo psi)
    {
        try
        {
            server = Process.Start(psi);
            // The pipes must be drained or a chatty server fills the buffer and
            // blocks. Since we are reading them anyway, keep the last run's output.
            OpenLog();
            server.OutputDataReceived += (s, e) => Log(e.Data);
            server.ErrorDataReceived += (s, e) => Log(e.Data);
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

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

    static volatile bool quitting;

    /** Matches SWITCH_EXIT in lib/disciplines.ts. */
    const int SwitchExit = 7;

    static void OnServerExit()
    {
        if (quitting) return;
        int code = -1;
        try { code = server.ExitCode; } catch { }

        // A follower's copy stopping is not the end of the session: the window
        // on the other machine is unaffected. Say so and carry on without it.
        if (settings.Remote)
        {
            hasCopy = false;
            Ui(() =>
            {
                Notify("This computer's copy of Corpus stopped (exit code " + code + "). The window on " +
                       HostOf(settings.RemoteUrl) + " is unaffected; restart Corpus to keep a copy again.");
                UpdateTip();
            });
            return;
        }

        // Asked for by the app when you open another discipline: the server
        // settles which library it is working in when it starts, so opening
        // another one is a new process rather than a switch inside this one.
        // Nothing of the old discipline can survive a restart, which is the
        // whole guarantee that two subjects do not bleed into each other.
        if (code == SwitchExit)
        {
            Ui(() => { Notify("Opening the other discipline\u2026"); Restart(); });
            return;
        }

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
        Ui(report);
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
            log = new StreamWriter(LogPath, false) { AutoFlush = true };
            log.WriteLine("--- Corpus started " + DateTime.Now + (follower ? " (a copy following " + settings.RemoteUrl + ")" : "") + " ---");
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
            else if (server == null && (!settings.Remote || adoptedFollower))
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
    static bool Healthy()
    {
        return Hello(LocalBase(), 15000) != null;
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
     * A request to this computer's own Corpus, with its LAN token when LAN mode
     * is on. Answers the body, error bodies included; null when nothing answered.
     */
    static string Http(string method, string url, string body, int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            var token = LanWanted() ? LanToken() : null;
            if (token != null) req.Headers.Add("x-corpus-token", token);
            if (body != null)
            {
                var bytes = Encoding.UTF8.GetBytes(body);
                req.ContentType = "application/json";
                req.ContentLength = bytes.Length;
                using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            }
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd();
        }
        catch (WebException ex)
        {
            var res = ex.Response as HttpWebResponse;
            if (res == null) return null;
            try
            {
                using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    return reader.ReadToEnd();
            }
            catch { return null; }
        }
        catch { return null; }
    }

    /** One string value from a JSON object, by key. Enough for the few answers the launcher reads. */
    static string JsonString(string json, string key)
    {
        if (json == null) return null;
        string needle = "\"" + key + "\":";
        int at = json.IndexOf(needle, StringComparison.Ordinal);
        if (at < 0) return null;
        int i = at + needle.Length;
        while (i < json.Length && json[i] == ' ') i++;
        if (i >= json.Length || json[i] != '"') return null;
        var sb = new StringBuilder();
        for (i++; i < json.Length; i++)
        {
            char c = json[i];
            if (c == '\\' && i + 1 < json.Length)
            {
                char next = json[++i];
                if (next == 'n') sb.Append('\n');
                else if (next == 't') sb.Append('\t');
                else if (next == 'u' && i + 4 < json.Length)
                {
                    int code;
                    if (int.TryParse(json.Substring(i + 1, 4), System.Globalization.NumberStyles.HexNumber, null, out code))
                    {
                        sb.Append((char)code);
                        i += 4;
                    }
                }
                else sb.Append(next);
                continue;
            }
            if (c == '"') break;
            sb.Append(c);
        }
        return sb.ToString();
    }

    static string JsonEscape(string s)
    {
        return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    /**
     * Sets the worker going once the server is up. A failure is not worth
     * reporting: the first action in the app kicks the worker too.
     */
    static void KickWorker()
    {
        Http("POST", LocalBase() + "/api/worker/kick", "", 15000);
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

    /** Whether the window should be this computer's copy rather than the Corpus it follows. */
    static bool UsingCopy()
    {
        return settings.Remote && hasCopy && (offline || conflict);
    }

    /** The Corpus the window shows. 127.0.0.1 rather than localhost: the server binds IPv4 only. */
    static string BaseUrl()
    {
        return settings.Remote && !UsingCopy() ? settings.RemoteUrl : LocalBase();
    }

    /**
     * Where a new window starts. In LAN mode that is the sign-in link, so the
     * window arrives signed in: this machine's own token for its own Corpus,
     * the one saved with the address for the other.
     */
    static string EntryUrl()
    {
        string token = settings.Remote && !UsingCopy() ? settings.Token : (LanWanted() ? LanToken() : null);
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
            if (FocusCorpusWindow(UsingCopy())) return;
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
     * An app window's title is the page's title and nothing else, while a
     * browser window whose tab happens to be Corpus appends the browser's name.
     * Every page is titled "Corpus", and a follower's copy titles itself as
     * one, so the window wanted — the Corpus followed, or this computer's copy
     * — is told apart by its title.
     */
    static bool FocusCorpusWindow(bool copy)
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
            bool isCopy = title.StartsWith(CopyTitle, StringComparison.Ordinal);
            if (isCopy != copy) return true;
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

        string host = JsonString(hello, "host") ?? HostOf(baseUrl);

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
            form.ClientSize = new Size(460, 350);
            form.Icon = LoadIcon();
            form.Font = SystemFonts.MessageBoxFont;

            var local = new RadioButton { Text = "This computer — start Corpus here", Left = 16, Top = 16, Width = 420, Checked = !settings.Remote };
            var remote = new RadioButton { Text = "A Corpus on another computer", Left = 16, Top = 44, Width = 420, Checked = settings.Remote };
            var addressLabel = new Label { Text = "Its address, as Settings → LAN mode shows it there:", Left = 36, Top = 76, Width = 404 };
            var address = new TextBox { Left = 36, Top = 96, Width = 404, Text = settings.RemoteUrl.Length > 0 ? settings.RemoteUrl : "http://" };
            var tokenLabel = new Label { Text = "Its token, from the same place:", Left = 36, Top = 128, Width = 404 };
            var token = new TextBox { Left = 36, Top = 148, Width = 404, Text = settings.Token, UseSystemPasswordChar = true };
            var status = new Label { Left = 16, Top = 184, Width = 428, Height = 48, ForeColor = Color.DimGray };
            var hint = new Label
            {
                Left = 16, Top = 234, Width = 428, Height = 72, ForeColor = Color.DimGray,
                Text = "The window opens on that computer, and this one keeps a copy of its library in step, to work from if it goes down. " +
                       "This computer's own library is replaced by that copy (the old one is kept in data\\backups). " +
                       "Point the browser extension's options at the same address.",
            };
            var test = new Button { Text = "Test", Left = 16, Top = 312, Width = 90 };
            var connect = new Button { Text = "Connect", Left = 256, Top = 312, Width = 90 };
            var cancel = new Button { Text = "Cancel", Left = 352, Top = 312, Width = 90, DialogResult = DialogResult.Cancel };

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
                    "Using another computer's Corpus stops this one's own server, and replaces this computer's library " +
                    "with a copy of that one's — the library here now is kept as a backup in data\\backups.\n\nSwitch?",
                    "Corpus", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (sure != DialogResult.Yes) return;
            }
            else if (connectTo == "local" && (offline || conflict))
            {
                var sure = MessageBox.Show(
                    "This computer's copy has work that has not gone back to " + HostOf(settings.RemoteUrl) + " yet.\n\n" +
                    "Using this computer on its own from now on keeps that work here, and " + HostOf(settings.RemoteUrl) +
                    " will not have it.\n\nSwitch anyway?",
                    "Corpus", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (sure != DialogResult.Yes) return;
            }

            settings.Connect = connectTo;
            settings.RemoteUrl = url2 ?? "";
            settings.Token = token2 ?? "";
            if (!TrySave()) return;
            Restart();
        }
    }

    static bool TrySave()
    {
        try { settings.Save(); return true; }
        catch (Exception ex) { Error("Couldn't save the setting:\n\n" + ex.Message); return false; }
    }

    /** Starts a fresh launcher with the new setting, and gets out of its way. */
    static void Restart()
    {
        Stop();
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

        if (settings.Remote)
        {
            resolveItem = menu.Items.Add("Choose which copy to keep…", null, (s, e) =>
            {
                var json = Http("GET", LocalBase() + "/api/sync/follow", null, 10000);
                ShowConflict(JsonString(json, "message") ?? "");
            });
            resolveItem.Visible = false;
            menu.Items.Add("Sync the copy now", null, (s, e) => { tickNow = true; });
        }

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

        var atStart = new ToolStripMenuItem("Start when Windows starts") { Checked = StartsWithWindows(), CheckOnClick = true };
        atStart.CheckedChanged += (s, e) =>
        {
            if (!SetStartsWithWindows(atStart.Checked))
            {
                atStart.Checked = StartsWithWindows();
                Error("Couldn't change whether Corpus starts with Windows.");
            }
            else if (atStart.Checked)
            {
                Notify("Corpus will start in the background when you sign in to Windows.");
            }
        };
        menu.Items.Add(atStart);

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

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(settings.Remote ? "Quit (stops this computer's copy)" : "Quit (stops ingesting)", null, (s, e) =>
        {
            Stop();
            Application.Exit();
        });

        var icon = new NotifyIcon
        {
            Icon = LoadIcon(),
            ContextMenuStrip = menu,
            Visible = true,
        };
        icon.DoubleClick += (s, e) =>
        {
            if (conflict) ShowConflict("");
            else Open(false);
        };
        tray = icon;
        UpdateTip();
        return icon;
    }

    // -- starting with Windows ---------------------------------------------
    //
    // A value under the user's Run key, which Windows reads at sign-in. Not a
    // shortcut in the Startup folder: the Run key is the one place Task
    // Manager's Startup tab lists and lets you switch off, so turning it off
    // there and here are the same switch. It names this exe, so a copy moved
    // or unpacked elsewhere shows unticked until it is ticked from that copy.

    static string SignInCommand()
    {
        return "\"" + Application.ExecutablePath + "\" " + SignInArg;
    }

    static bool StartsWithWindows()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                var value = key == null ? null : key.GetValue("Corpus") as string;
                return value != null &&
                       value.IndexOf(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    static bool SetStartsWithWindows(bool on)
    {
        try
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) key.SetValue("Corpus", SignInCommand());
                else key.DeleteValue("Corpus", false);
            }
            return true;
        }
        catch { return false; }
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
        tray.BalloonTipText = message.Length > 250 ? message.Substring(0, 250) : message;
        tray.ShowBalloonTip(5000);
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
