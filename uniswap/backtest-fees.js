const { ethers } = require("ethers");
const { CHAINS } = require("./lib");

const POOL = "0xc6962004f452be9203591991d15f6b388e09e8d0"; // Arbitrum WETH/USDC 0.05%
const FEE = 0.0005;
const DAY = 86_400;
const SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,int16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
];
const coder = ethers.AbiCoder.defaultAbiCoder();

function usage() {
  console.log(`
Бэктест комиссий Uniswap V3 Arbitrum WETH/USDC 0.05%.

Использование:
  node backtest-fees.js --from 2026-08-30 --to 2026-09-05 --capital 100

Опции:
  --from YYYY-MM-DD      Первая дата UTC (обязательно)
  --to YYYY-MM-DD        Последняя дата UTC включительно (обязательно)
  --capital USD          Размер одной позиции, по умолчанию 100
  --rpc URL              Архивный RPC Arbitrum; также читается RPC_ARBITRUM
  --liquidity end        Ликвидность пула на конец каждого дня (по умолчанию)
  --liquidity current    Грубая оценка с текущей ликвидностью, не для точных выводов
  --block-step N         Размер порции блоков для getLogs, по умолчанию 8000

Диапазон позиции для каждого дня автоматически берётся как минимум и максимум
ETH/USDT с Binance за этот день. Это оценка комиссии, а не точный PnL:
она не моделирует изменение ликвидности конкурентов внутри дня и не учитывает газ.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function assertDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} должен быть датой YYYY-MM-DD`);
  }
}

function dateToTimestamp(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(label, fn) {
  let error;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let timeout;
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${label}: таймаут RPC`)), 45_000);
        }),
      ]);
    } catch (err) {
      error = err;
      if (attempt < 4) await sleep(attempt * 1_500);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label}: ${error.shortMessage || error.message}`);
}

async function blockAt(provider, timestamp, latestBlock) {
  let lo = 1;
  let hi = latestBlock;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const block = await retry(`блок ${mid}`, () => provider.getBlock(mid));
    if (Number(block.timestamp) <= timestamp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function binanceDay(date) {
  const start = dateToTimestamp(date) * 1000;
  const url = `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&startTime=${start}&limit=1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
  const [candle] = await response.json();
  if (!candle) throw new Error(`Binance не вернул свечу ETHUSDT за ${date}`);
  return { low: Number(candle[3]), high: Number(candle[2]) };
}

function priceFromSqrt(sqrtPriceX96) {
  // token0 is WETH (18), token1 is USDC (6): convert raw ratio to USDC/WETH.
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  return sqrt * sqrt * 1e12;
}

function positionLiquidity(low, high, price, capital) {
  if (!(low < price && price < high)) {
    throw new Error(`цена открытия $${price.toFixed(2)} вне диапазона $${low}-$${high}`);
  }
  // Same raw-unit formulas as Uniswap V3, so this is comparable with pool.liquidity().
  const sqrtLow = Math.sqrt(low) * 1e-6;
  const sqrtHigh = Math.sqrt(high) * 1e-6;
  const sqrtPrice = Math.sqrt(price) * 1e-6;
  const amount0PerL = (sqrtHigh - sqrtPrice) / (sqrtPrice * sqrtHigh);
  const amount1PerL = sqrtPrice - sqrtLow;
  const usdPerL = amount0PerL / 1e18 * price + amount1PerL / 1e6;
  return capital / usdPerL;
}

async function swapsAndFees(provider, fromBlock, toBlock, step) {
  let feesUsd = 0;
  let swaps = 0;
  let firstPrice;
  for (let from = fromBlock; from <= toBlock; from += step) {
    const to = Math.min(from + step - 1, toBlock);
    const logs = await retry(`логи ${from}-${to}`, () => provider.getLogs({
      address: POOL,
      topics: [SWAP_TOPIC],
      fromBlock: from,
      toBlock: to,
    }));
    for (const log of logs) {
      const [amount0, amount1, sqrtPriceX96] = coder.decode(
        ["int256", "int256", "uint160", "uint128", "int24"],
        log.data,
      );
      const price = priceFromSqrt(sqrtPriceX96);
      firstPrice ??= price;
      // A positive pool delta is the input token, including the swap fee.
      const inputUsd = amount1 > 0n
        ? Number(amount1) / 1e6
        : Number(amount0) / 1e18 * price;
      feesUsd += inputUsd * FEE;
      swaps++;
    }
  }
  if (!firstPrice) throw new Error("за этот день в пуле не найдено Swap-событий");
  return { feesUsd, swaps, firstPrice };
}

function eachDay(from, to) {
  const result = [];
  for (let current = dateToTimestamp(from), last = dateToTimestamp(to); current <= last; current += DAY) {
    result.push(new Date(current * 1000).toISOString().slice(0, 10));
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.from || !args.to) {
    usage();
    return;
  }
  assertDate(args.from, "--from");
  assertDate(args.to, "--to");
  if (args.from > args.to) throw new Error("--from не может быть позже --to");

  const capital = Number(args.capital || 100);
  const step = Number(args["block-step"] || 8_000);
  const liquidityMode = args.liquidity || "end";
  if (!(capital > 0) || !(step > 0)) throw new Error("--capital и --block-step должны быть положительными");
  if (!["end", "current"].includes(liquidityMode)) throw new Error("--liquidity: end или current");

  const rpc = args.rpc || process.env.RPC_ARBITRUM || CHAINS.arbitrum.rpc;
  const provider = new ethers.JsonRpcProvider(rpc, CHAINS.arbitrum.chainId, { staticNetwork: true });
  const pool = new ethers.Contract(POOL, ABI, provider);
  const latestBlock = await retry("последний блок", () => provider.getBlockNumber());
  const currentLiquidity = liquidityMode === "current"
    ? Number(await retry("текущая ликвидность", () => pool.liquidity()))
    : null;

  console.log(`пул: ${POOL}`);
  console.log(`капитал на день: $${capital}`);
  console.log(`RPC: ${rpc.replace(/\/v2\/.+$/, "/v2/***")}`);
  console.log(`ликвидность: ${liquidityMode === "end" ? "на конец дня (нужен архивный RPC)" : "текущая, грубая оценка"}\n`);

  const rows = [];
  for (const day of eachDay(args.from, args.to)) {
    const startTimestamp = dateToTimestamp(day);
    const endTimestamp = startTimestamp + DAY - 1;
    const [fromBlock, toBlock, range] = await Promise.all([
      blockAt(provider, startTimestamp, latestBlock),
      blockAt(provider, endTimestamp, latestBlock),
      binanceDay(day),
    ]);
    const swaps = await swapsAndFees(provider, fromBlock, toBlock, step);
    const poolLiquidity = liquidityMode === "end"
      ? Number(await retry(`ликвидность ${day}`, () => pool.liquidity({ blockTag: toBlock })))
      : currentLiquidity;
    const positionL = positionLiquidity(range.low, range.high, swaps.firstPrice, capital);
    const estimatedFees = swaps.feesUsd * positionL / poolLiquidity;
    const row = { day, ...range, startPrice: swaps.firstPrice, swaps: swaps.swaps, poolFeesUsd: swaps.feesUsd, estimatedFeesUsd: estimatedFees };
    rows.push(row);
    console.log(`${day} | $${range.low.toFixed(2)}-$${range.high.toFixed(2)} | свапов ${swaps.swaps} | пул $${swaps.feesUsd.toFixed(2)} | позиция ~$${estimatedFees.toFixed(4)}`);
  }

  const total = rows.reduce((sum, row) => sum + row.estimatedFeesUsd, 0);
  console.log(`\nИтого комиссий: ~$${total.toFixed(4)} (${(total / capital * 100).toFixed(3)}% от одного дневного капитала)`);
  console.log("Это валовые комиссии: газ, проскальзывание первоначального свопа и impermanent loss не учтены.");
}

main().catch((error) => {
  console.error(`ошибка: ${error.message}`);
  if (/missing trie node|metadata is not found|historical|archive/i.test(error.message)) {
    console.error("Нужен архивный Arbitrum RPC. Укажите его через RPC_ARBITRUM или --rpc.");
  }
  process.exitCode = 1;
});
