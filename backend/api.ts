/**
 * Serves the frontend and its data. Lookups and the explorer read Arkiv first and fall back to
 * replay.json, and every response says which one answered.
 *
 *   bun backend/api.ts   then open http://localhost:3001
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { filterRows, jsonSource, lookup, type LiquidationRow } from "../web/lib/lookup";
import { arkivReader, arkivSource, explore, withFallback, type ExplorerFilter } from "./arkiv";

const root = join(import.meta.dir, "..");
const webDir = join(root, "web", "public");
const read = <T>(...path: string[]) => JSON.parse(readFileSync(join(root, ...path), "utf8")) as T;
const optional = <T>(...path: string[]): T | null => (existsSync(join(root, ...path)) ? read<T>(...path) : null);

const replay = read<{ liquidations: LiquidationRow[] } & Record<string, unknown>>("replay", "out", "replay.json");
const local = jsonSource(replay);
const arkivState = optional<{ writer: string; entities: Record<string, string>; txs: string[] }>("replay", "out", "arkiv.json");
const owner = arkivState?.writer;
const reader = arkivReader();

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const number = (v: string | null) => (v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

function staticFile(pathname: string): Response {
  const clean = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^([/\\])+/, "");
  const file = join(webDir, clean);
  if (!file.startsWith(webDir) || !existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/replay") return json(replay);
  if (path === "/api/deployments") return json(read("deployments", "sepolia.json"));
  if (path === "/api/mirror") return json(optional("replay", "out", "mirror-sepolia.json") ?? { rows: [] });
  if (path === "/api/live") return json(optional("replay", "out", "live.json") ?? { events: [] });
  if (path === "/api/controls") return json(optional("replay", "out", "controls.json") ?? { controls: [] });
  if (path === "/api/arkiv") return json({ writer: owner ?? null, entities: Object.keys(arkivState?.entities ?? {}).length, txs: arkivState?.txs.length ?? 0 });

  if (path.startsWith("/api/lookup/")) {
    const address = decodeURIComponent(path.slice("/api/lookup/".length));
    const served = await withFallback(() => lookup(arkivSource(reader, owner), address), () => lookup(local, address));
    return json(served);
  }

  if (path === "/api/verdicts") {
    const q = url.searchParams;
    const filter: ExplorerFilter = {
      verdict: q.get("verdict") || undefined,
      minMilliEth: number(q.get("minMilliEth")),
      maxMilliEth: number(q.get("maxMilliEth")),
      fromBlock: number(q.get("fromBlock")),
      toBlock: number(q.get("toBlock")),
    };
    return json(await withFallback(() => explore(reader, filter, owner), async () => filterRows(replay.liquidations, filter)));
  }

  if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
  return staticFile(path);
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3001);
  Bun.serve({ port, fetch: route });
  console.log(`Redress on http://localhost:${port}`);
}
