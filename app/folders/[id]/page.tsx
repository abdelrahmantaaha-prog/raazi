import { notFound } from "next/navigation";
import { folderFiles, getFolder, readableAs } from "@/lib/folders";
import { FolderView } from "./FolderView";

export const dynamic = "force-dynamic";

export default async function FolderPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const folder = getFolder(id);
  if (!folder) notFound();
  const files = folderFiles(id).map((f) => ({ ...f, as: readableAs(f.rel_path) }));
  return <FolderView folder={folder} files={files} />;
}
