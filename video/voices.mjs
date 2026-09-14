// Lists the Arabic voices Edge offers and reads one sample line in each
// candidate, with word timings, into out/voices/<voice>/.
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "out/voices");
fs.mkdirSync(OUT, { recursive: true });

const LINE =
  "كوربس موسوعةٌ تنمو مع مصادرك. كلُّ جملةٍ فيها تعود إلى اقتباسٍ في صفحةٍ محدَّدة، " +
  "وحين يصل كتابٌ جديد، تُراجِع المداخلُ نفسَها وتخبرك بما تغيَّر.";

const tts = new MsEdgeTTS();
const voices = await tts.getVoices();
const arabic = voices.filter((v) => v.Locale.startsWith("ar-"));
const multilingual = voices.filter((v) => /Multilingual/.test(v.ShortName));
console.log(`Arabic voices (${arabic.length}):`);
for (const v of arabic) console.log(`  ${v.ShortName.padEnd(28)} ${v.Gender}`);
console.log(`Multilingual voices (${multilingual.length}): ${multilingual.map((v) => v.ShortName).join(", ")}`);

const wanted = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["ar-SA-HamedNeural", "ar-SA-ZariyahNeural", "ar-EG-ShakirNeural", "ar-EG-SalmaNeural",
     "ar-AE-HamdanNeural", "ar-AE-FatimaNeural", "en-US-AndrewMultilingualNeural"];

for (const name of wanted) {
  if (!voices.some((v) => v.ShortName === name)) { console.log(`skip ${name}: not offered`); continue; }
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const tts = new MsEdgeTTS();
  await tts.setMetadata(name, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
  const { audioFilePath, metadataFilePath } = await tts.toFile(dir, LINE);
  tts.close();
  console.log(`${name}: ${fs.statSync(audioFilePath).size} bytes, metadata ${metadataFilePath ? "yes" : "no"}`);
}
