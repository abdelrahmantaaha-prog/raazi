import { tx } from "../db";
import { getConfig } from "../config";
import { staleEntities } from "../entries";
import { enqueue, finishTask } from "../queue";
import type { Handler } from "../worker";
import type { Task } from "../types";
import { handleExtract } from "./extract";
import { handleEnhance } from "./enhance";
import { handleSweep } from "./sweep";
import { handleContext, handlePlanContext } from "./context";
import { handleIdentity } from "./identity";
import { handleCoherence } from "./coherence";
import { handleVerify } from "./verify";
import { handleResolve } from "./resolve";
import { handleEntry } from "./entry";
import { handleOcr } from "./ocr";
import { handleShipment } from "./shipment";
import { handleShipcheck } from "./shipcheck";
import { handleTextWebcheck } from "./webcheck";
import { handleTranscribe } from "./transcribe";
import { handleTag } from "./tag";
import { handleFactcheck } from "./factcheck";
import { handleWebcheck } from "./webcheck";
import { handleFolderFile } from "./folder";
import { handlePortrait, handlePlanPortraits } from "./portrait";
import { handlePlanPolls, handlePoll, handleFetchItem } from "./poll";
import { handleBrief } from "./brief";
import { handleExpand } from "./expand";

/**
 * Costs nothing and decides a lot: which entries this ingest has left out of
 * date. Two rules, and keeping them apart matters —
 *
 *   - a *new* entry is only worth writing once an entity clears the mention
 *     threshold, so the ~700 names a book produces do not each cost a call;
 *   - an entry that already exists is always brought back into line with its
 *     evidence, however small the entity, because a stale entry contradicts the
 *     sources it cites.
 *
 * See lib/entries.ts, which the idle sweep and the manual refresh share.
 */
async function handlePlanEntries(task: Task): Promise<void> {
  const { threshold } = JSON.parse(task.payload_json) as { threshold?: number };
  const targets = staleEntities(threshold ?? getConfig().entryThreshold, { notQueued: true });
  const rewrites = targets.filter((t) => t.has_entry > 0).length;

  tx(() => {
    enqueue(
      task.run_id,
      targets.map((t) => ({ kind: "entry" as const, payload: { entityId: t.id } }))
    );
    finishTask(
      task.id,
      task.run_id,
      { tokensIn: 0, tokensOut: 0 },
      "done",
      targets.length === 0
        ? "Every entry is already up to date."
        : `Queued ${targets.length}: ${rewrites} to update, ${targets.length - rewrites} new.`
    );
  });
}

export const handlers: Record<string, Handler> = {
  tag: handleTag,
  factcheck: handleFactcheck,
  webcheck: handleWebcheck,
  folder_file: handleFolderFile,
  extract: handleExtract,
  enhance: handleEnhance,
  sweep: handleSweep,
  context: handleContext,
  plan_context: handlePlanContext,
  identity: handleIdentity,
  coherence: handleCoherence,
  verify: handleVerify,
  ocr: handleOcr,
  shipment: handleShipment,
  shipcheck: handleShipcheck,
  webcheck_text: handleTextWebcheck,
  transcribe: handleTranscribe,
  resolve: handleResolve,
  entry: handleEntry,
  plan_entries: handlePlanEntries,
  portrait: handlePortrait,
  plan_portraits: handlePlanPortraits,
  plan_polls: handlePlanPolls,
  poll: handlePoll,
  fetch_item: handleFetchItem,
  brief: handleBrief,
  expand: handleExpand,
};
