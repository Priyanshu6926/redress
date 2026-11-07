const $ = (id) => document.getElementById(id);
const WEI = 10n ** 18n;
const SEPOLIA = "https://sepolia.etherscan.io";
const MAINNET = "https://etherscan.io";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "—");

/** Wei as ETH, without passing through a float. */
function eth(wei, places = 4) {
  const v = BigInt(wei ?? 0);
  const whole = v / WEI;
  const frac = (v % WEI).toString().padStart(18, "0").slice(0, places);
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

const price = (wei) => (wei === null || wei === undefined ? null : Number(BigInt(wei) / 10n ** 10n) / 1e8);
const link = (base, kind, hash, text) => (hash ? `<a href="${base}/${kind}/${esc(hash)}" target="_blank" rel="noreferrer">${esc(text ?? short(hash))}</a>` : "—");
const stat = (value, label) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
const tag = (verdict) => `<span class="tag ${verdict === "WRONGFUL" ? "solid" : ""}">${esc(verdict)}</span>`;
const table = (head, rows) => `<div class="scroll"><table><thead><tr>${head.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const th = (t, num) => `<th ${num ? 'class="num"' : ""}>${esc(t)}</th>`;

// On the free static site there is no API: the same data sits beside the page, and the browser
// reads Arkiv itself through arkiv-client.js.
const STATIC = Boolean(window.REDRESS_STATIC);
const STATIC_FILES = {
  "/api/replay": "data/replay.json",
  "/api/mirror": "data/mirror.json",
  "/api/deployments": "data/deployments.json",
  "/api/arkiv": "data/arkiv.json",
  "/api/live": "data/live.json",
  "/api/controls": "data/controls.json",
};

const get = async (path) => {
  const url = STATIC ? STATIC_FILES[path] : path;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
};

let staticClient;
async function client() {
  if (!staticClient) {
    const { createClient } = await import("./arkiv-client.js");
    staticClient = createClient(state.replay.liquidations, state.arkiv.writer);
  }
  return staticClient;
}

const lookupAddress = async (address) => (STATIC ? (await client()).lookup(address) : get(`/api/lookup/${encodeURIComponent(address)}`));

async function queryVerdicts(params) {
  if (!STATIC) return get(`/api/verdicts?${params}`);
  const number = (k) => (params.has(k) ? Number(params.get(k)) : undefined);
  return (await client()).verdicts({
    verdict: params.get("verdict") || undefined,
    minMilliEth: number("minMilliEth"),
    maxMilliEth: number("maxMilliEth"),
    fromBlock: number("fromBlock"),
    toBlock: number("toBlock"),
  });
}

const state = {};

function verdictRows(rows, withUser = true) {
  const head = [...(withUser ? [th("User")] : []), th("Market"), th("Verdict"), th("Worst HF", true), th("Band", true), th("Redress (ETH)", true), th("Liquidation"), th("Payout")];
  const body = rows.map((r) => `<tr>
    ${withUser ? `<td class="mono">${link(MAINNET, "address", r.user)}</td>` : ""}
    <td>${r.market.includes("Lido") ? "Prime" : "Core"}</td>
    <td>${tag(r.verdict)}</td>
    <td class="num">${BigInt(r.hfWorst) > 10n ** 30n ? "max" : eth(r.hfWorst)}</td>
    <td class="num">${eth(r.bandLow)} – ${eth(r.bandHigh)}</td>
    <td class="num">${eth(r.redressFloor)}</td>
    <td class="mono">${link(MAINNET, "tx", r.tx)}</td>
    <td class="mono">${link(SEPOLIA, "tx", r.vaultTx)}</td>
  </tr>`);
  return table(head, body);
}

function renderOverview() {
  const s = state.replay.scorecard;
  const paid = s.paidFloor;
  $("overview-stats").innerHTML = [
    stat(s.events, "liquidation events"),
    stat(`${s.positionsAllWrongful} of ${s.positions}`, "positions wrongful on every event"),
    stat(s.addresses, "addresses paid"),
    stat(eth(s.payouts.totalPaidWei), "test WETH paid on Sepolia"),
  ].join("");
  $("overview-compare").innerHTML = table(
    [th("Measure"), th("ETH", true), th("vs DAO headline", true)],
    [
      `<tr><td>Floor: what Redress pays</td><td class="num">${esc(paid.eth.toFixed(4))}</td><td class="num">${esc(paid.vsDaoHeadlinePct)}%</td></tr>`,
      `<tr><td>Midpoint: comparison only</td><td class="num">${esc(s.comparisonMidpoint.eth.toFixed(4))}</td><td class="num">${esc(s.comparisonMidpoint.vsDaoHeadlinePct)}%</td></tr>`,
      `<tr><td>DAO refund, published headline</td><td class="num">${esc(s.daoHeadlineEth)}</td><td class="num">—</td></tr>`,
    ],
  ) + `<p class="hint">Redress pays only what it can prove, so the floor sits below the DAO's figure by design.</p>`;
}

async function runLookup(address) {
  const out = $("lookup-result");
  out.innerHTML = `<p class="hint">Checking…</p>`;
  try {
    const { source, data } = await lookupAddress(address);
    const from = `<p class="hint">Read from ${source === "arkiv" ? "Arkiv" : "the local JSON file, because Arkiv did not answer"}.</p>`;
    const titles = {
      "invalid-address": ["Not an address", "Enter a 20-byte address starting with 0x."],
      "no-record": ["No record", "This address has no liquidation in the incident data."],
      wronged: ["Wrongly liquidated", `Provable floor: ${eth(data.totalRedressFloor)} ETH, across ${data.rows.length} event(s).`],
      "not-wronged": ["Liquidation was valid", "No redress is due."],
      undetermined: ["Undetermined", "There was not enough evidence for a verdict."],
    };
    const [title, body] = titles[data.status] ?? ["Unknown", ""];
    out.innerHTML = `<div class="card"><h3>${esc(title)}</h3><p>${esc(body)}</p></div>${from}${data.rows.length ? verdictRows(data.rows, false) : ""}`;
  } catch (e) {
    out.innerHTML = `<div class="empty">The lookup failed: ${esc(e.message)}</div>`;
  }
}

function theaterSeries() {
  return state.replay.series;
}

function drawTheater(index) {
  const series = theaterSeries();
  const point = series[index];
  const W = 900, H = 300, P = 44;
  const values = series.flatMap((p) => [price(p.oraclePrice), price(p.bandLow), price(p.bandHigh)]).filter((v) => v !== null);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = (max - min) * 0.1 || 0.01;
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(series.length - 1, 1);
  const y = (v) => H - P - ((v - (min - pad)) * (H - 2 * P)) / (max + pad - (min - pad));

  const bands = series.map((p, i) => {
    if (p.bandLow === null || i > index) return "";
    const top = y(price(p.bandHigh)), bottom = y(price(p.bandLow));
    return `<rect x="${x(i) - 7}" y="${top}" width="14" height="${Math.max(bottom - top, 2)}" fill="#bbb"/>`;
  }).join("");
  const line = series.slice(0, index + 1).map((p, i) => `${x(i)},${y(price(p.oraclePrice))}`).join(" ");
  const ticks = [min, (min + max) / 2, max].map((v) => `<text x="4" y="${y(v) + 4}" font-size="11" font-family="monospace">${v.toFixed(3)}</text>`).join("");

  $("theater-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Oracle price against the independent band">
    ${ticks}${bands}
    <polyline points="${line}" fill="none" stroke="#000" stroke-width="2"/>
    <line x1="${x(index)}" x2="${x(index)}" y1="${P / 2}" y2="${H - P}" stroke="#000" stroke-dasharray="3 3"/>
    <text x="${P}" y="${H - 12}" font-size="12">Line: Aave oracle. Grey: independent band. WETH per wstETH.</text>
  </svg>`;

  $("theater-stats").innerHTML = [
    stat(point.block, "block"),
    stat(price(point.oraclePrice)?.toFixed(4) ?? "—", "oracle price"),
    stat(point.bandLow ? price(point.bandLow).toFixed(4) : "—", "band low"),
    stat(point.liquidations, "liquidations"),
    stat(eth(point.cumulativeRedressFloor), "cumulative redress (ETH)"),
  ].join("");

  const events = state.replay.liquidations.filter((r) => r.block === point.block);
  $("theater-events").innerHTML = events.length ? verdictRows(events) : `<div class="empty">No liquidations in this block.</div>`;
}

let playing = null;
function togglePlay() {
  const slider = $("theater-slider");
  if (playing) {
    clearInterval(playing);
    playing = null;
    $("theater-play").textContent = "Play";
    return;
  }
  if (Number(slider.value) >= Number(slider.max)) slider.value = 0;
  $("theater-play").textContent = "Pause";
  playing = setInterval(() => {
    const next = Number(slider.value) + 1;
    if (next > Number(slider.max)) return togglePlay();
    slider.value = next;
    drawTheater(next);
  }, 900);
}

async function runExplorer(form) {
  const f = new FormData(form);
  const q = new URLSearchParams();
  if (f.get("verdict")) q.set("verdict", f.get("verdict"));
  if (f.get("minEth")) q.set("minMilliEth", Math.floor(Number(f.get("minEth")) * 1000));
  if (f.get("maxEth")) q.set("maxMilliEth", Math.floor(Number(f.get("maxEth")) * 1000));
  if (f.get("fromBlock")) q.set("fromBlock", f.get("fromBlock"));
  if (f.get("toBlock")) q.set("toBlock", f.get("toBlock"));
  $("explorer-result").innerHTML = `<p class="hint">Querying…</p>`;
  try {
    const { source, data } = await queryVerdicts(q);
    $("explorer-source").textContent = `${data.length} result(s), served by ${source === "arkiv" ? "Arkiv" : "the local JSON fallback"}.`;
    $("explorer-result").innerHTML = data.length ? verdictRows(data) : `<div class="empty">Nothing matches these filters.</div>`;
  } catch (e) {
    $("explorer-result").innerHTML = `<div class="empty">The query failed: ${esc(e.message)}</div>`;
  }
}

function renderReserve() {
  const rows = state.mirror.rows ?? [];
  const sum = (f) => rows.reduce((a, r) => a + BigInt(f(r) ?? 0), 0n);
  const bond = sum((r) => r.fromBond), reserve = sum((r) => r.fromReserve);
  $("reserve-stats").innerHTML = [
    stat(eth(bond + reserve), "total paid (test WETH)"),
    stat(eth(bond), "from the operator bond"),
    stat(eth(reserve), "from the reserve"),
    stat(rows.length, "claims opened"),
  ].join("");

  const drew = rows.filter((r) => BigInt(r.fromBond ?? 0) > 0n);
  $("reserve-waterfall").innerHTML = drew.length ? table(
    [th("Event"), th("Redress", true), th("Bond", true), th("Reserve", true), th("Payout")],
    drew.map((r) => `<tr><td class="mono">${link(MAINNET, "tx", r.liquidationTx)}</td><td class="num">${eth(r.redress)}</td><td class="num">${eth(r.fromBond)}</td><td class="num">${eth(r.fromReserve)}</td><td class="mono">${link(SEPOLIA, "tx", r.vaultTx)}</td></tr>`),
  ) : `<div class="empty">No payout has used a bond yet.</div>`;

  const byLiquidator = new Map();
  for (const r of rows) {
    const k = r.liquidator ?? "unknown";
    const v = byLiquidator.get(k) ?? { events: 0, amount: 0n };
    byLiquidator.set(k, { events: v.events + 1, amount: v.amount + BigInt(r.redress) });
  }
  const sorted = [...byLiquidator].sort((a, b) => (b[1].amount > a[1].amount ? 1 : -1));
  $("reserve-claims").innerHTML = sorted.length ? table(
    [th("Liquidator"), th("Events", true), th("Claimed (ETH)", true)],
    sorted.map(([a, v]) => `<tr><td class="mono">${link(MAINNET, "address", a)}</td><td class="num">${v.events}</td><td class="num">${eth(v.amount)}</td></tr>`),
  ) : `<div class="empty">No claims yet.</div>`;
}

/** The vault's own rule: a payout that does not fit the epoch budget queues whole. */
function runStress(form) {
  const f = new FormData(form);
  const toWei = (name) => BigInt(Math.floor(Number(f.get(name) || 0) * 1e6)) * 10n ** 12n;
  let reserve = toWei("reserve"), bond = toWei("bond");
  const capBps = BigInt(Math.floor(Number(f.get("cap") || 0) * 100));
  const budget = (reserve * capBps) / 10_000n;
  let spent = 0n, paid = 0, queued = 0, queuedWei = 0n, fromBond = 0n;
  for (const r of state.replay.liquidations) {
    const amount = BigInt(r.redressFloor);
    if (amount === 0n) continue;
    const bonded = amount < bond ? amount : bond;
    const need = amount - bonded;
    if (need <= reserve && spent + need <= budget) {
      bond -= bonded; reserve -= need; spent += need; fromBond += bonded; paid++;
    } else {
      queued++; queuedWei += amount;
    }
  }
  $("stress-result").innerHTML = [
    stat(paid, "paid at once"),
    stat(queued, "queued for later epochs"),
    stat(eth(queuedWei, 2), "ETH left queued"),
    stat(eth(budget, 2), "epoch budget (ETH)"),
    stat(eth(fromBond, 2), "drawn from the bond (ETH)"),
  ].join("");
}

async function renderLive() {
  const [live, controls] = await Promise.all([get("/api/live"), get("/api/controls")]);
  const events = live.events ?? [];
  $("live-status").textContent = live.updatedAt ? `Last scan ${live.updatedAt}: blocks ${live.fromBlock} to ${live.toBlock}. ${live.note ?? ""}` : "The watcher has not run yet.";
  $("live-result").innerHTML = events.length ? table(
    [th("Block", true), th("Market"), th("Pair"), th("Gate"), th("Verdict"), th("Tx")],
    events.map((e) => `<tr><td class="num">${esc(e.block)}</td><td>${esc(e.market)}</td><td>${esc(e.pair)}</td><td>${esc(e.gate)}</td><td>${tag(e.verdict)}</td><td class="mono">${link(MAINNET, "tx", e.tx)}</td></tr>`),
  ) : `<div class="empty">No liquidations in the scanned range.</div>`;
  const list = controls.controls ?? [];
  $("live-controls").innerHTML = list.length ? table(
    [th("Control"), th("Expected"), th("Result"), th("Pass")],
    list.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.expected)}</td><td>${esc(c.result)}</td><td>${c.pass ? "Yes" : "No"}</td></tr>`),
  ) : `<div class="empty">Control results are not available yet.</div>`;
}

const pages = ["overview", "lookup", "theater", "explorer", "reserve", "live"];
function show() {
  const name = pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  for (const p of pages) $(`page-${p}`).hidden = p !== name;
  for (const a of document.querySelectorAll("nav a")) {
    if (a.getAttribute("href") === `#${name}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (name === "explorer" && !$("explorer-result").innerHTML) runExplorer($("explorer-form"));
  if (name === "live") renderLive().catch((e) => ($("live-status").textContent = e.message));
}

async function start() {
  [state.replay, state.mirror, state.deployments, state.arkiv] = await Promise.all([get("/api/replay"), get("/api/mirror"), get("/api/deployments"), get("/api/arkiv")]);
  renderOverview();
  renderReserve();
  runStress($("stress-form"));

  const slider = $("theater-slider");
  slider.max = theaterSeries().length - 1;
  slider.value = slider.max; // open on the whole incident; Play runs it from the start
  drawTheater(Number(slider.max));
  slider.addEventListener("input", () => drawTheater(Number(slider.value)));
  $("theater-play").addEventListener("click", togglePlay);

  $("lookup-form").addEventListener("submit", (e) => { e.preventDefault(); runLookup($("lookup-input").value.trim()); });
  $("explorer-form").addEventListener("submit", (e) => { e.preventDefault(); runExplorer(e.target); });
  $("stress-form").addEventListener("input", (e) => runStress(e.currentTarget));

  const d = state.deployments;
  $("footer").innerHTML = `Vault <code>${link(SEPOLIA, "address", d.vault)}</code> · Bond <code>${link(SEPOLIA, "address", d.operatorBond)}</code> · Ledger <code>${link(SEPOLIA, "address", d.recoveryLedger)}</code> · v4 hook (synthetic demo) <code>${link(SEPOLIA, "address", d.bandOracleHook)}</code> · Arkiv entities: ${esc(state.arkiv.entities)}`;

  addEventListener("hashchange", show);
  show();
}

start().catch((e) => {
  document.querySelector("main").innerHTML = `<div class="empty">Could not load data: ${esc(e.message)}. Try reloading the page.</div>`;
});
