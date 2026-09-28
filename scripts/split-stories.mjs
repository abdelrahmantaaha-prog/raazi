// Repairs story grouping built by older rules. Run with Corpus stopped.
//
//   node node_modules/tsx/dist/cli.mjs scripts/split-stories.mjs
//     takes apart the stories that grew past one event (splitRunaways)
//   node node_modules/tsx/dist/cli.mjs scripts/split-stories.mjs --since 2026-09-14
//     files every story Corpus opened since that day again (rebuildStories)
//
// Stories you named or pinned are left alone either way.
const stories = await import("../lib/stories.ts");
const { db } = await import("../lib/db/index.ts");

const at = process.argv.indexOf("--since");
const since = at > 0 ? process.argv[at + 1] : null;
const before = db().prepare("SELECT COUNT(*) AS n FROM stories").get().n;
const result = since ? stories.rebuildStories(since) : stories.splitRunaways();
const after = db().prepare("SELECT COUNT(*) AS n FROM stories").get().n;
console.log(JSON.stringify({ ...result, storiesBefore: before, storiesAfter: after }));
db().close();
