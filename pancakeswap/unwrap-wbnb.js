#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");
const RPC = "https://bsc-dataseed.binance.org/";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const WBNB_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function withdraw(uint256) payable",
];

function usage() {
  console.log("использование: node unwrap-wbnb.js --wallet <имя|адрес> <сумма WBNB|all>");
  console.log("пример: node unwrap-wbnb.js --wallet 697e all");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const walletIndex = args.indexOf("--wallet");
  if (walletIndex === -1 || !args[walletIndex + 1]) {
    usage();
    process.exit(1);
  }
  const walletSelector = args[walletIndex + 1];
  args.splice(walletIndex, 2);
  if (args.length !== 1 || (args[0] !== "all" && (!Number.isFinite(Number(args[0])) || Number(args[0]) <= 0))) {
    usage();
    process.exit(1);
  }
  return { walletSelector, amount: args[0] };
}

async function main() {
  const { walletSelector, amount } = parseArgs();
  const wallets = JSON.parse(fs.readFileSync(KEYSTORE, "utf8")).wallets || [];
  const selected = wallets.find((item) =>
    item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase(),
  );
  if (!selected?.keystore) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const password = await promptHidden("мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
  const wbnb = new ethers.Contract(WBNB, WBNB_ABI, wallet);
  const balance = await wbnb.balanceOf(wallet.address);
  const amountRaw = amount === "all" ? balance : ethers.parseEther(amount);
  if (amountRaw > balance) throw new Error(`недостаточно WBNB: доступно ${ethers.formatEther(balance)}`);
  if (amountRaw === 0n) {
    console.log("WBNB для разворачивания нет");
    return;
  }

  console.log(`кошелёк: ${wallet.address}`);
  console.log(`разворачиваю ${ethers.formatEther(amountRaw)} WBNB в BNB...`);
  const bnbBefore = await provider.getBalance(wallet.address);
  const tx = await wbnb.withdraw(amountRaw);
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  const bnbAfter = await provider.getBalance(wallet.address);
  console.log(`готово. изменение BNB с учётом газа: ${ethers.formatEther(bnbAfter - bnbBefore)}`);
}

main().catch((error) => {
  console.error("ошибка:", error.shortMessage || error.message);
  process.exit(1);
});
