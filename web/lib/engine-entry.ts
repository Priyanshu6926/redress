/** The browser bundle for the Glitch Simulator: the real engine, plus the simulated vault rules. */
export { PRESETS, SIM_ADAPTER, defaultScenario, parseWad, presetScenario, runIncident, settle, simulate } from "./scenario";
export { DEFAULT_VAULT, VaultRevert, VaultSim, deriveRedress } from "./vault-sim";
export { DEFAULT_CONFIG, VerdictType } from "../../cre/sentinel-verdict/verdict";
