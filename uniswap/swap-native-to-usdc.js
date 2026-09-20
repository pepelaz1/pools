#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS, promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160,uint32,uint256)",
];
const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut)",
];

function usage() {
  console.log("использование: node swap-native-to-usdc.js --wallet <имя|адрес> <WETH/WAVAX> <arbitrum|avalanche>");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const walletFlag = args.indexOf("--wallet");
  if (walletFlag === -1 || !args[walletFlag + 1]) throw new Error("укажите --wallet <имя|адрес>");
  const walletSelector = args[walletFlag + 1];
  args.splice(walletFlag, 2);
  if (args.length !== 2) {
    usage();
    process.exit(1);
  }
  const [amountRaw, chain] = args;
  if (!CHAINS[chain] || !/^\d+(\.\d+)?$/.test(amountRaw) || Number(amountRaw) <= 0) {
    throw new Error("укажите положительное количество WETH/WAVAX и сеть arbitrum или avalanche");
  }
  return { walletSelector, amountRaw, chain };
}

async function main() {
  const { walletSelector, amountRaw, chain } = parseArgs();
  if (!Number.isFinite(SLIPPAGE_BPS) || SLIPPAGE_BPS < 0 || SLIPPAGE_BPS >= 10000) throw new Error("SLIPPAGE_BPS должен быть от 0 до 9999");
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const selected = wallets.find((item) => item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase());
  if (!selected?.keystore) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const cfg = CHAINS[chain];
  const password = await promptHidden("мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  const wallet = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
  const native = new ethers.Contract(cfg.native, ERC20_ABI, wallet);
  const stable = new ethers.Contract(cfg.stable, ERC20_ABI, wallet);
  const nativeDec = Number(await native.decimals());
  const stableDec = Number(await stable.decimals());
  const amountIn = ethers.parseUnits(amountRaw, nativeDec);
  const balance = await native.balanceOf(wallet.address);
  if (amountIn > balance) throw new Error(`недостаточно ${cfg.nativeName}: доступно ${ethers.formatUnits(balance, nativeDec)}`);

  const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
  const quote = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: cfg.native, tokenOut: cfg.stable, amountIn, fee: cfg.defaultFee, sqrtPriceLimitX96: 0,
  });
  const minimum = quote[0] * BigInt(10000 - SLIPPAGE_BPS) / 10000n;
  console.log(`\n${cfg.nativeName} -> ${cfg.stableName}; кошелёк: ${wallet.address}`);
  console.log(`продаю: ${ethers.formatUnits(amountIn, nativeDec)} ${cfg.nativeName}`);
  console.log(`котировка: ${ethers.formatUnits(quote[0], stableDec)} ${cfg.stableName}; минимум: ${ethers.formatUnits(minimum, stableDec)} ${cfg.stableName}`);

  if (await native.allowance(wallet.address, cfg.swapRouter) < amountIn) {
    console.log("approve только на сумму свапа...");
    await (await native.approve(cfg.swapRouter, amountIn)).wait();
  }
  const router = new ethers.Contract(cfg.swapRouter, ROUTER_ABI, wallet);
  const params = { tokenIn: cfg.native, tokenOut: cfg.stable, fee: cfg.defaultFee, recipient: wallet.address, amountIn, amountOutMinimum: minimum, sqrtPriceLimitX96: 0 };
  await router.exactInputSingle.staticCall(params);
  const gas = await router.exactInputSingle.estimateGas(params);
  const before = await stable.balanceOf(wallet.address);
  const tx = await router.exactInputSingle(params, { gasLimit: gas * 120n / 100n });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  const received = (await stable.balanceOf(wallet.address)) - before;
  console.log(`получено: ${ethers.formatUnits(received, stableDec)} ${cfg.stableName}`);
}

main().catch((error) => {
  console.error(`ошибка: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
});
