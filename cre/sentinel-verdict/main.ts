import { EVMClient, Runner, getNetwork, handler, hexToBase64 } from "@chainlink/cre-sdk";
import { onLiquidation, type Config } from "./handler";
import { LIQUIDATION_TOPIC } from "./position";

function initWorkflow(config: Config) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.readChain });
  if (!network) throw new Error(`unknown chain: ${config.readChain}`);

  return [
    handler(
      new EVMClient(network.chainSelector.selector).logTrigger({
        addresses: config.markets.map((m) => hexToBase64(m.pool)),
        topics: [{ values: [hexToBase64(LIQUIDATION_TOPIC)] }],
        confidence: config.confidence,
      }),
      onLiquidation,
    ),
  ];
}

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
