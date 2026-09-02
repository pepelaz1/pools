const { ethers } = require("ethers");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://arb1.arbitrum.io/rpc";
const TOKEN_ID = Number(process.env.TOKEN_ID) || 5673996;
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const MAX_UINT128 = 2n ** 128n - 1n;
const TO_ADDRESS = process.env.TO_ADDRESS;

const POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

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
];

const SWAP_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

async function main() {
  if (!PRIVATE_KEY) throw new Error("Задайте PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const me = wallet.address;

  const pm = new ethers.Contract(POSITION_MANAGER, PM_ABI, wallet);
  const pos = await pm.positions(TOKEN_ID);

  const wethIdx =
    pos.token0.toLowerCase() === WETH.toLowerCase()
      ? 0
      : pos.token1.toLowerCase() === WETH.toLowerCase()
        ? 1
        : -1;
  if (wethIdx === -1) throw new Error("В пуле не найден WETH (это не ETH-пара)");

  const usdc = wethIdx === 0 ? pos.token1 : pos.token0;
  const usdcC = new ethers.Contract(usdc, ERC20_ABI, wallet);
  const wethC = new ethers.Contract(WETH, ERC20_ABI, wallet);
  const usdcDec = Number(await usdcC.decimals());
  const usdcSym = await usdcC.symbol();

  const collectParams = {
    tokenId: TOKEN_ID,
    recipient: me,
    amount0Max: MAX_UINT128,
    amount1Max: MAX_UINT128,
  };

  const [c0, c1] = await pm.collect.staticCall(collectParams);

  const wethCollected = wethIdx === 0 ? c0 : c1;
  const usdcCollected = wethIdx === 0 ? c1 : c0;

  console.log("Адрес:", me);
  console.log("К сбору WETH:", ethers.formatUnits(wethCollected, 18));
  console.log(`К сбору ${usdcSym}:`, ethers.formatUnits(usdcCollected, usdcDec));

  if (wethCollected === 0n && usdcCollected === 0n) {
    console.log("Комиссий нет — собирать нечего.");
    return;
  }

  const tx1 = await pm.collect(collectParams);
  await tx1.wait();
  console.log("Комиссии собраны:", tx1.hash);

  let swappedUsdc = 0n;
  if (wethCollected > 0n) {
    const allowance = await wethC.allowance(me, SWAP_ROUTER);
    if (allowance < wethCollected) {
      await (await wethC.approve(SWAP_ROUTER, ethers.MaxUint256)).wait();
    }

    let amountOutMin = 0n;
    try {
      const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
      const res = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: WETH,
        tokenOut: usdc,
        amountIn: wethCollected,
        fee: pos.fee,
        sqrtPriceLimitX96: 0,
      });
      const amountOut = res[0];
      amountOutMin = (amountOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
      console.log("Котировка WETH ->", usdcSym, ":", ethers.formatUnits(amountOut, usdcDec));
    } catch (e) {
      console.warn("Не удалось получить котировку, свап без защиты от проскальзывания:", e.shortMessage || e.message);
    }

    const before = await usdcC.balanceOf(me);
    const router = new ethers.Contract(SWAP_ROUTER, SWAP_ABI, wallet);
    const tx2 = await router.exactInputSingle({
      tokenIn: WETH,
      tokenOut: usdc,
      fee: pos.fee,
      recipient: me,
      amountIn: wethCollected,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0,
    });
    await tx2.wait();
    const after = await usdcC.balanceOf(me);
    swappedUsdc = after - before;
    console.log("Свап выполнен:", tx2.hash);
  }

  const totalUsdc = usdcCollected + swappedUsdc;
  console.log(`Комиссия в ${usdcSym}:`, ethers.formatUnits(usdcCollected, usdcDec));
  console.log(`Свап WETH -> ${usdcSym}:`, ethers.formatUnits(swappedUsdc, usdcDec));
  console.log(`ИТОГО получено ${usdcSym}:`, ethers.formatUnits(totalUsdc, usdcDec));

  if (TO_ADDRESS && totalUsdc > 0n) {
    if (!ethers.isAddress(TO_ADDRESS)) throw new Error("TO_ADDRESS содержит неверный адрес");
    const tx3 = await usdcC.transfer(TO_ADDRESS, totalUsdc);
    await tx3.wait();
    console.log(`Отправлено ${ethers.formatUnits(totalUsdc, usdcDec)} ${usdcSym} на`, TO_ADDRESS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
