/**
 * The browser's data client for the static site. It reads Arkiv directly and falls back to the
 * published JSON, so the site needs no server. Built into arkiv-client.js by web/build.ts.
 */
import { arkivReader, arkivSource, explore, withFallback, type ExplorerFilter } from "../../backend/arkiv";
import { filterRows, jsonSource, lookup, type LiquidationRow } from "./lookup";

export function createClient(rows: LiquidationRow[], owner: string | undefined) {
  const reader = arkivReader();
  const local = jsonSource({ liquidations: rows });
  return {
    lookup: (address: string) => withFallback(() => lookup(arkivSource(reader, owner), address), () => lookup(local, address)),
    verdicts: (filter: ExplorerFilter) => withFallback(() => explore(reader, filter, owner), async () => filterRows(rows, filter)),
  };
}
