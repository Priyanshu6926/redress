/**
 * Builds the free static site into web/dist. No server is needed: the browser reads Arkiv itself
 * and falls back to the JSON published beside the page.
 *
 *   bun web/build.ts
 *
 * The output is public. The access key is compiled out, and the build fails if any value from
 * .env reaches it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(import.meta.dir, "dist");
const read = <T>(...path: string[]) => JSON.parse(readFileSync(join(root, ...path), "utf8")) as T;

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "data"), { recursive: true });

for (const file of ["style.css", "app.js"]) copyFileSync(join(import.meta.dir, "public", file), join(dist, file));
const html = readFileSync(join(import.meta.dir, "public", "index.html"), "utf8");
writeFileSync(join(dist, "index.html"), html.replace("<script src=\"app.js\"", "<script>window.REDRESS_STATIC = true;</script>\n  <script src=\"app.js\""));
writeFileSync(join(dist, ".nojekyll"), "");

const data: Record<string, string> = {
  "replay.json": "replay/out/replay.json",
  "mirror.json": "replay/out/mirror-sepolia.json",
  "live.json": "replay/out/live.json",
  "controls.json": "replay/out/controls.json",
  "deployments.json": "deployments/sepolia.json",
};
for (const [name, source] of Object.entries(data)) copyFileSync(join(root, source), join(dist, "data", name));

const arkiv = read<{ writer: string; entities: Record<string, string>; txs: string[] }>("replay", "out", "arkiv.json");
writeFileSync(join(dist, "data", "arkiv.json"), JSON.stringify({ writer: arkiv.writer, entities: Object.keys(arkiv.entities).length, txs: arkiv.txs.length }));

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "lib", "static-client.ts")],
  outdir: dist,
  naming: "arkiv-client.js",
  target: "browser",
  format: "esm",
  minify: true,
  define: { "process.env.ARKIV_ACCESS_KEY": '""', "process.env.NODE_ENV": '"production"' },
});
if (!built.success) throw new Error(built.logs.join("\n"));

/** Every file in the output, for the secret scan. */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

const envPath = join(root, ".env");
const secrets = existsSync(envPath)
  ? [...readFileSync(envPath, "utf8").matchAll(/^([A-Z0-9_]+)=(\S+)/gm)].map((m) => ({ name: m[1]!, value: m[2]! })).filter((s) => s.value.length > 8)
  : [];
const files = walk(dist);
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const s of secrets) if (text.includes(s.value)) throw new Error(`refusing to publish: ${s.name} found in ${file}`);
}
console.log(`built ${files.length} files in web/dist, checked against ${secrets.length} secrets`);
