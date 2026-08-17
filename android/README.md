# Corpus on your phone

A small Android app that finds whichever computer is running Corpus on your
network and opens its library.

It is a wrapper around the web app, not a second implementation of it. Corpus
already reads well on a phone — the reader, entries, the connections graph, Ask
and Study all work as they are — and a native rewrite would only be a second
version to keep in step with the first.

## What it does

On launch it tries the machine you used last. That is one request and it
normally succeeds, so you go straight into the library.

If that fails, it asks all 254 addresses of your phone's own subnet whether
they are a Corpus, in batches of 48, with a 400 ms patience each. That takes
about a second. Anything that answers `/api/hello` with `{"app":"corpus"}` is
listed with its machine name and how much it holds; if exactly one answers, it
opens automatically.

Failing all that, you can type the address by hand.

## Before it can work: the firewall

**Windows blocks incoming connections by default**, so a freshly installed
Corpus is invisible to your phone even while it is running perfectly. From the
phone this looks identical to Corpus being switched off, which makes it worth
ruling out first.

Open PowerShell **as Administrator** and run:

```powershell
New-NetFirewallRule -DisplayName "Corpus (local network)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5400 -Profile Private
```

`-Profile Private` matters: it opens the port on networks you have marked as
private (home, office) and leaves it shut on public Wi-Fi. Check that your
network is classified private with `Get-NetConnectionProfile`.

To undo it later:

```powershell
Remove-NetFirewallRule -DisplayName "Corpus (local network)"
```

## Building the APK

There is no Android toolchain on the machine Corpus is developed on, so the APK
comes out of GitHub Actions.

1. Make this a git repository and push it somewhere on GitHub:

   ```bash
   git init && git add . && git commit -m "Corpus" && git branch -M main
   ```

   Add `data/` and `node_modules/` to `.gitignore` first — `data/` holds your
   library and your API keys.

2. Push. The **Android helper** workflow runs on any change under `android/`,
   or on demand from the Actions tab.

3. Download `corpus-helper-apk` from the finished run, unzip, and install the
   APK on your phone. You will have to allow installation from unknown sources
   once — it is an unsigned debug build, which is the normal way to install
   something you built yourself.

## Notes

- Both devices must be on the same Wi-Fi. A guest network is deliberately
  walled off from the rest of the house and will not reach your computer.
- The app permits cleartext HTTP, because Corpus has no certificate. It is only
  ever pointed at an address found on your own network or typed in by hand.
- Exports download through Android's own download manager and land in
  Downloads.
- Back from a library's front page returns to the connect screen, which is also
  how you switch between machines.

## What was tried and dropped

An mDNS announcement from the Corpus server, so the phone would find it
instantly instead of sweeping. Every pure-JS responder needs node's `dgram`,
which Next's bundler will not resolve inside the instrumentation hook — the
attempt took the entire site down twice before it was abandoned. Multicast is
also dropped by many home access points, so the sweep would have been needed
anyway, and one mechanism that always works beats two that sometimes do.
