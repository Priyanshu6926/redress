/**
 * Fetches two off-chain wstETH/ETH series for every incident and control timestamp and
 * writes replay/data/offchain-prices.json, with URLs, fetch date and timestamps.
 *
 * Values are stored as fetched. Nothing is filtered here: a bad series must be caught by
 * the engine's outlier rejection, not by hand. `status` records what the sanity check found.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventReads } from "./reads";

const WSTETH = "ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const WETH = "ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const LLAMA = "https://coins.llama.fi/batchHistorical";
const GECKO = "https://api.coingecko.com/api/v3/coins/wrapped-steth/market_chart/range";
const GECKO_WINDOW_SEC = 80 * 86_400; // ranges under 90 days return hourly points
const GECKO_PUBLIC_LIMIT_SEC = 364 * 86_400;
const SANITY_LIMIT_BPS = 100;
const dataDir = join(import.meta.dir, "data");

interface Point {
  timestamp: number;
  price: number;
}
export interface Snapshot {
  name: string;
  timestamp: number;
  price: string;
  legs?: { wstEthUsd: number; wstEthTimestamp: number; wethUsd: number; wethTimestamp: number };
}

const toE18 = (v: number) => (BigInt(Math.round(v * 1e12)) * 10n ** 6n).toString();

function nearest(points: Point[], t: number): Point | undefined {
  let best: Point | undefined;
  for (const p of points) if (!best || Math.abs(p.timestamp - t) < Math.abs(best.timestamp - t)) best = p;
  return best;
}

/** Ratio of two USD legs, dated by the leg further from the target so staleness is never understated. Pure. */
export function llamaEntry(target: number, wst: Point[], weth: Point[]): Snapshot | undefined {
  const w = nearest(wst, target);
  const e = nearest(weth, target);
  if (!w || !e) return undefined;
  const timestamp = Math.abs(w.timestamp - target) >= Math.abs(e.timestamp - target) ? w.timestamp : e.timestamp;
  return {
    name: "defillama",
    timestamp,
    price: toE18(w.price / e.price),
    legs: { wstEthUsd: w.price, wstEthTimestamp: w.timestamp, wethUsd: e.price, wethTimestamp: e.timestamp },
  };
}

async function fetchLlama(stamps: number[]): Promise<Snapshot[]> {
  const coins = encodeURIComponent(JSON.stringify({ [WSTETH]: stamps, [WETH]: stamps }));
  const res = await fetch(`${LLAMA}?coins=${coins}&searchWidth=1h`);
  if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);
  const body = (await res.json()) as { coins: Record<string, { prices: Point[] }> };
  const wst = body.coins[WSTETH]?.prices ?? [];
  const weth = body.coins[WETH]?.prices ?? [];
  return stamps.flatMap((t) => llamaEntry(t, wst, weth) ?? []);
}

async function fetchGecko(stamps: number[], now: number): Promise<{ entries: Snapshot[]; outOfRange: number }> {
  const inRange = stamps.filter((t) => now - t < GECKO_PUBLIC_LIMIT_SEC).sort((a, b) => a - b);
  const entries = new Map<number, Snapshot>();
  for (let i = 0; i < inRange.length; ) {
    const from = inRange[i]! - 7200;
    const to = from + GECKO_WINDOW_SEC;
    const res = await fetch(`${GECKO}?vs_currency=eth&from=${from}&to=${to}`);
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const { prices } = (await res.json()) as { prices: [number, number][] };
    const points = prices.map(([ms, price]) => ({ timestamp: Math.floor(ms / 1000), price }));
    while (i < inRange.length && inRange[i]! < to - 7200) {
      const p = nearest(points, inRange[i]!);
      if (p) entries.set(p.timestamp, { name: "coingecko", timestamp: p.timestamp, price: toE18(p.price) });
      i++;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { entries: [...entries.values()], outOfRange: stamps.length - inRange.length };
}

/** Median absolute distance from the Lido rate, in basis points. Pure. */
export function medianGapBps(entries: Snapshot[], rateAt: (timestamp: number) => number): number {
  const gaps = entries.map((e) => Math.abs((Number(e.price) / 1e18 / rateAt(e.timestamp) - 1) * 10_000)).sort((a, b) => a - b);
  return gaps[gaps.length >> 1] ?? 0;
}

async function main() {
  const load = (f: string) => JSON.parse(readFileSync(join(dataDir, f), "utf8")) as EventReads[];
  const events = [...load("incident-reads.json"), ...load("control-reads.json")];
  const stamps = [...new Set(events.map((e) => e.timestamp))].sort((a, b) => a - b);
  const rateAt = (t: number) => {
    const nearestEvent = events.reduce((b, e) => (Math.abs(e.timestamp - t) < Math.abs(b.timestamp - t) ? e : b));
    return Number(nearestEvent.lidoRate) / 1e18;
  };

  const now = Math.floor(Date.now() / 1000);
  const llama = await fetchLlama(stamps);
  const gecko = await fetchGecko(stamps, now);
  const llamaGap = medianGapBps(llama, rateAt);
  const geckoGap = medianGapBps(gecko.entries, rateAt);
  const status = (gap: number) => (gap <= SANITY_LIMIT_BPS ? "ok" : "failed-sanity");

  const snapshot = {
    fetchedAt: new Date(now * 1000).toISOString(),
    requestedTimestamps: stamps.length,
    sources: [
      {
        name: "defillama",
        url: `${LLAMA}?coins={wstETH and WETH timestamps}&searchWidth=1h`,
        method: "wstETH USD divided by WETH USD, nearest sample to each event, dated by the leg further from the event",
        points: llama.length,
        medianGapToLidoBps: Number(llamaGap.toFixed(1)),
        status: status(llamaGap),
      },
      {
        name: "coingecko",
        url: `${GECKO}?vs_currency=eth&from=..&to=..`,
        method: "hourly wstETH price quoted in ETH, nearest sample to each event",
        points: gecko.entries.length,
        timestampsBeyondPublicApiLimit: gecko.outOfRange,
        medianGapToLidoBps: Number(geckoGap.toFixed(1)),
        status: status(geckoGap),
      },
    ],
    prices: [...llama, ...gecko.entries].sort((a, b) => a.timestamp - b.timestamp || a.name.localeCompare(b.name)),
  };
  writeFileSync(join(dataDir, "offchain-prices.json"), JSON.stringify(snapshot, null, 1) + "\n");
  console.log(JSON.stringify(snapshot.sources, null, 1));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  });
}
