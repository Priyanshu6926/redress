/**
 * Writes cre/sentinel-verdict/config.<target>.json. Market addresses come from the cached
 * on-chain reads and the vault from deployments/<target>.json, so nothing is typed by hand.
 * Run: bun replay/gen-cre-config.ts <fork|sepolia>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../cre/sentinel-verdict/verdict";
import { DEMO_ENGINE } from "../cre/sentinel-verdict/v4hook";
import { CHAINLINK_STETH_ETH_FEED, WETH, WSTETH } from "./onchain";
import { TWAP_WINDOW_SEC, UNISWAP_POOL, type EventReads } from "./reads";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ZERO = "0x0000000000000000000000000000000000000000";
const root = join(import.meta.dir, "..");

const reads = JSON.parse(readFileSync(join(import.meta.dir, "data", "incident-reads.json"), "utf8")) as EventReads[];
const markets = [...new Map(reads.map((r) => [r.pool, r])).values()].map((r) => ({
  name: r.market, pool: r.pool, oracle: r.oracle, aToken: r.aToken, debtToken: r.debtToken,
}));

interface Deployment {
  vault: string;
  bandOracleHook?: string;
  hookPool?: { token0: string; token1: string; fee: number; tickSpacing: number };
}

/** The labelled demo: a synthetic pool as an extra source, and no write. See docs/HOOK_DESIGN.md. */
function demoFields(d: Deployment | undefined) {
  if (!d?.bandOracleHook || !d.hookPool) throw new Error("deploy the hook first: bash replay/deploy-hook.sh");
  return {
    dryRun: true,
    v4Hook: {
      type: "v4Hook",
      chain: "ethereum-testnet-sepolia",
      hook: d.bandOracleHook,
      poolKey: { currency0: d.hookPool.token0, currency1: d.hookPool.token1, fee: d.hookPool.fee, tickSpacing: d.hookPool.tickSpacing, hooks: d.bandOracleHook },
      windowSec: 1800,
      minObservations: 5,
      maxAgeSec: 3600,
      synthetic: true,
    },
  };
}

for (const target of process.argv.slice(2).length ? process.argv.slice(2) : ["fork", "sepolia", "demo-v4hook"]) {
  const demo = target === "demo-v4hook";
  const deployment = join(root, "deployments", `${demo ? "sepolia" : target}.json`);
  const deployed = existsSync(deployment) ? (JSON.parse(readFileSync(deployment, "utf8")) as Deployment) : undefined;
  const vault = demo ? ZERO : (deployed?.vault ?? ZERO);
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
      name: demo ? DEMO_ENGINE : DEFAULT_CONFIG.name,
      tauBps: DEFAULT_CONFIG.tauBps.toString(),
      muBps: DEFAULT_CONFIG.muBps.toString(),
      epsOutBps: DEFAULT_CONFIG.epsOutBps.toString(),
      epsHBps: DEFAULT_CONFIG.epsHBps.toString(),
      minSources: DEFAULT_CONFIG.minSources,
      maxStalenessSec: DEFAULT_CONFIG.maxStalenessSec.toString(),
    },
    ...(demo ? demoFields(deployed) : {}),
  };
  writeFileSync(join(root, "cre", "sentinel-verdict", `config.${target}.json`), JSON.stringify(config, null, 2) + "\n");
  console.log(`wrote config.${target}.json, vault ${vault}`);
}
