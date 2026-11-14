"use client";

import { useEffect, useState } from "react";
import { Card } from "../components/ui";

/**
 * The launcher's update check, said out loud and switchable. Off means no
 * update reaches this computer until it is switched on again or a package is
 * installed by hand. Shown only on a packaged copy: a checkout is updated by
 * git and its launcher never looks.
 */
export function UpdatesCard() {
  const [state, setState] = useState<{ checking: boolean; packaged: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/updates", { cache: "no-store" })
      .then((r) => r.json())
      .then(setState)
      .catch(() => setError("Couldn't read this setting."));
  }, []);

  const set = async (checking: boolean) => {
    setError(null);
    try {
      const res = await fetch("/api/settings/updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checking }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState(await res.json());
    } catch {
      setError("Couldn't save that.");
    }
  };

  if (!state?.packaged) return error ? <p className="text-sm text-red-700">{error}</p> : null;

  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Updates</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Version {process.env.RAAZI_RELEASE}. An update file you were given installs from Raazi&apos;s tray icon, with
        “Update from a file…”, with its .sig file in the same folder.
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
          checked={state.checking}
          onChange={(e) => void set(e.target.checked)}
        />
        <span>
          Look for new versions automatically
          <span className="block text-xs text-[var(--color-muted)]">
            Every few hours Raazi asks GitHub whether there is a new version. Nothing from your library is sent (GitHub
            sees this computer&apos;s address, nothing more), and nothing installs until you say so.
          </span>
        </span>
      </label>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </Card>
  );
}
