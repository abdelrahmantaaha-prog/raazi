/**
 * Deliberately not a "use client" module: both server components (the quote
 * bank, the source reader) and client components (the entry view) need this.
 * Importing a plain function from a "use client" file into a server component
 * hands back a client reference proxy, and calling it throws at render.
 */

/** Arabic sources read right to left; entries follow their sources. */
export function dirOf(text: string): "rtl" | "ltr" {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  return arabic > text.length * 0.2 ? "rtl" : "ltr";
}
