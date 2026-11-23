using System;
using System.Runtime.InteropServices;

/**
 * Drives launcher/Awake.cs (scripts/test-awake.mjs): reading /api/presence,
 * the rule for holding, and the power request itself — taken, seen by Windows,
 * and given back. Prints "ok"/"FAIL" lines; exits 1 on any failure.
 */
static class AwakeTest
{
    static int failed;

    static void Check(string name, bool ok)
    {
        Console.WriteLine((ok ? "ok    " : "FAIL  ") + name);
        if (!ok) failed++;
    }

    // What Windows is currently being asked to stay up for, by anything.
    [DllImport("powrprof.dll")]
    static extern uint CallNtPowerInformation(int level, IntPtr input, uint inputSize, out uint output, uint outputSize);
    const int SystemExecutionState = 16;
    const uint ES_SYSTEM_REQUIRED = 0x1;

    static bool SystemRequired()
    {
        uint state;
        return CallNtPowerInformation(SystemExecutionState, IntPtr.Zero, 0, out state, 4) == 0 && (state & ES_SYSTEM_REQUIRED) != 0;
    }

    static int Main()
    {
        // -- reading the answer ------------------------------------------------
        Check("a recent request is read", Awake.RemoteSeenAgoMs("{\"remoteSeenAgoMs\":4200}") == 4200);
        Check("a space after the colon is fine", Awake.RemoteSeenAgoMs("{\"remoteSeenAgoMs\": 17}") == 17);
        Check("nobody seen is nobody", Awake.RemoteSeenAgoMs("{\"remoteSeenAgoMs\":null}") == -1);
        Check("no answer is nobody", Awake.RemoteSeenAgoMs(null) == -1);
        Check("an older server's 404 is nobody", Awake.RemoteSeenAgoMs("<!DOCTYPE html><html>404</html>") == -1);
        Check("the sign-in refusal is nobody", Awake.RemoteSeenAgoMs("{\"error\":\"This Raazi is in LAN mode.\"}") == -1);
        Check("a negative number is not a time", Awake.RemoteSeenAgoMs("{\"remoteSeenAgoMs\":-5}") == -1);

        // -- the rule ----------------------------------------------------------
        Check("someone a moment ago: hold", Awake.ShouldHold("{\"remoteSeenAgoMs\":0}"));
        Check("someone just inside the window: hold", Awake.ShouldHold("{\"remoteSeenAgoMs\":" + (Awake.HoldForMs - 1) + "}"));
        Check("someone at the edge of the window: let go", !Awake.ShouldHold("{\"remoteSeenAgoMs\":" + Awake.HoldForMs + "}"));
        Check("nobody: let go", !Awake.ShouldHold("{\"remoteSeenAgoMs\":null}"));
        Check("no server: let go", !Awake.ShouldHold(null));
        Check("the window outlasts a phone's locked screen", Awake.HoldForMs >= 10 * 60 * 1000);
        Check("asked often enough to notice within a minute", Awake.AskEveryMs <= 60 * 1000);

        // -- the request itself ------------------------------------------------
        bool before = SystemRequired();
        Check("starts out not holding", !Awake.Holding);
        Check("letting go of nothing changes nothing", !Awake.Set(false));
        Check("holding takes the request", Awake.Set(true) && Awake.Holding);
        Check("Windows counts the system as required while it is held", SystemRequired());
        Check("holding twice is one hold", !Awake.Set(true) && Awake.Holding);
        Check("letting go gives it back", Awake.Set(false) && !Awake.Holding);
        // Something else on the machine may be holding one of its own; only a
        // machine that was not held before can be seen to return to that.
        if (!before) Check("and Windows no longer counts it", !SystemRequired());
        else Console.WriteLine("note  something else is keeping this computer awake; the release could not be observed");
        Check("it can be taken again afterwards", Awake.Set(true) && SystemRequired() && Awake.Set(false));

        Console.WriteLine(failed == 0 ? "all passed" : failed + " failed");
        return failed == 0 ? 0 : 1;
    }
}
