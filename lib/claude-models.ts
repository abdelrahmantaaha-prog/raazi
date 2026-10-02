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

/**
 * Which Claude suits each stage, as Settings suggests it: the quickest where
 * the calls number in thousands and the work is mechanical, the default where
 * judgement matters, the strongest for the few calls you read and present.
 */
export const STAGE_PLAN_ADVICE: Record<string, { model: string; why: string }> = {
  extract: { model: "claude-haiku-4-5", why: "thousands of calls, and reading a passage into a set shape is mechanical" },
  resolve: { model: "claude-sonnet-5-5", why: "small and occasional, but telling two people apart takes judgement" },
  entry: { model: "claude-opus-5-5", why: "the entries are the library itself — every one is written with Opus" },
  verify: { model: "claude-sonnet-5-5", why: "as many calls as writing, and it has to catch what the writer missed" },
  tag: { model: "claude-haiku-4-5", why: "one short call per source" },
  brief: { model: "claude-opus-5-5", why: "a handful of calls a week, and the one you present" },
  group: { model: "claude-haiku-4-5", why: "sorting headlines into piles is quick work" },
};

export function planModelName(id: string | null | undefined): string {
  return PLAN_MODELS.find((m) => m.id === id)?.name ?? id ?? "";
}
