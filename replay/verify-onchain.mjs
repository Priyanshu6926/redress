/**
 * PRD section 17: checks every on-chain [VERIFY] item and writes
 * replay/data/verification-report.txt. Run with `bun run verify`.
 *
 * PASS  chain agrees with the PRD       DIFF  chain differs: reported, never tuned away
 * INFO  value read for the record       SKIP  could not be checked here
 * FAIL  a read or an invariant failed (exit code 1)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import {
  CHAINLINK_STETH_ETH_FEED, CORE_PROVIDER, EXECUTION_TX, SCAN_AFTER, SCAN_BEFORE, SUBMISSION_TX, UNISWAP_V3_FACTORY, WETH, WSTETH,
  borrowCapChanged, collectLiquidations, erc20Abi, factoryAbi, fmt18, makeClient, oracleAbi, poolAbi,
  resolveMarkets, scanRange, summarize, v3PoolAbi, wstEthAbi,
} from "./onchain.ts";

const lines = [];
let failed = 0;
const log = (s = "") => { console.log(s); lines.push(s); };
const check = (status, name, detail = "") => {
  if (status === "FAIL") failed++;
  log(`[${status}] ${name}${detail ? ": " + detail : ""}`);
};
const within = (got, want, pct) => Math.abs(got - want) / want <= pct / 100;
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
const num = (v) => Number(fmt18(v, 6));

const c = makeClient();

log("Redress on-chain verification report");
log(`chain id: ${await c.getChainId()}`);
log("");

log("== Incident transactions");
const sub = await c.getTransactionReceipt({ hash: SUBMISSION_TX });
const exec = await c.getTransactionReceipt({ hash: EXECUTION_TX });
const B = exec.blockNumber;
const execBlock = await c.getBlock({ blockNumber: B });
const subBlock = await c.getBlock({ blockNumber: sub.blockNumber });
const iso = (b) => new Date(Number(b.timestamp) * 1000).toISOString();
check(sub.status === "success" ? "PASS" : "FAIL", "submission tx", `block ${sub.blockNumber}, ${iso(subBlock)}`);
check(exec.status === "success" ? "PASS" : "FAIL", "execution tx", `block ${B}, tx index ${exec.transactionIndex}, ${iso(execBlock)}`);
check(B === sub.blockNumber + 1n ? "PASS" : "DIFF", "execution follows submission by one block");
log(`[INFO] fork block (execution - 1): ${B - 1n}`);
log("");

log("== Aave markets (registry at the execution block)");
const markets = await resolveMarkets(c, B);
for (const m of markets) log(`[INFO] ${m.name}: provider ${m.provider} pool ${m.pool} oracle ${m.oracle} configurator ${m.configurator}`);
const core = markets.find((m) => eq(m.provider, CORE_PROVIDER));
check(core ? "PASS" : "FAIL", "Core market resolved", core?.pool);
log("");

log("== Liquidations");
const from = B - SCAN_BEFORE, to = B + SCAN_AFTER;
const all = await collectLiquidations(c, markets, from, to, B - 1n);
log(`[INFO] scanned blocks ${from}-${to}, all markets: ${all.length} wstETH-collateral liquidations`);
const pools = [...new Set(all.map((l) => l.market))];
const prime = markets.find((m) => m.pool === all.find((l) => !eq(l.pool, core.pool))?.pool);
check(prime ? "PASS" : "DIFF", "Prime market identified from incident logs", prime ? `${prime.name}: ${prime.pool}` : "no non-Core liquidations");
log(`[INFO] markets with liquidations: ${pools.join(", ")}`);
const before = all.filter((l) => BigInt(l.blockNumber) < B || (BigInt(l.blockNumber) === B && l.transactionIndex < exec.transactionIndex));
log(`[INFO] wstETH liquidations before the execution tx in the scan window: ${before.length}`);

log("");
log("== Containment (CAPO adapters and borrow caps)");
const adapters = [];
for (const m of [core, prime].filter(Boolean)) {
  const a = await c.readContract({ address: m.oracle, abi: oracleAbi, functionName: "getSourceOfAsset", args: [WSTETH], blockNumber: B });
  adapters.push(a);
  log(`[INFO] ${m.name} wstETH price source: ${a}`);
}
const adapterLogs = await scanRange(B, to, (fromBlock, toBlock) => c.getLogs({ address: [...new Set(adapters)], fromBlock, toBlock }));
for (const l of adapterLogs) log(`[INFO] adapter log: block ${l.blockNumber} ${l.address} tx ${l.transactionHash} topic ${l.topics[0].slice(0, 10)}`);
const realign = adapterLogs.find((l) => l.blockNumber > B);
check(realign ? "PASS" : "DIFF", "realignment found after execution", realign ? `block ${realign.blockNumber}, tx ${realign.transactionHash}` : "no later adapter log in the scan window");
const caps = await scanRange(B, to, (fromBlock, toBlock) =>
  c.getLogs({ address: [core, prime].filter(Boolean).map((m) => m.configurator), event: borrowCapChanged, fromBlock, toBlock }));
for (const l of caps) log(`[INFO] borrow cap: block ${l.blockNumber} asset ${l.args.asset} ${l.args.oldBorrowCap} -> ${l.args.newBorrowCap} tx ${l.transactionHash}`);
const capTx = caps.find((l) => l.transactionHash.startsWith("0x34f568b2"));
check(capTx ? "PASS" : "DIFF", "borrow cap tx completes 0x34f568b2", capTx?.transactionHash ?? "no match");
log("");

log("== Incident totals (execution tx onward, wstETH collateral, WETH debt)");
const endBlock = realign ? Number(realign.blockNumber) : Number(to);
const inc = all.filter((l) => eq(l.debtAsset, WETH) && !before.includes(l) && l.blockNumber <= endBlock);
const other = all.filter((l) => !eq(l.debtAsset, WETH) && !before.includes(l) && l.blockNumber <= endBlock);
const s = summarize(inc);
log(`[INFO] window: blocks ${B}-${endBlock}, ${s.count} liquidation events`);
for (const name of pools) { const p = summarize(inc.filter((l) => l.market === name)); log(`[INFO] ${name}: ${p.count} events, ${p.users} users, ${fmt18(p.collateralSeized)} wstETH`); }
check(s.users === 34 ? "PASS" : "DIFF", "distinct users vs PRD 34", String(s.users));
check(within(num(s.collateralSeized), 10938, 1) ? "PASS" : "DIFF", "wstETH seized vs PRD ~10,938", fmt18(s.collateralSeized));
log(`[INFO] WETH debt repaid: ${fmt18(s.debtCovered)}`);
check(within(num(s.netLossAtLidoRate), 512.19, 2) ? "PASS" : "DIFF", "rough net loss at raw Lido rate vs DAO 512.19 ETH (1 stETH = 1 ETH, not a verdict)", `${fmt18(s.netLossAtLidoRate)} ETH`);
for (const l of other) log(`[INFO] other debt asset in window: ${l.debtAsset} user ${l.user} block ${l.blockNumber} tx ${l.txHash}`);
const ONE = 10n ** 18n;
const perMarket = new Set(inc.map((l) => `${l.pool}:${l.user}`.toLowerCase())).size;
check(perMarket === 34 ? "PASS" : "DIFF", "distinct (market, user) positions vs PRD 34", String(perMarket));
const inMarket = (name) => new Set(inc.filter((l) => l.market === name).map((l) => l.user.toLowerCase()));
const [ma, mb] = pools.map(inMarket);
log(`[INFO] addresses liquidated in both markets: ${[...(ma ?? [])].filter((u) => mb?.has(u)).join(", ") || "none"}`);
const wethUsers = new Set(inc.map((l) => l.user.toLowerCase()));
for (const l of other) log(`[INFO] other-debt user ${l.user} also has a WETH-debt liquidation: ${wethUsers.has(l.user.toLowerCase())}; seized ${fmt18(BigInt(l.collateralSeized))} wstETH`);
const fee = inc.reduce((a, l) => a + BigInt(l.protocolFeeCollateral), 0n);
const feeEth = inc.reduce((a, l) => a + (BigInt(l.protocolFeeCollateral) * BigInt(l.stEthPerToken)) / ONE, 0n);
log(`[INFO] protocol fee taken in collateral (aToken transfers to treasury): ${fmt18(fee)} wstETH = ${fmt18(feeEth)} ETH at the Lido rate; events with a fee: ${inc.filter((l) => l.protocolFeeCollateral !== "0").length} of ${inc.length}`);
check(within(num(feeEth), 13.32, 2) ? "PASS" : "DIFF", "protocol fee vs DAO 13.32 ETH fees", `${fmt18(feeEth)} ETH`);
const lossGross = s.netLossAtLidoRate + feeEth;
check(within(num(lossGross), 512.19, 2) ? "PASS" : "DIFF", "rough net loss including protocol fee vs DAO 512.19 ETH (1 stETH = 1 ETH, not a verdict)", `${fmt18(lossGross)} ETH`);
const unhealthy = inc.filter((l) => BigInt(l.preGlitchHealthFactor) < ONE);
check(unhealthy.length === 0 ? "PASS" : "DIFF", "every position healthy just before the execution block", `${unhealthy.length} of ${inc.length} events below HF 1`);
const hfs = inc.map((l) => BigInt(l.preGlitchHealthFactor)).sort((a, b) => (a < b ? -1 : 1));
log(`[INFO] pre-glitch HF range: ${fmt18(hfs[0], 4)} to ${fmt18(hfs[hfs.length - 1], 4)}; above the PRD ~1.0288: ${hfs.filter((h) => h > 1028800000000000000n).length}`);
for (const l of inc.filter((x) => x.pre.eModeId === 0)) log(`[INFO] non-E-Mode event: ${l.market} user ${l.user} block ${l.blockNumber} tx ${l.txHash} pre-glitch HF ${fmt18(BigInt(l.preGlitchHealthFactor), 4)} HF at block-1 ${fmt18(BigInt(l.pre.healthFactor), 4)} seized ${fmt18(BigInt(l.collateralSeized))} wstETH`);
for (const prefix of ["0x9064b507f", "0x7872defde"]) {
  const m = inc.find((l) => l.txHash.startsWith(prefix));
  check(m ? "PASS" : "DIFF", `large liquidation completes ${prefix}`, m?.txHash ?? "no match");
}
log("");

log("== E-Mode (read at the execution block)");
const seen = new Set();
for (const l of inc) {
  const key = `${l.pool}:${l.pre.eModeId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const n = inc.filter((x) => x.pool === l.pool && x.pre.eModeId === l.pre.eModeId).length;
  if (l.pre.eModeId === 0) { log(`[INFO] ${l.market} no E-Mode: ${n} events`); continue; }
  const cfg = await c.readContract({ address: l.pool, abi: poolAbi, functionName: "getEModeCategoryCollateralConfig", args: [l.pre.eModeId], blockNumber: B });
  const label = await c.readContract({ address: l.pool, abi: poolAbi, functionName: "getEModeCategoryLabel", args: [l.pre.eModeId], blockNumber: B });
  log(`[INFO] ${l.market} category ${l.pre.eModeId} "${label}": ltv ${cfg.ltv} LT ${cfg.liquidationThreshold} bonus ${cfg.liquidationBonus} (${n} events)`);
  check(cfg.liquidationBonus === 10100 ? "PASS" : "DIFF", `${l.market} category ${l.pre.eModeId} bonus vs PRD 1%`, `raw ${cfg.liquidationBonus}`);
  check(cfg.liquidationThreshold === 9550 ? "PASS" : "DIFF", `${l.market} category ${l.pre.eModeId} LT vs PRD Appendix A assumed 95.5%`, `raw ${cfg.liquidationThreshold}`);
}
log("");

log("== Rates at the execution block");
const rate = await c.readContract({ address: WSTETH, abi: wstEthAbi, functionName: "stEthPerToken", blockNumber: B });
check(within(num(rate), 1.2288, 0.05) ? "PASS" : "DIFF", "stEthPerToken vs PRD ~1.2288", fmt18(rate, 6));
for (const m of [core, prime].filter(Boolean)) {
  const [pc, pd] = await Promise.all([WSTETH, WETH].map((asset) => c.readContract({ address: m.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [asset], blockNumber: B })));
  const ratio = (pc * 10n ** 18n) / pd;
  check(within(num(ratio), 1.193957, 0.05) ? "PASS" : "DIFF", `${m.name} oracle wstETH/WETH vs PRD 1.193957`, fmt18(ratio, 6));
}
log("");

log("== Uniswap v3 wstETH/WETH pools at the execution block");
let deepest;
for (const fee of [100, 500, 3000, 10000]) {
  const pool = await c.readContract({ address: UNISWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [WSTETH, WETH, fee], blockNumber: B });
  if (/^0x0+$/.test(pool)) { log(`[INFO] fee ${fee}: no pool`); continue; }
  const [liquidity, wst, weth] = await Promise.all([
    c.readContract({ address: pool, abi: v3PoolAbi, functionName: "liquidity", blockNumber: B }),
    c.readContract({ address: WSTETH, abi: erc20Abi, functionName: "balanceOf", args: [pool], blockNumber: B }),
    c.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [pool], blockNumber: B }),
  ]);
  log(`[INFO] fee ${fee}: ${pool} liquidity ${liquidity} wstETH ${fmt18(wst, 2)} WETH ${fmt18(weth, 2)}`);
  if (!deepest || liquidity > deepest.liquidity) deepest = { pool, fee, liquidity };
}
check(deepest ? "PASS" : "FAIL", "deepest pool by in-range liquidity", deepest && `${deepest.pool} (fee ${deepest.fee})`);
if (deepest) {
  try {
    const [ticks] = await c.readContract({ address: deepest.pool, abi: v3PoolAbi, functionName: "observe", args: [[1800, 0]], blockNumber: B });
    const tick = Number(ticks[1] - ticks[0]) / 1800;
    check("PASS", "30-minute TWAP readable", `mean tick ${tick}, wstETH/WETH ${Math.pow(1.0001, tick).toFixed(6)}`);
  } catch (e) {
    check("DIFF", "30-minute TWAP readable", e.shortMessage ?? e.message);
  }
}
log("");

log("== Chainlink stETH/ETH feed");
const desc = await c.readContract({ address: CHAINLINK_STETH_ETH_FEED, abi: parseAbi(["function description() view returns (string)"]), functionName: "description", blockNumber: B });
check(/steth\s*\/\s*eth/i.test(desc) ? "PASS" : "FAIL", "feed description", `${CHAINLINK_STETH_ETH_FEED}: ${desc}`);
log("");

log("== Etherscan cross-check");
const key = process.env.ETHERSCAN_API_KEY;
if (key) {
  let n = 0;
  for (const m of [core, prime].filter(Boolean)) {
    const q = new URLSearchParams({ chainid: "1", module: "logs", action: "getLogs", fromBlock: String(from), toBlock: String(to), address: m.pool,
      topic0: "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286", topic1: "0x" + WSTETH.slice(2).toLowerCase().padStart(64, "0"), topic0_1_opr: "and", apikey: key });
    const r = await (await fetch(`https://api.etherscan.io/v2/api?${q}`)).json();
    if (!Array.isArray(r.result)) { check("FAIL", "Etherscan logs", String(r.message)); continue; }
    n += r.result.length;
  }
  check(n === all.length ? "PASS" : "DIFF", "Etherscan log count vs RPC", `${n} vs ${all.length}`);
} else check("SKIP", "Etherscan logs", "ETHERSCAN_API_KEY not set; logs came from the RPC only");

log("");
log(failed ? `RESULT: ${failed} failed check(s)` : "RESULT: no failed checks (see DIFF lines for differences from the PRD)");
writeFileSync(join(import.meta.dir, "data", "verification-report.txt"), lines.join("\n") + "\n");
process.exit(failed ? 1 : 0);
