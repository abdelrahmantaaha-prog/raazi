using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;

/**
 * Putting a release in place, and taking it out again.
 *
 * Kept apart from the tray app so a test program can drive it against a
 * throwaway folder (scripts/test-update-swap.mjs compiles this file with
 * launcher/tests/UpdateSwapTest.cs) without ever starting Raazi.
 *
 * Everything is written down as it happens in update-backup\update-swapped.txt:
 *
 *   from 0.10.0           the release being replaced
 *   library disciplines\x where the open library lives under data\ (absent: data\ itself)
 *   moved server          an entry of the old release went into update-backup\
 *   placed server         the package's entry went live
 *   complete <ticks>      the swap finished (UTC ticks, for the database rule below)
 *   undone-placed server  an undo took the package's entry out again
 *   undone-moved server   …and put the old one back
 *   db-restored           the pre-update database went back in
 *   db-kept-in-use        it did not: the library was worked in after the update
 *   recovery-failed       an undo could not finish; nothing more is tried by itself
 *
 * Each undo step is done once, a live entry whose original has nowhere to come
 * back from is never deleted, and the database is only ever replaced when the
 * new release is the only thing that could have written to it. That shape came
 * from Mutarjim, whose first undo replayed every step on each run and lost work.
 *
 * A Raazi has one library per discipline. Only the open one is saved: the server
 * opens no other until someone switches, and the new release is judged long
 * before that.
 */
static class UpdateSwap
{
    public static readonly string[] DbFiles = { "corpus.db", "corpus.db-wal", "corpus.db-shm" };

    public static string BackupDir(string root) { return Path.Combine(root, "update-backup"); }
    public static string StagingDir(string root) { return Path.Combine(root, "update-staging"); }
    public static string Journal(string root) { return Path.Combine(BackupDir(root), "update-swapped.txt"); }
    static string SavedDb(string root) { return Path.Combine(BackupDir(root), "update-database"); }

    /** How long after the swap the new release may write to the library before an undo leaves it alone. */
    public static readonly TimeSpan NewReleaseWindow = TimeSpan.FromMinutes(10);

    /** Never replaced, never moved aside: what belongs to this install rather than to a release. */
    public static bool Protected(string name)
    {
        string n = name.ToLowerInvariant();
        return n == "data" || n == "raazi.exe" || n == "corpus.exe" || n == "update.json" ||
               n == ".git" || n.StartsWith("update-");
    }

    /**
     * The open discipline's folder, relative to data\, from data\disciplines.json:
     * "" for the original library, which lives in data\ itself. Anything that
     * will not read, or that points outside data\, is the original.
     */
    public static string ActiveLibrary(string root)
    {
        try
        {
            string text = File.ReadAllText(Path.Combine(root, "data", "disciplines.json"));
            var active = Regex.Match(text, "\"active\"\\s*:\\s*\"([^\"]*)\"");
            if (!active.Success) return "";
            foreach (Match m in Regex.Matches(text, "\\{[^{}]*\\}"))
            {
                if (!Regex.IsMatch(m.Value, "\"id\"\\s*:\\s*\"" + Regex.Escape(active.Groups[1].Value) + "\"")) continue;
                var dir = Regex.Match(m.Value, "\"dir\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                if (!dir.Success) return "";
                string rel = dir.Groups[1].Value.Replace("\\\\", "\\").Replace('/', '\\');
                if (rel.Contains("..") || Path.IsPathRooted(rel)) return "";
                return Directory.Exists(Path.Combine(root, "data", rel)) ? rel : "";
            }
        }
        catch { }
        return "";
    }

    /** The library this update saved, as the journal has it; the open one before there is a journal. */
    static string LibraryDir(string root)
    {
        if (File.Exists(Journal(root)))
        {
            foreach (var l in Lines(root))
                if (l.StartsWith("library ")) return Path.Combine(root, "data", l.Substring(8).Trim());
            return Path.Combine(root, "data");
        }
        return Path.Combine(root, "data", ActiveLibrary(root));
    }

    static string LiveDb(string root) { return Path.Combine(LibraryDir(root), "corpus.db"); }

    public static List<string> Lines(string root)
    {
        try { return new List<string>(File.ReadAllLines(Journal(root))); }
        catch { return new List<string>(); }
    }

    static void Note(string root, string line)
    {
        File.AppendAllText(Journal(root), line + "\r\n");
    }

    /** An earlier update left something this install has not settled. */
    public static bool Pending(string root) { return Directory.Exists(BackupDir(root)); }

    public static bool Complete(string root)
    {
        foreach (var l in Lines(root)) if (l == "complete" || l.StartsWith("complete ")) return true;
        return false;
    }

    public static bool RecoveryFailed(string root) { return Lines(root).Contains("recovery-failed"); }

    /** When the swap finished, or null for a journal that does not say. */
    static DateTime? CompletedAt(string root)
    {
        foreach (var l in Lines(root))
        {
            long ticks;
            if (l.StartsWith("complete ") && long.TryParse(l.Substring(9).Trim(), out ticks))
                return new DateTime(ticks, DateTimeKind.Utc);
        }
        return null;
    }

    static bool Exists(string path) { return File.Exists(path) || Directory.Exists(path); }

    static void Move(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
    }

    static void Delete(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, true);
        else if (File.Exists(path)) File.Delete(path);
    }

    /**
     * A fresh update-backup\ holding the database as it is now. Run with the
     * server stopped.
     *
     * An earlier update-backup\ is never deleted here: when the live database
     * is missing it may hold the only copy of the library, so the update is
     * refused; otherwise it is kept aside under a dated name.
     */
    public static void PrepareBackup(string root, string from)
    {
        string backup = BackupDir(root);
        if (Directory.Exists(backup))
        {
            if (!File.Exists(LiveDb(root)))
                throw new InvalidOperationException(
                    "An earlier update was never settled, and your library is not where it should be. Nothing was installed.");
            Directory.Move(backup, backup + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"));
        }
        string library = ActiveLibrary(root);
        string saved = SavedDb(root);
        Directory.CreateDirectory(saved);
        foreach (var name in DbFiles)
        {
            string live = Path.Combine(root, "data", library, name);
            if (File.Exists(live)) File.Copy(live, Path.Combine(saved, name));
        }
        File.WriteAllText(Journal(root), "from " + from + "\r\n" + (library.Length > 0 ? "library " + library + "\r\n" : ""));
    }

    /**
     * Moves the package's entries in, the old ones into update-backup\. Every
     * step is written to the journal as it happens, so a swap cut off by a
     * power cut can be undone exactly.
     */
    public static void SwapIn(string root, string zipPath)
    {
        string staging = StagingDir(root);
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        try
        {
            ZipFile.ExtractToDirectory(zipPath, staging);
            if (!File.Exists(Path.Combine(staging, "server", "server.js")))
                throw new Exception("the package has no server");

            var names = new List<string>();
            foreach (var path in Directory.GetFileSystemEntries(staging))
            {
                string name = Path.GetFileName(path);
                if (!Protected(name)) names.Add(name);
            }
            foreach (var name in names)
            {
                string live = Path.Combine(root, name);
                if (!Exists(live)) continue;
                Move(live, Path.Combine(BackupDir(root), name));
                Note(root, "moved " + name);
            }
            foreach (var name in names)
            {
                Move(Path.Combine(staging, name), Path.Combine(root, name));
                Note(root, "placed " + name);
            }
            Note(root, "complete " + DateTime.UtcNow.Ticks);
        }
        finally
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
        }
    }

    public enum DbRule
    {
        /** Leave the live database exactly as it is. */
        Keep,
        /** Put the pre-update copy back unless the library was worked in after the update. */
        IfUnused,
        /** Put it back regardless (an explicit --undo-update); the live one is still kept aside. */
        Always,
    }

    /**
     * Puts back what SwapIn moved out and removes what it placed, each step at
     * most once. Returns whether everything is back; update-backup\ is removed
     * only then, and only when it holds nothing the live folder lacks.
     */
    public static bool Rollback(string root, DbRule db)
    {
        string backup = BackupDir(root);
        if (!Directory.Exists(backup)) return true;
        var lines = Lines(root);
        var done = new HashSet<string>(lines);
        bool clean = true;

        // 1. Take out what the package put in. Never a live entry whose
        // original has nowhere to come back from: if update-backup\ no longer
        // holds it, what is live may well BE the original, put back by an
        // earlier undo that did not get to write its note.
        foreach (var line in lines)
        {
            if (!line.StartsWith("placed ")) continue;
            string name = line.Substring(7);
            if (done.Contains("undone-placed " + name)) continue;
            if (done.Contains("moved " + name) && !done.Contains("undone-moved " + name) &&
                !Exists(Path.Combine(backup, name)))
            {
                clean = false;
                continue;
            }
            try
            {
                Delete(Path.Combine(root, name));
                Note(root, "undone-placed " + name);
                done.Add("undone-placed " + name);
            }
            catch { clean = false; }
        }

        // 2. Put back what it moved out.
        foreach (var line in lines)
        {
            if (!line.StartsWith("moved ")) continue;
            string name = line.Substring(6);
            if (done.Contains("undone-moved " + name)) continue;
            string from = Path.Combine(backup, name), to = Path.Combine(root, name);
            if (!Exists(from))
            {
                // Back already (the note was lost), or lost: only the first is fine.
                if (Exists(to)) Note(root, "undone-moved " + name);
                else clean = false;
                continue;
            }
            // The package's entry is still there: step 1 could not remove it.
            if (Exists(to)) { clean = false; continue; }
            try
            {
                Move(from, to);
                Note(root, "undone-moved " + name);
            }
            catch { clean = false; }
        }

        // 3. The database.
        if (db != DbRule.Keep && !done.Contains("db-restored") && !done.Contains("db-kept-in-use"))
        {
            if (!RestoreDatabase(root, db == DbRule.IfUnused ? CompletedAt(root) : null, db == DbRule.Always))
                clean = false;
        }

        if (clean && SafeToDiscard(root))
        {
            try { Directory.Delete(backup, true); } catch { }
        }
        return clean;
    }

    /** update-backup\ may go: either the live library is in place, or it holds no copy of one. */
    static bool SafeToDiscard(string root)
    {
        if (File.Exists(LiveDb(root))) return true;
        string saved = SavedDb(root);
        return !Directory.Exists(saved) || Directory.GetFiles(saved).Length == 0;
    }

    /**
     * Puts the pre-update database back. The live one is never deleted: it is
     * set aside as rollback-kept-<time>.db (with its -wal and -shm), and the
     * saved copy goes in under temporary names first, so a failure part-way
     * leaves the library recoverable.
     *
     * `swappedAt`: a library written to well after this moment was not touched
     * by the new release's first start but by real work, and an automatic undo
     * keeps it. Null with `force` for an explicit undo.
     */
    static bool RestoreDatabase(string root, DateTime? swappedAt, bool force)
    {
        string saved = SavedDb(root);
        if (!Directory.Exists(saved)) return true;
        string data = LibraryDir(root);
        string live = LiveDb(root);

        if (!force && File.Exists(live))
        {
            // A journal without a time cannot show the library is untouched,
            // so the live one stays.
            if (!swappedAt.HasValue || LastWrite(data) > swappedAt.Value + NewReleaseWindow)
            {
                Note(root, "db-kept-in-use");
                return true;
            }
        }

        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        try
        {
            foreach (var file in Directory.GetFiles(saved))
                File.Copy(file, Path.Combine(data, Path.GetFileName(file) + ".restoring"), true);
            foreach (var name in DbFiles)
            {
                string p = Path.Combine(data, name);
                if (File.Exists(p)) File.Move(p, Path.Combine(data, name.Replace("corpus.db", "rollback-kept-" + stamp + ".db")));
            }
            foreach (var file in Directory.GetFiles(saved))
            {
                string n = Path.GetFileName(file);
                File.Move(Path.Combine(data, n + ".restoring"), Path.Combine(data, n));
            }
            Note(root, "db-restored");
            return true;
        }
        catch { return false; }
    }

    /** The latest write to the live library, database or its log. */
    static DateTime LastWrite(string data)
    {
        DateTime last = DateTime.MinValue;
        foreach (var name in DbFiles)
        {
            string p = Path.Combine(data, name);
            if (name.EndsWith("-shm") || !File.Exists(p)) continue;
            var t = File.GetLastWriteTimeUtc(p);
            if (t > last) last = t;
        }
        return last;
    }

    public enum Recovery { Nothing, Undone, Failed, AlreadyFailed }

    /**
     * Before anything starts: a swap cut off half-way (no "complete") is
     * undone. The new release never ran, so whatever is in the library is the
     * previous version's — possibly days of work after an undo that was cut
     * short — and it stays exactly as it is.
     *
     * An undo that cannot finish is tried once. After that the install is left
     * as it is and the owner is told: replaying it at every start is how the
     * first version of this lost work.
     */
    public static Recovery RecoverInterrupted(string root)
    {
        if (!Pending(root) || Complete(root)) return Recovery.Nothing;
        if (RecoveryFailed(root)) return Recovery.AlreadyFailed;
        if (Rollback(root, DbRule.Keep)) return Recovery.Undone;
        try { Note(root, "recovery-failed"); } catch { }
        return Recovery.Failed;
    }

    /** The new release answered: keep its database copy beside the library as pre-update-<old>.db, drop the rest. */
    public static void Finish(string root)
    {
        try
        {
            string from = "previous";
            foreach (var line in Lines(root))
                if (line.StartsWith("from ")) from = Regex.Replace(line.Substring(5), "[^0-9A-Za-z.-]", "");
            string data = LibraryDir(root);
            foreach (var old in Directory.GetFiles(data, "pre-update-*.db*"))
                try { File.Delete(old); } catch { }
            string saved = SavedDb(root);
            if (Directory.Exists(saved))
                foreach (var file in Directory.GetFiles(saved))
                    File.Move(file, Path.Combine(data, Path.GetFileName(file).Replace("corpus.db", "pre-update-" + from + ".db")));
        }
        catch { }
        if (SafeToDiscard(root))
        {
            try { Directory.Delete(BackupDir(root), true); } catch { }
        }
    }
}
