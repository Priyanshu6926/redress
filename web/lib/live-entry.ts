/**
 * The browser bundle for the Live Demo. It runs the real engine on a real Sepolia liquidation and
 * encodes the result as the report RedressVault decodes. Everything is pure: the page sends it.
 */
import { concatHex, decodeEventLog, encodeFunctionData, getAddress, pad, parseAbi, toHex, type Address, type Hex } from "viem";
import { encodeReport } from "../../cre/sentinel-verdict/report";
import { INCONCLUSIVE } from "../../cre/sentinel-verdict/verdict";
import { defaultScenario, factsFor, prices, review, type Review } from "./scenario";

const HEADER_LENGTH = 109;

export const poolAbi = parseAbi([
  "function open() payable returns (uint256)",
  "function glitch(uint256 id, uint256 severityBps)",
  "function liquidate(uint256 id)",
  "function close(uint256 id)",
  "function healthFactor(uint256 id) view returns (uint256)",
  "function equity(uint256 id) view returns (uint256)",
  "function positions(uint256 id) view returns (address owner, uint256 collateral, uint256 debt, uint256 oraclePrice, bool closed)",
  "event PositionOpened(uint256 indexed id, address indexed owner, uint256 deposit, uint256 collateral, uint256 debt)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  "event PositionClosed(uint256 indexed id, address indexed owner, uint256 returned)",
]);

export const vaultAbi = parseAbi([
  "event Paid(bytes32 indexed liquidationTx, address indexed user, address asset, uint256 amount, uint8 source)",
  "event Queued(bytes32 indexed liquidationTx, uint32 logIndex, address indexed user, uint256 amount)",
  "event Attested(bytes32 indexed liquidationTx, uint32 logIndex, address indexed user, uint8 verdict, uint256 redress, bytes32 evidenceHash)",
]);

const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);

export const call = {
  open: () => encodeFunctionData({ abi: poolAbi, functionName: "open" }),
  glitch: (id: bigint, bps: bigint) => encodeFunctionData({ abi: poolAbi, functionName: "glitch", args: [id, bps] }),
  liquidate: (id: bigint) => encodeFunctionData({ abi: poolAbi, functionName: "liquidate", args: [id] }),
  close: (id: bigint) => encodeFunctionData({ abi: poolAbi, functionName: "close", args: [id] }),
  healthFactor: (id: bigint) => encodeFunctionData({ abi: poolAbi, functionName: "healthFactor", args: [id] }),
  equity: (id: bigint) => encodeFunctionData({ abi: poolAbi, functionName: "equity", args: [id] }),
  positions: (id: bigint) => encodeFunctionData({ abi: poolAbi, functionName: "positions", args: [id] }),
};

type RawLog = { address: string; topics: Hex[]; data: Hex; logIndex: string };

/** Decodes a receipt's logs for one contract, keeping each log's real index. */
export function eventsFrom(logs: RawLog[], address: string, abi: typeof poolAbi | typeof vaultAbi) {
  return logs.flatMap((l) => {
    if (l.address.toLowerCase() !== address.toLowerCase()) return [];
    try {
      const e = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return [{ name: e.eventName as string, args: e.args as Record<string, unknown>, logIndex: Number(l.logIndex) }];
    } catch {
      return [];
    }
  });
}

export interface LiquidationFacts {
  tx: Hex;
  logIndex: number;
  blockNumber: bigint;
  user: Address;
  liquidator: Address;
  builder: Address;
  adapter: Address;
  debtAsset: Address;
  oracle: bigint;
  /** The position just before the liquidation. */
  collateral: bigint;
  debt: bigint;
  seized: bigint;
  repaid: bigint;
}

export interface Judgement {
  review: Review;
  data: Hex;
}

/**
 * Real engine, real liquidation. Only the independent sources are synthetic, because Sepolia has
 * no wstETH market: they sit around the true price, with the simulator's default noise.
 */
export function judge(f: LiquidationFacts, forwarderReceiver: Address, executionId: bigint): Judgement {
  const s = { ...defaultScenario(), collateral: f.collateral, debt: f.debt };
  const p = prices(s);
  const facts = { ...factsFor(s, f.oracle, s.truePrice, p.lido, p.twap, f.repaid, f.seized), logIndex: f.logIndex };
  const offchain = [{ name: "off-chain (synthetic)", timestamp: facts.timestamp, price: p.offchain!.toString() }];
  const r = review(facts, offchain, { label: "Live Sepolia liquidation", synthetic: false, tx: f.tx, user: f.user, liquidator: f.liquidator, builder: f.builder, adapter: f.adapter });

  const band = r.assessment.band;
  const report = encodeReport({
    liquidationTx: f.tx,
    logIndex: f.logIndex,
    blockNumber: f.blockNumber,
    user: getAddress(f.user),
    collateralAsset: "0x0000000000000000000000000000000000000001",
    debtAsset: getAddress(f.debtAsset),
    debtToCover: r.report.debtToCover,
    collateralSeized: r.report.collateralSeized,
    bandLowE18: r.report.bandLowE18,
    bandHighE18: r.report.bandHighE18,
    debtPriceHighE18: r.report.debtPriceHighE18,
    liquidationBonusBps: r.report.liquidationBonusBps,
    verdict: r.report.verdict,
    sourceCount: band === INCONCLUSIVE ? 0 : band.collateral.n,
    redress: r.report.redress,
    evidenceHash: r.evidence as Hex,
    oracleAdapter: getAddress(f.adapter),
    liquidator: getAddress(f.liquidator),
    builder: getAddress(f.builder),
  });
  const raw = concatHex([pad(toHex(executionId), { size: 33 }), pad("0x", { size: HEADER_LENGTH - 33 }), report]);
  return { review: r, data: encodeFunctionData({ abi: forwarderAbi, functionName: "report", args: [forwarderReceiver, raw, "0x", []] }) };
}

export function decodePosition(data: Hex) {
  const word = (i: number) => `0x${data.slice(2 + i * 64, 66 + i * 64)}`;
  return { owner: getAddress(`0x${word(0).slice(-40)}`), collateral: BigInt(word(1)), debt: BigInt(word(2)), oraclePrice: BigInt(word(3)), closed: BigInt(word(4)) === 1n };
}
