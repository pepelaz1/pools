const { ethers } = require("ethers");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://arb1.arbitrum.io/rpc";
const AMOUNT_WETH = process.env.AMOUNT_WETH || "0.001614583116335606";
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const TO_ADDRESS = process.env.TO_ADDRESS;

const SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const FEE = 500;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
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

  const amountIn = ethers.parseUnits(AMOUNT_WETH, 18);
  const weth = new ethers.Contract(WETH, ERC20_ABI, wallet);
  const bal = await weth.balanceOf(me);

  if (bal < amountIn) {
    throw new Error(
      `Недостаточно WETH. На кошельке ${ethers.formatUnits(bal, 18)} WETH, нужно ${AMOUNT_WETH}`,
    );
  }

  const allowance = await weth.allowance(me, SWAP_ROUTER);
  if (allowance < amountIn) {
    await (await weth.approve(SWAP_ROUTER, ethers.MaxUint256)).wait();
  }

  const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
  const res = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn,
    fee: FEE,
    sqrtPriceLimitX96: 0,
  });
  const amountOut = res[0];
  const amountOutMin = (amountOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  console.log("Свапаем WETH:", AMOUNT_WETH);
  console.log("Ожидаемо USDC:", ethers.formatUnits(amountOut, 6));

  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const usdcBefore = await usdc.balanceOf(me);

  const router = new ethers.Contract(SWAP_ROUTER, SWAP_ABI, wallet);
  const tx = await router.exactInputSingle({
    tokenIn: WETH,
    tokenOut: USDC,
    fee: FEE,
    recipient: me,
    amountIn,
    amountOutMinimum: amountOutMin,
    sqrtPriceLimitX96: 0,
  });
  console.log("Транзакция отправлена:", tx.hash);
  await tx.wait();

  const usdcAfter = await usdc.balanceOf(me);
  const received = usdcAfter - usdcBefore;
  console.log("Получено USDC:", ethers.formatUnits(received, 6));

  if (TO_ADDRESS && received > 0n) {
    if (!ethers.isAddress(TO_ADDRESS)) throw new Error("TO_ADDRESS содержит неверный адрес");
    await (await usdc.transfer(TO_ADDRESS, received)).wait();
    console.log(`Отправлено ${ethers.formatUnits(received, 6)} USDC на`, TO_ADDRESS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
