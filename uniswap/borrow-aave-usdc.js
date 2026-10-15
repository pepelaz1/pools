#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS } = require("./lib");
const { publicArgs, readMasterPassword } = require("./password-input");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const AAVE_POOL = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const MIN_HEALTH_FACTOR = 1.5;
const AAVE_BASE_DECIMALS = 8;
const AAVE_ABI = [
  "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)",
  "function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)",
];

function usage() {
  console.log("использование: node borrow-aave-usdc.js [--dry-run] [--chain arbitrum|avalanche] --wallet <имя|адрес> <сумма USDC>");
}

function parseArgs(argv = publicArgs()) {
  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((arg) => arg !== "--dry-run");
  const chainIndex = args.indexOf("--chain");
  const chain = chainIndex === -1 ? "arbitrum" : args[chainIndex + 1];
  if (!(["arbitrum", "avalanche"].includes(chain))) throw new Error("укажите сеть: arbitrum или avalanche");
  if (chainIndex !== -1) args.splice(chainIndex, 2);
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
  return { dryRun, chain, walletSelector, amount: args[0] };
}

async function main() {
  const { dryRun, chain, walletSelector, amount } = parseArgs();
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const selected = wallets.find((item) => item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase());
  if (!selected?.address) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const cfg = CHAINS[chain];
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  const readPool = new ethers.Contract(AAVE_POOL, AAVE_ABI, provider);
  const amountRaw = ethers.parseUnits(amount, 6);
  const account = await readPool.getUserAccountData(selected.address);
  const debtUsd = Number(ethers.formatUnits(account[1], AAVE_BASE_DECIMALS));
  const availableUsd = Number(ethers.formatUnits(account[2], AAVE_BASE_DECIMALS));
  const hf = account[1] === 0n ? Infinity : Number(account[5]) / 1e18;
  const nextHf = debtUsd + Number(amount) === 0 ? Infinity
    : Number(ethers.formatUnits(account[0], AAVE_BASE_DECIMALS)) * Number(account[3]) / 10000 / (debtUsd + Number(amount));

  console.log(`\nAave ${chain}; кошелёк: ${selected.address}`);
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

  const password = await readMasterPassword("мастер-пароль: ");
  const signer = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
  const pool = new ethers.Contract(AAVE_POOL, AAVE_ABI, signer);
  const tx = await pool.borrow(...params, { gasLimit: estimatedGas * 120n / 100n });
  console.log(`borrow tx: ${tx.hash}`);
  await tx.wait();
  console.log("готово: USDC зачислены на кошелек");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ошибка: ${error.shortMessage || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs };
