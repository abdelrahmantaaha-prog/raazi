# Raazi on your phone

An Android app that finds the computer running Raazi on your network and opens
your library in it — the inbox, the reader, the pedia, everything the web app
does, laid out for the phone.

It is a window onto the web app, not a second app: Raazi already lays itself
out for a phone, and a native copy would be a second version always running
behind. What the app adds is what a browser tab cannot do:

- **Finds the computer by itself.** It tries the addresses it used before (the
  home Wi-Fi one and, with Tailscale, the one from away) all at once; if none
  answers it asks every address on the phone's network whether it is a Raazi
  (`GET /api/hello` → `{"app":"corpus"}`), which takes about a second. One
  found opens straight away.
- **Signs in once.** Settings → Phone & other laptop → *Show the code* on the computer; tap
  *Scan the code* in the app. Pasting the sign-in link or the token works too,
  and so does opening the link from the camera app. A computer that turns up
  under a new address is offered the tokens already known before anyone is
  asked.
- **Listen works.** Android's WebView has no speech synthesis at all, so the
  reader's Listen button had nothing to speak with. `assets/phone.js` stands in
  a `speechSynthesis` backed by the phone's own voices (`PhoneVoice.kt`) — the
  same API the reader already uses, so the web app did not change for it.
  Android's engine cannot pause, only stop, so pause stops and resume says the
  current sentence again.
- **Back closes what is open first** — the inbox sheet, a drawer, the book —
  by sending Escape, which every panel in Raazi already answers; then it goes
  back a page; from the front page it shows the connect screen, which is also
  how you switch computers.
- **The screen stays on while a book is open** (the reader asks for a wake
  lock; the app honours it).
- **Files and downloads** go through Android's own picker and download manager,
  the download carrying the sign-in cookie.
- **Links out** (articles, sources) open in the phone's browser.

The bridge between the page and the phone (`RaaziPhone`) is offered to Raazi's
own address only, so pages from other sites shown inside the inbox cannot
reach it.

## Before it can work: Sharing on, and the firewall

Raazi listens only to its own computer until **Settings → Phone & other laptop → Sharing** is set to
*Shared*. Then the phone needs the token, once — that is the code above.

**Windows blocks incoming connections by default**, which from the phone looks
exactly like Raazi being switched off. Open PowerShell **as Administrator** once:

```powershell
New-NetFirewallRule -DisplayName "Raazi (local network)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5400 -Profile Private
```

Both devices must be on the same Wi-Fi (a guest network is walled off), or on
Tailscale.

## Building it

```powershell
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
```

Uses the toolchain in `E:\Claude\tools\android` and writes
`dist\raazi-phone.apk`, signed with the release key in `android\.signing\`
(made on the first build, kept out of git; a copy of its password is in the
owner's vault). Every build signed with that key installs over the last one.
`-Debug` builds one whose pages can be inspected from the computer
(`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`) — it is
signed differently, so switching between the two means uninstalling first.

## What was tried and dropped

An mDNS announcement from the Raazi server, so the phone would find it
instantly instead of sweeping. Every pure-JS responder needs node's `dgram`,
which Next's bundler will not resolve inside the instrumentation hook — the
attempt took the entire site down twice before it was abandoned. Multicast is
also dropped by many home access points, so the sweep would have been needed
anyway.
