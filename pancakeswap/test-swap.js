#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const RPC = "https://bsc-dataseed.binance.org/";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const SMART = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";

const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results)",
];
const SMART_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)",
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
  const keystore = walletsRaw.wallets[0].keystore;
  const provider = new ethers.JsonRpcProvider(RPC, 56);
  const wallet = (await ethers.Wallet.fromEncryptedJson(keystore, password)).connect(provider);
  console.log("кошелёк:", wallet.address);

  const amount = ethers.parseUnits("0.5", 18);
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const usdt = new ethers.Contract(USDT, ERC20_ABI, wallet);

  // Способ 1: SwapRouter exactInputSingle
  console.log("\n1. SwapRouter exactInputSingle...");
  try {
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
    const wbnbBefore = await new ethers.Contract(WBNB, ERC20_ABI, wallet).balanceOf(wallet.address);
    const tx = await router.exactInputSingle({
      tokenIn: USDT, tokenOut: WBNB, fee: 100,
      recipient: wallet.address, amountIn: amount,
      amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    });
    await tx.wait();
    const wbnbAfter = await new ethers.Contract(WBNB, ERC20_ABI, wallet).balanceOf(wallet.address);
    console.log("   ok! WBNB:", ethers.formatUnits(wbnbAfter - wbnbBefore, 18));
    return;
  } catch (e) {
    console.log("   ошибка:", (e.shortMessage || e.message).slice(0, 150));
  }

  // Способ 2: SwapRouter multicall
  console.log("\n2. SwapRouter multicall...");
  try {
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
    const swapData = router.interface.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDT, tokenOut: WBNB, fee: 100,
      recipient: wallet.address, amountIn: amount,
      amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    }]);
    const tx = await router.multicall(deadline, [swapData]);
    await tx.wait();
    console.log("   ok!");
    return;
  } catch (e) {
    console.log("   ошибка:", (e.shortMessage || e.message).slice(0, 150));
  }

  // Способ 3: SmartRouter
  console.log("\n3. SmartRouter swap...");
  try {
    await (await usdt.approve(SMART, ethers.MaxUint256)).wait();
    const smart = new ethers.Contract(SMART, SMART_ABI, wallet);
    const tx = await smart.swapExactTokensForTokens(amount, 0, [USDT, WBNB], wallet.address, deadline);
    await tx.wait();
    console.log("   ok!");
    return;
  } catch (e) {
    console.log("   ошибка:", (e.shortMessage || e.message).slice(0, 150));
  }

  // Способ 4: SwapRouter fee=500
  console.log("\n4. SwapRouter fee=500...");
  try {
    const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
    const tx = await router.exactInputSingle({
      tokenIn: USDT, tokenOut: WBNB, fee: 500,
      recipient: wallet.address, amountIn: amount,
      amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    });
    await tx.wait();
    console.log("   ok!");
    return;
  } catch (e) {
    console.log("   ошибка:", (e.shortMessage || e.message).slice(0, 150));
  }

  console.log("\nвсе способы не сработали");
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
