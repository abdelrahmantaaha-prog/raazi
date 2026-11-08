using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

/**
 * Drives launcher/UpdateFeed.cs against throwaway files (scripts/test-update-feed.mjs).
 * Compiled exactly as a release build compiles it — no UPDATE_TESTS — so the
 * address rule tested is the one every install gets. Prints "ok"/"FAIL" lines;
 * exits 1 on any failure.
 */
static class UpdateFeedTest
{
    static int failed;

    static void Check(string name, bool ok)
    {
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + name);
        if (!ok) failed++;
    }

    static string Modulus(RSACryptoServiceProvider rsa)
    {
        return Convert.ToBase64String(rsa.ExportParameters(false).Modulus);
    }

    static string Sign(RSACryptoServiceProvider rsa, byte[] data)
    {
        return Convert.ToBase64String(rsa.SignData(data, "SHA256"));
    }

    static int Main()
    {
        string dir = Path.Combine(Path.GetTempPath(), "feed-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            // -- signatures, two keys, retiring one ---------------------------
            using (var k1 = new RSACryptoServiceProvider(2048))
            using (var k2 = new RSACryptoServiceProvider(2048))
            using (var stranger = new RSACryptoServiceProvider(2048))
            {
                var data = Encoding.UTF8.GetBytes("{\"stable\":{\"version\":\"2.7.0\"}}");
                var keys = new[] { Modulus(k1), Modulus(k2) };
                Check("the first key's signature verifies as key 1", UpdateFeed.SignedBy(data, Sign(k1, data), keys, null) == 1);
                Check("the spare's signature verifies as key 2", UpdateFeed.SignedBy(data, Sign(k2, data), keys, null) == 2);
                Check("a stranger's signature verifies as nothing", UpdateFeed.SignedBy(data, Sign(stranger, data), keys, null) == 0);
                Check("a retired key's signature no longer counts", UpdateFeed.SignedBy(data, Sign(k1, data), keys, new List<int> { 1 }) == 0);
                Check("an empty spare slot trusts nothing", UpdateFeed.SignedBy(data, Sign(k2, data), new[] { Modulus(k1), "" }, null) == 0);
                Check("garbage instead of a signature", UpdateFeed.SignedBy(data, "not base64!", keys, null) == 0);
                var tampered = Encoding.UTF8.GetBytes("{\"stable\":{\"version\":\"2.7.1\"}}");
                Check("a changed manifest fails its signature", UpdateFeed.SignedBy(tampered, Sign(k1, data), keys, null) == 0);
            }

            // -- what a feed may ask --------------------------------------------
            string feed = "{\"stable\":{\"version\":\"2.7.0\",\"zip\":\"https://x/y.zip\"},\"revoked\":[\"2.6.1\", \"2.6.2\"],\"retire\":[1, 2, 7]}";
            var revoked = UpdateFeed.StringArray(feed, "revoked");
            Check("withdrawn versions are read", revoked.Count == 2 && revoked.Contains("2.6.1") && revoked.Contains("2.6.2"));
            Check("no list reads as empty", UpdateFeed.StringArray("{}", "revoked").Count == 0);
            var retire = UpdateFeed.KeysToRetire(feed, 2, 2, null);
            Check("a manifest signed by the spare retires key 1 only", retire.Count == 1 && retire[0] == 1);
            Check("an unsigned manifest retires nothing", UpdateFeed.KeysToRetire(feed, 0, 2, null).Count == 0);
            Check("a key never retires itself", !UpdateFeed.KeysToRetire(feed, 1, 2, null).Contains(1));

            // -- addresses: HTTPS only in a release build --------------------
            Check("https is accepted", UpdateFeed.AcceptableUrl("https://github.com/x/manifest.json"));
            Check("http to this computer is refused in a release build", !UpdateFeed.AcceptableUrl("http://127.0.0.1:8080/manifest.json"));
            Check("http elsewhere is refused", !UpdateFeed.AcceptableUrl("http://example.com/manifest.json"));
            Check("file addresses are refused in a release build", !UpdateFeed.AcceptableUrl("file:///C:/feed/manifest.json"));

            // -- downloads are capped -----------------------------------------
            string big = Path.Combine(dir, "big.bin");
            File.WriteAllBytes(big, new byte[2 * 1024 * 1024]);
            string dest = Path.Combine(dir, "got.bin");
            bool refused = false;
            try { UpdateFeed.Download(new Uri(big).AbsoluteUri, dest, 1024 * 1024, 10000, 60000); }
            catch { refused = true; }
            Check("a download over its cap is refused", refused);
            Check("and leaves no partial file", !File.Exists(dest));
            UpdateFeed.Download(new Uri(big).AbsoluteUri, dest, 4 * 1024 * 1024, 10000, 60000);
            Check("a download under its cap arrives whole", new FileInfo(dest).Length == 2 * 1024 * 1024);

            // -- Node before installing ---------------------------------
            string plain = Path.Combine(dir, "plain");
            Directory.CreateDirectory(Path.Combine(plain, "server"));
            File.WriteAllText(Path.Combine(plain, "server", "node-abi.txt"), "137 v24.19.0\n");
            string plainZip = Path.Combine(dir, "plain.zip");
            ZipFile.CreateFromDirectory(plain, plainZip);
            Check("a package for this Node is accepted", UpdateFeed.NodeRefusal(plainZip, "137") == null);
            string why = UpdateFeed.NodeRefusal(plainZip, "141");
            Check("a package for another Node is refused before it is installed", why != null && why.Contains("137") && why.Contains("141"));
            Check("with no Node here it is refused too", UpdateFeed.NodeRefusal(plainZip, null) != null);
            string carrying = Path.Combine(dir, "carrying");
            Directory.CreateDirectory(Path.Combine(carrying, "server"));
            Directory.CreateDirectory(Path.Combine(carrying, "node"));
            File.WriteAllText(Path.Combine(carrying, "server", "node-abi.txt"), "141 v26.0.0\n");
            File.WriteAllText(Path.Combine(carrying, "node", "node.exe"), "");
            string carryingZip = Path.Combine(dir, "carrying.zip");
            ZipFile.CreateFromDirectory(carrying, carryingZip);
            Check("a package that brings its own Node is accepted", UpdateFeed.NodeRefusal(carryingZip, "137") == null);
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
        return failed == 0 ? 0 : 1;
    }
}
