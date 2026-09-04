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
    native: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    nativeSym: "ETH",
    stableToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    nativePoolFee: 500,
  },
  avalanche: {
    label: "Avalanche",
    rpc: process.env.RPC_AVALANCHE || "https://api.avax.network/ext/bc/C/rpc",
    nfpm: "0x655C406EBFa14EE2006250925e54ec43AD184f8B",
    factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
    stable: "USDC",
    native: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    nativeSym: "AVAX",
    stableToken: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    nativePoolFee: 500,
  },
  bsc: {
    label: "BSC",
    rpc: process.env.RPC_BSC || "https://bsc-dataseed.binance.org/",
    nfpm: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    masterChef: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
    cakeUsdtPool: "0x7f51c8AaA6B0599aBd16674e2b17FEc7a9f674A1",
    stable: "USDT",
    native: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    nativeSym: "BNB",
    stableToken: "0x55d398326f99059fF775485246999027B3197955",
    nativePoolFee: 100,
  },
};

const POSITIONS_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
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

function tickToSqrtPrice(tick) {
  return Math.pow(1.0001, Number(tick) / 2);
}

function valueInStable(amt0, amt1, price, stableIs0) {
  return stableIs0 ? amt0 + amt1 / price : amt1 + amt0 * price;
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

function collectItems() {
  const items = [];
  const names = {};

  const wd = loadJson(path.join(ROOT, "uniswap/wallets.json"));
  if (wd && wd.wallets) {
    for (const w of wd.wallets) names[w.address.toLowerCase()] = w.name;
  }
  const pd = loadJson(path.join(ROOT, "uniswap/positions.json"));
  if (pd && pd.positions) {
    for (const pos of pd.positions) {
      items.push({ dex: "uniswap", chain: pos.chain || "arbitrum", address: pos.address, tokenId: pos.tokenId });
    }
  }

  const wd2 = loadJson(path.join(ROOT, "pancakeswap/wallets.json"));
  if (wd2 && wd2.wallets) {
    for (const w of wd2.wallets) names[w.address.toLowerCase()] = w.name;
  }
  const pd2 = loadJson(path.join(ROOT, "pancakeswap/positions.json"));
  if (pd2 && pd2.positions) {
    for (const pos of pd2.positions) {
      items.push({ dex: "pancakeswap", chain: "bsc", address: pos.address, tokenId: pos.tokenId });
    }
  }

  const result = [];
  for (const it of items) {
    if (!it.address || !it.tokenId) continue;
    it.name = names[it.address.toLowerCase()] || "";
    it.id = `${it.dex}:${it.chain}:${it.tokenId}`;
    result.push(it);
  }
  return result;
}

async function readPosition(item) {
  const { chain, dex, address, name, tokenId } = item;
  const c = CHAINS[chain];
  const p = provider(chain);

  const pm = new ethers.Contract(c.nfpm, POSITIONS_ABI, p);
  const pos = await pm.positions(tokenId);

  if (pos.liquidity === 0n) return null;

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
  const valueUsd = valueInStable(amt0, amt1, price, stableIs0);
  const feeUsd = valueInStable(fee0, fee1, price, stableIs0);

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
    id: item.id,
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
    stableIs0,
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

async function getPrices() {
  const result = {};
  for (const [key, c] of Object.entries(CHAINS)) {
    try {
      const p = provider(key);
      const factory = new ethers.Contract(c.factory, FACTORY_ABI, p);
      const poolAddr = await factory.getPool(c.native, c.stableToken, c.nativePoolFee);
      const pool = new ethers.Contract(poolAddr, POOL_ABI, p);
      const [slot0, token0] = await Promise.all([pool.slot0(), pool.token0()]);
      const dec0 = Number(await new ethers.Contract(token0, ERC20_ABI, p).decimals());
      const dec1 = Number(await new ethers.Contract(c.stableToken, ERC20_ABI, p).decimals());
      const rawPrice = (Number(slot0.sqrtPriceX96) / 2 ** 96) ** 2;
      const humanPrice = rawPrice * Math.pow(10, dec0 - dec1);
      const nativeIs0 = token0.toLowerCase() === c.native.toLowerCase();
      result[key] = { sym: c.nativeSym, price: nativeIs0 ? humanPrice : 1 / humanPrice };
    } catch {
      result[key] = { sym: c.nativeSym, price: null };
    }
  }
  return result;
}

module.exports = { CHAINS, collectItems, readPosition, getPrices, valueInStable };
