/**
 * Writes cre/sentinel-verdict/config.<target>.json. Market addresses come from the cached
 * on-chain reads and the vault from deployments/<target>.json, so nothing is typed by hand.
 * Run: bun replay/gen-cre-config.ts <fork|sepolia>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../cre/sentinel-verdict/verdict";
import { CHAINLINK_STETH_ETH_FEED, WETH, WSTETH } from "./onchain";
import { TWAP_WINDOW_SEC, UNISWAP_POOL, type EventReads } from "./reads";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ZERO = "0x0000000000000000000000000000000000000000";
const root = join(import.meta.dir, "..");

const reads = JSON.parse(readFileSync(join(import.meta.dir, "data", "incident-reads.json"), "utf8")) as EventReads[];
const markets = [...new Map(reads.map((r) => [r.pool, r])).values()].map((r) => ({
  name: r.market, pool: r.pool, oracle: r.oracle, aToken: r.aToken, debtToken: r.debtToken,
}));

for (const target of process.argv.slice(2).length ? process.argv.slice(2) : ["fork", "sepolia"]) {
  const deployment = join(root, "deployments", `${target}.json`);
  const vault = existsSync(deployment) ? (JSON.parse(readFileSync(deployment, "utf8")) as { vault: string }).vault : ZERO;
  const config = {
    readChain: "ethereum-mainnet",
    writeChain: target === "fork" ? "ethereum-mainnet" : "ethereum-testnet-sepolia",
    vault,
    // Sepolia's gas schedule costs far more than the fork's: 740,498 at most for onReport and
    // about 850,000 through the forwarder, by node estimate, against 216,575 on the fork.
    gasLimit: target === "fork" ? "500000" : "1500000",
    confidence: "CONFIDENCE_LEVEL_SAFE",
    wstEth: WSTETH,
    weth: WETH,
    multicall3: MULTICALL3,
    chainlinkStEthEth: CHAINLINK_STETH_ETH_FEED,
    uniswapPool: UNISWAP_POOL,
    twapWindowSec: TWAP_WINDOW_SEC,
    markets,
    offchain: {
      mode: "snapshot",
      snapshotUrl: "http://127.0.0.1:8787/offchain-prices.json",
      liveUrl: `https://coins.llama.fi/prices/historical/{timestamp}/ethereum:${WSTETH},ethereum:${WETH}?searchWidth=1h`,
    },
    engine: {
      name: DEFAULT_CONFIG.name,
      tauBps: DEFAULT_CONFIG.tauBps.toString(),
      muBps: DEFAULT_CONFIG.muBps.toString(),
      epsOutBps: DEFAULT_CONFIG.epsOutBps.toString(),
      epsHBps: DEFAULT_CONFIG.epsHBps.toString(),
      minSources: DEFAULT_CONFIG.minSources,
      maxStalenessSec: DEFAULT_CONFIG.maxStalenessSec.toString(),
    },
  };
  writeFileSync(join(root, "cre", "sentinel-verdict", `config.${target}.json`), JSON.stringify(config, null, 2) + "\n");
  console.log(`wrote config.${target}.json, vault ${vault}`);
}
