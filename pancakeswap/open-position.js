#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");
const POSITIONS = path.join(__dirname, "positions.json");

const DRY_RUN = process.argv.includes("--dry-run");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const TX_ATTEMPTS = Math.max(1, Number(process.env.TX_ATTEMPTS) || 3);

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

const WBNB_ABI = [
  "function deposit() payable",
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
  "function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function setApprovalForAll(address,bool) returns (bool)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function getApproved(uint256) view returns (address)",
  "function safeTransferFrom(address,address,uint256)",
  "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function ownerOf(uint256) view returns (address)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

function priceToTick(price) {
  return Math.round(Math.log(price) / Math.log(1.0001));
}

function tickToSqrtPrice(tick) {
  const base = BigInt(Math.round(1.0001 * 1e18));
  const exp = tick < 0 ? BigInt(-tick) : BigInt(tick);
  let result = BigInt(1e18);
  let basePow = base;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = result * basePow / BigInt(1e18);
    basePow = basePow * basePow / BigInt(1e18);
    e >>= 1n;
  }
  if (tick < 0) result = BigInt(1e36) / result;
  return BigInt(Math.round(Math.sqrt(Number(result)) * 65536));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function swapWithRetries({ router, quoter, wallet, amountIn, tokenIn = CFG.usdt, tokenOut = CFG.wbnb }) {
  let lastError;
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt += 1) {
    try {
      const quote = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn,
        fee: CFG.fee,
        sqrtPriceLimitX96: 0,
      });
      const params = {
        tokenIn,
        tokenOut,
        fee: CFG.fee,
        recipient: wallet.address,
        amountIn,
        amountOutMinimum: quote.amountOut * BigInt(10000 - SLIPPAGE_BPS) / 10000n,
        sqrtPriceLimitX96: 0,
      };
      // A failed simulation spends no gas and avoids broadcasting a known-bad swap.
      await router.exactInputSingle.staticCall(params);
      const estimatedGas = await router.exactInputSingle.estimateGas(params);
      const tx = await router.exactInputSingle(params, { gasLimit: estimatedGas * 120n / 100n });
      console.log(`   tx: ${tx.hash}`);
      await tx.wait();
      return;
    } catch (error) {
      lastError = error;
      const retryable = error.code === "CALL_EXCEPTION" || /transaction execution reverted/i.test(error.message || "");
      if (!retryable || attempt === TX_ATTEMPTS) throw error;
      console.log(`   попытка ${attempt}/${TX_ATTEMPTS} откатилась; повторяю через ${attempt * 2} с...`);
      await sleep(attempt * 2_000);
    }
  }
  throw lastError;
}

async function mintWithRetries(pm, mintParams) {
  let lastError;
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt += 1) {
    try {
      const preview = await pm.mint.staticCall(mintParams);
      console.log(`   preview: amount0=${ethers.formatUnits(preview.amount0, 18)}, amount1=${ethers.formatUnits(preview.amount1, 18)}`);
      const estimatedGas = await pm.mint.estimateGas(mintParams);
      const tx = await pm.mint(mintParams, { gasLimit: estimatedGas * 120n / 100n });
      console.log(`   tx: ${tx.hash}`);
      const receipt = await tx.wait();
      return { preview, receipt };
    } catch (error) {
      lastError = error;
      const retryable = error.code === "CALL_EXCEPTION" || /transaction execution reverted/i.test(error.message || "");
      if (!retryable || attempt === TX_ATTEMPTS) throw error;
      console.log(`   mint попытка ${attempt}/${TX_ATTEMPTS} откатилась; повторяю через ${attempt * 2} с...`);
      await sleep(attempt * 2_000);
    }
  }
  throw lastError;
}

async function increaseWithRetries(pm, increaseParams) {
  let lastError;
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt += 1) {
    try {
      const preview = await pm.increaseLiquidity.staticCall(increaseParams);
      const estimatedGas = await pm.increaseLiquidity.estimateGas(increaseParams);
      const tx = await pm.increaseLiquidity(increaseParams, { gasLimit: estimatedGas * 120n / 100n });
      console.log(`   tx: ${tx.hash}`);
      const receipt = await tx.wait();
      return { preview, receipt };
    } catch (error) {
      lastError = error;
      const retryable = error.code === "CALL_EXCEPTION" || /transaction execution reverted/i.test(error.message || "");
      if (!retryable || attempt === TX_ATTEMPTS) throw error;
      console.log(`   increase попытка ${attempt}/${TX_ATTEMPTS} откатилась; повторяю через ${attempt * 2} с...`);
      await sleep(attempt * 2_000);
    }
  }
  throw lastError;
}

async function stakeWithRetries(pm, walletAddress, tokenId) {
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt += 1) {
    try {
      const estimatedGas = await pm.safeTransferFrom.estimateGas(walletAddress, CFG.masterChef, tokenId);
      const tx = await pm.safeTransferFrom(walletAddress, CFG.masterChef, tokenId, {
        gasLimit: estimatedGas * 120n / 100n,
      });
      console.log(`   tx: ${tx.hash}`);
      await tx.wait();
      return;
    } catch (error) {
      const retryable = error.code === "CALL_EXCEPTION" || /transaction execution reverted/i.test(error.message || "");
      if (!retryable || attempt === TX_ATTEMPTS) throw error;
      console.log(`   стейкинг попытка ${attempt}/${TX_ATTEMPTS} откатилась; повторяю через ${attempt * 2} с...`);
      await sleep(attempt * 2_000);
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const fromBnb = args.includes("--from-bnb");
  if (fromBnb) args.splice(args.indexOf("--from-bnb"), 1);
  const keepBnbFlag = args.indexOf("--keep-bnb");
  const keepBnb = keepBnbFlag === -1 ? 0.01 : parseFloat(args[keepBnbFlag + 1]);
  if (keepBnbFlag !== -1) args.splice(keepBnbFlag, 2);
  const walletFlag = args.indexOf("--wallet");
  if (walletFlag === -1 || !args[walletFlag + 1]) {
    console.log("укажите кошелёк: --wallet <имя|адрес>");
    console.log("пример: node open-position.js --wallet 697e 680 730 500");
    process.exit(1);
  }
  const walletSelector = args[walletFlag + 1];
  args.splice(walletFlag, 2);

  if (args.length < 3) {
    console.log("использование: node open-position.js [--dry-run] [--from-bnb] [--keep-bnb <BNB>] --wallet <имя|адрес> <цена от> <цена до> <сумма>");
    console.log("пример: node open-position.js --wallet 697e 680 730 500");
    console.log("        node open-position.js --from-bnb --wallet 697e 680 730 0.35");
    console.log("        node open-position.js --dry-run --wallet 697e 680 730 1");
    process.exit(1);
  }

  const priceFrom = parseFloat(args[0]);
  const priceTo = parseFloat(args[1]);
  const amountUsd = parseFloat(args[2]);

  if (!Number.isFinite(keepBnb) || keepBnb < 0) {
    console.log("--keep-bnb должен быть неотрицательным числом");
    process.exit(1);
  }
  if (!Number.isFinite(priceFrom) || !Number.isFinite(priceTo) || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    console.log("цены и сумма должны быть положительными числами");
    process.exit(1);
  }
  if (priceFrom >= priceTo) {
    console.log("цена 'от' должна быть меньше цены 'до'");
    process.exit(1);
  }

  const tickLower = priceToTick(1 / priceTo);
  const tickUpper = priceToTick(1 / priceFrom);

  return { tickLower, tickUpper, amountUsd, priceFrom, priceTo, walletSelector, fromBnb, keepBnb };
}

function savePosition(address, tokenId, opened) {
  let data = { toAddress: address, positions: [] };
  if (fs.existsSync(POSITIONS)) {
    const raw = JSON.parse(fs.readFileSync(POSITIONS, "utf8"));
    data = Array.isArray(raw) ? { toAddress: address, positions: raw } : raw;
  }

  if (!Array.isArray(data.positions)) data.positions = [];
  if (!data.positions.some((item) => String(item.tokenId) === String(tokenId))) {
    data.positions.push({ address, tokenId: Number(tokenId), opened });
  }

  const temporaryPath = `${POSITIONS}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporaryPath, POSITIONS);
}

let wallet;

async function main() {
  const { tickLower, tickUpper, amountUsd, priceFrom, priceTo, walletSelector, fromBnb, keepBnb } = parseArgs();

  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(KEYSTORE, "utf8"));
  const selectedWallet = (walletsRaw.wallets || []).find((item) =>
    item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase(),
  );
  if (!selectedWallet?.keystore) {
    const available = (walletsRaw.wallets || []).map((item) => `${item.name || "без имени"} (${item.address})`).join(", ");
    throw new Error(`кошелёк '${walletSelector}' не найден. Доступны: ${available}`);
  }
  const provider = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId);
  wallet = (await ethers.Wallet.fromEncryptedJson(selectedWallet.keystore, password)).connect(provider);

  console.log(`\n${DRY_RUN ? "=== DRY RUN ===" : "=== MAINNET ==="}`);
  console.log(`кошелёк: ${wallet.address}`);
  console.log(`диапазон: $${priceFrom} - $${priceTo}`);
  console.log(`тики: [${tickLower}, ${tickUpper}]`);
  console.log(`сумма: ${amountUsd} ${fromBnb ? "BNB" : "USDT"}`);
  if (fromBnb) console.log(`остаток BNB: ${keepBnb} BNB`);

  const [t0, t1] = CFG.usdt.toLowerCase() < CFG.wbnb.toLowerCase()
    ? [CFG.usdt, CFG.wbnb]
    : [CFG.wbnb, CFG.usdt];
  const usdtIs0 = CFG.usdt.toLowerCase() === t0.toLowerCase();

  let amountIn = ethers.parseUnits(amountUsd.toString(), 18);

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

  if (!fromBnb && usdtBal < amountIn) {
    console.log(`\nнедостаточно USDT (нужно ${amountUsd}, есть ${ethers.formatUnits(usdtBal, 18)})`);
    process.exit(1);
  }
  const bnbReserve = ethers.parseEther((fromBnb ? Math.max(keepBnb, 0.005) : 0.005).toString());
  if (fromBnb) {
    const availableBnb = bnbBal > bnbReserve ? bnbBal - bnbReserve : 0n;
    if (availableBnb === 0n) {
      console.log(`\nнедостаточно BNB: нужен резерв ${ethers.formatEther(bnbReserve)} BNB на кошельке`);
      process.exit(1);
    }
    if (amountIn > availableBnb) {
      console.log(`\nдля ликвидности доступно ${ethers.formatEther(availableBnb)} BNB; оставляю ${ethers.formatEther(bnbReserve)} BNB резерв`);
      amountIn = availableBnb;
    }
  }
  if (bnbBal < bnbReserve) {
    console.log("\nнедостаточно BNB на газ");
    process.exit(1);
  }

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

  const quoter = new ethers.Contract("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997", QUOTER_ABI, provider);

  // Find a token ratio that uses the whole USDT or BNB budget in the concentrated range.
  const currentTick = Number(slot0.tick);

  let usdtAmount, wbnbAmount, swapAmountIn;

  if (currentTick < tickLower) {
    // Below the range the position contains only token0 (USDT).
    usdtAmount = fromBnb ? 0n : amountIn;
    swapAmountIn = fromBnb ? amountIn : 0n;
    wbnbAmount = 0n;
    console.log(`\nтекущий тик ${currentTick} < ${tickLower} (ниже диапазона)`);
    console.log(`  позиция = 100% USDT`);
  } else if (currentTick >= tickUpper) {
    // Above the range the position contains only token1 (WBNB).
    usdtAmount = 0n;
    swapAmountIn = fromBnb ? 0n : amountIn;
    if (fromBnb) {
      wbnbAmount = amountIn;
    } else {
      const wbnbQuoteRes = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: CFG.usdt,
        tokenOut: CFG.wbnb,
        amountIn: swapAmountIn,
        fee: CFG.fee,
        sqrtPriceLimitX96: 0,
      });
      wbnbAmount = wbnbQuoteRes.amountOut;
    }
    console.log(`\nтекущий тик ${currentTick} >= ${tickUpper} (выше диапазона)`);
    console.log(`  позиция = 100% WBNB`);
  } else {
    const sqrtLower = Math.pow(1.0001, tickLower / 2);
    const sqrtUpper = Math.pow(1.0001, tickUpper / 2);
    const requiredWbnb = (usdt, sqrtPriceX96) => {
      const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
      if (sqrtPrice <= sqrtLower) return 0n;
      if (sqrtPrice >= sqrtUpper) return ethers.MaxUint256;
      const wbnbPerUsdt = (sqrtPrice - sqrtLower) / (1 / sqrtPrice - 1 / sqrtUpper);
      return ethers.parseUnits(
        (Number(ethers.formatUnits(usdt, 18)) * wbnbPerUsdt).toFixed(18),
        18,
      );
    };

    let low = 0n;
    let high = amountIn;

    // The swap changes the pool price, so use Quoter's post-swap price for each candidate ratio.
    for (let attempt = 0; attempt < 24 && low < high; attempt += 1) {
      const candidateSwap = (low + high) / 2n;
      const candidateUsdt = fromBnb ? 0n : amountIn - candidateSwap;
      const quote = candidateSwap === 0n
        ? { amountOut: 0n, sqrtPriceX96After: slot0.sqrtPriceX96 }
        : await quoter.quoteExactInputSingle.staticCall({
          tokenIn: fromBnb ? CFG.wbnb : CFG.usdt,
          tokenOut: fromBnb ? CFG.usdt : CFG.wbnb,
          amountIn: candidateSwap,
          fee: CFG.fee,
          sqrtPriceLimitX96: 0,
        });
      const required = requiredWbnb(fromBnb ? quote.amountOut : candidateUsdt, quote.sqrtPriceX96After);
      const enoughWbnb = fromBnb ? amountIn - candidateSwap <= required : quote.amountOut >= required;
      if (enoughWbnb) high = candidateSwap;
      else low = candidateSwap + 1n;
    }

    swapAmountIn = high;
    usdtAmount = fromBnb ? 0n : amountIn - swapAmountIn;
    const wbnbQuoteRes = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: fromBnb ? CFG.wbnb : CFG.usdt,
      tokenOut: fromBnb ? CFG.usdt : CFG.wbnb,
      amountIn: swapAmountIn,
      fee: CFG.fee,
      sqrtPriceLimitX96: 0,
    });
    if (fromBnb) {
      usdtAmount = wbnbQuoteRes.amountOut;
      wbnbAmount = amountIn - swapAmountIn;
    } else {
      wbnbAmount = wbnbQuoteRes.amountOut;
    }

    console.log(`\nтекущий тик ${currentTick} в диапазоне [${tickLower}, ${tickUpper}]`);
    console.log(`  подобрана пропорция для полного использования ${fromBnb ? "BNB" : "USDT"}`);
  }

  console.log(`  USDT (token0): ${ethers.formatUnits(usdtAmount, 18)}`);
  console.log(`  WBNB (token1): ${ethers.formatUnits(wbnbAmount, 18)}`);

  if (DRY_RUN) {
    console.log("\n=== dry run завершён, всё ок ===");
    return;
  }

  // 1. approvals for the token used by the swap and both position tokens.
  const routerInputToken = fromBnb ? wbnbC : usdtC;
  const currentAllowanceSwap = await routerInputToken.allowance(wallet.address, CFG.swapRouter);
  if (currentAllowanceSwap < swapAmountIn) {
    console.log(`\n1. approve ${fromBnb ? "WBNB" : "USDT"} для swapRouter...`);
    await (await routerInputToken.approve(CFG.swapRouter, ethers.MaxUint256)).wait();
    console.log("   approve ok");
  }
  const currentAllowancePM = await usdtC.allowance(wallet.address, CFG.positionManager);
  if (fromBnb || currentAllowancePM < usdtAmount) {
    console.log("   approve USDT для positionManager...");
    await (await usdtC.approve(CFG.positionManager, ethers.MaxUint256)).wait();
    console.log("   approve ok");
  }

  // 1b. approve WBNB для positionManager
  const wbnbAllowance = await wbnbC.allowance(wallet.address, CFG.positionManager);
  if (wbnbAllowance < wbnbAmount) {
    console.log("   approve WBNB для positionManager...");
    await (await wbnbC.approve(CFG.positionManager, ethers.MaxUint256)).wait();
    console.log("   approve ok");
  }

  // Wrap exactly the BNB allocated to this position, then swap only its required share.
  let wbnbReceived = 0n;
  let usdtReceived = usdtAmount;
  if (fromBnb) {
    console.log("\n2. заворачиваю BNB -> WBNB...");
    const wbnbBeforeWrap = await wbnbC.balanceOf(wallet.address);
    const wrapTx = await new ethers.Contract(CFG.wbnb, WBNB_ABI, wallet).deposit({ value: amountIn });
    console.log(`   tx: ${wrapTx.hash}`);
    await wrapTx.wait();
    const wrapped = (await wbnbC.balanceOf(wallet.address)) - wbnbBeforeWrap;
    if (wrapped < amountIn) throw new Error("не удалось завернуть указанную сумму BNB");
    wbnbReceived = amountIn - swapAmountIn;
  }

  // Swap only the planned part of the selected budget.
  if (swapAmountIn > 0n) {
    console.log(`\n${fromBnb ? "3" : "2"}. свап ${fromBnb ? "WBNB -> USDT" : "USDT -> WBNB"}...`);
    const outputToken = fromBnb ? usdtC : wbnbC;
    const outputBefore = await outputToken.balanceOf(wallet.address);
    const router = new ethers.Contract(CFG.swapRouter, ROUTER_ABI, wallet);
    await swapWithRetries({
      router,
      quoter,
      wallet,
      amountIn: swapAmountIn,
      tokenIn: fromBnb ? CFG.wbnb : CFG.usdt,
      tokenOut: fromBnb ? CFG.usdt : CFG.wbnb,
    });
    const received = (await outputToken.balanceOf(wallet.address)) - outputBefore;
    if (fromBnb) {
      usdtReceived = received;
      console.log(`   получено: ${ethers.formatUnits(usdtReceived, 18)} USDT`);
    } else {
      wbnbReceived = received;
      console.log(`   получено: ${ethers.formatUnits(wbnbReceived, 18)} WBNB`);
    }
  } else {
    console.log(`\n${fromBnb ? "3" : "2"}. свап не нужен`);
  }

  // 3. mint position
  console.log("\n3. создаю позицию...");
  const amount0Desired = usdtIs0 ? usdtReceived : wbnbReceived;
  const amount1Desired = usdtIs0 ? wbnbReceived : usdtReceived;
  console.log(`   desired: amount0=${ethers.formatUnits(amount0Desired, 18)}, amount1=${ethers.formatUnits(amount1Desired, 18)}`);

  const pm = new ethers.Contract(CFG.positionManager, PM_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 1800;

  const mintParams = {
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
  };
  const { preview, receipt: mintReceipt } = await mintWithRetries(pm, mintParams);

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

  const increase = mintReceipt.logs.find((log) => {
    try {
      return log.address.toLowerCase() === CFG.positionManager.toLowerCase()
        && pm.interface.parseLog(log)?.name === "IncreaseLiquidity";
    } catch {
      return false;
    }
  });
  const actual = increase ? pm.interface.parseLog(increase).args : preview;
  let amount0Raw = actual.amount0;
  let amount1Raw = actual.amount1;
  let openingSlot0 = await pool.slot0();
  let openingPrice = (Number(openingSlot0.sqrtPriceX96) / 2 ** 96) ** 2;
  let amount0 = Number(ethers.formatUnits(amount0Raw, 18));
  let amount1 = Number(ethers.formatUnits(amount1Raw, 18));
  let initialValueUsd = usdtIs0 ? amount0 + amount1 / openingPrice : amount1 + amount0 * openingPrice;

  // The price can move between the swap and mint; use the small leftover before staking the NFT.
  const residualUsd = amountUsd - initialValueUsd;
  if (!fromBnb && residualUsd > 0.05 && Number(openingSlot0.tick) >= tickLower && Number(openingSlot0.tick) < tickUpper) {
    try {
      const sqrtPrice = Number(openingSlot0.sqrtPriceX96) / 2 ** 96;
      const sqrtLower = Math.pow(1.0001, tickLower / 2);
      const sqrtUpper = Math.pow(1.0001, tickUpper / 2);
      const wbnbPerUsdt = (sqrtPrice - sqrtLower) / (1 / sqrtPrice - 1 / sqrtUpper);
      const topUpUsdt = residualUsd / (1 + wbnbPerUsdt / openingPrice);
      const topUpSwap = residualUsd - topUpUsdt;
      const topUpUsdtRaw = ethers.parseUnits(topUpUsdt.toFixed(18), 18);
      const topUpSwapRaw = ethers.parseUnits(topUpSwap.toFixed(18), 18);
      const router = new ethers.Contract(CFG.swapRouter, ROUTER_ABI, wallet);
      const wbnbBefore = await wbnbC.balanceOf(wallet.address);

      console.log(`3b. докладываю остаток: ~${residualUsd.toFixed(4)} USDT...`);
      if (topUpSwapRaw > 0n) await swapWithRetries({ router, quoter, wallet, amountIn: topUpSwapRaw });
      const topUpWbnbRaw = (await wbnbC.balanceOf(wallet.address)) - wbnbBefore;
      const increaseParams = {
        tokenId,
        amount0Desired: usdtIs0 ? topUpUsdtRaw : topUpWbnbRaw,
        amount1Desired: usdtIs0 ? topUpWbnbRaw : topUpUsdtRaw,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 1800,
      };
      const { preview: topUpPreview, receipt: topUpReceipt } = await increaseWithRetries(pm, increaseParams);
      const topUpLog = topUpReceipt.logs.find((log) => {
        try {
          return log.address.toLowerCase() === CFG.positionManager.toLowerCase()
            && pm.interface.parseLog(log)?.name === "IncreaseLiquidity";
        } catch {
          return false;
        }
      });
      const topUp = topUpLog ? pm.interface.parseLog(topUpLog).args : topUpPreview;
      amount0Raw += topUp.amount0;
      amount1Raw += topUp.amount1;
      openingSlot0 = await pool.slot0();
      openingPrice = (Number(openingSlot0.sqrtPriceX96) / 2 ** 96) ** 2;
      amount0 = Number(ethers.formatUnits(amount0Raw, 18));
      amount1 = Number(ethers.formatUnits(amount1Raw, 18));
      initialValueUsd = usdtIs0 ? amount0 + amount1 / openingPrice : amount1 + amount0 * openingPrice;
      console.log(`   внесено после корректировки: ${initialValueUsd.toFixed(4)} USDT`);
    } catch (error) {
      console.log(`   остаток не довнесён: ${error.shortMessage || error.message}`);
    }
  }
  const opened = {
    at: new Date().toISOString(),
    price: openingPrice,
    amount0: ethers.formatUnits(amount0Raw, 18),
    amount1: ethers.formatUnits(amount1Raw, 18),
    valueUsd: initialValueUsd,
  };

  // Keep the NFT visible to the dashboard even if a later MasterChef transfer fails.
  savePosition(wallet.address, tokenId, opened);
  console.log("   позиция сохранена в positions.json");

  // 4. stake (safeTransferFrom NFT to MasterChef)
  console.log("4. стейкаю в MasterChef...");
  const isApproved = await pm.isApprovedForAll(wallet.address, CFG.masterChef);
  if (!isApproved) {
    await (await pm.setApprovalForAll(CFG.masterChef, true)).wait();
    console.log("   approveAll ok");
  }
  await stakeWithRetries(pm, wallet.address, tokenId);
  console.log("   стейкинг ok");

  console.log(`\n=== готово ===`);
  console.log(`tokenId: ${tokenId}`);
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
