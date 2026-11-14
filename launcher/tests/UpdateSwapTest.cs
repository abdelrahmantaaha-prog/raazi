using System;
using System.IO;
using System.IO.Compression;

/**
 * Drives launcher/UpdateSwap.cs against throwaway install folders. Compiled
 * and run by scripts/test-update-swap.mjs; never touches a real install.
 *
 * Each case builds an "installed" 1.0 (server\server.js, docs\, data\ with a
 * library) and a package for 2.0, then cuts the swap or its undo off at the
 * awkward places. The rule under test: an
 * undo never loses work done in the library, however often it is replayed.
 */
static class UpdateSwapTest
{
    static int failures;

    static void Check(bool ok, string what)
    {
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + what);
        if (!ok) failures++;
    }

    static string Install(string name)
    {
        string root = Path.Combine(Path.GetTempPath(), "upd-swap-" + name + "-" + Guid.NewGuid().ToString("N").Substring(0, 6));
        Directory.CreateDirectory(Path.Combine(root, "server"));
        Directory.CreateDirectory(Path.Combine(root, "docs"));
        Directory.CreateDirectory(Path.Combine(root, "data"));
        File.WriteAllText(Path.Combine(root, "server", "server.js"), "release 1.0");
        File.WriteAllText(Path.Combine(root, "docs", "guide.txt"), "guide 1.0");
        File.WriteAllText(Path.Combine(root, "data", "corpus.db"), "library: day 0");
        return root;
    }

    static string Package(string root)
    {
        string src = root + "-pkg";
        Directory.CreateDirectory(Path.Combine(src, "server"));
        Directory.CreateDirectory(Path.Combine(src, "docs"));
        File.WriteAllText(Path.Combine(src, "server", "server.js"), "release 2.0");
        File.WriteAllText(Path.Combine(src, "docs", "guide.txt"), "guide 2.0");
        string zip = root + "-pkg.zip";
        ZipFile.CreateFromDirectory(src, zip);
        return zip;
    }

    static string Read(string root, string rel)
    {
        string p = Path.Combine(root, rel);
        return File.Exists(p) ? File.ReadAllText(p) : "(missing)";
    }

    static void Work(string root, string what)
    {
        File.WriteAllText(Path.Combine(root, "data", "corpus.db"), what);
    }

    static void HappyPath()
    {
        string root = Install("happy");
        UpdateSwap.PrepareBackup(root, "1.0");
        UpdateSwap.SwapIn(root, Package(root));
        Check(UpdateSwap.Complete(root), "happy: swap marked complete");
        Check(Read(root, "server/server.js") == "release 2.0", "happy: new server in place");
        UpdateSwap.Finish(root);
        Check(!UpdateSwap.Pending(root), "happy: update-backup removed after the new release answered");
        Check(File.Exists(Path.Combine(root, "data", "pre-update-1.0.db")), "happy: pre-update copy kept in data");
        Check(Read(root, "data/corpus.db") == "library: day 0", "happy: library untouched");
    }

    /** The swap is cut off after the old server went aside and before the new one went in. */
    static void InterruptedSwapKeepsLaterWork()
    {
        string root = Install("cut");
        UpdateSwap.PrepareBackup(root, "1.0");
        // By hand: what SwapIn had done when the power went.
        Directory.Move(Path.Combine(root, "server"), Path.Combine(UpdateSwap.BackupDir(root), "server"));
        File.AppendAllText(UpdateSwap.Journal(root), "moved server\r\n");
        Check(UpdateSwap.RecoverInterrupted(root) == UpdateSwap.Recovery.Undone, "cut: recovery undoes the half swap");
        Check(Read(root, "server/server.js") == "release 1.0", "cut: old server back");
        Check(!UpdateSwap.Pending(root), "cut: nothing left pending");
    }

    /**
     * The case this was built for. The first undo cannot remove one of the package's
     * files (antivirus holds it), the old release is running again and the
     * library is worked in for a week; then the undo is replayed at every start.
     */
    static void ReplayAfterPartialUndoKeepsTheWeek()
    {
        string root = Install("replay");
        UpdateSwap.PrepareBackup(root, "1.0");
        UpdateSwap.SwapIn(root, Package(root));
        // Pretend SwapIn was cut off before "complete": drop that line.
        var lines = UpdateSwap.Lines(root).FindAll(l => !l.StartsWith("complete"));
        File.WriteAllLines(UpdateSwap.Journal(root), lines);

        bool clean;
        using (File.Open(Path.Combine(root, "docs", "guide.txt"), FileMode.Open, FileAccess.Read, FileShare.None))
            clean = UpdateSwap.Rollback(root, UpdateSwap.DbRule.Keep);
        Check(!clean, "replay: first undo reports it could not finish");
        Check(Read(root, "server/server.js") == "release 1.0", "replay: old server back after the first undo");

        Work(root, "library: a week of work");

        var first = UpdateSwap.RecoverInterrupted(root);
        Check(first == UpdateSwap.Recovery.Undone, "replay: next start finishes the undo (" + first + ")");
        Check(Read(root, "server/server.js") == "release 1.0", "replay: the old server is NOT deleted again");
        Check(Read(root, "docs/guide.txt") == "guide 1.0", "replay: old docs back");
        Check(Read(root, "data/corpus.db") == "library: a week of work", "replay: the week of work is kept");

        var second = UpdateSwap.RecoverInterrupted(root);
        Check(second == UpdateSwap.Recovery.Nothing, "replay: a further start has nothing to do");
        Check(Read(root, "data/corpus.db") == "library: a week of work", "replay: still the week of work");
    }

    /** An undo that cannot finish is tried once, then left alone with a message. */
    static void FailedRecoveryIsNotReplayed()
    {
        string root = Install("stuck");
        UpdateSwap.PrepareBackup(root, "1.0");
        UpdateSwap.SwapIn(root, Package(root));
        var lines = UpdateSwap.Lines(root).FindAll(l => !l.StartsWith("complete"));
        File.WriteAllLines(UpdateSwap.Journal(root), lines);

        UpdateSwap.Recovery outcome;
        using (File.Open(Path.Combine(root, "docs", "guide.txt"), FileMode.Open, FileAccess.Read, FileShare.None))
            outcome = UpdateSwap.RecoverInterrupted(root);
        Check(outcome == UpdateSwap.Recovery.Failed, "stuck: first recovery fails (" + outcome + ")");
        Work(root, "library: worked in after the failure");
        Check(UpdateSwap.RecoverInterrupted(root) == UpdateSwap.Recovery.AlreadyFailed, "stuck: not replayed at the next start");
        Check(Read(root, "data/corpus.db") == "library: worked in after the failure", "stuck: library untouched");
        Check(UpdateSwap.Pending(root), "stuck: update-backup kept for support");
    }

    /** The new release did not answer: its first minutes may be undone, real work never. */
    static void UndoKeepsWorkDoneAfterTheWindow()
    {
        string root = Install("window");
        UpdateSwap.PrepareBackup(root, "1.0");
        UpdateSwap.SwapIn(root, Package(root));
        Work(root, "library: migrated by 2.0, then a day of work");
        File.SetLastWriteTimeUtc(Path.Combine(root, "data", "corpus.db"), DateTime.UtcNow + TimeSpan.FromHours(3));
        bool clean = UpdateSwap.Rollback(root, UpdateSwap.DbRule.IfUnused);
        Check(clean, "window: undo completes");
        Check(Read(root, "server/server.js") == "release 1.0", "window: old server back");
        Check(Read(root, "data/corpus.db") == "library: migrated by 2.0, then a day of work", "window: worked-in library kept");

        string root2 = Install("window2");
        UpdateSwap.PrepareBackup(root2, "1.0");
        UpdateSwap.SwapIn(root2, Package(root2));
        Work(root2, "library: touched by 2.0's first start only");
        UpdateSwap.Rollback(root2, UpdateSwap.DbRule.IfUnused);
        Check(Read(root2, "data/corpus.db") == "library: day 0", "window: first-minutes change undone");
        Check(Directory.GetFiles(Path.Combine(root2, "data"), "rollback-kept-*.db").Length == 1,
              "window: the replaced library is kept aside, never deleted");
    }

    /** A pending update-backup is never deleted by the next update. */
    static void NextUpdateNeverDeletesTheOnlyCopy()
    {
        string root = Install("only");
        UpdateSwap.PrepareBackup(root, "1.0");
        File.Delete(Path.Combine(root, "data", "corpus.db"));
        bool refused = false;
        try { UpdateSwap.PrepareBackup(root, "1.0"); } catch (InvalidOperationException) { refused = true; }
        Check(refused, "only: a new update is refused while the library is missing");
        Check(File.Exists(Path.Combine(UpdateSwap.BackupDir(root), "update-database", "corpus.db")),
              "only: the saved copy is still there");

        string root2 = Install("aside");
        UpdateSwap.PrepareBackup(root2, "1.0");
        UpdateSwap.PrepareBackup(root2, "1.0");
        Check(Directory.GetDirectories(root2, "update-backup-*").Length == 1, "aside: an old update-backup is set aside, not deleted");
    }

    /** The open discipline's library is the one saved and put back, wherever it lives. */
    static void TheOpenDisciplineIsTheOneSaved()
    {
        string root = Install("disc");
        string lib = Path.Combine(root, "data", "disciplines", "biology");
        Directory.CreateDirectory(lib);
        File.WriteAllText(Path.Combine(lib, "corpus.db"), "biology: day 0");
        File.WriteAllText(Path.Combine(root, "data", "disciplines.json"),
            "{\n  \"active\": \"biology\",\n  \"disciplines\": [\n    { \"id\": \"main\", \"name\": \"Politics\", \"dir\": null },\n    { \"id\": \"biology\", \"name\": \"Biology\", \"dir\": \"disciplines\\\\biology\" }\n  ]\n}");
        UpdateSwap.PrepareBackup(root, "1.0");
        Check(File.ReadAllText(Path.Combine(UpdateSwap.BackupDir(root), "update-database", "corpus.db")) == "biology: day 0",
              "discipline: the open library is the one saved");
        UpdateSwap.SwapIn(root, Package(root));
        File.WriteAllText(Path.Combine(lib, "corpus.db"), "biology: touched by 2.0's first start only");
        UpdateSwap.Rollback(root, UpdateSwap.DbRule.IfUnused);
        Check(File.ReadAllText(Path.Combine(lib, "corpus.db")) == "biology: day 0", "discipline: and the one put back");
        Check(Read(root, "data/corpus.db") == "library: day 0", "discipline: the other library is not touched");
        Check(UpdateSwap.ActiveLibrary(root) == @"disciplines\biology", "discipline: read from the registry");
    }

    /** A registry naming a folder outside data\ is not followed. */
    static void ARegistryCannotPointOutside()
    {
        string root = Install("outside");
        File.WriteAllText(Path.Combine(root, "data", "disciplines.json"),
            "{ \"active\": \"x\", \"disciplines\": [ { \"id\": \"x\", \"dir\": \"..\\\\server\" } ] }");
        Check(UpdateSwap.ActiveLibrary(root) == "", "outside: a path out of data is refused");
    }

    static int Main()
    {
        HappyPath();
        InterruptedSwapKeepsLaterWork();
        ReplayAfterPartialUndoKeepsTheWeek();
        FailedRecoveryIsNotReplayed();
        UndoKeepsWorkDoneAfterTheWindow();
        NextUpdateNeverDeletesTheOnlyCopy();
        TheOpenDisciplineIsTheOneSaved();
        ARegistryCannotPointOutside();
        Console.WriteLine(failures == 0 ? "all update-swap checks passed" : failures + " update-swap check(s) failed");
        return failures == 0 ? 0 : 1;
    }
}
