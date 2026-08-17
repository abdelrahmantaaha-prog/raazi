"use client";

import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-[var(--color-rule)] bg-white p-4 ${className}`}>
      {children}
    </div>
  );
}

const TONES = {
  neutral: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
  running: "bg-blue-50 text-blue-700",
  warn: "bg-amber-50 text-amber-800",
  danger: "bg-red-50 text-red-700",
  ok: "bg-emerald-50 text-emerald-700",
  quiet: "bg-neutral-100 text-neutral-600",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const styles = {
    default: "border border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]",
    primary: "bg-[var(--color-accent)] text-white hover:opacity-90",
    ghost: "text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]",
    danger: "border border-red-200 text-red-700 hover:bg-red-50",
  }[variant];

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Progress({ value, total, tone = "accent" }: { value: number; total: number; tone?: "accent" | "amber" }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-rule)]">
      <div
        className={`h-full rounded-full transition-all ${tone === "amber" ? "bg-amber-500" : "bg-[var(--color-accent)]"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-rule)] px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

// dirOf lives in lib/dir.ts — server components need it too, and it cannot be
// re-exported from here without dragging the client boundary along with it.
