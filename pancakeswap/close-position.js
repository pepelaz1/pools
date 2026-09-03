#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { closePosition, RPC, prompt, promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "..", "wallets.json");
const POSITIONS = path.join(__dirname, "positions.json");

async function main() {
  const password = await promptHidden("Master password: ");

  let keystores;
  try {
    keystores = JSON.parse(fs.readFileSync(KEYSTORE, "utf8"));
  } catch {
    console.error("wallets.json not found");
    process.exit(1);
  }

  let items;
  try {
    items = JSON.parse(fs.readFileSync(POSITIONS, "utf8"));
  } catch {
    console.error("pancakeswap/positions.json not found");
    process.exit(1);
  }

  const pcsPositions = items.filter((it) => it.chain === "bsc");
  if (pcsPositions.length === 0) {
    console.log("no pancakeswap positions found");
    process.exit(0);
  }

  const ks = keystores.bsc || keystores.pancakeswap;
  if (!ks) {
    console.error("no bsc keystore found in wallets.json");
    process.exit(1);
  }

  const wallet = await ethers.Wallet.fromEncryptedJson(ks, password);
  const provider = new ethers.JsonRpcProvider(RPC);
  const connected = wallet.connect(provider);

  const balBefore = await provider.getBalance(wallet.address);
  const usdtBefore = await new ethers.Contract(
    "0x55d398326f99059fF775485246999027B3197955",
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  ).balanceOf(wallet.address);

  console.log(`\nwallet: ${wallet.address}`);
  console.log(`positions: ${pcsPositions.length}\n`);

  let totalCake = 0n;
  let totalUsdt = 0n;

  for (const item of pcsPositions) {
    console.log(`--- position ${item.tokenId} ---`);
    try {
      const stats = await closePosition(connected, item.tokenId, {
        slippageBps: 100,
      });
      if (stats.status === "skip") {
        console.log(`skip: ${stats.reason}`);
        continue;
      }
      if (stats.cakeReceived) {
        totalCake += stats.cakeReceived;
      }
      totalUsdt = stats.usdtReceived;
      console.log(`done. steps: ${stats.steps.join(", ")}`);
      console.log(`usdt now: ${ethers.formatUnits(stats.usdtReceived, 18)}`);
      if (stats.cakeReceived) {
        console.log(`cake harvested: ${ethers.formatUnits(stats.cakeReceived, 18)}`);
      }
    } catch (e) {
      console.error(`error: ${e.shortMessage || e.message}`);
    }
  }

  const balAfter = await provider.getBalance(wallet.address);
  const usdtAfter = await new ethers.Contract(
    "0x55d398326f99059fF775485246999027B3197955",
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  ).balanceOf(wallet.address);

  console.log("\n=== stats ===");
  console.log(`bsc spent: ${ethers.formatEther(balBefore - balAfter)} BNB`);
  console.log(`usdt: ${ethers.formatUnits(usdtAfter - usdtBefore, 18)} USDT`);
  if (totalCake > 0n) {
    console.log(`cake harvested: ${ethers.formatUnits(totalCake, 18)} CAKE`);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
