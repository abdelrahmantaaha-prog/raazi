import fs from "node:fs";
import path from "node:path";

/**
 * More than one discipline, with a wall between them.
 *
 * Topics organise the pedia without partitioning it — deliberately, because
 * someone who turns up in two of your subjects should stay one person with
 * one entry. That is right within a discipline and wrong between two. A
 * political beat and a history of the early Church share no people, no
 * events, no feeds and no morning; an entry that drew on both would be a
 * mistake rather than a synthesis, and a brief that mixed them would be
 * unreadable.
 *
 * So a discipline is a **separate library**: its own database, its own
 * sources, entities, entries, feeds, inbox, briefs, drafts and search index,
 * under its own folder. One is open at a time. Nothing filters anything —
 * there is nothing to filter, because the other discipline is not in the
 * database being read. That matters more than it sounds: scoping one shared
 * database would have meant a discipline test on 267 separate queries, and a
 * single one forgotten is a silent leak of exactly the kind this exists to
 * prevent.
 *
 * What is shared is what is not about the subject: the API keys and which
 * model does which job. Those live in one file beside the registry, so a key
 * pasted once works everywhere and a key's quota is counted once.
 *
 * The first discipline is the library you already had. It keeps its folder —
 * `data/` itself — so nothing moves on disk and no upgrade can lose it;
 * later ones get `data/disciplines/<id>/`.
 */

export interface Discipline {
  id: string;
  name: string;
  /** Relative to the data root. Null for the original library, which is the root. */
  dir: string | null;
  createdAt: string;
}

interface Registry {
  active: string;
  disciplines: Discipline[];
}

/** The folder holding every discipline, the registry and the shared keys. */
export function rootDir(): string {
  return process.env.CORPUS_ROOT_DIR
    ? path.resolve(process.env.CORPUS_ROOT_DIR)
    : path.join(process.cwd(), "data");
}

/**
 * A test, or anything else pointed straight at one library, has no registry
 * and no disciplines — it is simply that one folder. Everything below returns
 * a single unnamed discipline in that case, so no caller needs to know.
 */
export function pinnedDir(): string | null {
  return process.env.CORPUS_DATA_DIR ? path.resolve(process.env.CORPUS_DATA_DIR) : null;
}

const REGISTRY = () => path.join(rootDir(), "disciplines.json");
export const SHARED_CONFIG = () => path.join(rootDir(), "shared.json");

const ORIGINAL: Discipline = { id: "main", name: "Library", dir: null, createdAt: "" };

function read(): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY(), "utf8")) as Partial<Registry>;
    const list = (raw.disciplines ?? []).filter((d) => d && typeof d.id === "string");
    if (!list.length) return { active: ORIGINAL.id, disciplines: [ORIGINAL] };
    const active = list.some((d) => d.id === raw.active) ? (raw.active as string) : list[0].id;
    return { active, disciplines: list };
  } catch {
    // No registry yet, or one that will not parse: the library you have.
    return { active: ORIGINAL.id, disciplines: [ORIGINAL] };
  }
}

function write(reg: Registry): void {
  fs.mkdirSync(rootDir(), { recursive: true });
  const tmp = `${REGISTRY()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRY());
}

export function listDisciplines(): Discipline[] {
  if (pinnedDir()) return [{ ...ORIGINAL, name: "This library" }];
  return read().disciplines;
}

export function activeDiscipline(): Discipline {
  if (pinnedDir()) return { ...ORIGINAL, name: "This library" };
  const reg = read();
  return reg.disciplines.find((d) => d.id === reg.active) ?? reg.disciplines[0];
}

/** Where a discipline's library lives. */
export function dirOfDiscipline(d: Discipline): string {
  const pinned = pinnedDir();
  if (pinned) return pinned;
  return d.dir ? path.join(rootDir(), d.dir) : rootDir();
}

/** The folder the database, the sources and the covers of the open discipline are in. */
export function activeDir(): string {
  return dirOfDiscipline(activeDiscipline());
}

/** Letters, digits and dashes: it becomes a folder name. */
export function slugOf(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || `discipline-${Date.now().toString(36)}`;
}

/**
 * Starts a new discipline. Its folder is made straight away and is empty: a
 * library with nothing in it, which is what a new subject is.
 */
export function addDiscipline(name: string): Discipline {
  if (pinnedDir()) throw new Error("This copy is pointed at a single library.");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the discipline a name.");
  const reg = read();
  if (reg.disciplines.some((d) => d.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`There is already a discipline called “${trimmed}”.`);
  }
  let id = slugOf(trimmed);
  while (reg.disciplines.some((d) => d.id === id)) id = `${id}-2`;

  const made: Discipline = {
    id,
    name: trimmed,
    dir: path.join("disciplines", id),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(rootDir(), made.dir!), { recursive: true });
  // The registry is written with the original in it, so a library that
  // predates any of this is named and kept rather than being lost the first
  // time a second discipline is made.
  write({ active: reg.active, disciplines: [...reg.disciplines, made] });
  return made;
}

export function renameDiscipline(id: string, name: string): Discipline[] {
  if (pinnedDir()) throw new Error("This copy is pointed at a single library.");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the discipline a name.");
  const reg = read();
  const found = reg.disciplines.find((d) => d.id === id);
  if (!found) throw new Error("No such discipline.");
  found.name = trimmed;
  write(reg);
  return reg.disciplines;
}

/**
 * Marks a discipline as the one to open.
 *
 * It does not switch anything by itself, and cannot: the database, the
 * worker and every path in the process were settled when it started. The
 * server exits with SWITCH_EXIT afterwards and the launcher starts it again
 * on the new folder — a new process, which is the whole guarantee. Nothing
 * of the old discipline can survive in a connection or a cache, because
 * there is no old process left to hold it.
 */
export function chooseDiscipline(id: string): Discipline {
  if (pinnedDir()) throw new Error("This copy is pointed at a single library.");
  const reg = read();
  const found = reg.disciplines.find((d) => d.id === id);
  if (!found) throw new Error("No such discipline.");
  write({ active: id, disciplines: reg.disciplines });
  return found;
}

/**
 * What the server exits with to ask the launcher for a restart on the
 * discipline just chosen. Anything else is a crash and is reported as one,
 * so this has to be a number nothing else uses.
 */
export const SWITCH_EXIT = 7;

/** Removes a discipline from the registry. The folder and its library stay. */
export function forgetDiscipline(id: string): Discipline[] {
  if (pinnedDir()) throw new Error("This copy is pointed at a single library.");
  const reg = read();
  if (reg.disciplines.length <= 1) throw new Error("There is only one discipline.");
  if (id === reg.active) throw new Error("Open another discipline first.");
  const left = reg.disciplines.filter((d) => d.id !== id);
  write({ active: reg.active, disciplines: left });
  return left;
}
