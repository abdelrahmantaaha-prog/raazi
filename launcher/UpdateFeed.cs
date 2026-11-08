using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

/**
 * What the starter believes about the update feed, apart from Launcher.cs so
 * scripts/test-update-feed.mjs can test it. Nothing here shows a dialog or touches the running server.
 *
 * The feed (manifest.json) is plain JSON on a public host. A package is only
 * ever installed when its zip verifies against a key compiled into the
 * starter, so an unsigned feed can at worst withhold updates. The few things
 * a feed may ask beyond "here is a package" — move to another feed address,
 * withdraw versions, retire a key — are honoured only when the manifest
 * itself carries a valid signature (manifest.json.sig).
 */
static class UpdateFeed
{
    /** RSA-SHA256 over `data` with the public modulus (exponent 65537). */
    public static bool VerifyWith(byte[] data, byte[] sig, string modulusB64)
    {
        if (string.IsNullOrEmpty(modulusB64) || sig == null) return false;
        try
        {
            using (var rsa = new RSACryptoServiceProvider())
            {
                rsa.ImportParameters(new RSAParameters
                {
                    Modulus = Convert.FromBase64String(modulusB64),
                    Exponent = new byte[] { 1, 0, 1 },
                });
                return rsa.VerifyData(data, "SHA256", sig);
            }
        }
        catch { return false; }
    }

    /**
     * Which trusted key (1-based) signed `data`, or 0. `moduli[i]` is key
     * i+1; a key listed in `retired` no longer counts — that is how a leaked
     * key is cut off by a manifest signed with the spare.
     */
    public static int SignedBy(byte[] data, string sigB64, string[] moduli, ICollection<int> retired)
    {
        byte[] sig;
        try { sig = Convert.FromBase64String((sigB64 ?? "").Trim()); }
        catch { return 0; }
        for (int i = 0; i < moduli.Length; i++)
        {
            if (retired != null && retired.Contains(i + 1)) continue;
            if (VerifyWith(data, sig, moduli[i])) return i + 1;
        }
        return 0;
    }

    /**
     * HTTPS only. Plain HTTP to this machine exists only in the test build
     * (/define:UPDATE_TESTS), so another Windows user cannot serve this
     * starter a feed from a local port.
     */
    public static bool AcceptableUrl(string u)
    {
        Uri uri;
        if (!Uri.TryCreate(u, UriKind.Absolute, out uri)) return false;
        if (uri.Scheme == Uri.UriSchemeHttps) return true;
#if UPDATE_TESTS
        if (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback) return true;
        if (uri.Scheme == Uri.UriSchemeFile) return true;
#endif
        return false;
    }

    /** The strings in a flat JSON array field: "revoked": ["2.6.1", "2.6.2"]. */
    public static List<string> StringArray(string json, string field)
    {
        var list = new List<string>();
        var m = Regex.Match(json ?? "", "\"" + Regex.Escape(field) + "\"\\s*:\\s*\\[([^\\]]*)\\]");
        if (!m.Success) return list;
        foreach (Match s in Regex.Matches(m.Groups[1].Value, "\"([^\"\\\\]*)\"")) list.Add(s.Groups[1].Value);
        return list;
    }

    /** The numbers in a flat JSON array field: "retire": [1]. */
    public static List<int> IntArray(string json, string field)
    {
        var list = new List<int>();
        var m = Regex.Match(json ?? "", "\"" + Regex.Escape(field) + "\"\\s*:\\s*\\[([^\\]]*)\\]");
        if (!m.Success) return list;
        foreach (Match s in Regex.Matches(m.Groups[1].Value, "\\d+"))
        {
            int n;
            if (int.TryParse(s.Value, out n)) list.Add(n);
        }
        return list;
    }

    /**
     * The keys a signed manifest retires, minus the one that signed it and
     * never all of them: a manifest can hand trust to the spare key, never
     * leave the starter trusting nothing.
     */
    public static List<int> KeysToRetire(string feed, int signedBy, int keyCount, ICollection<int> alreadyRetired)
    {
        var result = new List<int>();
        if (signedBy <= 0) return result;
        foreach (int k in IntArray(feed, "retire"))
        {
            if (k < 1 || k > keyCount || k == signedBy) continue;
            if (alreadyRetired != null && alreadyRetired.Contains(k)) continue;
            if (!result.Contains(k)) result.Add(k);
        }
        return result;
    }

    /**
     * Downloads to `dest` with a size cap, a per-read timeout and an overall
     * deadline, so a hostile feed can neither fill the disk nor stall the
     * check for ever. A partial file is deleted on any failure.
     */
    public static void Download(string url, string dest, long maxBytes, int timeoutMs, int deadlineMs)
    {
        var started = DateTime.UtcNow;
        try
        {
            var req = WebRequest.Create(url);
            req.Timeout = timeoutMs;
            var http = req as HttpWebRequest;
            if (http != null)
            {
                http.ReadWriteTimeout = timeoutMs;
                http.Headers[HttpRequestHeader.CacheControl] = "no-cache";
                http.UserAgent = "Raazi-updater";
            }
            using (var res = req.GetResponse())
            {
                if (res.ContentLength > maxBytes) throw new IOException("larger than " + maxBytes + " bytes");
                using (var input = res.GetResponseStream())
                using (var output = File.Create(dest))
                {
                    var buf = new byte[81920];
                    long total = 0;
                    int n;
                    while ((n = input.Read(buf, 0, buf.Length)) > 0)
                    {
                        total += n;
                        if (total > maxBytes) throw new IOException("larger than " + maxBytes + " bytes");
                        if ((DateTime.UtcNow - started).TotalMilliseconds > deadlineMs) throw new TimeoutException("took too long");
                        output.Write(buf, 0, n);
                    }
                }
            }
        }
        catch
        {
            try { if (File.Exists(dest)) File.Delete(dest); } catch { }
            throw;
        }
    }

    /** A small file over the network, capped the same way — the exact bytes, for a signature. */
    public static byte[] ReadBytes(string url, int maxBytes, int timeoutMs)
    {
        string tmp = Path.Combine(Path.GetTempPath(), "raazi-feed-" + Guid.NewGuid().ToString("N") + ".part");
        try
        {
            Download(url, tmp, maxBytes, timeoutMs, timeoutMs * 2);
            return File.ReadAllBytes(tmp);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    public static string ReadText(string url, int maxBytes, int timeoutMs)
    {
        return new UTF8Encoding(false).GetString(ReadBytes(url, maxBytes, timeoutMs));
    }

    /** An entry by its path with either separator: zips made on older .NET use backslashes. */
    static ZipArchiveEntry Entry(ZipArchive zip, string name)
    {
        foreach (var e in zip.Entries)
            if (string.Equals(e.FullName.Replace('\\', '/'), name, StringComparison.OrdinalIgnoreCase)) return e;
        return null;
    }

    /** One text entry of a zip, or null. */
    public static string ZipText(string zipPath, string entryName)
    {
        try
        {
            using (var zip = ZipFile.OpenRead(zipPath))
            {
                var entry = Entry(zip, entryName);
                if (entry == null) return null;
                using (var reader = new StreamReader(entry.Open(), Encoding.UTF8))
                    return reader.ReadToEnd();
            }
        }
        catch { return null; }
    }

    public static bool ZipHas(string zipPath, string entryName)
    {
        try
        {
            using (var zip = ZipFile.OpenRead(zipPath)) return Entry(zip, entryName) != null;
        }
        catch { return false; }
    }

    /**
     * Why the Node this install would run cannot load a package's server, or
     * null. A package that carries its own node\node.exe brings the
     * Node it was built with. Otherwise its server\node-abi.txt ("137 v24.19.0")
     * must match `installedAbi`, the ABI of the Node found here; a mismatch
     * would swap in, fail to start, and roll back.
     */
    public static string NodeRefusal(string zipPath, string installedAbi)
    {
        if (ZipHas(zipPath, "node/node.exe")) return null;
        string stamp = ZipText(zipPath, "server/node-abi.txt");
        if (string.IsNullOrEmpty(stamp)) return null;
        string want = stamp.Trim().Split(new[] { ' ', '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries)[0];
        if (string.IsNullOrEmpty(installedAbi)) return "no Node.js here to check it against (needs ABI " + want + ")";
        return want == installedAbi.Trim() ? null : "built for Node ABI " + want + ", this computer has " + installedAbi.Trim();
    }
}
