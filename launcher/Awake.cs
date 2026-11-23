// Keeps this computer awake while another device is reading from it.
//
// A laptop running Raazi sleeps like any other laptop: a few minutes after the
// last key press Windows idles it into standby and takes the Wi-Fi down seconds
// later. Nothing in that looks at whether a phone across the room is halfway
// through a book served from here — on the phone the library just stops
// answering, and comes back when somebody touches the laptop. On 23 Nov 2026
// the event log of the computer this was written on showed thirteen standbys
// by "Idle Timeout" in one working day, each one a lost connection on the
// phone, and the server itself had not missed a request.
//
// So while a signed-in request from another device is recent (GET
// /api/presence, lib/presence.ts), the launcher holds a "system required"
// power request: the screen still turns off on its timer, the computer does
// not go to sleep under the reader. `powercfg /requests` lists it by the
// reason below, so it is never a mystery what is keeping the machine up.
//
// What it cannot do:
//  - On battery, a laptop with Modern Standby honours such a request for only
//    about five minutes past its sleep timeout. Plugged in, it is honoured for
//    as long as it is held.
//  - Closing the lid or pressing the power button still sleeps the machine;
//    this only answers the idle timer.
//  - A computer already asleep cannot be woken from the phone.

using System;
using System.Globalization;
using System.Runtime.InteropServices;

static class Awake
{
    /**
     * How long after the last request from another device the computer is
     * held. A page left open asks for /api/hello every ten seconds, but a phone
     * stops doing that the moment its own screen locks — and picking it up ten
     * minutes later to find the library gone is the complaint this exists for.
     */
    public const int HoldForMs = 30 * 60 * 1000;

    /** How often the launcher asks the server whether anybody else is there. */
    public const int AskEveryMs = 20 * 1000;

    public const string Reason = "Raazi: another device is using this library";

    /**
     * The "remoteSeenAgoMs" of /api/presence, or -1 when nobody has been seen
     * or the answer is not one (an older server, an error page, nothing).
     */
    public static long RemoteSeenAgoMs(string json)
    {
        if (json == null) return -1;
        const string key = "\"remoteSeenAgoMs\":";
        int at = json.IndexOf(key, StringComparison.Ordinal);
        if (at < 0) return -1;
        int i = at + key.Length;
        while (i < json.Length && json[i] == ' ') i++;
        int start = i;
        while (i < json.Length && json[i] >= '0' && json[i] <= '9') i++;
        if (i == start) return -1;
        long value;
        return long.TryParse(json.Substring(start, i - start), NumberStyles.None, CultureInfo.InvariantCulture, out value)
            ? value
            : -1;
    }

    /** Whether that answer is a reason to stay awake. */
    public static bool ShouldHold(string presenceJson)
    {
        long ago = RemoteSeenAgoMs(presenceJson);
        return ago >= 0 && ago < HoldForMs;
    }

    static readonly object gate = new object();
    static IntPtr request = IntPtr.Zero;
    static bool holding;

    public static bool Holding { get { lock (gate) return holding; } }

    /**
     * Holds or lets go. Answers true when that changed anything, so the caller
     * can say so once rather than every twenty seconds.
     */
    public static bool Set(bool on)
    {
        lock (gate)
        {
            if (on == holding) return false;
            if (on)
            {
                if (request == IntPtr.Zero || request == Invalid)
                {
                    var why = new REASON_CONTEXT
                    {
                        Version = 0,                      // POWER_REQUEST_CONTEXT_VERSION
                        Flags = 1,                        // POWER_REQUEST_CONTEXT_SIMPLE_STRING
                        SimpleReasonString = Reason,
                    };
                    request = PowerCreateRequest(ref why);
                }
                if (request == IntPtr.Zero || request == Invalid) return false;
                if (!PowerSetRequest(request, SystemRequired)) return false;
                holding = true;
                return true;
            }
            PowerClearRequest(request, SystemRequired);
            holding = false;
            return true;
        }
    }

    const int SystemRequired = 1;                         // PowerRequestSystemRequired
    static readonly IntPtr Invalid = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct REASON_CONTEXT
    {
        public uint Version;
        public uint Flags;
        [MarshalAs(UnmanagedType.LPWStr)] public string SimpleReasonString;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT context);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool PowerSetRequest(IntPtr request, int type);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool PowerClearRequest(IntPtr request, int type);
}
