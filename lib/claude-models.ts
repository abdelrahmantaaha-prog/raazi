/**
 * The Claudes a Claude plan can be asked for, through Claude Code.
 *
 * No server code here, so the settings page can import it. Full names, never
 * aliases: on a Pro plan the "sonnet" alias still answered with Sonnet 5.
 * Checked on a Pro plan, 30 Sep 2026: Sonnet 5.5, Opus 5.5 and Haiku 4.5
 * answer; Fable 5.1 answers "requires usage credits", which a Max plan has.
 */
export const PLAN_MODELS = [
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", line: "The default — strong, quick, and on every plan." },
  { id: "claude-opus-5-5", name: "Opus 5.5", line: "The strongest writer. Spends the plan's allowance faster." },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", line: "The quickest, and the lightest on the allowance." },
  { id: "claude-fable-5-1", name: "Fable 5.1", line: "The most capable. Max plans, or a plan with usage credits." },
] as const;

export type PlanModel = (typeof PLAN_MODELS)[number]["id"];
export const DEFAULT_PLAN_MODEL: PlanModel = "claude-sonnet-5-5";

export function isPlanModel(v: unknown): v is PlanModel {
  return PLAN_MODELS.some((m) => m.id === v);
}

export function planModelName(id: string | null | undefined): string {
  return PLAN_MODELS.find((m) => m.id === id)?.name ?? id ?? "";
}
