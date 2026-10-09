#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS, promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const AAVE_POOL = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const MIN_HEALTH_FACTOR = 1.5;
const AAVE_BASE_DECIMALS = 8;
const AAVE_ABI = [
  "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)",
  "function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)",
];

function usage() {
  console.log("использование: node borrow-aave-usdc.js [--dry-run] --wallet <имя|адрес> <сумма USDC>");
}

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const args = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
  const walletIndex = args.indexOf("--wallet");
  if (walletIndex === -1 || !args[walletIndex + 1]) {
    usage();
    process.exit(1);
  }
  const walletSelector = args[walletIndex + 1];
  args.splice(walletIndex, 2);
  if (args.length !== 1 || !/^\d+(\.\d{1,6})?$/.test(args[0]) || Number(args[0]) <= 0) {
    usage();
    process.exit(1);
  }
  return { dryRun, walletSelector, amount: args[0] };
}

async function main() {
  const { dryRun, walletSelector, amount } = parseArgs();
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const selected = wallets.find((item) => item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase());
  if (!selected?.address) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const cfg = CHAINS.arbitrum;
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const readPool = new ethers.Contract(AAVE_POOL, AAVE_ABI, provider);
  const amountRaw = ethers.parseUnits(amount, 6);
  const account = await readPool.getUserAccountData(selected.address);
  const debtUsd = Number(ethers.formatUnits(account[1], AAVE_BASE_DECIMALS));
  const availableUsd = Number(ethers.formatUnits(account[2], AAVE_BASE_DECIMALS));
  const hf = account[1] === 0n ? Infinity : Number(account[5]) / 1e18;
  const nextHf = account[1] === 0n ? Infinity : hf * debtUsd / (debtUsd + Number(amount));

  console.log(`\nAave Arbitrum; кошелёк: ${selected.address}`);
  console.log(`заем: ${amount} USDC (variable rate)`);
  console.log(`доступно по Aave: ${availableUsd.toFixed(2)} USD`);
  console.log(`HF: ${Number.isFinite(hf) ? hf.toFixed(2) : "∞"} -> ${Number.isFinite(nextHf) ? nextHf.toFixed(2) : "∞"}`);
  if (Number(amount) > availableUsd) throw new Error("сумма превышает доступный лимит Aave");
  if (nextHf < MIN_HEALTH_FACTOR) throw new Error(`заем отменен: расчетный HF ${nextHf.toFixed(2)} ниже минимального порога ${MIN_HEALTH_FACTOR}`);

  const params = [cfg.stable, amountRaw, 2, 0, selected.address]; // 2 = variable debt.
  await readPool.borrow.staticCall(...params, { from: selected.address });
  const estimatedGas = await readPool.borrow.estimateGas(...params, { from: selected.address });
  console.log(`симуляция успешна; оценка газа: ${estimatedGas.toString()}`);
  if (dryRun) return console.log("dry-run: транзакция не отправлена");

  const password = await promptHidden("мастер-пароль: ");
  const signer = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
  const pool = new ethers.Contract(AAVE_POOL, AAVE_ABI, signer);
  const tx = await pool.borrow(...params, { gasLimit: estimatedGas * 120n / 100n });
  console.log(`borrow tx: ${tx.hash}`);
  await tx.wait();
  console.log("готово: USDC зачислены на кошелек");
}

main().catch((error) => {
  console.error(`ошибка: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
});
