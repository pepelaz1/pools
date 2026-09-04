const { ethers } = require("ethers");

const MAX_UINT128 = 2n ** 128n - 1n;

const RPC = "https://bsc-dataseed.binance.org/";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";

const POSITION_MANAGER = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";
const SWAP_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
const QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const MASTERCHEF = "0x556B9306565093C855AEA9AE92A594704c2Cd59e";

const WBNB_USDT_FEE = 100;
const CAKE_USDT_FEE = 2500;

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

const PM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const MC_ABI = [
  "function pendingCake(uint256 tokenId) view returns (uint256)",
  "function harvest(uint256 tokenId, address to)",
  "function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
  "function userPositionInfos(uint256 tokenId) view returns (uint256 liquidity, uint256 boostLiquidity, int24 tickLower, int24 tickUpper, uint256 rewardGrowthInside, uint256 rewardGrowthInside2, address owner, uint256 boostMultiplier, uint256 precision)",
  "function withdraw(uint256 tokenId)",
  "function burn(uint256 tokenId)",
];

const SWAP_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

async function quoteUsdt(provider, tokenIn, amountIn, fee) {
  const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
  const res = await quoter.quoteExactInputSingle.staticCall({
    tokenIn,
    tokenOut: USDT,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  });
  return res[0];
}

async function swapToUsdt(wallet, tokenIn, amountIn, fee, slippageBps) {
  if (amountIn === 0n) return 0n;
  const me = wallet.address;
  const provider = wallet.provider;

  const tokenC = new ethers.Contract(tokenIn, ERC20_ABI, wallet);
  const allowance = await tokenC.allowance(me, SWAP_ROUTER);
  if (allowance < amountIn) {
    await (await tokenC.approve(SWAP_ROUTER, ethers.MaxUint256)).wait();
  }

  let amountOutMin = 0n;
  try {
    const amountOut = await quoteUsdt(provider, tokenIn, amountIn, fee);
    amountOutMin = (amountOut * BigInt(10000 - slippageBps)) / 10000n;
  } catch {
    amountOutMin = 0n;
  }

  const usdtC = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const before = await usdtC.balanceOf(me);
  const router = new ethers.Contract(SWAP_ROUTER, SWAP_ABI, wallet);
  await (
    await router.exactInputSingle({
      tokenIn,
      tokenOut: USDT,
      fee,
      recipient: me,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0,
    })
  ).wait();
  const after = await usdtC.balanceOf(me);
  return after - before;
}

async function collectAndSwap(wallet, tokenId, { toAddress, slippageBps = 100, minUsd = 1 } = {}) {
  const me = wallet.address;
  const provider = wallet.provider;

  const pm = new ethers.Contract(POSITION_MANAGER, PM_ABI, wallet);
  const mc = new ethers.Contract(MASTERCHEF, MC_ABI, wallet);

  const pos = await pm.positions(tokenId);

  const wbnbIdx =
    pos.token0.toLowerCase() === WBNB.toLowerCase()
      ? 0
      : pos.token1.toLowerCase() === WBNB.toLowerCase()
        ? 1
        : -1;
  if (wbnbIdx === -1) {
    return { status: "skip", reason: "в пуле нет WBNB (не BNB-пара)" };
  }

  const quote = wbnbIdx === 0 ? pos.token1 : pos.token0;
  if (quote.toLowerCase() !== USDT.toLowerCase()) {
    return { status: "skip", reason: "вторая монета пары не USDT" };
  }

  let isStaked = false;
  try {
    const info = await mc.userPositionInfos(tokenId);
    isStaked = info.owner.toLowerCase() === me.toLowerCase();
  } catch {
    isStaked = false;
  }

  const usdtC = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const usdtDec = Number(await usdtC.decimals());

  const collectParams = {
    tokenId,
    recipient: me,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  const [a0, a1] = isStaked
    ? await mc.collect.staticCall(collectParams)
    : await pm.collect.staticCall(collectParams);

  const wbnbCollected = wbnbIdx === 0 ? a0 : a1;
  const usdtCollected = wbnbIdx === 0 ? a1 : a0;

  let cakeOwed = 0n;
  if (isStaked) {
    try {
      cakeOwed = await mc.pendingCake(tokenId);
    } catch {
      cakeOwed = 0n;
    }
  }

  if (wbnbCollected === 0n && usdtCollected === 0n && cakeOwed === 0n) {
    return { status: "empty", usdtDec };
  }

  const minRaw = ethers.parseUnits(String(minUsd), usdtDec);
  let wbnbUsdtValue = 0n;
  let cakeUsdtValue = 0n;
  if (wbnbCollected > 0n) {
    try {
      wbnbUsdtValue = await quoteUsdt(provider, WBNB, wbnbCollected, WBNB_USDT_FEE);
    } catch {
      wbnbUsdtValue = 0n;
    }
  }
  if (cakeOwed > 0n) {
    try {
      cakeUsdtValue = await quoteUsdt(provider, CAKE, cakeOwed, CAKE_USDT_FEE);
    } catch {
      cakeUsdtValue = 0n;
    }
  }
  const estimatedTotal = usdtCollected + wbnbUsdtValue + cakeUsdtValue;
  if (estimatedTotal < minRaw) {
    return {
      status: "skip",
      reason: `комиссия ${ethers.formatUnits(estimatedTotal, usdtDec)} USDT меньше ${minUsd}$`,
    };
  }

  if (isStaked) {
    await (await mc.collect(collectParams)).wait();
  } else {
    await (await pm.collect(collectParams)).wait();
  }

  let cakeReceived = 0n;
  if (cakeOwed > 0n) {
    const cakeC = new ethers.Contract(CAKE, ERC20_ABI, wallet);
    const cakeBefore = await cakeC.balanceOf(me);
    await (await mc.harvest(tokenId, me)).wait();
    const cakeAfter = await cakeC.balanceOf(me);
    cakeReceived = cakeAfter - cakeBefore;
  }

  let swappedWbnbUsdt = 0n;
  if (wbnbCollected > 0n) {
    swappedWbnbUsdt = await swapToUsdt(wallet, WBNB, wbnbCollected, WBNB_USDT_FEE, slippageBps);
  }

  let swappedCakeUsdt = 0n;
  if (cakeReceived > 0n) {
    swappedCakeUsdt = await swapToUsdt(wallet, CAKE, cakeReceived, CAKE_USDT_FEE, slippageBps);
  }

  const totalUsdt = usdtCollected + swappedWbnbUsdt + swappedCakeUsdt;

  if (toAddress && toAddress.toLowerCase() !== me.toLowerCase() && totalUsdt > 0n) {
    if (!ethers.isAddress(toAddress)) {
      return { status: "error", reason: `неверный toAddress: ${toAddress}` };
    }
    await (await usdtC.transfer(toAddress, totalUsdt)).wait();
  }

  return {
    status: "ok",
    usdtDec,
    wbnbCollected,
    usdtCollected,
    cakeReceived,
    swappedWbnbUsdt,
    swappedCakeUsdt,
    totalUsdt,
  };
}

function promptHidden(question) {
  const readline = require("readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    rl._writeToOutput = (s) => {
      if (s === "\r\n" || s === "\n" || s === "\r") {
        rl.output.write("\n");
      }
    };
  });
}

function prompt(question) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function closePosition(wallet, tokenId, { slippageBps = 100 } = {}) {
  const me = wallet.address;
  const provider = wallet.provider;
  const pm = new ethers.Contract(POSITION_MANAGER, PM_ABI, wallet);
  const mc = new ethers.Contract(MASTERCHEF, MC_ABI, wallet);
  const usdtC = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const cakeC = new ethers.Contract(CAKE, ERC20_ABI, wallet);
  const wbnbC = new ethers.Contract(WBNB, ERC20_ABI, wallet);

  const pos = await pm.positions(tokenId);
  const liquidity = pos.liquidity;

  const wbnbIdx =
    pos.token0.toLowerCase() === WBNB.toLowerCase()
      ? 0
      : pos.token1.toLowerCase() === WBNB.toLowerCase()
        ? 1
        : -1;

  if (wbnbIdx === -1) {
    return { status: "skip", reason: "в пуле нет WBNB" };
  }

  let isStaked = false;
  const nftOwner = await pm.ownerOf(tokenId);
  if (nftOwner.toLowerCase() === MASTERCHEF.toLowerCase()) {
    isStaked = true;
  }

  const stats = { tokenId, status: "ok", steps: [] };

  // 1. withdraw + harvest (unstakes NFT, harvests CAKE, returns NFT to wallet)
  if (isStaked) {
    try {
      console.log("  withdraw...");
      await (await mc.withdraw(tokenId)).wait();
      stats.steps.push("withdraw");
      console.log("  withdraw ok");
    } catch (e) {
      console.log(`  withdraw ошибка: ${e.shortMessage || e.message}`);
      throw e;
    }
  }

  // 2. collect fees from PM
  const collectParams = {
    tokenId,
    recipient: me,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };
  try {
    console.log("  collect...");
    await (await pm.collect(collectParams)).wait();
    stats.steps.push("collect");
    console.log("  collect ok");
  } catch (e) {
    console.log(`  collect ошибка: ${e.shortMessage || e.message}`);
    throw e;
  }

  // 3. decreaseLiquidity + collect withdrawn tokens
  if (liquidity > 0n) {
    try {
      console.log("  забираю ликвидность...");
      await (await pm.decreaseLiquidity({
        tokenId,
        liquidity,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 1800,
      })).wait();
      stats.steps.push("decreaseLiquidity");
      console.log("  ликвидность забрана");

      console.log("  забираю токены...");
      await (await pm.collect(collectParams)).wait();
      stats.steps.push("collectWithdrawn");
      console.log("  токены забраны");
    } catch (e) {
      console.log(`  ошибка: ${e.shortMessage || e.message}`);
      throw e;
    }
  }

  // 4. swap WBNB + CAKE to USDT
  const wbnb0 = await wbnbC.balanceOf(me);
  const cake0 = await cakeC.balanceOf(me);

  // 6. swap WBNB to USDT
  let swappedWbnb = 0n;
  if (wbnb0 > 0n) {
    try {
      swappedWbnb = await swapToUsdt(wallet, WBNB, wbnb0, WBNB_USDT_FEE, slippageBps);
    } catch {}
    stats.steps.push("swapWbnb");
  }

  // 7. swap CAKE to USDT
  let swappedCake = 0n;
  if (cake0 > 0n) {
    try {
      swappedCake = await swapToUsdt(wallet, CAKE, cake0, CAKE_USDT_FEE, slippageBps);
    } catch {}
    stats.steps.push("swapCake");
  }

  const usdtFinal = await usdtC.balanceOf(me);
  stats.usdtReceived = usdtFinal;

  return stats;
}

async function getOwner(provider, tokenId) {
  const pm = new ethers.Contract(POSITION_MANAGER, PM_ABI, provider);
  const owner = await pm.ownerOf(tokenId);
  if (owner.toLowerCase() === MASTERCHEF.toLowerCase()) {
    const mc = new ethers.Contract(MASTERCHEF, MC_ABI, provider);
    const info = await mc.userPositionInfos(tokenId);
    return info.owner;
  }
  return owner;
}

module.exports = {
  collectAndSwap,
  closePosition,
  getOwner,
  RPC,
  WBNB,
  USDT,
  CAKE,
  prompt,
  promptHidden,
};
