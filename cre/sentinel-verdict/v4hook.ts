/**
 * The optional v4Hook source. The demo pool is synthetic: we set its price and make its swaps,
 * so it is never market evidence and must never reach the incident replay. The rules that keep
 * it out live here, in code. See docs/HOOK_DESIGN.md.
 */
import type { Address } from "viem";
import { priceAtTick } from "./position";
import type { PriceSource } from "./verdict";

export const DEMO_ENGINE = "demo-v4hook";
export const HOOK_SOURCE_NAME = "S4 v4 hook (synthetic demo pool)";

export interface V4HookConfig {
  type: "v4Hook";
  chain: string;
  hook: Address;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  windowSec: number;
  minObservations: number;
  maxAgeSec: number;
  synthetic: true;
}

export interface HookBand {
  twapTick: number;
  minTick: number;
  maxTick: number;
  count: number;
  coveredSeconds: number;
  lastObservedAt: number;
}

/** Throws unless a hook source is confined to a labelled demo that cannot write. Pure. */
export function assertHookAllowed(cfg: { engine: { name: string }; dryRun?: boolean; v4Hook?: V4HookConfig }): void {
  const demo = cfg.engine.name === DEMO_ENGINE;
  if (cfg.v4Hook && !demo) throw new Error("v4Hook source is only allowed in the demo-v4hook config");
  if (cfg.v4Hook && cfg.v4Hook.synthetic !== true) throw new Error("v4Hook source must be marked synthetic");
  if (demo && !cfg.v4Hook) throw new Error("demo-v4hook config needs a v4Hook source");
  if (demo && cfg.dryRun !== true) throw new Error("demo-v4hook config must be a dry run");
}

/**
 * The hook's band as a price source, or null if it is too thin or too old. Pure.
 * The price is current, not historical, so it carries the event's timestamp only because the
 * engine's staleness check needs one. That is part of why this path is a labelled demo.
 */
export function hookSource(band: HookBand | undefined, nowSec: number, eventTimestamp: number, cfg: V4HookConfig): PriceSource | null {
  if (!band || band.count < cfg.minObservations || nowSec - band.lastObservedAt > cfg.maxAgeSec) return null;
  return { name: HOOK_SOURCE_NAME, price: priceAtTick(band.twapTick), timestamp: BigInt(eventTimestamp) };
}
