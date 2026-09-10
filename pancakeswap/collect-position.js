#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { collectAndSwap, RPC, promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const MIN_USD = Number(process.env.MIN_USD ?? 0);

function usage() {
  console.log("использование: node collect-position.js --wallet <имя|адрес> <tokenId>");
  console.log("пример: node collect-position.js --wallet 697e 7389043");
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
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    usage();
    process.exit(1);
  }
  return { walletSelector, tokenId: BigInt(args[0]) };
}

async function main() {
  const { walletSelector, tokenId } = parseArgs();
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const selected = wallets.find((item) =>
    item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase(),
  );
  if (!selected?.keystore) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const password = await promptHidden("мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(process.env.RPC_BSC || RPC);
  const wallet = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);

  console.log(`кошелёк: ${wallet.address}`);
  console.log(`собираю комиссии и награды позиции #${tokenId}...`);
  const result = await collectAndSwap(wallet, tokenId, {
    slippageBps: SLIPPAGE_BPS,
    minUsd: MIN_USD,
  });

  if (result.status === "empty") {
    console.log("комиссий и наград для сбора нет");
    return;
  }
  if (result.status !== "ok") throw new Error(result.reason || result.status);

  console.log(`собрано USDT: ${ethers.formatUnits(result.usdtCollected, result.usdtDec)}`);
  console.log(`собрано WBNB: ${ethers.formatUnits(result.wbnbCollected, 18)}`);
  console.log(`собрано CAKE: ${ethers.formatUnits(result.cakeReceived, 18)}`);
  console.log(`WBNB -> USDT: ${ethers.formatUnits(result.swappedWbnbUsdt, result.usdtDec)}`);
  console.log(`CAKE -> USDT: ${ethers.formatUnits(result.swappedCakeUsdt, result.usdtDec)}`);
  console.log(`итого получено: ${ethers.formatUnits(result.totalUsdt, result.usdtDec)} USDT`);
}

main().catch((error) => {
  console.error("ошибка:", error.shortMessage || error.message);
  process.exit(1);
});
