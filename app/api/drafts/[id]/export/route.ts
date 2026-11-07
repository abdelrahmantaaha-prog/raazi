import { NextResponse } from "next/server";
import { asId, attachment, badRequest, notFound } from "@/lib/http";
import { buildDocx } from "@/lib/docx";
import { citationsFor, getDraft } from "@/lib/drafts";
import { htmlToDocx, htmlToText } from "@/lib/richtext";
import { dirOf } from "@/lib/dir";

export const dynamic = "force-dynamic";

/**
 * The draft as a Word document.
 *
 * Built here rather than in the browser because the whole thing is a few
 * kilobytes of XML in a ZIP and the server can do it without shipping an
 * archiver to the client. Citations become real Word footnotes, so they
 * renumber themselves when the document is edited afterwards — which it will be.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = asId((await ctx.params).id);
  if (id === null) return badRequest("Not a valid id.");
  const draft = getDraft(id);
  if (!draft) return notFound("No such draft.");

  const citations = citationsFor(id);
  const { blocks, notes } = htmlToDocx(draft.body_html || `<p>${draft.body_md}</p>`, citations);

  // Which way the document reads, judged the way the editor judges it — from
  // the draft's own words, with the title thrown in for a piece that is still
  // only a heading. Word infers nothing from the characters themselves, so a
  // draft written in Arabic exported ragged-left until this was passed.
  const rtl = dirOf(`${draft.title} ${htmlToText(draft.body_html || draft.body_md || "")}`) === "rtl";

  const file = buildDocx({
    title: draft.title,
    blocks,
    notes,
    rtl,
    subtitle: `Drawn from Raazi · ${new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`,
  });

  // A filename Word will accept on any platform. The header carries it twice:
  // an ASCII rendering, and the real name UTF-8 encoded — an Arabic title used
  // to throw from inside the response constructor and export nothing.
  const name = (draft.title || "draft").replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "draft";

  return new NextResponse(new Uint8Array(file), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": attachment(`${name}.docx`, `draft-${id}.docx`),
      "content-length": String(file.length),
    },
  });
}
