// The Live Demo. Your wallet signs every step. Amounts come from chain reads and engine output.
import { call, decodePosition, eventsFrom, judge, poolAbi, vaultAbi } from "./live-engine.js";

const $ = (id) => document.getElementById(id);
const SEPOLIA_HEX = "0xaa36a7";
const SCAN = "https://sepolia.etherscan.io";
const WAD = 10n ** 18n;
const REPORT_GAS = "0x2dc6c0"; // 3,000,000: a report writes a record and a claim

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "—");
function fmt(v, places = 6) {
  const a = v < 0n ? -v : v;
  return `${v < 0n ? "−" : ""}${a / WAD}.${(a % WAD).toString().padStart(18, "0").slice(0, places)}`;
}
const txLink = (hash, text = "View transaction") => `<a href="${SCAN}/tx/${esc(hash)}" target="_blank" rel="noreferrer">${esc(text)}</a>`;
const addrLink = (a, text) => `<a href="${SCAN}/address/${esc(a)}#code" target="_blank" rel="noreferrer">${esc(text ?? short(a))}</a>`;
const ROUND = (n) => (n * 10n ** 15n);

const s = { account: null, start: null, deposit: 0n, id: null, cfg: null, liq: null, refund: 0n, returned: 0n, lost: 0n, spentGasNote: "" };
const wallet = () => window.ethereum;
const rpc = (method, params = []) => wallet().request({ method, params });

function fail(e) {
  $("error").hidden = false;
  $("error").textContent = e?.code === 4001 ? "You rejected the request in your wallet." : `That step failed: ${e?.message ?? e}`;
}

function busy(n, on, text) {
  const b = $(`b${n}`);
  b.disabled = on;
  if (text) $(`o${n}`).innerHTML = `<p class="hint">${esc(text)}</p>`;
}

function unlock(n) {
  for (let i = 1; i <= 5; i++) {
    $(`b${i}`).disabled = i !== n;
    $(`s${i}`).dataset.state = i < n ? "done" : i === n ? "now" : "wait";
  }
}

async function refresh() {
  if (!s.account) return;
  const wei = BigInt(await rpc("eth_getBalance", [s.account, "latest"]));
  $("balance").textContent = fmt(wei);
  if (s.start === null) s.start = wei;
  const d = wei - s.start;
  $("delta").textContent = `${d > 0n ? "+" : ""}${fmt(d)}`;
  $("delta").dataset.sign = d < 0n ? "down" : d > 0n ? "up" : "";
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(tx) {
  $("error").hidden = true;
  const hash = await rpc("eth_sendTransaction", [{ from: s.account, ...tx }]);
  for (let i = 0; i < 90; i++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`transaction ${short(hash)} reverted`);
      return { hash, receipt };
    }
    await wait(2000);
  }
  throw new Error(`transaction ${short(hash)} is still pending`);
}

const read = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const position = async () => decodePosition(await read(s.cfg.pool, call.positions(s.id)));
const health = async () => BigInt(await read(s.cfg.pool, call.healthFactor(s.id)));
const equity = async () => BigInt(await read(s.cfg.pool, call.equity(s.id)));

async function connect() {
  try {
    const [account] = await rpc("eth_requestAccounts");
    await rpc("wallet_switchEthereumChain", [{ chainId: SEPOLIA_HEX }]);
    s.account = account;
    $("connect").textContent = short(account);
    $("who").textContent = `Wallet ${short(account)}`;
    await refresh();
    unlock(1);
  } catch (e) {
    fail(e);
  }
}

function amountWei() {
  const m = /^(\d*)\.?(\d{0,18})$/.exec($("amount").value.trim());
  if (!m) throw new Error("enter a deposit such as 0.005");
  return BigInt(m[1] || "0") * WAD + BigInt((m[2] || "").padEnd(18, "0"));
}

async function step1() {
  try {
    s.deposit = amountWei();
    if (s.deposit < ROUND(1n) || s.deposit > ROUND(20n)) throw new Error("the deposit must be between 0.001 and 0.02");
    busy(1, true, "Confirm in your wallet, then wait for the block…");
    const { hash, receipt } = await send({ to: s.cfg.pool, data: call.open(), value: `0x${s.deposit.toString(16)}` });
    s.id = eventsFrom(receipt.logs, s.cfg.pool, poolAbi).find((e) => e.name === "PositionOpened").args.id;
    const p = await position();
    await refresh();
    $("o1").innerHTML = `<p>Position #${esc(s.id)}: ${fmt(p.collateral, 4)} collateral, ${fmt(p.debt, 4)} debt, health factor <mark class="hl-lime">${fmt(await health(), 4)}</mark>. Your equity is ${fmt(await equity())} ETH. ${txLink(hash)}</p>`;
    unlock(2);
  } catch (e) {
    busy(1, false);
    fail(e);
  }
}

async function step2() {
  try {
    busy(2, true, "Confirm in your wallet, then wait for the block…");
    const { hash } = await send({ to: s.cfg.pool, data: call.glitch(s.id, BigInt($("sev").value)) });
    const p = await position();
    await refresh();
    $("o2").innerHTML = `<p>Oracle now reads ${fmt(p.oraclePrice)}. The real value has not moved. Health factor <span class="sim-bad">${fmt(await health(), 4)}</span>. ${txLink(hash)}</p>`;
    unlock(3);
  } catch (e) {
    busy(2, false);
    fail(e);
  }
}

async function step3() {
  try {
    busy(3, true, "Confirm in your wallet, then wait for the block…");
    const before = await position();
    const equityBefore = await equity();
    const { hash, receipt } = await send({ to: s.cfg.pool, data: call.liquidate(s.id) });
    const e = eventsFrom(receipt.logs, s.cfg.pool, poolAbi).find((x) => x.name === "LiquidationCall");
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    s.lost = equityBefore - (await equity());
    s.liq = { tx: hash, logIndex: e.logIndex, blockNumber: BigInt(receipt.blockNumber), user: s.account, liquidator: e.args.liquidator, builder: block.miner, adapter: s.cfg.pool, debtAsset: s.cfg.weth, oracle: before.oraclePrice, collateral: before.collateral, debt: before.debt, seized: e.args.liquidatedCollateralAmount, repaid: e.args.debtToCover };
    await refresh();
    $("o3").innerHTML = `<p><span class="sim-bad">LIQUIDATED</span> Seized ${fmt(s.liq.seized, 4)} collateral. You lost <mark class="hl-pink">${fmt(s.lost)} ETH</mark> at the true price, paid to the liquidator ${esc(short(e.args.liquidator))}. ${txLink(hash)}</p>`;
    unlock(4);
  } catch (e) {
    busy(3, false);
    fail(e);
  }
}

async function step4() {
  try {
    busy(4, true, "Running the verdict engine…");
    const { review, data } = judge(s.liq, s.cfg.vault, BigInt(Date.now()));
    const band = review.assessment.band;
    const sources = review.sources.map((x) => fmt(x.source.price, 4)).join(", ");
    const ruling = `<p>Three synthetic sources: ${sources}. Sepolia has no real wstETH market, so these sit around the true price. Band ${fmt(band.collateral.low, 4)} to ${fmt(band.collateral.high, 4)}. Oracle ${esc(review.oracleGapBps)} bps ${esc(review.oracleSide)} the band.</p>
      <div class="sim-stamp">${esc(review.verdict)}</div>
      <p>Provable floor: <mark class="hl-yellow">${fmt(review.assessment.redress)} ETH</mark>. The vault re-derives this on-chain and reverts on any difference.</p>`;
    $("o4").innerHTML = `${ruling}<p class="hint">Confirm in your wallet, then wait for the block…</p>`;

    const { hash, receipt } = await send({ to: s.cfg.forwarder, data, gas: REPORT_GAS });
    const events = eventsFrom(receipt.logs, s.cfg.vault, vaultAbi);
    const paid = events.filter((e) => e.name === "Paid");
    const queued = events.some((e) => e.name === "Queued");
    const part = (src) => paid.filter((e) => Number(e.args.source) === src).reduce((a, e) => a + e.args.amount, 0n);
    s.refund = part(0) + part(1);
    await refresh();
    const result = queued
      ? `<p><span class="sim-bad">QUEUED</span> The reserve's epoch cap was reached, so this waits for a later epoch.</p>`
      : s.refund > 0n
        ? `<p><span class="sim-good">PAID ${fmt(s.refund)} ETH</span> to your wallet, as native SepoliaETH: ${fmt(part(0))} from the operator's bond, ${fmt(part(1))} from the reserve. A claim is open against the liquidator and builder. ${txLink(hash)}</p>`
        : `<p><span class="sim-bad">No payout</span> The vault paid nothing for this report. ${txLink(hash)}</p>`;
    $("o4").innerHTML = ruling + result;
    unlock(5);
  } catch (e) {
    busy(4, false);
    fail(e);
  }
}

async function step5() {
  try {
    busy(5, true, "Confirm in your wallet, then wait for the block…");
    const { hash, receipt } = await send({ to: s.cfg.pool, data: call.close(s.id) });
    s.returned = eventsFrom(receipt.logs, s.cfg.pool, poolAbi).find((e) => e.name === "PositionClosed").args.returned;
    await refresh();
    $("o5").innerHTML = `<p>${fmt(s.returned)} ETH returned to your wallet. ${txLink(hash)}</p>`;
    const end = s.returned + s.refund;
    const gap = s.deposit - end;
    const stat = (v, label) => `<div class="stat"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
    $("result").innerHTML = stat(fmt(s.deposit), "ETH sent") + stat(fmt(s.lost), "ETH lost to the liquidation") + stat(fmt(s.refund), "ETH paid back by Redress") + stat(fmt(gap), "ETH remaining gap");
    $("summary").hidden = false;
    for (let i = 1; i <= 5; i++) $(`b${i}`).disabled = true;
    $("s5").dataset.state = "done";
  } catch (e) {
    busy(5, false);
    fail(e);
  }
}

async function start() {
  const r = await fetch("data/live-demo.json");
  if (!r.ok) throw new Error(`data/live-demo.json answered ${r.status}`);
  s.cfg = await r.json();
  $("footer").innerHTML = `Pool ${addrLink(s.cfg.pool)} · Vault ${addrLink(s.cfg.vault)} · Bond ${addrLink(s.cfg.bond)} · Ledger ${addrLink(s.cfg.ledger)}`;
  $("sev").addEventListener("input", () => {
    const v = BigInt($("sev").value);
    $("sev-label").textContent = `${v / 100n}.${(v % 100n).toString().padStart(2, "0")}%`;
  });
  [step1, step2, step3, step4, step5].forEach((f, i) => $(`b${i + 1}`).addEventListener("click", f));
  if (!wallet()) {
    $("connect").disabled = true;
    $("connect").title = "No wallet found in this browser";
    $("who").textContent = "Install MetaMask to run this demo";
    return;
  }
  $("connect").addEventListener("click", connect);
}

start().catch(fail);
