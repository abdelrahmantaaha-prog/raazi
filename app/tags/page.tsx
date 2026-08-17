import { db } from "@/lib/db";
import { listTags } from "@/lib/tags";
import { TagsManager } from "./TagsManager";

export const dynamic = "force-dynamic";

export default async function TagsPage() {
  const tags = listTags();

  const sources = db()
    .prepare(
      `SELECT s.id, s.title, s.author, s.kind, s.tagged_at,
              (SELECT COUNT(*) FROM chunks c WHERE c.source_id = s.id) AS chunks,
              (SELECT group_concat(t.id) FROM source_tags st JOIN tags t ON t.id=st.tag_id
                WHERE st.source_id = s.id) AS tag_ids
         FROM sources s ORDER BY s.id DESC`
    )
    .all() as {
    id: number;
    title: string;
    author: string | null;
    kind: string;
    chunks: number;
    tag_ids: string | null;
  }[];

  return (
    <TagsManager
      tags={tags}
      sources={sources.map((s) => ({
        id: s.id,
        title: s.title,
        author: s.author,
        kind: s.kind,
        chunks: s.chunks,
        tagIds: s.tag_ids ? s.tag_ids.split(",").map(Number) : [],
      }))}
    />
  );
}
