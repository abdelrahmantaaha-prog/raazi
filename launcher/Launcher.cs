// Raazi launcher.
//
// Double-click, and it starts the Next server hidden, waits for it to answer,
// opens Raazi in its own app window, and sits in the notification area.
// Right-click the tray icon to reopen, to connect to a Raazi on another
// computer, or to quit. Quitting stops the server; closing the window does not,
// so a long ingest keeps running while you get on with something else.
//
// One window. Opening Raazi again — from the tray, the desktop shortcut, or a
// second double-click — brings the window already open to the front instead
// of opening another. The window is the browser in app mode (Brave first, then
// Chrome, then Edge), so it has no tabs or address bar but keeps your sign-ins,
// the Raazi Inbox extension, and the Page view.
//
// Local, or following another. "Connect to another Raazi" points this
// launcher at a Raazi running on another machine — the other laptop, over the
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
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Raazi
{
#if UPDATE_TESTS
    // scripts/check-auto-update.mjs runs a scratch install beside the real one.
    static readonly int Port = int.Parse(Environment.GetEnvironmentVariable("RAAZI_TEST_PORT") ?? "5400");
#else
    const int Port = 5400;
#endif
    const string CopyTitle = "Raazi · this computer's copy";
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
        // A newer starter, before it replaces this one (ReplaceStarter): it
        // writes the release it belongs to and does nothing else.
        if (args.Length >= 2 && args[0] == "--selftest")
        {
            try { File.WriteAllText(args[1], Build.Release); } catch { }
            return;
        }

        // TLS 1.2 for every connection this starter makes. .NET 4 on an older
        // Windows otherwise offers only TLS 1.0, and GitHub refuses that.
        try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { }

        // The starter an update replaced, left beside the new one (ReplaceStarter).
        try { string old = Application.ExecutablePath + ".old"; if (File.Exists(old)) File.Delete(old); } catch { }

        if (RunUpdateCommand(args)) return;

        // A restart after changing where to connect waits for the old launcher
        // to let go; anything else that finds one running hands over to it.
        bool restarted = Array.IndexOf(args, "--restarted") >= 0;
        atSignIn = Array.IndexOf(args, SignInArg) >= 0;
        settings = Settings.Load(Path.Combine(Root, "data", "launcher.ini"));

        MoveRunKeyFromCorpus();

        // Still named for Corpus, Raazi's old name: a Corpus.exe left running
        // through the rename must count as the one already running.
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
                else Error("Raazi is already starting up. Give it a moment.");
                return;
            }

            try
            {
                Application.EnableVisualStyles();
                ui = new Control();
                var handle = ui.Handle; // created now, on this thread, so others can marshal onto it
                RecoverInterruptedUpdate();
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
                  "Install the LTS build from nodejs.org, then run Raazi again.");
            return;
        }

        // A packaged copy carries a self-contained server instead of a
        // checkout: no node_modules/next to point at, just server.js.
        string standalone = Path.Combine(Root, "server", "server.js");
        bool packaged = File.Exists(standalone);

        string nextBin = Path.Combine(Root, "node_modules", "next", "dist", "bin", "next");
        if (!packaged && !File.Exists(nextBin))
        {
            Error("Raazi isn't set up yet.\n\nOpen a terminal in\n" + Root +
                  "\nand run:  npm install\n\nThen run Raazi again.");
            return;
        }

        bool alreadyRunning = ClaimPort();
        if (!alreadyRunning &&
            !(packaged ? StartStandalone(node, standalone) : Start(node, nextBin))) return;

        tray = BuildTray();

        bool up = WaitForServer(60);

        // An update finished swapping but the launcher went before it saw the
        // new server answer (a restart, a crash). Answering now confirms it;
        // not answering puts the previous version and its database back.
        if (UpdateSwap.Pending(Root) && UpdateSwap.Complete(Root))
        {
            if (up) UpdateSwap.Finish(Root);
            else
            {
                UndoUpdate(InstalledVersion());
                up = RestartAfterUpdate(InstalledVersion());
                if (up) Notify("The new version didn't start, so the previous one was put back. Nothing was lost.");
            }
        }

        if (!up)
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

        if (Updatable()) StartUpdateChecks();

        // At sign-in the point is the server — feeds polled and parked runs
        // resumed before you sit down — not a window you did not ask for.
        if (atSignIn)
        {
            Notify("Raazi started with Windows and is running in the background. Double-click here to open it.");
        }
        else
        {
            Open(false);
            Notify(alreadyRunning
                ? "Raazi was already running — opened it for you."
                : "Raazi is running. It stays up if you close its window; quit from here.");
        }

        Application.Run();
        Stop();
    }

    // -- following another Raazi ---------------------------------------------

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
     * Uses a Raazi on another machine, with a copy of it kept here.
     *
     * The window opens on the other machine at once, if it answers; the copy is
     * started and kept in step on a background thread, so a first copy that
     * takes minutes never holds up the window. The tray stays up even when the
     * other Raazi cannot be reached, because the tray is where you change your
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
            Notify("Using the Raazi at " + HostOf(settings.RemoteUrl) + ". A copy is kept on this computer in case it goes down.");
        }

        var thread = new Thread(FollowLoop) { IsBackground = true, Name = "Raazi follower" };
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
                (node == null ? "Node.js isn't installed." : "Raazi isn't set up here.") +
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
                // A Raazi running here as its own library would keep reading and
                // spending, and drift from the one being followed.
                var answer = MessageBox.Show(
                    "A Raazi is already running on this computer as its own library.\n\n" +
                    "Keeping a copy of " + HostOf(settings.RemoteUrl) + " here needs it stopped. Stop it?",
                    "Raazi", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
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
     * The warning, when the Raazi this computer follows stops answering.
     *
     * A window of its own rather than a balloon, because a balloon is gone in
     * four seconds and this is the moment your changes stop saving.
     */
    static void ShowDown(bool withCopy)
    {
        string host = HostOf(settings.RemoteUrl);
        Notify("The Raazi server at " + host + " is down.");
        if (downForm != null && !downForm.IsDisposed)
        {
            downForm.Activate();
            return;
        }
        string text = "The Raazi server at " + host + " is down. Anything you change in its window now will not be saved.\n\n" +
            (withCopy
                ? "You can keep working from this computer's copy" +
                  (lastSyncText.Length > 0 ? ", which has everything up to " + lastSyncText : "") +
                  ". What you change on it goes back to " + host + " as soon as it answers again, before you are switched back."
                : "This computer keeps no copy of it, so there is nothing to work from until it answers again.");
        downForm = Prompt("Raazi — the server is down", text,
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
        conflictForm = Prompt("Raazi — both copies changed",
            host + " and this computer both changed while they were apart.\n\n" + message + "\n\n" +
            "Raazi copies a library whole; it can't merge two of them. Choose which to keep. " +
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
            ? (LanWanted() ? "Raazi — on this network, port " + Port + " (token required)" : "Raazi — running on localhost:" + Port)
            : offline
                ? "Raazi — " + host + " is down; using this computer's copy"
                : conflict
                    ? "Raazi — both copies changed; choose which to keep"
                    : "Raazi — using " + host + (hasCopy && lastSyncText.Length > 0 ? ", copy " + lastSyncText : "");
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
        var form = Prompt("Raazi",
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
                    label.Text = "Bringing back what was done on " + host + " while this computer was off. Raazi opens as soon as it has it.";
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
     * Returns true if there is a healthy Raazi we should simply adopt, false if
     * the port is now ours to start on. Three cases, and telling them apart is
     * what stops the launcher lying to you:
     *
     *   - nothing there            → start normally.
     *   - a healthy Raazi         → adopt it, and say so.
     *   - something else, or a
     *     Raazi that has stopped
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
            "Port " + Port + " is taken by " + who + ", but it isn't answering as Raazi.\n\n" +
            "This is usually a leftover Raazi server from a session that didn't close cleanly. " +
            "Ending it and starting fresh is safe — ingestion resumes where it stopped.\n\n" +
            "End it and start Raazi?",
            "Raazi", MessageBoxButtons.YesNo, MessageBoxIcon.Question);

        if (answer != DialogResult.Yes)
        {
            Error("Left it alone. Raazi needs port " + Port + ", so it can't start.");
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
     * The "lan" section of data/shared.json, or null.
     *
     * LAN mode belongs to the machine, not to a discipline, so it lives in the
     * shared file beside the keys (lib/lan.ts). It used to be data/config.json;
     * reading that after disciplines moved it left every restart on loopback
     * while Settings still said LAN was on. Deliberately a substring cut rather
     * than a JSON parser — the section holds only flat values.
     */
    static string LanSection()
    {
        try
        {
            var path = Path.Combine(Root, "data", "shared.json");
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path);
            int at = text.IndexOf("\"lan\"", StringComparison.Ordinal);
            if (at < 0) return null;
            int end = text.IndexOf('}', at);
            if (end < 0) end = text.Length;
            return text.Substring(at, end - at);
        }
        catch { return null; }
    }

    /**
     * Whether data/shared.json asks for LAN mode.
     *
     * Read here rather than passed in because the setting is changed from the
     * Settings page, in the running app, and takes effect the next time the
     * launcher starts the server. A file we cannot read means off, which is the
     * setting that keeps the server on this machine only.
     */
    static bool LanWanted()
    {
        var section = LanSection();
        if (section == null) return false;
        var packed = new StringBuilder();
        foreach (var c in section) if (!char.IsWhiteSpace(c)) packed.Append(c);
        return packed.ToString().Contains("\"enabled\":true");
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
        // An update stops and starts the server itself, and a new release that
        // will not start is its to undo, not a crash to report.
        if (installing || (UpdateSwap.Pending(Root) && !UpdateSwap.RecoveryFailed(Root))) return;
        int code = -1;
        try { code = server.ExitCode; } catch { }

        // A follower's copy stopping is not the end of the session: the window
        // on the other machine is unaffected. Say so and carry on without it.
        if (settings.Remote)
        {
            hasCopy = false;
            Ui(() =>
            {
                Notify("This computer's copy of Raazi stopped (exit code " + code + "). The window on " +
                       HostOf(settings.RemoteUrl) + " is unaffected; restart Raazi to keep a copy again.");
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
            Error("The Raazi server stopped unexpectedly (exit code " + code + ").\n\n" +
                  "The log has the details:\n" + LogPath + "\n\n" +
                  "Nothing is lost — ingestion resumes where it stopped when you start Raazi again.");
            CloseLog();
            if (tray != null) tray.Visible = false;
            Application.Exit();
        };
        Ui(report);
    }

    // -- logging -----------------------------------------------------------

    static StreamWriter log;
    static bool continuingLog;
    static readonly object logLock = new object();

    static string LogPath { get { return Path.Combine(Root, "data", "server.log"); } }

    static void OpenLog()
    {
        try
        {
            Directory.CreateDirectory(Path.Combine(Root, "data"));
            // Restarting for an update keeps what led up to it.
            log = new StreamWriter(LogPath, continuingLog) { AutoFlush = true };
            continuingLog = false;
            log.WriteLine("--- Raazi started " + DateTime.Now + (follower ? " (a copy following " + settings.RemoteUrl + ")" : "") + " ---");
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

    // A *Raazi* is listening on this machine, and it is answering requests.
    static bool Healthy()
    {
        return Hello(LocalBase(), 15000) != null;
    }

    static bool RemoteHealthy(string baseUrl)
    {
        return !string.IsNullOrEmpty(baseUrl) && Hello(baseUrl, 6000) != null;
    }

    /** What /api/hello says at an address, or null when it is not Raazi answering. */
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
     * A request to this computer's own Raazi, with its LAN token when LAN mode
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

    /** The LAN token from data/shared.json, or null when there is none yet.
     *  Searched within the "lan" section only: a paired copy under "followers"
     *  carries a "token" of its own. */
    static string LanToken()
    {
        try
        {
            var text = LanSection();
            if (text == null) return null;
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

    // -- updates ---------------------------------------------------------------
    //
    // The same system as Mutarjim's. A packaged copy looks for a newer version
    // by itself, so nobody has to carry a folder to it. The feed is a small
    // JSON file on the public raazi-updates repository, naming the newest
    // package per ring:
    //
    //   { "stable": { "version": "0.11.0", "zip": "https://…/raazi-update-0.11.0.zip" },
    //     "early":  { "version": "0.11.1", "zip": "https://…/raazi-update-0.11.1.zip" } }
    //
    // with each zip's signature at <zip>.sig. The feed is NOT trusted: a
    // package is offered only if it verifies against a key compiled into this
    // exe (UpdateKeys.cs), is newer than this install, and calls itself the
    // version the feed promised. The worst a hostile feed can do is withhold
    // updates.
    //
    // Nothing installs by itself. A verified package is offered at most once a
    // day, and the tray carries "Install the new version" until it is
    // installed. Nothing about the library is sent: the check is two plain
    // downloads.
    //
    // Installing stops the server, copies the open library's database into
    // update-backup\, and swaps in ONLY the entries the package carries — never
    // data\ or this exe. The new server must then answer /api/hello as the
    // promised release, or the old files AND the database copy go back, and
    // that version is never offered here again.
    //
    // Only a packaged install updates itself: a checkout is updated by git, and
    // swapping its folders would wreck it. A copy following another computer
    // does not either — it follows that computer.
    //
    // data\update-ring.txt holding "early" makes this a test install;
    // data\update-feed.txt overrides the feed; data\updates-off.txt (Settings)
    // stops the checks.

    const string DefaultFeed =
        "https://github.com/abdelrahmantaaha-prog/raazi-updates/releases/download/feed/manifest.json";

    static string[] Moduli { get { return new[] { UpdateKeys.Modulus1, UpdateKeys.Modulus2 }; } }

    /** Keys a signed manifest retired here, one number per line. */
    static string RetiredPath { get { return Path.Combine(Root, "data", "update-retired.txt"); } }

    static List<int> Retired()
    {
        var list = new List<int>();
        try
        {
            if (File.Exists(RetiredPath))
                foreach (var line in File.ReadAllLines(RetiredPath))
                {
                    int n;
                    if (int.TryParse(line.Trim(), out n)) list.Add(n);
                }
        }
        catch { }
        return list;
    }

    /** Settings → Updates: the owner switched the checks off (app/api/settings/updates). */
    static bool UpdatesOff()
    {
        return File.Exists(Path.Combine(Root, "data", "updates-off.txt"));
    }

    /** Versions the last signed manifest withdrew; refused even if a feed offers them. */
    static List<string> withdrawn = new List<string>();

    /** The largest package a feed may make this computer download. */
    const long MaxPackageBytes = 1024L * 1024 * 1024;

    static string DownloadDir { get { return Path.Combine(Root, "update-download"); } }
    static string BackupDir { get { return UpdateSwap.BackupDir(Root); } }
    static string FeedOverridePath { get { return Path.Combine(Root, "data", "update-feed.txt"); } }

    static volatile bool installing;
    static readonly object installLock = new object();
    static int checking;
    static DateTime lastAsked = DateTime.MinValue;
    static ToolStripMenuItem installItem;
    static string readyPackage, readyVersion;
    static System.Threading.Timer updateTimer;

    static bool Updatable()
    {
        return File.Exists(Path.Combine(Root, "server", "server.js")) &&
               !Directory.Exists(Path.Combine(Root, ".git"));
    }

    /** The release the packaged server is, from the package.json Next copies beside it. */
    static string InstalledVersion()
    {
        try { return JsonString(File.ReadAllText(Path.Combine(Root, "server", "package.json")).Replace("\": \"", "\":\""), "version"); }
        catch { return null; }
    }

    /** The module ABI and version of a Node ("137 v24.19.0"), or null when it will not say. */
    static string NodeAbi(string node)
    {
        if (node == null) return null;
        try
        {
            using (var p = Process.Start(new ProcessStartInfo
            {
                FileName = node,
                Arguments = "-p \"process.versions.modules + ' ' + process.version\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            }))
            {
                string said = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(15000);
                return said.Length > 0 ? said : null;
            }
        }
        catch { return null; }
    }

    static string FeedUrl()
    {
        try
        {
            if (File.Exists(FeedOverridePath))
            {
                string u = File.ReadAllText(FeedOverridePath).Trim();
                if (UpdateFeed.AcceptableUrl(u)) return u;
            }
        }
        catch { }
        return DefaultFeed;
    }

    static bool IsEarlyInstall()
    {
        try
        {
            string p = Path.Combine(Root, "data", "update-ring.txt");
            return File.Exists(p) && File.ReadAllText(p).Trim().ToLowerInvariant() == "early";
        }
        catch { return false; }
    }

    static bool RingEntry(string feed, string ring, out string version, out string zipUrl)
    {
        version = zipUrl = null;
        var block = Regex.Match(feed, "\"" + ring + "\"\\s*:\\s*\\{([^}]*)\\}");
        if (!block.Success) return false;
        string fields = Regex.Replace(block.Groups[1].Value, "\"\\s*:\\s*\"", "\":\"");
        version = JsonString(fields, "version");
        zipUrl = JsonString(fields, "zip");
        return !string.IsNullOrEmpty(version) && !string.IsNullOrEmpty(zipUrl);
    }

    static string LeadingDigits(string s)
    {
        int i = 0;
        while (i < s.Length && char.IsDigit(s[i])) i++;
        return i == 0 ? "0" : s.Substring(0, i);
    }

    /** Dotted numeric compare: -1, 0 or 1. Anything unreadable counts as 0. */
    static int CompareVersions(string a, string b)
    {
        if (a == null || b == null) return 0;
        string[] x = a.Split('.'), y = b.Split('.');
        for (int i = 0; i < Math.Max(x.Length, y.Length); i++)
        {
            int xi = 0, yi = 0;
            if (i < x.Length) int.TryParse(LeadingDigits(x[i]), out xi);
            if (i < y.Length) int.TryParse(LeadingDigits(y[i]), out yi);
            if (xi != yi) return xi < yi ? -1 : 1;
        }
        return 0;
    }

    static bool SignatureValid(string zipPath)
    {
        try
        {
            return UpdateFeed.SignedBy(File.ReadAllBytes(zipPath), File.ReadAllText(zipPath + ".sig"), Moduli, Retired()) > 0;
        }
        catch { return false; }
    }

    /** The version a package says it is, from the update.json at its top. */
    static string PackageVersion(string zipPath)
    {
        try
        {
            string text = UpdateFeed.ZipText(zipPath, "update.json");
            if (text == null) return null;
            string v = JsonString(Regex.Replace(text, "\"\\s*:\\s*\"", "\":\""), "version");
            return string.IsNullOrEmpty(v) ? null : v;
        }
        catch { return null; }
    }

    /** Why this package must not be installed here, or null. */
    static string PackageRefusal(string zipPath, string promised)
    {
        if (!SignatureValid(zipPath)) return "bad signature";
        string inside = PackageVersion(zipPath);
        if (inside == null) return "package has no version";
        if (promised != null && CompareVersions(inside, promised) != 0) return "package says " + inside;
        if (CompareVersions(inside, InstalledVersion()) <= 0) return "not newer";
        if (withdrawn.Contains(inside)) return "version " + inside + " was withdrawn";
        // The Node it needs, checked before anything is moved: a package built
        // on another Node would swap in, fail to start and roll back.
        string abi = NodeAbi(FindNode());
        string nodeProblem = UpdateFeed.NodeRefusal(zipPath, abi == null ? null : abi.Split(' ')[0]);
        if (nodeProblem != null) return nodeProblem;
        return null;
    }

    static string FailedMarker(string version)
    {
        return Path.Combine(DownloadDir, "failed-" + Regex.Replace(version ?? "", "[^0-9A-Za-z.-]", "") + ".txt");
    }

    static void MarkFailed(string version)
    {
        try
        {
            Directory.CreateDirectory(DownloadDir);
            File.WriteAllText(FailedMarker(version), DateTime.Now.ToString("s"));
        }
        catch { }
    }

    /**
     * One look at the feed. Fetches and verifies a newer package if there is
     * one; returns a line saying what happened (logged, or written by
     * --check-update). Runs off the UI thread — no dialogs in here.
     */
    static string CheckForUpdate(out string zipPath, out string version)
    {
        zipPath = version = null;
        if (!Updatable()) return "skip: not a packaged install";
        if (UpdatesOff()) return "skip: switched off in Settings";
        string installed = InstalledVersion();
        if (installed == null) return "skip: server\\package.json has no version";

        string feedUrl = FeedUrl(), feed;
        byte[] feedBytes;
        try { feedBytes = UpdateFeed.ReadBytes(feedUrl, 256 * 1024, 30000); }
        catch (Exception ex) { return "feed unreachable: " + ex.Message; }
        feed = new UTF8Encoding(false).GetString(feedBytes);

        // What only a signed manifest may ask: moving the feed, withdrawing
        // versions, retiring a key. Unsigned, a feed can still name a package
        // — whose own signature decides — and nothing more.
        int signer = 0;
        try { signer = UpdateFeed.SignedBy(feedBytes, UpdateFeed.ReadText(feedUrl + ".sig", 8 * 1024, 30000), Moduli, Retired()); }
        catch { }
        withdrawn = signer > 0 ? UpdateFeed.StringArray(feed, "revoked") : new List<string>();
        if (signer > 0)
        {
            var retire = UpdateFeed.KeysToRetire(feed, signer, Moduli.Length, Retired());
            if (retire.Count > 0)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(RetiredPath));
                    File.AppendAllLines(RetiredPath, retire.ConvertAll(k => k.ToString()));
                    Log("[updates] key " + string.Join(",", retire.ConvertAll(k => k.ToString()).ToArray()) + " retired by a manifest signed with key " + signer);
                }
                catch { }
            }
            string moved = JsonString(Regex.Replace(feed, "\"\\s*:\\s*\"", "\":\""), "feed");
            if (!string.IsNullOrEmpty(moved) && moved != feedUrl && UpdateFeed.AcceptableUrl(moved))
            {
                try { File.WriteAllText(FeedOverridePath, moved); } catch { }
            }
        }

        string v, url, ev, eurl;
        bool found = RingEntry(feed, "stable", out v, out url);
        if (IsEarlyInstall() && RingEntry(feed, "early", out ev, out eurl) &&
            (!found || CompareVersions(ev, v) > 0))
        {
            v = ev; url = eurl; found = true;
        }
        if (!found) return "feed names no package for this install";
        if (CompareVersions(v, installed) <= 0) return "up to date (" + installed + ")";
        if (withdrawn.Contains(v)) return "skipping " + v + ": withdrawn by the signed feed";
        if (File.Exists(FailedMarker(v))) return "skipping " + v + ": it failed to start here before";
        if (!UpdateFeed.AcceptableUrl(url)) return "refused package address: " + url;

        Directory.CreateDirectory(DownloadDir);
        string zip = Path.Combine(DownloadDir, "raazi-update-" + Regex.Replace(v, "[^0-9A-Za-z.-]", "") + ".zip");
        string sig = zip + ".sig";
        if (!(File.Exists(zip) && File.Exists(sig)))
        {
            try
            {
                UpdateFeed.Download(url + ".sig", sig + ".part", 8 * 1024, 60000, 120000);
                UpdateFeed.Download(url, zip + ".part", MaxPackageBytes, 60000, 45 * 60 * 1000);
                File.Move(sig + ".part", sig);
                File.Move(zip + ".part", zip);
            }
            catch (Exception ex)
            {
                foreach (var f in new[] { zip, sig, zip + ".part", sig + ".part" })
                    try { if (File.Exists(f)) File.Delete(f); } catch { }
                return "download of " + v + " failed: " + ex.Message;
            }
        }

        string refusal = PackageRefusal(zip, v);
        if (refusal != null)
        {
            try { File.Delete(zip); File.Delete(sig); } catch { }
            return "refused " + v + ": " + refusal;
        }

        // Packages from earlier checks are superseded; the failure marks stay.
        foreach (var f in Directory.GetFiles(DownloadDir))
        {
            if (f == zip || f == sig || Path.GetFileName(f).StartsWith("failed-")) continue;
            try { File.Delete(f); } catch { }
        }

        zipPath = zip;
        version = v;
        return "ready: " + v;
    }

    /** First look two minutes after start, then every six hours. */
    static void StartUpdateChecks()
    {
        updateTimer = new System.Threading.Timer(_ =>
        {
            if (installing || quitting || Interlocked.Exchange(ref checking, 1) == 1) return;
            string zip = null, version = null, outcome;
            try { outcome = CheckForUpdate(out zip, out version); }
            catch (Exception ex) { outcome = "check failed: " + ex.Message; }
            Interlocked.Exchange(ref checking, 0);
            Log("[updates] " + outcome);
            if (zip != null) Ui(() => UpdateReady(zip, version));
        }, null, 2 * 60 * 1000, 6 * 60 * 60 * 1000);
    }

    static void UpdateReady(string zip, string version)
    {
        if (installing) return;
        readyPackage = zip;
        readyVersion = version;
        if (installItem != null)
        {
            installItem.Text = "Install the new version (" + version + ")";
            installItem.Visible = true;
        }
        if (lastAsked.Date == DateTime.Today) return;
        lastAsked = DateTime.Now;
        AskToInstall();
    }

    /** "Later" comes first, so Enter or a stray click leaves Raazi working. */
    static void AskToInstall()
    {
        string zip = readyPackage, version = readyVersion;
        if (zip == null || installing) return;
        Prompt("Raazi — update",
            "A new version of Raazi is ready (" + version + ").\n\n" + InstallWarning,
            new[] { "Later", "Install now" },
            choice => { if (choice == 1) ThreadPool.QueueUserWorkItem(_ => Install(zip, version)); });
    }

    const string InstallWarning =
        "Installing stops Raazi for a minute or two and brings it back by itself. Ingestion pauses and resumes where it stopped.\n\n" +
        "Your library is not touched, and a copy of its database and of the current version is kept first.";

    static string FromFileDir { get { return Path.Combine(DownloadDir, "from-file"); } }

    /**
     * A package carried in by hand installs from the tray instead of a command
     * line. Same checks as the feed's — its .sig beside it, a trusted
     * signature, newer than this install — and the same way back. Copied in
     * before it is checked, so the file that was checked is the file that is
     * swapped in.
     */
    static void UpdateFromFile()
    {
        if (installing) return;
        string picked;
        using (var dialog = new OpenFileDialog
        {
            Title = "Choose a Raazi update",
            Filter = "Raazi update (raazi-update-*.zip)|raazi-update-*.zip|ZIP|*.zip",
            CheckFileExists = true,
        })
        {
            if (dialog.ShowDialog() != DialogResult.OK) return;
            picked = dialog.FileName;
        }
        if (!File.Exists(picked + ".sig"))
        {
            Error("The signature isn't beside the update:\n" + Path.GetFileName(picked) + ".sig\n\n" +
                  "Put the two files in one folder and choose the update again.");
            return;
        }
        ThreadPool.QueueUserWorkItem(_ =>
        {
            string zip = Path.Combine(FromFileDir, Path.GetFileName(picked)), refusal;
            try
            {
                if (Directory.Exists(FromFileDir)) Directory.Delete(FromFileDir, true);
                Directory.CreateDirectory(FromFileDir);
                File.Copy(picked, zip);
                File.Copy(picked + ".sig", zip + ".sig");
                refusal = PackageRefusal(zip, null);
            }
            catch (Exception ex) { refusal = ex.Message; }
            string version = PackageVersion(zip);
            if (refusal != null)
            {
                ForgetFromFile();
                string why = refusal == "not newer"
                    ? "This version (" + version + ") isn't newer than the one installed here."
                    : refusal == "bad signature"
                        ? "The signature doesn't match: the file is damaged, or isn't an update from Raazi."
                        : refusal;
                Ui(() => Error("The update was not installed.\n\n" + why));
                return;
            }
            Ui(() => Prompt("Raazi — update from a file",
                "Install version " + version + " from this file?\n\n" + InstallWarning,
                new[] { "Later", "Install now" },
                choice =>
                {
                    if (choice != 1) { ForgetFromFile(); return; }
                    ThreadPool.QueueUserWorkItem(__ =>
                    {
                        Install(zip, version);
                        ForgetFromFile();
                    });
                }));
        });
    }

    static void ForgetFromFile()
    {
        try { if (Directory.Exists(FromFileDir)) Directory.Delete(FromFileDir, true); } catch { }
    }

    static void ClearReadyUpdate()
    {
        readyPackage = readyVersion = null;
        Ui(() => { if (installItem != null) installItem.Visible = false; });
        try
        {
            if (Directory.Exists(DownloadDir))
                foreach (var f in Directory.GetFiles(DownloadDir))
                    if (!Path.GetFileName(f).StartsWith("failed-")) File.Delete(f);
        }
        catch { }
    }

    /** Off the UI thread: it stops, swaps, and waits for the new server. */
    static void Install(string zip, string version)
    {
        lock (installLock)
        {
            if (installing) return;
            installing = true;
        }
        try
        {
            string refusal = PackageRefusal(zip, version);
            if (refusal != null)
            {
                Ui(() => Error("The update was not installed: " + refusal + "."));
                return;
            }
            string from = InstalledVersion();
            Ui(() => Notify("Installing version " + version + "… Raazi will be back in a minute or two."));
            Log("[updates] installing " + version + " over " + from);

            if (!StopForUpdate())
            {
                // Something still holds the port: whatever it is keeps running.
                quitting = false;
                Ui(() => Error("Raazi didn't stop for the update, so nothing was installed. Try again later."));
                return;
            }

            try
            {
                UpdateSwap.PrepareBackup(Root, from);
            }
            catch (Exception ex)
            {
                // Nothing was moved: the release that was running runs again.
                RestartAfterUpdate(from);
                Ui(() => Error("The update was not installed:\n\n" + ex.Message));
                return;
            }

            try
            {
                UpdateSwap.SwapIn(Root, zip);
            }
            catch (Exception ex)
            {
                // The new files never ran, so the library is left exactly as it is.
                bool clean = UpdateSwap.Rollback(Root, UpdateSwap.DbRule.Keep);
                RestartAfterUpdate(from);
                Ui(() => Error(clean
                    ? "The update failed and nothing changed:\n\n" + ex.Message
                    : UndoFailedMessage + "\n\n" + ex.Message));
                return;
            }

            if (RestartAfterUpdate(version))
            {
                UpdateSwap.Finish(Root);
                ReplaceStarter(version);
                ClearReadyUpdate();
                KickWorker();
                Ui(() => Notify("Updated to version " + version + "."));
                return;
            }

            bool undone = UndoUpdate(version);
            RestartAfterUpdate(from);
            KickWorker();
            Ui(() => Error(undone
                ? "The new version (" + version + ") didn't start, so the previous one was put back. Your work is safe.\n\nThe log has the details:\n" + LogPath
                : UndoFailedMessage));
        }
        finally
        {
            installing = false;
        }
    }

    /**
     * A package may carry the starter it was built with (starter\Raazi.exe,
     * inside the signed zip): it replaces this one for the next start, so the
     * starter and its keys can change after all. Windows lets a running exe be
     * renamed but not overwritten, so this one becomes Raazi.exe.old (deleted
     * at the next start). The new one must first answer --selftest with the
     * release it belongs to, or nothing changes; if the copy fails, this one
     * is put back.
     */
    static void ReplaceStarter(string version)
    {
        string fresh = Path.Combine(Root, "starter", "Raazi.exe");
        string current = Application.ExecutablePath;
        if (!File.Exists(fresh)) return;
        try
        {
            if (new FileInfo(fresh).Length == new FileInfo(current).Length &&
                Convert.ToBase64String(SHA256.Create().ComputeHash(File.ReadAllBytes(fresh))) ==
                Convert.ToBase64String(SHA256.Create().ComputeHash(File.ReadAllBytes(current)))) return;
            string answer = Path.Combine(Path.GetTempPath(), "raazi-selftest-" + Guid.NewGuid().ToString("N") + ".txt");
            using (var p = Process.Start(new ProcessStartInfo
            {
                FileName = fresh,
                Arguments = "--selftest \"" + answer + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            }))
            {
                if (!p.WaitForExit(15000)) { try { p.Kill(); } catch { } }
            }
            string said = File.Exists(answer) ? File.ReadAllText(answer).Trim() : "";
            try { File.Delete(answer); } catch { }
            if (said != version)
            {
                Log("[updates] kept this starter: the new one answered \"" + said + "\", not " + version);
                return;
            }
            string old = current + ".old";
            if (File.Exists(old)) File.Delete(old);
            File.Move(current, old);
            try { File.Copy(fresh, current); }
            catch { File.Move(old, current); throw; }
            Log("[updates] the starter is now " + version + "'s; it runs from the next start");
        }
        catch (Exception ex) { Log("[updates] kept this starter: " + ex.Message); }
    }

    /** Stops this install's server, keeping the tray. Ingestion resumes where it stopped. */
    static bool StopForUpdate()
    {
        quitting = true;
        try
        {
            var s = server;
            if (s != null && !s.HasExited) KillTree(s.Id);
            else if (Healthy()) KillTree(PortOwner());
        }
        catch { }
        for (int i = 0; i < 60 && PortBusy(); i++) Thread.Sleep(250);
        CloseLog();
        return !PortBusy();
    }

    /** Starts the server again and waits for it to answer as the expected release. */
    static bool RestartAfterUpdate(string expect)
    {
        quitting = false;
        continuingLog = true;
        string node = FindNode();
        if (node == null || !StartStandalone(node, Path.Combine(Root, "server", "server.js"))) return false;
        if (!WaitForServer(120)) return false;
        return JsonString(Hello(LocalBase(), 15000), "version") == expect;
    }

    const string UndoFailedMessage =
        "The update didn't finish, and not every file of the previous version could be put back. Nothing of your work was deleted: " +
        "your library is in the data folder as it was, and the previous version is in the update-backup folder. " +
        "Don't try another update until this is sorted out.";

    /** The new release did not come up: everything back, and never offer it here again. */
    static bool UndoUpdate(string version)
    {
        StopForUpdate();
        // The new release may have opened the library and changed it in its
        // first minutes; work done after that is never thrown away (UpdateSwap.DbRule).
        bool clean = UpdateSwap.Rollback(Root, UpdateSwap.DbRule.IfUnused);
        MarkFailed(version);
        ClearReadyUpdate();
        return clean;
    }

    /** Before anything starts: a swap cut off half-way is undone once (UpdateSwap.RecoverInterrupted). */
    static void RecoverInterruptedUpdate()
    {
        try
        {
            var outcome = UpdateSwap.RecoverInterrupted(Root);
            if (outcome == UpdateSwap.Recovery.Nothing) return;
            MessageBox.Show(
                outcome == UpdateSwap.Recovery.Undone
                    ? "The last update didn't finish, so the version that was running has been put back. Your work wasn't touched."
                    : UndoFailedMessage,
                "Raazi", MessageBoxButtons.OK,
                outcome == UpdateSwap.Recovery.Undone ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch { /* recovery must never be what stops Raazi opening */ }
    }

    /**
     * The update commands, with Raazi closed. Each answers in a file beside the
     * exe, because a winexe has no console:
     *
     *   Raazi.exe --check-update         one look at the feed; installs nothing (update-check.txt)
     *   Raazi.exe --apply-update <zip>   verify and swap; the next start confirms or undoes it (update-result.txt)
     *   Raazi.exe --undo-update          put back the version and database from before the swap (update-result.txt)
     */
    static bool RunUpdateCommand(string[] args)
    {
        if (Array.IndexOf(args, "--check-update") >= 0)
        {
            string zip, version, outcome;
            try { outcome = CheckForUpdate(out zip, out version); }
            catch (Exception ex) { outcome = "check failed: " + ex.Message; }
            try { File.WriteAllText(Path.Combine(Root, "update-check.txt"), outcome); } catch { }
            return true;
        }

        if (args.Length >= 2 && args[0] == "--apply-update")
        {
            string result;
            try
            {
                string refusal = !Updatable() ? "not a packaged install"
                    : File.Exists(args[1] + ".sig") ? PackageRefusal(args[1], null) : "signature missing";
                if (refusal != null) result = "FAIL " + refusal;
                else if (PortBusy() && Healthy()) result = "FAIL Raazi is running - quit it from the tray first";
                else
                {
                    UpdateSwap.PrepareBackup(Root, InstalledVersion());
                    try { UpdateSwap.SwapIn(Root, args[1]); }
                    catch { UpdateSwap.Rollback(Root, UpdateSwap.DbRule.Keep); throw; }
                    result = "OK version=" + InstalledVersion();
                }
            }
            catch (Exception ex) { result = "FAIL " + ex.Message; }
            try { File.WriteAllText(Path.Combine(Root, "update-result.txt"), result); } catch { }
            return true;
        }

        if (args.Length >= 1 && args[0] == "--undo-update")
        {
            string result;
            if (!Directory.Exists(BackupDir)) result = "FAIL nothing to undo";
            else if (PortBusy() && Healthy()) result = "FAIL Raazi is running - quit it from the tray first";
            else
            {
                // Asked for in so many words: the pre-update library goes back
                // even if it was worked in since (the live one is kept aside as
                // rollback-kept-*.db).
                bool clean = UpdateSwap.Rollback(Root, UpdateSwap.DbRule.Always);
                result = clean ? "OK version=" + InstalledVersion() : "FAIL some files could not be put back";
            }
            try { File.WriteAllText(Path.Combine(Root, "update-result.txt"), result); } catch { }
            return true;
        }

#if UPDATE_TESTS
        // The whole of Install against a scratch install on its own port: server
        // up, stopped, swapped, restarted, judged. scripts/check-auto-update.mjs.
        if (args.Length >= 2 && args[0] == "--install-update")
        {
            settings = Settings.Load(Path.Combine(Root, "data", "launcher.ini"));
            string result;
            try
            {
                string node = FindNode();
                string js = Path.Combine(Root, "server", "server.js");
                if (node == null || !StartStandalone(node, js) || !WaitForServer(60)) result = "FAIL the old release did not start";
                else
                {
                    Install(args[1], PackageVersion(args[1]));
                    result = "installed=" + InstalledVersion() + " answering=" + JsonString(Hello(LocalBase(), 15000), "version") +
                             " pending=" + UpdateSwap.Pending(Root);
                    StopForUpdate();
                }
            }
            catch (Exception ex) { result = "FAIL " + ex.Message; }
            try { File.WriteAllText(Path.Combine(Root, "update-result.txt"), result); } catch { }
            return true;
        }
#endif
        return false;
    }

    // -- the window ----------------------------------------------------------

    /** Whether the window should be this computer's copy rather than the Raazi it follows. */
    static bool UsingCopy()
    {
        return settings.Remote && hasCopy && (offline || conflict);
    }

    /** The Raazi the window shows. 127.0.0.1 rather than localhost: the server binds IPv4 only. */
    static string BaseUrl()
    {
        return settings.Remote && !UsingCopy() ? settings.RemoteUrl : LocalBase();
    }

    /**
     * Where a new window starts. In LAN mode that is the sign-in link, so the
     * window arrives signed in: this machine's own token for its own Raazi,
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
     * Brings Raazi up: the window already open, if there is one, else a new
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
     * Finds an app window already showing Raazi and brings it forward.
     *
     * An app window's title is the page's title and nothing else, while a
     * browser window whose tab happens to be Raazi appends the browser's name.
     * Every page is titled "Raazi", and a follower's copy titles itself as
     * one, so the window wanted — the Raazi followed, or this computer's copy
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
            if (!title.StartsWith("Raazi", StringComparison.Ordinal)) return true;
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
     * and Raazi's port when none was given. Null when it is not an address.
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
        // "192.168.1.20" means Raazi on that machine, not a web server on port 80.
        bool portTyped = text.IndexOf(':', text.IndexOf("//", StringComparison.Ordinal) + 2) >= 0;
        var port = portTyped ? uri.Port : Port;
        return uri.Scheme + "://" + uri.Host + ":" + port;
    }

    /** What an address answers, in words for the Test button. */
    static string Probe(string baseUrl, string token)
    {
        var hello = Hello(baseUrl, 6000);
        if (hello == null)
            return "Nothing answered as Raazi at " + baseUrl + ". Is it running there, with LAN mode on?";

        string host = JsonString(hello, "host") ?? HostOf(baseUrl);

        try
        {
            var req = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/drafts");
            req.Timeout = 6000;
            req.ReadWriteTimeout = 6000;
            if (!string.IsNullOrEmpty(token)) req.Headers.Add("x-corpus-token", token);
            using (var res = (HttpWebResponse)req.GetResponse()) { }
            return "Found Raazi on " + host + ", and it let this computer in.";
        }
        catch (WebException ex)
        {
            var res = ex.Response as HttpWebResponse;
            if (res != null && (int)res.StatusCode == 401)
                return string.IsNullOrEmpty(token)
                    ? "Found Raazi on " + host + ". It needs its token — copy it from Settings → LAN mode there."
                    : "Found Raazi on " + host + ", but that token isn't the one it uses.";
            return "Found Raazi on " + host + ", but it didn't answer properly: " + ex.Message;
        }
    }

    /**
     * Chooses between this computer's Raazi and one on another machine.
     *
     * Switching restarts the launcher, and switching away from this computer
     * stops its server first — say so before doing it.
     */
    static void ShowConnect()
    {
        using (var form = new Form())
        {
            form.Text = "Raazi — where to connect";
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = new Size(460, 350);
            form.Icon = LoadIcon();
            form.Font = SystemFonts.MessageBoxFont;

            var local = new RadioButton { Text = "This computer — start Raazi here", Left = 16, Top = 16, Width = 420, Checked = !settings.Remote };
            var remote = new RadioButton { Text = "A Raazi on another computer", Left = 16, Top = 44, Width = 420, Checked = settings.Remote };
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
                    "Using another computer's Raazi stops this one's own server, and replaces this computer's library " +
                    "with a copy of that one's — the library here now is kept as a backup in data\\backups.\n\nSwitch?",
                    "Raazi", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (sure != DialogResult.Yes) return;
            }
            else if (connectTo == "local" && (offline || conflict))
            {
                var sure = MessageBox.Show(
                    "This computer's copy has work that has not gone back to " + HostOf(settings.RemoteUrl) + " yet.\n\n" +
                    "Using this computer on its own from now on keeps that work here, and " + HostOf(settings.RemoteUrl) +
                    " will not have it.\n\nSwitch anyway?",
                    "Raazi", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
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
        catch (Exception ex) { Error("Couldn't restart Raazi:\n\n" + ex.Message); }
        Application.Exit();
    }

    // -- tray --------------------------------------------------------------

    static NotifyIcon BuildTray()
    {
        var menu = new ContextMenuStrip();
        var open = menu.Items.Add("Open Raazi", null, (s, e) => Open(false));
        open.Font = new Font(open.Font, FontStyle.Bold);
        menu.Items.Add("Open in a browser tab", null, (s, e) => Open(true));
        menu.Items.Add(new ToolStripSeparator());

        if (!settings.Remote && Updatable())
        {
            installItem = new ToolStripMenuItem("Install the new version") { Visible = false };
            installItem.Font = new Font(installItem.Font, FontStyle.Bold);
            installItem.Click += (s, e) => AskToInstall();
            menu.Items.Add(installItem);
            menu.Items.Add("Update from a file…", null, (s, e) => UpdateFromFile());
        }

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
            : "Connect to another Raazi…", null, (s, e) => ShowConnect());

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
                Error("Couldn't change whether Raazi starts with Windows.");
            }
            else if (atStart.Checked)
            {
                Notify("Raazi will start in the background when you sign in to Windows.");
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
                Error("No log yet — the server was already running when Raazi started.");
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
                var value = key == null ? null : key.GetValue("Raazi") as string;
                return value != null &&
                       value.IndexOf(Application.ExecutablePath, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    /* Raazi was called Corpus, and Windows started it from a Run value named
       "Corpus" that points at Corpus.exe, which is gone now. The first
       Raazi.exe to run takes the entry over under its own name, and only if
       it was on. */
    static void MoveRunKeyFromCorpus()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (key == null || key.GetValue("Corpus") == null) return;
                key.SetValue("Raazi", SignInCommand());
                key.DeleteValue("Corpus", false);
            }
        }
        catch { }
    }

    static bool SetStartsWithWindows(bool on)
    {
        try
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) key.SetValue("Raazi", SignInCommand());
                else key.DeleteValue("Raazi", false);
                key.DeleteValue("Corpus", false);
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
        tray.BalloonTipTitle = "Raazi";
        tray.BalloonTipText = message.Length > 250 ? message.Substring(0, 250) : message;
        tray.ShowBalloonTip(5000);
    }

    static void Error(string message)
    {
        MessageBox.Show(message, "Raazi", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
            "# Raazi launcher: where this copy connects, and how it opens.",
            "# Changed from the tray icon (right-click, Connect to another Raazi).",
            "connect=" + Connect,
            "remote=" + RemoteUrl,
            "token=" + Token,
            "window=" + Window,
        });
    }
}
