#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const RPC = "https://bsc-dataseed.binance.org/";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
const QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const FEE = 100;
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const TX_ATTEMPTS = Math.max(1, Number(process.env.TX_ATTEMPTS) || 3);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
];

function usage() {
  console.log("использование: node swap-wbnb-to-usdt.js --wallet <имя|адрес> <сумма WBNB|all>");
  console.log("пример: node swap-wbnb-to-usdt.js --wallet 697e all");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const walletFlag = args.indexOf("--wallet");
  if (walletFlag === -1 || !args[walletFlag + 1]) {
    usage();
    process.exit(1);
  }
  const walletSelector = args[walletFlag + 1];
  args.splice(walletFlag, 2);
  if (args.length !== 1 || (args[0] !== "all" && (!Number.isFinite(Number(args[0])) || Number(args[0]) <= 0))) {
    usage();
    process.exit(1);
  }
  return { walletSelector, amount: args[0] };
}

async function main() {
  const { walletSelector, amount } = parseArgs();
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const selected = wallets.find((item) =>
    item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase(),
  );
  if (!selected?.keystore) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const password = await promptHidden("мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(RPC, 56);
  const wallet = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
  const wbnb = new ethers.Contract(WBNB, ERC20_ABI, wallet);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const balance = await wbnb.balanceOf(wallet.address);
  const amountIn = amount === "all" ? balance : ethers.parseUnits(amount, 18);
  if (amountIn === 0n || amountIn > balance) throw new Error("недостаточно WBNB");

  const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  if (await wbnb.allowance(wallet.address, ROUTER) < amountIn) {
    console.log("approve WBNB...");
    await (await wbnb.approve(ROUTER, ethers.MaxUint256)).wait();
  }

  console.log(`кошелёк: ${wallet.address}`);
  console.log(`свап: ${ethers.formatUnits(amountIn, 18)} WBNB -> USDT`);
  const usdtBefore = await usdt.balanceOf(wallet.address);
  let lastError;
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt += 1) {
    try {
      const quote = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: WBNB, tokenOut: USDT, amountIn, fee: FEE, sqrtPriceLimitX96: 0,
      });
      const params = {
        tokenIn: WBNB,
        tokenOut: USDT,
        fee: FEE,
        recipient: wallet.address,
        amountIn,
        amountOutMinimum: quote.amountOut * BigInt(10000 - SLIPPAGE_BPS) / 10000n,
        sqrtPriceLimitX96: 0,
      };
      await router.exactInputSingle.staticCall(params);
      const gas = await router.exactInputSingle.estimateGas(params);
      const tx = await router.exactInputSingle(params, { gasLimit: gas * 120n / 100n });
      console.log(`tx: ${tx.hash}`);
      await tx.wait();
      const received = (await usdt.balanceOf(wallet.address)) - usdtBefore;
      console.log(`готово: получено ${ethers.formatUnits(received, 18)} USDT`);
      return;
    } catch (error) {
      lastError = error;
      const retryable = error.code === "CALL_EXCEPTION" || /transaction execution reverted/i.test(error.message || "");
      if (!retryable || attempt === TX_ATTEMPTS) throw error;
      console.log(`попытка ${attempt}/${TX_ATTEMPTS} откатилась; повторяю через ${attempt * 2} с...`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

main().catch((error) => {
  console.error(`ошибка: ${error.shortMessage || error.message}`);
  process.exit(1);
});
