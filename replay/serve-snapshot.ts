/**
 * Serves the committed off-chain snapshot to the workflow's HTTP capability during replay,
 * because a historical price cannot be fetched live. Binds to localhost and serves one file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const body = readFileSync(join(import.meta.dir, "data", "offchain-prices.json"));

Bun.serve({
  hostname: "127.0.0.1",
  port: 8787,
  fetch: (req) =>
    new URL(req.url).pathname === "/offchain-prices.json"
      ? new Response(body, { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 }),
});
console.log("serving replay/data/offchain-prices.json on http://127.0.0.1:8787");
