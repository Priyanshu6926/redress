// The VAR Room. Every number on screen comes from the JSON files in data/.
const $ = (id) => document.getElementById(id);
const WEI = 10n ** 18n;
const SEPOLIA = "https://sepolia.etherscan.io";
const MAINNET = "https://etherscan.io";
const STEP_MS = 400;
const SPEEDS = [1, 4, 16];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "—");
const link = (base, kind, hash, text) => (hash ? `<a href="${base}/${kind}/${esc(hash)}" target="_blank" rel="noreferrer">${esc(text ?? short(hash))}</a>` : "—");
const stat = (id, label) => `<div class="stat"><b id="${id}">0.0000</b><span>${esc(label)}</span></div>`;

/** Wei as a decimal string, without passing through a float. */
function eth(wei, places = 4) {
  const v = BigInt(wei ?? 0);
  return `${(v / WEI).toLocaleString("en-US")}.${(v % WEI).toString().padStart(18, "0").slice(0, places)}`;
}
const num = (wei) => Number(BigInt(wei) / 10n ** 10n) / 1e8;

const data = {};
let speed = 0;
let run = 0; // each playback has its own number, so a stale one stops itself
let skipping = false;

const pause = (ms) => new Promise((done) => setTimeout(done, ms / SPEEDS[speed]));
const live = (id) => id === run && !skipping;

async function load(name) {
  const r = await fetch(`data/${name}.json`);
  if (!r.ok) throw new Error(`data/${name}.json answered ${r.status}`);
  return r.json();
}

function drawChart(index) {
  const series = data.series;
  const W = 420, H = 250, P = 12;
  const prices = series.flatMap((p) => [num(p.oraclePrice), ...(p.bandLow ? [num(p.bandLow), num(p.bandHigh)] : [])]);
  const min = Math.min(...prices), max = Math.max(...prices), pad = (max - min) * 0.12;
  const x = (i) => P + (i * (W - 2 * P)) / (series.length - 1);
  const y = (v) => H - P - ((v - min + pad) * (H - 2 * P)) / (max - min + 2 * pad);
  const col = (W - 2 * P) / (series.length - 1);

  const band = series.slice(0, index + 1).map((p, i) => {
    if (!p.bandLow) return "";
    const top = y(num(p.bandHigh));
    return `<rect x="${x(i) - col / 2}" y="${top}" width="${col}" height="${Math.max(y(num(p.bandLow)) - top, 3)}" fill="#00c853" opacity="0.45"/>`;
  }).join("");
  const line = series.slice(0, index + 1).map((p, i) => `${x(i)},${y(num(p.oraclePrice))}`).join(" ");
  const head = series[index];
  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Aave oracle price against the independent band">
    ${band}<polyline points="${line}" fill="none" stroke="#d6003c" stroke-width="3"/>
    <circle cx="${x(index)}" cy="${y(num(head.oraclePrice))}" r="5" fill="#d6003c"/></svg>`;

  $("block").textContent = head.block;
  $("price").textContent = num(head.oraclePrice).toFixed(4);
  const first = BigInt(series[0].oraclePrice), now = BigInt(head.oraclePrice);
  $("drop").textContent = `${(Number(((first - now) * 1000000n) / first) / 10000).toFixed(2)}%`;
}

function setBadge(text, kind) {
  $("badge").textContent = text;
  $("badge").className = `badge ${kind}`;
}

function addCard(row) {
  const card = document.createElement("div");
  card.className = "card-liq";
  card.innerHTML = `<span>#${esc(row.block)}</span><span>${esc(short(row.user))}</span><b>LIQUIDATED</b>`;
  $("feed").prepend(card);
}

/** Counts up to a value read from the data. It always lands on the exact figure. */
function countTo(id, value) {
  const el = $(id);
  const from = el.value ?? 0n;
  const tween = (el.tween = {}); // a newer write cancels this one, even for the same value
  el.value = value;
  if (REDUCED || skipping) {
    el.textContent = eth(value);
    return;
  }
  const started = performance.now();
  const frame = (now) => {
    if (el.tween !== tween) return;
    const part = BigInt(Math.max(0, Math.min(1000, Math.round(((now - started) / 250) * 1000))));
    el.textContent = eth(from + ((value - from) * part) / 1000n);
    if (part < 1000n) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function addTotals(row, t) {
  const paid = data.paidOf(row);
  t.total += BigInt(row.redressFloor);
  t.bond += BigInt(paid?.fromBond ?? 0);
  t.reserve += BigInt(paid?.fromReserve ?? 0);
  t.done++;
  countTo("t-total", t.total);
  countTo("t-bond", t.bond);
  countTo("t-reserve", t.reserve);
  $("t-claims").textContent = t.done;
  $("count").textContent = `${t.done} / ${data.rows.length}`;
}

function stepsFor(row) {
  const paid = data.paidOf(row);
  return [
    ["CHECKING…", `${esc(short(row.tx))} at block ${esc(row.block)}`],
    ["Sources", esc(row.sourcesUsed.join(", "))],
    ["Band", `${eth(row.bandLow)} to ${eth(row.bandHigh)}`],
    ["Worst-case health factor", eth(row.hfWorst)],
    ["PAID", `${eth(row.redressFloor)} test WETH. Bond ${eth(paid?.fromBond)}, reserve ${eth(paid?.fromReserve)}. ${link(SEPOLIA, "tx", row.vaultTx, "Payout")}`],
  ];
}

function stamp(row) {
  const el = $("stamp");
  el.hidden = false;
  el.textContent = row.verdict;
  el.className = `stamp ${row.verdict === "WRONGFUL" ? "" : "soft"}`;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
}

async function review(row, id) {
  $("reviewing").textContent = `Reviewing ${short(row.user)}`;
  $("steps").innerHTML = "";
  $("stamp").hidden = true;
  const all = stepsFor(row);
  for (const [i, [title, body]] of all.entries()) {
    if (!live(id)) return;
    $("steps").insertAdjacentHTML("beforeend", `<li class="now">${esc(title)}<span>${body}</span></li>`);
    if (i === all.length - 2) stamp(row);
    await pause(STEP_MS);
  }
}

function finish(id, t) {
  if (id !== run) return;
  skipping = true; // the totals land on their exact figures, with no animation in flight
  for (const row of data.rows.slice(t.done)) {
    addCard(row);
    addTotals(row, t);
  }
  countTo("t-total", t.total);
  countTo("t-bond", t.bond);
  countTo("t-reserve", t.reserve);
  skipping = false;
  const last = data.rows[data.rows.length - 1];
  drawChart(data.series.length - 1);
  $("reviewing").textContent = `All ${data.rows.length} events reviewed. Last one shown.`;
  $("steps").innerHTML = stepsFor(last).map(([a, b]) => `<li>${esc(a)}<span>${b}</span></li>`).join("");
  stamp(last);
  setBadge("REPLAY ENDED", "done");
  $("scene").classList.remove("playing");
  $("break").textContent = "RUN IT AGAIN";
  $("skip").disabled = true;
}

function reset() {
  $("feed").innerHTML = "";
  $("steps").innerHTML = "";
  $("stamp").hidden = true;
  $("totals").innerHTML = stat("t-total", "test WETH paid") + stat("t-bond", "from the operator bond") + stat("t-reserve", "from the reserve") + `<div class="stat"><b id="t-claims">0</b><span>claims opened</span></div>`;
  $("count").textContent = `0 / ${data.rows.length}`;
  drawChart(0);
}

async function play() {
  const id = ++run;
  skipping = false;
  const t = { total: 0n, bond: 0n, reserve: 0n, done: 0 };
  reset();
  setBadge("REPLAY", "on");
  $("scene").classList.add("playing");
  $("skip").disabled = false;
  $("break").textContent = "RESTART";
  if (REDUCED) return finish(id, t);

  for (const row of data.rows) {
    if (!live(id)) break;
    drawChart(data.series.findIndex((p) => p.block === row.block));
    addCard(row);
    await review(row, id);
    if (!live(id)) break;
    addTotals(row, t);
  }
  finish(id, t);
}

function showWallet(address) {
  const rows = data.rows.filter((r) => r.user.toLowerCase() === address.toLowerCase());
  const total = rows.reduce((a, r) => a + BigInt(r.redressFloor), 0n);
  $("wallet").innerHTML = rows.length
    ? `<div class="card"><h3><mark class="hl-yellow">${esc(short(address))} was liquidated in this incident</mark></h3><p>${rows.length} event(s), provable floor ${eth(total)} test WETH.</p>${rows.map((r) => `<p>${esc(r.verdict)} at block ${esc(r.block)}: ${link(MAINNET, "tx", r.tx, "liquidation")}, ${link(SEPOLIA, "tx", r.vaultTx, "payout")}</p>`).join("")}</div>`
    : `<div class="card"><h3>${esc(short(address))}</h3><p>No liquidation for this wallet in the 10 March 2026 incident.</p></div>`;
}

async function connect() {
  try {
    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (!address) return;
    $("connect").textContent = short(address);
    showWallet(address);
  } catch (e) {
    $("wallet").innerHTML = `<div class="empty">Wallet not connected: ${esc(e.message)}</div>`;
  }
}

function setupWallet() {
  const button = $("connect");
  if (!window.ethereum) {
    button.disabled = true;
    button.title = "No wallet found in this browser";
    return;
  }
  button.addEventListener("click", connect);
  window.ethereum.on?.("accountsChanged", ([a]) => (a ? (($("connect").textContent = short(a)), showWallet(a)) : location.reload()));
}

function fail(e) {
  $("scene").hidden = true;
  $("error").hidden = false;
  $("error").textContent = `Could not load the replay data, so nothing is shown: ${e.message}`;
}

async function start() {
  const [replay, mirror, deployments, arkiv] = await Promise.all(["replay", "mirror", "deployments", "arkiv"].map(load));
  data.rows = replay.liquidations;
  data.series = replay.series;
  const byEvent = new Map(mirror.rows.map((m) => [`${m.liquidationTx}:${m.logIndex}`.toLowerCase(), m]));
  data.paidOf = (row) => byEvent.get(`${row.tx}:${row.logIndex}`.toLowerCase());

  reset();
  setupWallet();
  $("break").disabled = false;
  $("faster").disabled = false;
  $("break").addEventListener("click", play);
  $("faster").addEventListener("click", () => {
    speed = (speed + 1) % SPEEDS.length;
    $("faster").textContent = `Speed ${SPEEDS[speed]}×`;
  });
  $("skip").addEventListener("click", () => (skipping = true));
  $("footer").innerHTML = `Vault <code>${link(SEPOLIA, "address", deployments.vault)}</code> · Bond <code>${link(SEPOLIA, "address", deployments.operatorBond)}</code> · Ledger <code>${link(SEPOLIA, "address", deployments.recoveryLedger)}</code> · Arkiv entities: ${esc(arkiv.entities)} · <a href="evidence.html">Evidence</a>`;
}

start().catch(fail);
