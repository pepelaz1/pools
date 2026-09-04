#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");

const DRY_RUN = process.argv.includes("--dry-run");

const CFG = {
  rpc: "https://bsc-dataseed.binance.org/",
  chainId: 56,
  swapRouter: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
  positionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  masterChef: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
  factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  fee: 100,
};

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const PM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function setApprovalForAll(address,bool) returns (bool)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function getApproved(uint256) view returns (address)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const MC_ABI = [
  "function mint(uint256 tokenId) external",
];

function priceToTick(price) {
  return Math.round(Math.log(price) / Math.log(1.0001));
}

function parseArgs() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (args.length < 3) {
    console.log("использование: node open-position.js [--dry-run] <цена от> <цена до> <сумма USDT>");
    console.log("пример: node open-position.js 680 730 500");
    console.log("        node open-position.js --dry-run 680 730 1");
    process.exit(1);
  }

  const priceFrom = parseFloat(args[0]);
  const priceTo = parseFloat(args[1]);
  const amountUsd = parseFloat(args[2]);

  if (priceFrom >= priceTo) {
    console.log("цена 'от' должна быть меньше цены 'до'");
    process.exit(1);
  }

  const tickLower = priceToTick(1 / priceTo);
  const tickUpper = priceToTick(1 / priceFrom);

  return { tickLower, tickUpper, amountUsd, priceFrom, priceTo };
}

let wallet;

async function main() {
  const { tickLower, tickUpper, amountUsd, priceFrom, priceTo } = parseArgs();

  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(KEYSTORE, "utf8"));
  const keystore = walletsRaw.wallets[0].keystore;
  const provider = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId);
  wallet = (await ethers.Wallet.fromEncryptedJson(keystore, password)).connect(provider);

  console.log(`\n${DRY_RUN ? "=== DRY RUN ===" : "=== MAINNET ==="}`);
  console.log(`кошелёк: ${wallet.address}`);
  console.log(`диапазон: $${priceFrom} - $${priceTo}`);
  console.log(`тики: [${tickLower}, ${tickUpper}]`);
  console.log(`сумма: ${amountUsd} USDT`);

  const [t0, t1] = CFG.usdt.toLowerCase() < CFG.wbnb.toLowerCase()
    ? [CFG.usdt, CFG.wbnb]
    : [CFG.wbnb, CFG.usdt];
  const usdtIs0 = CFG.usdt.toLowerCase() === t0.toLowerCase();

  const amountIn = ethers.parseUnits(amountUsd.toString(), 18);
  const halfAmount = amountIn / 2n;

  // проверки балансов
  const usdtC = new ethers.Contract(CFG.usdt, ERC20_ABI, wallet);
  const wbnbC = new ethers.Contract(CFG.wbnb, ERC20_ABI, wallet);
  const [usdtBal, wbnbBal, bnbBal] = await Promise.all([
    usdtC.balanceOf(wallet.address),
    wbnbC.balanceOf(wallet.address),
    provider.getBalance(wallet.address),
  ]);
  console.log(`\nбалансы:`);
  console.log(`  USDT: ${ethers.formatUnits(usdtBal, 18)}`);
  console.log(`  WBNB: ${ethers.formatUnits(wbnbBal, 18)}`);
  console.log(`  BNB: ${ethers.formatEther(bnbBal)}`);

  if (usdtBal < amountIn) {
    console.log(`\nнедостаточно USDT (нужно ${amountUsd}, есть ${ethers.formatUnits(usdtBal, 18)})`);
    process.exit(1);
  }
  if (bnbBal < ethers.parseEther("0.005")) {
    console.log("\nнедостаточно BNB на газ");
    process.exit(1);
  }

  // котировка
  const quoter = new ethers.Contract("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", QUOTER_ABI, provider);
  const quoteRes = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: CFG.usdt,
    tokenOut: CFG.wbnb,
    amountIn: halfAmount,
    fee: CFG.fee,
    sqrtPriceLimitX96: 0,
  });
  const wbnbExpected = quoteRes.amountOut;
  console.log(`\nкотировка: ${ethers.formatUnits(halfAmount, 18)} USDT -> ${ethers.formatUnits(wbnbExpected, 18)} WBNB`);

  // pool check
  const f = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);
  const poolAddr = await f.getPool(t0, t1, CFG.fee);
  if (poolAddr === ethers.ZeroAddress) {
    console.log("\nпул не найден!");
    process.exit(1);
  }
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
  console.log(`пул: ${poolAddr}`);
  console.log(`  tick: ${slot0.tick}, liquidity: ${liq}`);

  if (DRY_RUN) {
    console.log("\n=== dry run завершён, всё ок ===");
    return;
  }

  // 1. approve USDT для swapRouter И positionManager
  const currentAllowanceSwap = await usdtC.allowance(wallet.address, CFG.swapRouter);
  if (currentAllowanceSwap < amountIn) {
    console.log("\n1. approve USDT для swapRouter...");
    await (await usdtC.approve(CFG.swapRouter, ethers.MaxUint256)).wait();
    console.log("   approve ok");
  }

  const currentAllowancePM = await usdtC.allowance(wallet.address, CFG.positionManager);
  if (currentAllowancePM < amountIn) {
    console.log("   approve USDT для positionManager...");
    await (await usdtC.approve(CFG.positionManager, ethers.MaxUint256)).wait();
    console.log("   approve ok");
  }

  // 1b. approve WBNB для positionManager
  const wbnbAllowance = await wbnbC.allowance(wallet.address, CFG.positionManager);
  if (wbnbAllowance < ethers.parseUnits("1", 18)) {
    console.log("   approve WBNB для positionManager...");
    await (await wbnbC.approve(CFG.positionManager, ethers.MaxUint256)).wait();
    console.log("   approve ok");
  }

  // 2. swap half USDT -> WBNB (через fee=500 пул)
  console.log("2. свап USDT -> WBNB...");
  const wbnbBefore = await wbnbC.balanceOf(wallet.address);
  const router = new ethers.Contract(CFG.swapRouter, ROUTER_ABI, wallet);
  await (await router.exactInputSingle({
    tokenIn: CFG.usdt,
    tokenOut: CFG.wbnb,
    fee: 500,
    recipient: wallet.address,
    amountIn: halfAmount,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  })).wait();
  const wbnbAfter = await wbnbC.balanceOf(wallet.address);
  const wbnbReceived = wbnbAfter - wbnbBefore;
  console.log(`   получено: ${ethers.formatUnits(wbnbReceived, 18)} WBNB`);

  // 3. mint position
  console.log("3. создаю позицию...");
  const usdtLeft = amountIn - halfAmount;

  // Рассчитываем пропорции по текущей цене пула
  // pool sqrtPriceX96 = sqrt(price * 2^192), price = token1/token0
  const sqrtPrice = slot0.sqrtPriceX96;
  const Q96 = 2n ** 96n;

  let amount0Desired, amount1Desired;
  if (usdtIs0) {
    // price = WBNB/USDT = (sqrtPrice/2^96)^2
    // amount1 (WBNB) = amount0 (USDT) * price
    const priceNum = sqrtPrice * sqrtPrice;
    const priceDen = Q96 * Q96;
    amount0Desired = usdtLeft;
    amount1Desired = (usdtLeft * priceNum) / priceDen;
    if (amount1Desired > wbnbReceived) {
      // Ограничиваем по WBNB
      amount1Desired = wbnbReceived;
      amount0Desired = (wbnbReceived * priceDen) / priceNum;
    }
  } else {
    const priceNum = sqrtPrice * sqrtPrice;
    const priceDen = Q96 * Q96;
    amount1Desired = usdtLeft;
    amount0Desired = (usdtLeft * priceDen) / priceNum;
    if (amount0Desired > wbnbReceived) {
      amount0Desired = wbnbReceived;
      amount1Desired = (wbnbReceived * priceNum) / priceDen;
    }
  }
  console.log(`   USDT: ${ethers.formatUnits(amount0Desired, 18)}, WBNB: ${ethers.formatUnits(amount1Desired, 18)}`);

  const pm = new ethers.Contract(CFG.positionManager, PM_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const mintTx = await pm.mint({
    token0: t0,
    token1: t1,
    fee: CFG.fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: 0,
    amount1Min: 0,
    recipient: wallet.address,
    deadline,
  });
  const mintReceipt = await mintTx.wait();

  let tokenId = null;
  for (const log of mintReceipt.logs) {
    if (log.address.toLowerCase() === CFG.positionManager.toLowerCase() && log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
      tokenId = BigInt(log.topics[3]);
      break;
    }
  }
  if (!tokenId) {
    console.log("   не удалось извлечь tokenId");
    console.log("   tx:", mintReceipt.hash);
    process.exit(1);
  }
  console.log(`   tokenId: ${tokenId}`);

  // 4. stake
  console.log("4. стейкаю в MasterChef...");
  const isApproved = await pm.isApprovedForAll(wallet.address, CFG.masterChef);
  if (!isApproved) {
    await (await pm.setApprovalForAll(CFG.masterChef, true)).wait();
    console.log("   approveAll ok");
  }
  const mc = new ethers.Contract(CFG.masterChef, MC_ABI, wallet);
  await (await mc.mint(tokenId)).wait();
  console.log("   стейкинг ok");

  console.log(`\n=== готово ===`);
  console.log(`tokenId: ${tokenId}`);
  console.log(`добавьте в positions.json:`);
  console.log(JSON.stringify({ address: wallet.address, tokenId: Number(tokenId) }, null, 2));
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
