#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { closePosition, RPC, prompt, promptHidden } = require("./lib");
const { recordCloseIncome } = require("../close-income");

const KEYSTORE = path.join(__dirname, "wallets.json");
const POSITIONS = path.join(__dirname, "positions.json");

function removePosition(raw, tokenId) {
  const data = Array.isArray(raw) ? { positions: raw } : raw;
  data.positions = (data.positions || []).filter((item) => String(item.tokenId) !== String(tokenId));

  const temporaryPath = `${POSITIONS}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporaryPath, POSITIONS);
}

function closingSummary(opened, usdtBefore, usdtAfter, { keepBnb = false, complete = true } = {}) {
  const initialUsd = opened?.valueUsd == null ? null : Number(opened.valueUsd);
  const knownInitial = Number.isFinite(initialUsd) && initialUsd > 0;
  const lines = [knownInitial
    ? `внесено в пул: ~$${initialUsd.toFixed(2)} (включая довнесения)`
    : "внесено в пул: нет исходных данных в positions.json"];
  if (keepBnb) return [...lines, "разница в USD не рассчитана: позиция закрыта в BNB"];
  const receivedRaw = usdtAfter - usdtBefore;
  lines.unshift(`получено из позиции: ${ethers.formatUnits(receivedRaw, 18)} USDT (с комиссиями и проданными CAKE)`);
  if (!complete) return [...lines, "разница не рассчитана: не подтверждена полная конвертация ликвидности в USDT"];
  if (!knownInitial) return [...lines, "разница не рассчитана: нет исходной стоимости позиции"];
  const difference = Number(ethers.formatUnits(receivedRaw, 18)) - initialUsd;
  const sign = difference >= 0 ? "+" : "-";
  lines.push(`разница с полученным: ${sign}$${Math.abs(difference).toFixed(4)} (${sign}${Math.abs(difference / initialUsd * 100).toFixed(2)}%), без газа`);
  return lines;
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
      if (!keepBnb) recordCloseIncome({
        dex:"pancakeswap", chain:"bsc", tokenId:String(item.tokenId), address:wallet.address,
        initialUsd:item.opened?.valueUsd == null ? null : Number(item.opened.valueUsd),
        receivedUsd:Number(ethers.formatUnits(stats.usdtReceived - usdtBefore, 18)),
        principalReceivedUsd:stats.principalUsdtReceived == null ? null
          : Number(ethers.formatUnits(stats.principalUsdtReceived, 18)),
      });
      removePosition(raw, item.tokenId);
      console.log("позиция удалена из positions.json");
      console.log(`готово. шаги: ${stats.steps.join(", ")}`);
      console.log(`${keepBnb ? "BNB" : "USDT"} сейчас: ${ethers.formatUnits(keepBnb ? stats.bnbBalance : stats.usdtReceived, 18)}`);
      for (const line of closingSummary(item.opened, usdtBefore, stats.usdtReceived, {
        keepBnb, complete:stats.principalUsdtReceived != null,
      })) console.log(line);
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

if (require.main === module) main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
module.exports = { closingSummary };
