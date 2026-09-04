#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const RPC = "https://bsc-dataseed.binance.org/";
const MC = "0x556B9306565093C855AEA9AE92A594704c2Cd59e";
const MC_ABI = [
  "function deposit(uint256 tokenId) external",
];

async function main() {
  const tokenId = process.argv[2];
  if (!tokenId) { console.log("usage: node stake.js <tokenId>"); process.exit(1); }

  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, 56);
  const wallet = (await ethers.Wallet.fromEncryptedJson(walletsRaw.wallets[0].keystore, password)).connect(provider);

  console.log(`кошелёк: ${wallet.address}`);
  console.log(`стейкаю tokenId ${tokenId}...`);

  const mc = new ethers.Contract(MC, MC_ABI, wallet);
  await (await mc.deposit(tokenId)).wait();
  console.log("стейкинг ok!");
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
