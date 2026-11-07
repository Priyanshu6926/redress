// The Glitch Simulator page. It only formats: every value and verdict comes from engine.js.
import { PRESETS, parseWad, presetScenario, runIncident, settle, simulate } from "./engine.js";

const $ = (id) => document.getElementById(id);
const WAD = 10n ** 18n;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STEP_MS = 600;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "—");

/** Fixed-point bigint to text, at the edge only. */
function fmt(v, places = 6) {
  const sign = v < 0n ? "−" : "";
  const a = v < 0n ? -v : v;
  return `${sign}${(a / WAD).toLocaleString("en-US")}.${(a % WAD).toString().padStart(18, "0").slice(0, places)}`;
}
const bps = (v) => {
  const a = v < 0n ? -v : v;
  return `${v < 0n ? "−" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}%`;
};
const raw = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

const line = (label, value, formula) => `<p><b>${esc(label)}:</b> <span>${value}</span>${formula ? `<span class="sim-f">${esc(formula)}</span>` : ""}</p>`;
const details = (o) => `<details><summary>Raw values</summary><pre>${esc(raw(o))}</pre></details>`;

/** Bar position for a health factor, from 0.9 to 1.1. */
function gauge(hf) {
  const low = (WAD * 9n) / 10n, span = WAD / 5n;
  const clamped = hf < low ? low : hf > low + span ? low + span : hf;
  const pct = ((clamped - low) * 100n) / span;
  return `<div class="sim-gauge ${hf < WAD ? "low" : ""}" role="img" aria-label="Health factor ${esc(fmt(hf, 4))}"><i style="width:${pct}%"></i><b style="left:50%"></b></div>`;
}
function bar(part, whole) {
  return `<div class="sim-bar"><i style="width:${whole === 0n ? 0n : (part * 100n) / whole}%"></i></div>`;
}

const REASONS = {
  VALID: "The position was unhealthy on independent prices too, so the liquidation stands.",
  WRONGFUL: "Healthy across the whole band, so the oracle caused this liquidation.",
  EXCESS: "The liquidation was allowed, but it took more than it was entitled to.",
  AMBIGUOUS: "The band straddles a health factor of 1, so only the provable excess is paid.",
  INCONCLUSIVE: "There are too few good sources to judge, so nothing is paid.",
  OVERPRICED: "The oracle was too high, which did not harm the borrower, so nothing is paid.",
};

const state = { sim: null, settled: null, tamper: false, shown: 0, timer: null, log: [] };
const cards = () => $("sim-cards").children;

function cardBefore(s) {
  const { scenario: c, hfTrue } = s;
  return card(1, "BEFORE", `
    ${line("Collateral", `${fmt(c.collateral, 2)} wstETH`)}
    ${line("Debt", `${fmt(c.debt, 2)} WETH`)}
    ${line("Price", `${fmt(c.truePrice)} WETH per wstETH`, "oracle price = true price")}
    ${line("Health factor", `${fmt(hfTrue, 4)} ${hfTrue >= WAD ? '<span class="sim-good">Healthy</span>' : '<span class="sim-bad">Unhealthy</span>'}`, `HF = C × price × LT / D = ${fmt(c.collateral, 2)} × ${fmt(c.truePrice)} × ${bps(c.ltBps)} / ${fmt(c.debt, 2)}`)}
    ${gauge(hfTrue)}`, { collateral: c.collateral, debt: c.debt, truePrice: c.truePrice, ltBps: c.ltBps, hfTrue });
}

function cardGlitch(s) {
  const { scenario: c, oracle, hfOracle } = s;
  const change = ((oracle - c.truePrice) * 10000n) / c.truePrice;
  return card(2, "GLITCH", `
    ${line("Oracle price", `${fmt(c.truePrice)} → ${fmt(oracle)} (${bps(change)})`, "oracle = true price × (1 ± severity)")}
    ${line("Health factor", `${fmt(hfOracle, 4)} ${hfOracle < WAD ? '<span class="sim-bad">below 1.0</span>' : '<span class="sim-good">still above 1.0</span>'}`, `HF = ${fmt(c.collateral, 2)} × ${fmt(oracle)} × ${bps(c.ltBps)} / ${fmt(c.debt, 2)}`)}
    ${gauge(hfOracle)}
    ${line("Event, illustrative", `<code>AnswerUpdated(current: ${esc(oracle)}, …)</code>`)}`, { oracle, hfOracle, changeBps: change });
}

function cardLiquidation(s) {
  if (!s.liquidated) return card(3, "LIQUIDATION", `<p>Not reached. The health factor stayed at 1.0 or above, so nobody can liquidate this position.</p>`, {});
  const { scenario: c, oracle, debtCovered: x, seized, market, netLoss } = s;
  return card(3, "LIQUIDATION", `
    ${line("Repaid X", `${fmt(x, 4)} WETH`, `X = D × close factor = ${fmt(c.debt, 2)} × ${bps(c.closeFactorBps)}`)}
    ${line("Seized C", `${fmt(seized, 4)} wstETH`, `C = X × (1 + bonus) / oracle = ${fmt(x, 4)} × ${bps(10000n + c.bonusBps)} / ${fmt(oracle)}`)}
    ${line("Position after", `${fmt(c.collateral - seized, 4)} wstETH, ${fmt(c.debt - x, 4)} WETH debt`)}
    ${line("What Priya lost", `<span class="sim-bad">${fmt(netLoss, 4)} ETH</span>`, `C × market price − X = ${fmt(seized, 4)} × ${fmt(market)} − ${fmt(x, 4)}`)}
    ${line("Event, illustrative", `<code>LiquidationCall(wstETH, WETH, Priya, ${esc(x)}, ${esc(seized)}, …)</code>`)}`, { debtCovered: x, seized, market, netLoss });
}

function cardDetect(s) {
  const r = s.result;
  if (!r) return card(4, "VAR DETECT", `<p>Not reached.</p>`, {});
  const { band } = r.assessment;
  const ok = band !== "INCONCLUSIVE";
  const cfg = r.config;
  const rows = r.sources.map((x) => `<tr><td>${esc(x.source.name)}</td><td class="num">${fmt(x.source.price)}</td><td class="num">${bps(x.devBps)}</td><td><span class="tag ${x.used ? "" : "solid"}">${x.used ? "accepted" : "rejected"}</span></td></tr>`).join("");
  const used = r.sources.filter((x) => x.used).length;
  const tau = cfg.tauBps;
  const gapPct = r.oracleGapBps > 2n * tau * 4n ? 100n : (r.oracleGapBps * 100n) / (tau * 8n);
  return card(4, "VAR DETECT", `
    <div class="scroll"><table><thead><tr><th>Source</th><th class="num">Price</th><th class="num">From median</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${line("Median", fmt(r.median))}
    ${line("minSources", `${used} of ${cfg.minSources} needed ${used >= cfg.minSources ? '<span class="sim-good">met</span>' : '<span class="sim-bad">not met</span>'}`, `a source survives if |price − median| ≤ ${bps(cfg.epsOutBps)}`)}
    ${ok ? line("Band", `[${fmt(band.collateral.low)}, ${fmt(band.collateral.high)}]`, `lowest and highest survivor, widened by μ = ${bps(cfg.muBps)}`) : line("Band", '<span class="sim-bad">none</span>', "too few survivors")}
    ${ok ? line("Oracle deviation", `${bps(r.oracleGapBps)} ${esc(r.oracleSide)} the band, against τ = ${bps(tau)}`, "gate opens if oracle < band low × (1 − τ)") + `<div class="sim-bar ${r.gateOpen ? "over" : ""}"><i style="width:${gapPct}%"></i><b style="left:12.5%"></b></div>` : ""}
    ${line("Anomaly gate", ok ? (r.gateOpen ? '<span class="sim-bad">gate OPEN</span>' : '<span class="sim-good">gate CLOSED</span>') : "not run")}`,
    { sources: r.sources.map((x) => ({ name: x.source.name, price: x.source.price, devBps: x.devBps, used: x.used })), median: r.median, band: ok ? band.collateral : null, gateOpen: r.gateOpen, oracleGapBps: r.oracleGapBps });
}

function cardJudge(s) {
  const r = s.result;
  if (!r) return card(5, "VAR JUDGE", `<p>Not reached.</p>`, {});
  const { hfBest, hfWorst } = r.assessment.outcome;
  const ok = r.assessment.band !== "INCONCLUSIVE";
  return card(5, "VAR JUDGE", `
    ${ok ? line("Worst case", `HF ${fmt(hfWorst, 4)}`, "health factor at band low") + line("Best case", `HF ${fmt(hfBest, 4)}`, "health factor at band high") : "<p>No band, so no interval can be judged.</p>"}
    <ul class="sim-rules">
      <li>Gate closed → VALID, or OVERPRICED if the oracle is above the band</li>
      <li>HF worst ≥ ${fmt((WAD * (10000n + r.config.epsHBps)) / 10000n, 3)} → WRONGFUL</li>
      <li>HF best &lt; 1 → VALID, or EXCESS if more was taken than earned</li>
      <li>Otherwise → AMBIGUOUS</li>
    </ul>
    ${line("Direction rule", r.oracleSide === "below" ? "The oracle was too low, so it harmed the borrower." : r.oracleSide === "above" ? "The oracle was too high, which did not cause harm." : "The oracle was inside the band.", "only act if the oracle harmed the borrower")}
    <div class="sim-stamp">${esc(r.verdict)}</div>
    <p>${esc(REASONS[r.verdict])}</p>`, { hfBest, hfWorst, verdict: r.verdict });
}

function cardRedress(s) {
  const r = s.result;
  if (!r) return card(6, "REDRESS MATH", `<p>Not reached.</p>`, {});
  const floor = r.assessment.redress;
  const low = r.report.bandLowE18;
  const same = r.rederived === floor;
  const formula = r.verdict === "WRONGFUL" ? `C × pL − X = ${fmt(r.report.collateralSeized, 4)} × ${fmt(low)} − ${fmt(r.report.debtToCover, 4)}`
    : `excess = C × pL − X × (1 + bonus), for ${r.verdict}. Other verdicts pay 0`;
  return card(6, "REDRESS MATH", `
    ${line("Redress floor, paid", `<mark class="hl-yellow">${fmt(floor)} ETH</mark>`, formula)}
    ${line("Midpoint estimate, not paid", `${fmt(r.midpointLoss)} ETH`, "C × band midpoint − X")}
    ${line("Difference", `${fmt(r.midpointLoss - floor)} ETH`)}
    <p><strong>We pay what we can prove, not what we guess.</strong></p>
    ${line("Vault re-derivation", `${esc(r.rederived)} wei ${same ? '<span class="sim-good">✓ exact match</span>' : '<span class="sim-bad">differs</span>'}`, "the vault recomputes the amount and reverts on any difference")}
    <label class="sim-check"><input id="sim-tamper" type="checkbox" ${state.tamper ? "checked" : ""}> Tamper with the report by 1 wei</label>`,
    { redress: floor, midpointLoss: r.midpointLoss, rederived: r.rederived, evidenceHash: r.evidence });
}

function cardPayout(s) {
  const r = s.result, v = state.settled;
  if (!r || !v) return card(7, "PAYOUT", `<p>Not reached.</p>`, {});
  const label = "<p class=\"hint\">Vault rules, simulated in-browser.</p>";
  const checks = (v.revert?.checks ?? v.payout.checks).map((c) => `<li>${c.pass ? "✓" : "✗"} ${esc(c.name)}<span class="sim-f">${esc(c.rule)}</span></li>`).join("");
  if (v.revert) {
    return card(7, "PAYOUT", `${label}<ul class="sim-rules">${checks}</ul>
      <p><span class="sim-bad">REVERT ${esc(v.revert.name)}</span></p><p class="sim-f">${esc(v.revert.detail)}</p>
      <p>Nothing moved. Untick the tamper box to send the honest report.</p>`, { revert: v.revert });
  }
  const p = v.payout;
  const paid = p.fromBond + p.fromReserve;
  const gap = s.netLoss - paid;
  return card(7, "PAYOUT", `${label}<ul class="sim-rules">${checks}<li>✓ Replay of this report: ${esc(v.replayRevert ?? "not rejected")}</li></ul>
    ${line("Bond", `${fmt(v.bondBefore, 4)} → ${fmt(v.bondAfter, 4)} ETH (draws first)`)}${bar(v.bondAfter, v.bondBefore)}
    ${line("Reserve", `${fmt(v.reserveBefore, 4)} → ${fmt(v.reserveAfter, 4)} ETH`)}${bar(v.reserveAfter, v.reserveBefore)}
    ${line("Priya receives", `+${fmt(paid, 4)} test WETH`, "bond share + reserve share")}
    ${p.claim ? line("Claim opened", `against liquidator ${esc(short(p.claim.liquidator))} and builder ${esc(short(p.claim.builder))}, for ${fmt(p.claim.expected, 4)} ETH`) : line("Claim", "none, because nothing was paid")}
    <h3>Priya net position</h3>
    ${line("Loss", `${fmt(s.netLoss, 4)} ETH`)}${line("Refund", `${fmt(paid, 4)} ETH`)}${line("Remaining gap", `${fmt(gap, 4)} ETH`, "loss − refund")}
    <p><strong>Net loss restored, not the position reversed.</strong></p>`, { fromBond: p.fromBond, fromReserve: p.fromReserve, claim: p.claim, netLoss: s.netLoss, gap });
}

function card(n, title, body, values) {
  return `<li class="sim-card" data-state="wait"><h3>${n}. ${esc(title)}</h3>${body}${details(values)}</li>`;
}

function ledgerEvents() {
  const { sim: s, settled: v } = state;
  const r = s.result;
  return [
    [1, `Position open: HF ${fmt(s.hfTrue, 4)}`],
    [2, `Oracle set to ${fmt(s.oracle, 4)}`],
    ...(s.liquidated ? [[3, `Liquidated: C ${fmt(s.seized, 4)}, X ${fmt(s.debtCovered, 4)}`]] : []),
    ...(r ? [[4, r.gateOpen ? "Gate open" : "Gate closed"], [5, `Verdict ${r.verdict}`], [6, `Redress ${fmt(r.assessment.redress, 4)} ETH`]] : []),
    ...(v?.revert ? [[7, `REVERT ${v.revert.name}`]] : []),
    ...(v?.payout?.fromBond ? [[7, `Bond paid ${fmt(v.payout.fromBond, 4)}`]] : []),
    ...(v?.payout?.fromReserve ? [[7, `Reserve paid ${fmt(v.payout.fromReserve, 4)}`]] : []),
    ...(v?.payout?.claim ? [[7, "Claim opened"]] : []),
  ];
}

function renderLedger() {
  const { sim: s, settled: v, shown } = state;
  const done = v && shown >= 7;
  const reserve = done ? v.reserveAfter : s?.scenario.reserve ?? 0n;
  const bond = done ? v.bondAfter : s?.scenario.bond ?? 0n;
  const paid = done && v.payout ? v.payout.fromBond + v.payout.fromReserve : 0n;
  const claims = done && v.payout?.claim ? 1 : 0;
  const stat = (a, b) => `<div class="stat"><b>${esc(a)}</b><span>${esc(b)}</span></div>`;
  $("sim-totals").innerHTML = stat(fmt(reserve, 4), "reserve (ETH)") + stat(fmt(bond, 4), "bond (ETH)") + stat(fmt(paid, 4), "paid (ETH)") + stat(claims, "claims open");
  $("sim-log").innerHTML = s ? ledgerEvents().filter(([n]) => n <= shown).map(([, t]) => `<li>${esc(t)}</li>`).join("") : "";
}

function paint() {
  [...cards()].forEach((el, i) => {
    el.dataset.state = i < state.shown - 1 ? "done" : i === state.shown - 1 ? "now" : "wait";
    el.hidden = i >= state.shown;
  });
  renderLedger();
  const more = state.shown < 7;
  $("sim-step").disabled = !more;
  $("sim-instant").disabled = !more;
  $("sim-play").disabled = !more || Boolean(state.timer);
  $("sim-pause").disabled = !state.timer;
}

function stop() {
  clearInterval(state.timer);
  state.timer = null;
}

function step() {
  state.shown = Math.min(7, state.shown + 1);
  if (state.shown === 7) stop();
  paint();
}

function play() {
  stop();
  state.timer = setInterval(step, STEP_MS);
  paint();
}

function renderCards() {
  const s = state.sim;
  $("sim-cards").innerHTML = [cardBefore, cardGlitch, cardLiquidation, cardDetect, cardJudge, cardRedress, cardPayout].map((f) => f(s)).join("");
}

function settleNow() {
  const { sim: s } = state;
  state.settled = s.result ? settle(s.scenario.reserve, s.scenario.bond, s.result.report, state.tamper) : null;
}

const FIELDS = [
  ["collateral", "Collateral (wstETH)", (s) => fmt(s.collateral, 18)], ["debt", "Debt (WETH)", (s) => fmt(s.debt, 18)], ["truePrice", "True price", (s) => fmt(s.truePrice, 18)],
  ["ltBps", "Liquidation threshold (bps)", (s) => s.ltBps], ["bonusBps", "Liquidation bonus (bps)", (s) => s.bonusBps], ["closeFactorBps", "Close factor (bps)", (s) => s.closeFactorBps],
  ["lido", "Lido noise (bps)", (s) => s.noiseBps.lido], ["twap", "TWAP noise (bps)", (s) => s.noiseBps.twap], ["offchain", "Off-chain noise (bps)", (s) => s.noiseBps.offchain],
  ["reserve", "Reserve (ETH)", (s) => fmt(s.reserve, 18)], ["bond", "Bond (ETH)", (s) => fmt(s.bond, 18)],
];

/** Text for an input: no separators, and no trailing zeros after a decimal point. */
function plain(v) {
  const t = String(v).replaceAll(",", "");
  return t.includes(".") ? t.replace(/\.?0+$/, "") : t;
}

function fillForm() {
  const s = presetScenario($("sim-preset").value, BigInt($("sim-sev").value));
  $("sim-form").innerHTML = FIELDS.map(([k, label, get]) => `<label>${esc(label)}<input name="${k}" value="${esc(plain(get(s)))}" inputmode="decimal"></label>`).join("");
  const preset = PRESETS.find((p) => p.id === $("sim-preset").value);
  $("sim-note").textContent = preset.note;
}

function readScenario() {
  const f = new FormData($("sim-form"));
  const s = presetScenario($("sim-preset").value, BigInt($("sim-sev").value));
  const wad = (k) => parseWad(String(f.get(k)));
  const int = (k) => {
    const t = String(f.get(k)).trim();
    if (!/^-?\d+$/.test(t)) throw new RangeError(`${k} must be a whole number of basis points`);
    return BigInt(t);
  };
  return { ...s, collateral: wad("collateral"), debt: wad("debt"), truePrice: wad("truePrice"), ltBps: int("ltBps"), bonusBps: int("bonusBps"), closeFactorBps: int("closeFactorBps"), noiseBps: { lido: int("lido"), twap: int("twap"), offchain: int("offchain") }, reserve: wad("reserve"), bond: wad("bond") };
}

function glitch() {
  $("sim-error").hidden = true;
  stop();
  state.tamper = false;
  try {
    state.sim = simulate(readScenario());
    settleNow();
    renderCards();
    state.shown = 0;
    if (REDUCED) state.shown = 7;
    else play();
    paint();
  } catch (e) {
    $("sim-error").hidden = false;
    $("sim-error").textContent = `That scenario cannot run: ${e.message}`;
  }
}

function reset() {
  stop();
  Object.assign(state, { sim: null, settled: null, tamper: false, shown: 0 });
  $("sim-cards").innerHTML = "";
  $("sim-error").hidden = true;
  $("sim-sev").value = 285;
  $("sim-preset").value = PRESETS[0].id;
  syncSeverity();
  fillForm();
  renderLedger();
  ["sim-play", "sim-pause", "sim-step", "sim-instant"].forEach((id) => ($(id).disabled = true));
}

function syncSeverity() {
  $("sim-sev-label").textContent = bps(BigInt($("sim-sev").value));
}

async function realIncident() {
  const out = $("sim-real-out");
  out.innerHTML = `<p class="hint">Running…</p>`;
  try {
    const get = async (n) => {
      const r = await fetch(`data/${n}.json`);
      if (!r.ok) throw new Error(`data/${n}.json answered ${r.status}`);
      return r.json();
    };
    const [reads, offchain, replay] = await Promise.all(["incident-reads", "offchain-prices", "replay"].map(get));
    const run = runIncident(reads, offchain.prices, parseWad("3000"), parseWad("100"));
    const same = run.rows.filter((row) => {
      const want = replay.liquidations.find((x) => x.tx === row.tx && x.logIndex === row.logIndex);
      return want && want.verdict === row.verdict && BigInt(want.redressFloor) === row.redress;
    }).length;
    const dao = parseWad(String(replay.scorecard.daoHeadlineEth));
    const counts = {};
    for (const r of run.rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    out.innerHTML = `<div class="stats">
      <div class="stat"><b>${fmt(run.total, 4)}</b><span>ETH, floor from this engine</span></div>
      <div class="stat"><b>${esc(replay.scorecard.daoHeadlineEth)}</b><span>ETH, the DAO's figure</span></div>
      <div class="stat"><b>${bps(((run.total - dao) * 10000n) / dao)}</b><span>difference</span></div>
      <div class="stat"><b>${same} / ${run.rows.length}</b><span>rows equal replay.json to the wei</span></div>
    </div><p class="hint">Verdicts: ${esc(Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", "))}. Bond ${fmt(run.fromBond, 4)}, reserve ${fmt(run.fromReserve, 4)}, ${run.claims} claims. Run in this browser just now.</p>`;
  } catch (e) {
    out.innerHTML = `<div class="empty">The real incident could not run: ${esc(e.message)}</div>`;
  }
}

function start() {
  $("sim-preset").innerHTML = PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
  $("sim-go").disabled = false;
  $("sim-real").disabled = false;
  syncSeverity();
  fillForm();
  renderLedger();
  $("sim-go").addEventListener("click", glitch);
  $("sim-reset").addEventListener("click", reset);
  $("sim-play").addEventListener("click", play);
  $("sim-pause").addEventListener("click", () => { stop(); paint(); });
  $("sim-step").addEventListener("click", () => { stop(); step(); });
  $("sim-instant").addEventListener("click", () => { stop(); state.shown = 7; paint(); });
  $("sim-real").addEventListener("click", realIncident);
  $("sim-sev").addEventListener("input", () => { syncSeverity(); });
  $("sim-preset").addEventListener("change", fillForm);
  $("sim-cards").addEventListener("change", (e) => {
    if (e.target.id !== "sim-tamper") return;
    const shown = state.shown;
    state.tamper = e.target.checked;
    settleNow();
    renderCards();
    state.shown = shown;
    paint();
  });
}

start();
