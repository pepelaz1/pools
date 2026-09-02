const { ethers } = require("ethers");

const MAX_UINT128 = 2n ** 128n - 1n;

const CHAINS = {
  arbitrum: {
    rpc: "https://arb1.arbitrum.io/rpc",
    native: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    nativeName: "WETH",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    swapRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  },
  avalanche: {
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    native: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    nativeName: "WAVAX",
    positionManager: "0x655C406EBFa14EE2006250925e54ec43AD184f8B",
    swapRouter: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
    quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
  },
};

const WETH = CHAINS.arbitrum.native;

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
  "function ownerOf(uint256 tokenId) view returns (address)",
];

const SWAP_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

async function collectAndSwap(wallet, tokenId, { toAddress, slippageBps = 100, chain = "arbitrum", minUsd = 1 } = {}) {
  const chainInfo = CHAINS[chain] || CHAINS.arbitrum;
  const native = chainInfo.native;
  const provider = wallet.provider;
  const me = wallet.address;

  const pm = new ethers.Contract(chainInfo.positionManager, PM_ABI, wallet);
  const pos = await pm.positions(tokenId);

  const nativeIdx =
    pos.token0.toLowerCase() === native.toLowerCase()
      ? 0
      : pos.token1.toLowerCase() === native.toLowerCase()
        ? 1
        : -1;
  if (nativeIdx === -1) {
    return { status: "skip", reason: `в пуле нет ${chainInfo.nativeName} (не ${chainInfo.nativeName}-пара)` };
  }

  const usdc = nativeIdx === 0 ? pos.token1 : pos.token0;
  const usdcC = new ethers.Contract(usdc, ERC20_ABI, wallet);
  const nativeC = new ethers.Contract(native, ERC20_ABI, wallet);
  const usdcDec = Number(await usdcC.decimals());
  const usdcSym = await usdcC.symbol();
  const nativeDec = Number(await nativeC.decimals());

  const collectParams = {
    tokenId,
    recipient: me,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  const [c0, c1] = await pm.collect.staticCall(collectParams);
  const nativeCollected = nativeIdx === 0 ? c0 : c1;
  const usdcCollected = nativeIdx === 0 ? c1 : c0;

  if (nativeCollected === 0n && usdcCollected === 0n) {
    return { status: "empty", usdcSym, usdcDec, nativeName: chainInfo.nativeName, nativeDec };
  }

  const minRaw = ethers.parseUnits(String(minUsd), usdcDec);
  let nativeUsdcValue = 0n;
  if (nativeCollected > 0n) {
    try {
      const quoter = new ethers.Contract(chainInfo.quoter, QUOTER_ABI, provider);
      const q = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: native,
        tokenOut: usdc,
        amountIn: nativeCollected,
        fee: pos.fee,
        sqrtPriceLimitX96: 0,
      });
      nativeUsdcValue = q[0];
    } catch {
      nativeUsdcValue = 0n;
    }
  }
  const estimatedTotal = usdcCollected + nativeUsdcValue;
  if (estimatedTotal < minRaw) {
    return {
      status: "skip",
      reason: `комиссия ${ethers.formatUnits(estimatedTotal, usdcDec)} ${usdcSym} меньше ${minUsd}$`,
    };
  }

  const tx1 = await pm.collect(collectParams);
  await tx1.wait();

  let swappedUsdc = 0n;
  if (nativeCollected > 0n) {
    const allowance = await nativeC.allowance(me, chainInfo.swapRouter);
    if (allowance < nativeCollected) {
      await (await nativeC.approve(chainInfo.swapRouter, ethers.MaxUint256)).wait();
    }

    let amountOutMin = 0n;
    try {
      const quoter = new ethers.Contract(chainInfo.quoter, QUOTER_ABI, provider);
      const res = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: native,
        tokenOut: usdc,
        amountIn: nativeCollected,
        fee: pos.fee,
        sqrtPriceLimitX96: 0,
      });
      amountOutMin = (res[0] * BigInt(10000 - slippageBps)) / 10000n;
    } catch {
      amountOutMin = 0n;
    }

    const before = await usdcC.balanceOf(me);
    const router = new ethers.Contract(chainInfo.swapRouter, SWAP_ABI, wallet);
    const tx2 = await router.exactInputSingle({
      tokenIn: native,
      tokenOut: usdc,
      fee: pos.fee,
      recipient: me,
      amountIn: nativeCollected,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0,
    });
    await tx2.wait();
    const after = await usdcC.balanceOf(me);
    swappedUsdc = after - before;
  }

  const totalUsdc = usdcCollected + swappedUsdc;

  if (toAddress && totalUsdc > 0n) {
    if (!ethers.isAddress(toAddress)) {
      return { status: "error", reason: `неверный toAddress: ${toAddress}` };
    }
    const tx3 = await usdcC.transfer(toAddress, totalUsdc);
    await tx3.wait();
  }

  return {
    status: "ok",
    usdcSym,
    usdcDec,
    nativeName: chainInfo.nativeName,
    nativeDec,
    nativeCollected,
    usdcCollected,
    swappedUsdc,
    totalUsdc,
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

async function getOwner(provider, tokenId, chain = "arbitrum") {
  const chainInfo = CHAINS[chain] || CHAINS.arbitrum;
  const pm = new ethers.Contract(chainInfo.positionManager, PM_ABI, provider);
  return await pm.ownerOf(tokenId);
}

module.exports = { collectAndSwap, getOwner, CHAINS, WETH, prompt, promptHidden };
