#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { closePosition, RPC, prompt, promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");
const POSITIONS = path.join(__dirname, "positions.json");

function removePosition(raw, tokenId) {
  const data = Array.isArray(raw) ? { positions: raw } : raw;
  data.positions = (data.positions || []).filter((item) => String(item.tokenId) !== String(tokenId));

  const temporaryPath = `${POSITIONS}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporaryPath, POSITIONS);
}

async function main() {
  const args = process.argv.slice(2);
  const keepBnb = args.includes("--keep-bnb");
  const tokenIdArg = args.find((arg) => /^\d+$/.test(arg));
  if (!tokenIdArg) {
    console.log("использование: node close-position.js <tokenId> [--keep-bnb]");
    console.log("  --keep-bnb: конвертировать USDT и CAKE из позиции в нативный BNB вместо USDT");
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
  const ksEntry = walletsList.find((entry) =>
    entry.address.toLowerCase() === item.address.toLowerCase(),
  );
  if (!ksEntry || !ksEntry.keystore) {
    console.error(`для позиции не найден keystore кошелька ${item.address}`);
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
  console.log(`закрываю позицию ${item.tokenId}${keepBnb ? " с конвертацией в BNB" : ""}\n`);

  try {
    const stats = await closePosition(connected, item.tokenId, {
      slippageBps: 100,
      keepBnb,
    });
    if (stats.status === "skip") {
      console.log(`пропуск: ${stats.reason}`);
    } else {
      removePosition(raw, item.tokenId);
      console.log("позиция удалена из positions.json");
      console.log(`готово. шаги: ${stats.steps.join(", ")}`);
      console.log(`${keepBnb ? "BNB" : "USDT"} сейчас: ${ethers.formatUnits(keepBnb ? stats.bnbBalance : stats.usdtReceived, 18)}`);
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
  if (keepBnb) console.log(`изменение BNB с учётом газа: ${ethers.formatEther(balAfter - balBefore)}`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
