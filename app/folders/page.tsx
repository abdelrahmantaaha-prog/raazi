import Link from "next/link";
import { listFolders } from "@/lib/folders";
import { Badge, Card, Empty } from "../components/ui";
import { relativeDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function FoldersPage() {
  const folders = listFolders();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Folders</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Zips and folders you brought in whole. Their files wait here, unread, until you open a
          folder and press Read. Add one from the Library: Add source → Folder or zip.
        </p>
      </div>
      {folders.length === 0 ? (
        <Empty title="No folders yet." hint="Library → Add source → Folder or zip." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {folders.map((f) => (
            <Link key={f.id} href={`/folders/${f.id}`}>
              <Card className="h-full transition hover:border-[var(--color-accent)]">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 break-words font-medium">📁 {f.name}</p>
                  <span className="shrink-0 text-xs text-[var(--color-muted)]">{relativeDate(f.created_at)}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge tone="quiet">{f.files} file{f.files === 1 ? "" : "s"}</Badge>
                  {f.waiting > 0 && <Badge tone="warn">{f.waiting} waiting</Badge>}
                  {f.added > 0 && <Badge tone="ok">{f.added} read</Badge>}
                  {f.failed > 0 && <Badge tone="danger">{f.failed} failed</Badge>}
                  {f.unsupported > 0 && <Badge tone="quiet">{f.unsupported} not readable</Badge>}
                  <Badge tone="quiet">from a {f.origin}</Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
