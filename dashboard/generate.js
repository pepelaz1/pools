const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const MAX_UINT128 = 2n ** 128n - 1n;

const CHAINS = {
  arbitrum: {
    label: "Arbitrum",
    rpc: process.env.RPC_ARBITRUM || "https://arb1.arbitrum.io/rpc",
    nfpm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    stable: "USDC",
  },
  avalanche: {
    label: "Avalanche",
    rpc: process.env.RPC_AVALANCHE || "https://api.avax.network/ext/bc/C/rpc",
    nfpm: "0x655C406EBFa14EE2006250925e54ec43AD184f8B",
    factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
    stable: "USDC",
  },
  bsc: {
    label: "BSC",
    rpc: process.env.RPC_BSC || "https://bsc-dataseed.binance.org/",
    nfpm: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    masterChef: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
    cakeUsdtPool: "0x7f51c8AaA6B0599aBd16674e2b17FEc7a9f674A1",
    stable: "USDT",
  },
};

const POSITIONS_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const OWNER_ABI = ["function ownerOf(uint256) view returns (address)"];

const MC_ABI = [
  "function pendingCake(uint256) view returns (uint256)",
  "function userPositionInfos(uint256) view returns (uint256, uint256, int24, int24, uint256, uint256, address owner, uint256, uint256)",
];

const COLLECT_ABI = [
  "function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
];

const providers = {};
function provider(chain) {
  if (!providers[chain]) providers[chain] = new ethers.JsonRpcProvider(CHAINS[chain].rpc);
  return providers[chain];
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fmt(n, dec = 18, max = 6) {
  if (!isFinite(n)) return "—";
  return n.toFixed(Math.min(dec, max)).replace(/\.?0+$/, "") || "0";
}

function fmtUsd(n) {
  if (!isFinite(n)) return "—";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function tickToSqrtPrice(tick) {
  return Math.pow(1.0001, Number(tick) / 2);
}

function computeAmounts(pos, sqrtPriceX96, tickCurrent) {
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);
  tickCurrent = Number(tickCurrent);
  const L = Number(pos.liquidity);
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtLower = tickToSqrtPrice(tickLower);
  const sqrtUpper = tickToSqrtPrice(tickUpper);
  let amount0, amount1, inRange;
  if (tickCurrent < tickLower) {
    amount0 = L * (1 / sqrtLower - 1 / sqrtUpper);
    amount1 = 0;
    inRange = false;
  } else if (tickCurrent >= tickUpper) {
    amount0 = 0;
    amount1 = L * (sqrtUpper - sqrtLower);
    inRange = false;
  } else {
    amount0 = L * (1 / sqrtP - 1 / sqrtUpper);
    amount1 = L * (sqrtP - sqrtLower);
    inRange = true;
  }
  return { amount0, amount1, inRange, sqrtP };
}

async function readPosition(chain, dex, address, name, tokenId) {
  const c = CHAINS[chain];
  const p = provider(chain);

  const pm = new ethers.Contract(c.nfpm, POSITIONS_ABI, p);
  const pos = await pm.positions(tokenId);

  const t0c = new ethers.Contract(pos.token0, ERC20_ABI, p);
  const t1c = new ethers.Contract(pos.token1, ERC20_ABI, p);
  const [sym0, sym1, dec0Raw, dec1Raw] = await Promise.all([
    t0c.symbol(),
    t1c.symbol(),
    t0c.decimals(),
    t1c.decimals(),
  ]);
  const dec0 = Number(dec0Raw);
  const dec1 = Number(dec1Raw);

  const factory = new ethers.Contract(c.factory, FACTORY_ABI, p);
  const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, p);
  const slot0 = await pool.slot0();
  const tickCurrent = Number(slot0.tick);

  const amounts = computeAmounts(pos, slot0.sqrtPriceX96, tickCurrent);
  const amt0 = amounts.amount0 / 10 ** dec0;
  const amt1 = amounts.amount1 / 10 ** dec1;

  const rawPrice = amounts.sqrtP * amounts.sqrtP;
  const price = rawPrice * Math.pow(10, dec0 - dec1);

  let owner = await new ethers.Contract(c.nfpm, OWNER_ABI, p).ownerOf(tokenId);
  let collectTarget = c.nfpm;
  if (c.masterChef && owner.toLowerCase() === c.masterChef.toLowerCase()) {
    const mc = new ethers.Contract(c.masterChef, MC_ABI, p);
    const info = await mc.userPositionInfos(tokenId);
    owner = info.owner;
    collectTarget = c.masterChef;
  }

  let fee0 = 0;
  let fee1 = 0;
  try {
    const collectIface = new ethers.Interface(COLLECT_ABI);
    const calldata = collectIface.encodeFunctionData("collect", [
      { tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
    ]);
    const raw = await p.call({ to: collectTarget, from: owner, data: calldata });
    const res = collectIface.decodeFunctionResult("collect", raw);
    fee0 = Number(res[0]) / 10 ** dec0;
    fee1 = Number(res[1]) / 10 ** dec1;
  } catch {}

  const stableIs0 = sym0.toUpperCase() === c.stable;
  let valueUsd;
  let feeUsd;
  if (stableIs0) {
    valueUsd = amt0 + amt1 / price;
    feeUsd = fee0 + fee1 / price;
  } else {
    valueUsd = amt1 + amt0 * price;
    feeUsd = fee1 + fee0 * price;
  }

  let cake = null;
  if (c.masterChef) {
    try {
      const mc = new ethers.Contract(c.masterChef, MC_ABI, p);
      const pending = await mc.pendingCake(tokenId);
      if (pending > 0n) {
        const cakeDec = Number(await new ethers.Contract("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", ERC20_ABI, p).decimals());
        const cakeAmt = Number(pending) / 10 ** cakeDec;
        let cakeUsd = 0;
        try {
          const cs = await new ethers.Contract(c.cakeUsdtPool, POOL_ABI, p).slot0();
          const cakePrice = (Number(cs.sqrtPriceX96) / 2 ** 96) ** 2;
          cakeUsd = cakeAmt * cakePrice;
        } catch {}
        cake = { amount: cakeAmt, usd: cakeUsd };
      }
    } catch {}
  }

  const lowerPrice = Math.pow(1.0001, Number(pos.tickLower)) * Math.pow(10, dec0 - dec1);
  const upperPrice = Math.pow(1.0001, Number(pos.tickUpper)) * Math.pow(10, dec0 - dec1);
  const pct = Math.max(0, Math.min(100, ((tickCurrent - Number(pos.tickLower)) / (Number(pos.tickUpper) - Number(pos.tickLower))) * 100));

  return {
    dex,
    chain,
    chainLabel: c.label,
    address,
    name,
    tokenId,
    sym0,
    sym1,
    dec0,
    dec1,
    fee: Number(pos.fee),
    inRange: amounts.inRange,
    lowerPrice,
    upperPrice,
    currentPrice: price,
    amt0,
    amt1,
    fee0,
    fee1,
    valueUsd,
    feeUsd,
    cake,
    pct,
  };
}

function collectPositions() {
  const items = [];
  const names = {};

  for (const [dex, wf, pf, defaultChain] of [
    ["uniswap", "uniswap/wallets.json", "uniswap/positions.json", "arbitrum"],
  ]) {
    const wd = loadJson(path.join(ROOT, wf));
    if (wd && wd.wallets) {
      for (const w of wd.wallets) names[w.address.toLowerCase()] = w.name;
    }
    const pd = loadJson(path.join(ROOT, pf));
    if (pd && pd.positions) {
      for (const pos of pd.positions) {
        items.push({ dex, chain: pos.chain || defaultChain, address: pos.address, tokenId: pos.tokenId });
      }
    }
  }

  const wd = loadJson(path.join(ROOT, "pancakeswap/wallets.json"));
  if (wd && wd.wallets) {
    for (const w of wd.wallets) names[w.address.toLowerCase()] = w.name;
  }
  const pd = loadJson(path.join(ROOT, "pancakeswap/positions.json"));
  if (pd && pd.positions) {
    for (const pos of pd.positions) {
      items.push({ dex: "pancakeswap", chain: "bsc", address: pos.address, tokenId: pos.tokenId });
    }
  }

  return { items, names };
}

function badge(text, color) {
  return `<span class="badge" style="background:${color}">${text}</span>`;
}

function renderCard(r) {
  const dexColor = r.dex === "uniswap" ? "#ff007a" : "#1fc7d4";
  const chainColor = { arbitrum: "#12aaff", avalanche: "#e84142", bsc: "#f0b90b" }[r.chain] || "#888";

  const rangeMark = `<div class="rangebar"><div class="rangebar-fill" style="left:0%;width:${r.pct}%"></div><div class="rangebar-dot" style="left:${r.pct}%"></div></div>`;

  const cakeRow = r.cake
    ? `<div class="row"><span>Награды CAKE</span><b>${fmt(r.cake.amount, 18, 4)} CAKE · ${fmtUsd(r.cake.usd)}</b></div>`
    : "";

  return `
  <div class="card ${r.inRange ? "" : "out"}">
    <div class="card-head">
      <div>${badge(r.dex, dexColor)} ${badge(r.chainLabel, chainColor)} <span class="pair">${r.sym0}/${r.sym1}</span> <span class="fee">${r.fee / 10000}%</span></div>
      <div class="range-status ${r.inRange ? "in" : "outrange"}">${r.inRange ? "в диапазоне" : "вне диапазона"}</div>
    </div>
    <div class="sub">${r.name || ""} · ${r.address.slice(0, 6)}…${r.address.slice(-4)} · ID ${r.tokenId}</div>
    <div class="range-labels"><span>${r.lowerPrice.toPrecision(4)}</span><span>текущ. ${r.currentPrice.toPrecision(4)}</span><span>${r.upperPrice.toPrecision(4)}</span></div>
    ${rangeMark}
    <div class="rows">
      <div class="row"><span>Ликвидность</span><b>${fmt(r.amt0, r.dec0)} ${r.sym0} + ${fmt(r.amt1, r.dec1)} ${r.sym1}</b></div>
      <div class="row"><span>Накоплено комиссий</span><b>${fmt(r.fee0, r.dec0, 6)} ${r.sym0} + ${fmt(r.fee1, r.dec1, 6)} ${r.sym1}</b></div>
      ${cakeRow}
    </div>
    <div class="value">${fmtUsd(r.valueUsd)} <span class="dim">(в ${r.chain === "bsc" ? "USDT" : "USDC"})</span></div>
  </div>`;
}

function render(data) {
  const cards = data.positions.map(renderCard).join("\n");
  const totalValue = data.positions.reduce((a, r) => a + r.valueUsd, 0);
  const totalFees = data.positions.reduce((a, r) => a + r.feeUsd, 0);
  const totalCake = data.positions.reduce((a, r) => a + (r.cake ? r.cake.usd : 0), 0);
  const inRange = data.positions.filter((r) => r.inRange).length;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LP Dashboard</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0d1117; color:#e6edf3; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color:#8b949e; font-size: 13px; }
  .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:14px; margin: 20px 0; }
  .stat { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:16px; }
  .stat .k { color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .stat .v { font-size:22px; font-weight:700; margin-top:6px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(360px,1fr)); gap:16px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:14px; padding:16px; }
  .card.out { border-color:#b08800; }
  .card-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
  .badge { display:inline-block; padding:2px 8px; border-radius:6px; color:#fff; font-size:11px; font-weight:600; text-transform:capitalize; }
  .pair { font-weight:700; font-size:15px; }
  .fee { color:#8b949e; font-size:12px; }
  .range-status { font-size:12px; font-weight:600; padding:3px 8px; border-radius:6px; }
  .range-status.in { background:#12261b; color:#3fb950; }
  .range-status.outrange { background:#2a1e12; color:#d29922; }
  .sub { color:#8b949e; font-size:12px; margin:8px 0 10px; }
  .range-labels { display:flex; justify-content:space-between; font-size:11px; color:#8b949e; }
  .rangebar { position:relative; height:6px; background:#30363d; border-radius:4px; margin:6px 0 12px; }
  .rangebar-fill { position:absolute; top:0; bottom:0; background:#3fb950; border-radius:4px; }
  .rangebar-dot { position:absolute; top:-3px; width:12px; height:12px; border-radius:50%; background:#fff; transform:translateX(-6px); }
  .rows { border-top:1px solid #30363d; margin-top:4px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; font-size:13px; border-bottom:1px solid #21262d; }
  .row span { color:#8b949e; }
  .value { margin-top:12px; font-size:20px; font-weight:700; }
  .dim { color:#8b949e; font-size:12px; font-weight:400; }
</style>
</head>
<body>
<div class="wrap">
  <h1>LP Dashboard</h1>
  <div class="muted">Обновлено: ${data.generated}</div>
  <div class="stats">
    <div class="stat"><div class="k">Стоимость ликвидности</div><div class="v">${fmtUsd(totalValue)}</div></div>
    <div class="stat"><div class="k">Накоплено комиссий</div><div class="v">${fmtUsd(totalFees)}</div></div>
    <div class="stat"><div class="k">Награды CAKE</div><div class="v">${fmtUsd(totalCake)}</div></div>
    <div class="stat"><div class="k">Позиции (в диапазоне)</div><div class="v">${data.positions.length} (${inRange})</div></div>
  </div>
  <div class="grid">${cards}</div>
</div>
</body>
</html>`;
}

async function main() {
  const { items, names } = collectPositions();

  const results = [];
  for (const it of items) {
    if (!it.address || !it.tokenId) continue;
    try {
      const r = await readPosition(it.chain, it.dex, it.address, names[it.address.toLowerCase()], it.tokenId);
      results.push(r);
    } catch (e) {
      console.error(`skip ${it.dex} ${it.chain} #${it.tokenId}:`, e.shortMessage || e.message);
    }
  }

  results.sort((a, b) => b.valueUsd - a.valueUsd);

  const html = render({ positions: results, generated: new Date().toLocaleString("ru-RU") });
  const out = path.join(__dirname, "index.html");
  fs.writeFileSync(out, html);
  console.log(`Готово: ${results.length} позиций -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
