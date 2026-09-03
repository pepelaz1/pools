#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { closePosition, RPC, prompt, promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");
const POSITIONS = path.join(__dirname, "positions.json");

async function main() {
  const tokenIdArg = process.argv[2];
  if (!tokenIdArg) {
    console.log("использование: node close-position.js <tokenId>");
    process.exit(1);
  }

  const password = await promptHidden("мастер-пароль: ");

  let walletsRaw;
  try {
    walletsRaw = JSON.parse(fs.readFileSync(KEYSTORE, "utf8"));
  } catch {
    console.error("wallets.json не найден");
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(POSITIONS, "utf8"));
  } catch {
    console.error("pancakeswap/positions.json не найден");
    process.exit(1);
  }

  const items = Array.isArray(raw) ? raw : raw.positions || [];
  const item = items.find((it) => String(it.tokenId) === tokenIdArg);
  if (!item) {
    console.error(`позиция ${tokenIdArg} не найдена в pancakeswap/positions.json`);
    process.exit(1);
  }

  const walletsList = walletsRaw.wallets || [];
  const ksEntry = walletsList[0];
  if (!ksEntry || !ksEntry.keystore) {
    console.error("не найден keystore в wallets.json");
    process.exit(1);
  }

  const wallet = await ethers.Wallet.fromEncryptedJson(ksEntry.keystore, password);
  const provider = new ethers.JsonRpcProvider(RPC);
  const connected = wallet.connect(provider);

  const balBefore = await provider.getBalance(wallet.address);
  const usdtBefore = await new ethers.Contract(
    "0x55d398326f99059fF775485246999027B3197955",
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  ).balanceOf(wallet.address);

  console.log(`\nкошелёк: ${wallet.address}`);
  console.log(`закрываю позицию ${item.tokenId}\n`);

  try {
    const stats = await closePosition(connected, item.tokenId, {
      slippageBps: 100,
    });
    if (stats.status === "skip") {
      console.log(`пропуск: ${stats.reason}`);
    } else {
      console.log(`готово. шаги: ${stats.steps.join(", ")}`);
      console.log(`usdt сейчас: ${ethers.formatUnits(stats.usdtReceived, 18)}`);
      if (stats.cakeReceived) {
        console.log(`собрано CAKE: ${ethers.formatUnits(stats.cakeReceived, 18)}`);
      }
    }
  } catch (e) {
    console.error(`ошибка: ${e.shortMessage || e.message}`);
  }

  const balAfter = await provider.getBalance(wallet.address);
  const usdtAfter = await new ethers.Contract(
    "0x55d398326f99059fF775485246999027B3197955",
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  ).balanceOf(wallet.address);

  console.log("\n=== итого ===");
  console.log(`потрачено BNB: ${ethers.formatEther(balBefore - balAfter)}`);
  console.log(`изменение USDT: ${ethers.formatUnits(usdtAfter - usdtBefore, 18)}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
