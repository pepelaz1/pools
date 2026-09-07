#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS, promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const POSITIONS_FILE = path.join(__dirname, "positions.json");
const DRY_RUN = process.argv.includes("--dry-run");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];
const POOL_ABI = [
  "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function tickSpacing() view returns(int24)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160,uint32,uint256)",
];
const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut)",
];
const PM_ABI = [
  "function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) returns(uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
];

function usage() {
  console.log("использование: node open-position.js [--dry-run] <цена нативного токена от> <цена до> <сумма USDC> [arbitrum|avalanche]");
  console.log("пример: node open-position.js 2300 2500 500 arbitrum");
}

function parseArgs() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
  if (args.length < 3 || args.length > 4) {
    usage();
    process.exit(1);
  }
  const [fromRaw, toRaw, amountRaw, chain = "arbitrum"] = args;
  const priceFrom = Number(fromRaw);
  const priceTo = Number(toRaw);
  const amount = Number(amountRaw);
  if (!Number.isFinite(priceFrom) || !Number.isFinite(priceTo) || !Number.isFinite(amount) || priceFrom <= 0 || priceTo <= priceFrom || amount <= 0) {
    console.error("цены и сумма должны быть положительными; цена 'до' должна быть больше цены 'от'.");
    process.exit(1);
  }
  if (!CHAINS[chain]) {
    console.error(`неизвестная сеть: ${chain}`);
    process.exit(1);
  }
  return { priceFrom, priceTo, amount, chain };
}

function alignTicks(tickA, tickB, spacing) {
  const lower = Math.min(tickA, tickB);
  const upper = Math.max(tickA, tickB);
  return {
    tickLower: Math.floor(lower / spacing) * spacing,
    tickUpper: Math.ceil(upper / spacing) * spacing,
  };
}

function writePosition(address, tokenId, chain, opened) {
  let data = { toAddress: address, positions: [] };
  if (fs.existsSync(POSITIONS_FILE)) data = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  if (!Array.isArray(data.positions)) data.positions = [];
  if (!data.positions.some((item) => String(item.tokenId) === String(tokenId) && item.chain === chain)) {
    data.positions.push({ address, tokenId: Number(tokenId), chain, opened });
  }
  const temporary = `${POSITIONS_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporary, POSITIONS_FILE);
}

async function main() {
  const { priceFrom, priceTo, amount, chain } = parseArgs();
  const cfg = CHAINS[chain];
  if (!fs.existsSync(WALLETS_FILE)) throw new Error("wallets.json не найден. Сначала запустите: node setup.js");

  const password = await promptHidden("мастер-пароль: ");
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  if (!wallets[0]?.keystore) throw new Error("не найден keystore в wallets.json");

  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  const wallet = (await ethers.Wallet.fromEncryptedJson(wallets[0].keystore, password)).connect(provider);
  const [token0, token1] = [cfg.stable, cfg.native].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const stableIs0 = token0.toLowerCase() === cfg.stable.toLowerCase();

  const [stable, native] = [
    new ethers.Contract(cfg.stable, ERC20_ABI, wallet),
    new ethers.Contract(cfg.native, ERC20_ABI, wallet),
  ];
  const [stableDecRaw, nativeDecRaw, stableBalance, nativeBalance, gasBalance] = await Promise.all([
    stable.decimals(), native.decimals(), stable.balanceOf(wallet.address), native.balanceOf(wallet.address), provider.getBalance(wallet.address),
  ]);
  const stableDec = Number(stableDecRaw);
  const nativeDec = Number(nativeDecRaw);
  const budget = ethers.parseUnits(String(amount), stableDec);

  console.log(`\n${DRY_RUN ? "=== DRY RUN ===" : "=== MAINNET ==="}`);
  console.log(`сеть: ${chain}; кошелёк: ${wallet.address}`);
  console.log(`диапазон: $${priceFrom} - $${priceTo} за ${cfg.nativeName}`);
  console.log(`сумма: ${amount} ${cfg.stableName}`);
  console.log(`балансы: ${ethers.formatUnits(stableBalance, stableDec)} ${cfg.stableName}; ${ethers.formatUnits(nativeBalance, nativeDec)} ${cfg.nativeName}; газ ${ethers.formatEther(gasBalance)}`);
  if (stableBalance < budget) throw new Error(`недостаточно ${cfg.stableName}`);

  const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(token0, token1, cfg.defaultFee);
  if (poolAddress === ethers.ZeroAddress) throw new Error("пул WETH/USDC с выбранной комиссией не найден");
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [slot0, spacingRaw] = await Promise.all([pool.slot0(), pool.tickSpacing()]);
  const spacing = Number(spacingRaw);

  // The pool price is token1/token0 in raw units; users enter USD per ETH/WETH.
  const rawForUsd = (usd) => {
    const token1PerToken0 = stableIs0 ? 1 / usd : usd;
    return token1PerToken0 / Math.pow(10, stableIs0 ? stableDec - nativeDec : nativeDec - stableDec);
  };
  const tickForUsd = (usd) => Math.log(rawForUsd(usd)) / Math.log(1.0001);
  const { tickLower, tickUpper } = alignTicks(tickForUsd(priceFrom), tickForUsd(priceTo), spacing);
  const currentTick = Number(slot0.tick);
  console.log(`пул: ${poolAddress}; тики: [${tickLower}, ${tickUpper}], текущий: ${currentTick}`);

  let stableToMint = budget;
  let stableToSwap = 0n;
  let nativeTarget = 0n;
  const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
  const quoteNative = async (stableIn) => (await quoter.quoteExactInputSingle.staticCall({
    tokenIn: cfg.stable, tokenOut: cfg.native, amountIn: stableIn, fee: cfg.defaultFee, sqrtPriceLimitX96: 0,
  }))[0];

  const stableIsToken0 = stableIs0;
  const nativeOnly = (currentTick < tickLower && !stableIsToken0) || (currentTick >= tickUpper && stableIsToken0);
  const stableOnly = (currentTick < tickLower && stableIsToken0) || (currentTick >= tickUpper && !stableIsToken0);
  if (nativeOnly) {
    stableToMint = 0n;
    stableToSwap = budget;
    nativeTarget = await quoteNative(budget);
    console.log("позиция вне диапазона: будет целиком в WETH/WAVAX");
  } else if (stableOnly) {
    console.log("позиция вне диапазона: будет целиком в USDC");
  } else {
    const sqrtCurrent = Number(slot0.sqrtPriceX96) / 2 ** 96;
    const sqrtLower = Math.pow(1.0001, tickLower / 2);
    const sqrtUpper = Math.pow(1.0001, tickUpper / 2);
    const amount0PerLiquidity = 1 / sqrtCurrent - 1 / sqrtUpper;
    const amount1PerLiquidity = sqrtCurrent - sqrtLower;
    const token1PerToken0 = amount1PerLiquidity / amount0PerLiquidity;
    const nativePerStable = stableIs0
      ? token1PerToken0 * Math.pow(10, stableDec - nativeDec)
      : Math.pow(10, nativeDec - stableDec) / token1PerToken0;
    let low = 0n;
    let high = budget;
    for (let attempt = 0; attempt < 24 && low < high; attempt += 1) {
      const candidate = (low + high) / 2n;
      const remainingStable = budget - candidate;
      const requiredNative = ethers.parseUnits(
        (Number(ethers.formatUnits(remainingStable, stableDec)) * nativePerStable).toFixed(nativeDec), nativeDec,
      );
      if (await quoteNative(candidate) >= requiredNative) high = candidate;
      else low = candidate + 1n;
    }
    stableToSwap = high;
    stableToMint = budget - high;
    nativeTarget = await quoteNative(high);
    console.log("позиция в диапазоне: пропорция USDC/WETH подобрана по котировке пула");
  }
  console.log(`для mint: ${ethers.formatUnits(stableToMint, stableDec)} ${cfg.stableName}; ожидается ${ethers.formatUnits(nativeTarget, nativeDec)} ${cfg.nativeName}`);
  if (DRY_RUN) return;

  if (await stable.allowance(wallet.address, cfg.swapRouter) < budget) await (await stable.approve(cfg.swapRouter, ethers.MaxUint256)).wait();
  if (await stable.allowance(wallet.address, cfg.positionManager) < budget) await (await stable.approve(cfg.positionManager, ethers.MaxUint256)).wait();
  if (await native.allowance(wallet.address, cfg.positionManager) < nativeTarget) await (await native.approve(cfg.positionManager, ethers.MaxUint256)).wait();

  let nativeReceived = 0n;
  if (stableToSwap > 0n) {
    const before = await native.balanceOf(wallet.address);
    const router = new ethers.Contract(cfg.swapRouter, ROUTER_ABI, wallet);
    const minimum = (await quoteNative(stableToSwap)) * BigInt(10000 - SLIPPAGE_BPS) / 10000n;
    await (await router.exactInputSingle({ tokenIn: cfg.stable, tokenOut: cfg.native, fee: cfg.defaultFee, recipient: wallet.address, amountIn: stableToSwap, amountOutMinimum: minimum, sqrtPriceLimitX96: 0 })).wait();
    nativeReceived = (await native.balanceOf(wallet.address)) - before;
  }

  const amount0Desired = stableIs0 ? stableToMint : nativeReceived;
  const amount1Desired = stableIs0 ? nativeReceived : stableToMint;
  const pm = new ethers.Contract(cfg.positionManager, PM_ABI, wallet);
  const mintParams = { token0, token1, fee: cfg.defaultFee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min: 0, amount1Min: 0, recipient: wallet.address, deadline: Math.floor(Date.now() / 1000) + 1800 };
  const preview = await pm.mint.staticCall(mintParams);
  const tx = await pm.mint(mintParams);
  const receipt = await tx.wait();
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const log = receipt.logs.find((entry) => entry.address.toLowerCase() === cfg.positionManager.toLowerCase() && entry.topics[0] === transferTopic && entry.topics[1] === ethers.ZeroHash);
  if (!log) throw new Error(`позиция создана, но tokenId не найден: ${receipt.hash}`);
  const tokenId = BigInt(log.topics[3]);
  const increase = receipt.logs.find((entry) => {
    try {
      return entry.address.toLowerCase() === cfg.positionManager.toLowerCase()
        && pm.interface.parseLog(entry)?.name === "IncreaseLiquidity";
    } catch {
      return false;
    }
  });
  const actual = increase ? pm.interface.parseLog(increase).args : preview;
  const [openingSlot0, amount0Raw, amount1Raw] = await Promise.all([pool.slot0(), actual.amount0, actual.amount1]);
  const dec0 = stableIs0 ? stableDec : nativeDec;
  const dec1 = stableIs0 ? nativeDec : stableDec;
  const amount0 = Number(ethers.formatUnits(amount0Raw, dec0));
  const amount1 = Number(ethers.formatUnits(amount1Raw, dec1));
  const openingPrice = (Number(openingSlot0.sqrtPriceX96) / 2 ** 96) ** 2 * Math.pow(10, dec0 - dec1);
  const initialValueUsd = stableIs0 ? amount0 + amount1 / openingPrice : amount1 + amount0 * openingPrice;
  writePosition(wallet.address, tokenId, chain, {
    at: new Date().toISOString(),
    price: openingPrice,
    amount0: ethers.formatUnits(amount0Raw, dec0),
    amount1: ethers.formatUnits(amount1Raw, dec1),
    valueUsd: initialValueUsd,
  });
  console.log(`готово. tokenId ${tokenId} сохранён в positions.json`);
}

main().catch((error) => { console.error("ошибка:", error.shortMessage || error.message); process.exit(1); });
