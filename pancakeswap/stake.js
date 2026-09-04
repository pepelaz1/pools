#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const RPC = "https://bsc-dataseed.binance.org/";
const MC = "0x556B9306565093C855AEA9AE92A594704c2Cd59e";

async function main() {
  const tokenId = process.argv[2];
  if (!tokenId) { console.log("usage: node stake.js <tokenId>"); process.exit(1); }

  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, 56);
  const wallet = (await ethers.Wallet.fromEncryptedJson(walletsRaw.wallets[0].keystore, password)).connect(provider);

  console.log(`кошелёк: ${wallet.address}`);
  console.log(`стейкаю tokenId ${tokenId}...`);

  // deposit(uint256) selector = 0xb6b55f25
  const data = "0xb6b55f25" + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [tokenId]).slice(2);
  const tx = await wallet.sendTransaction({ to: MC, data, gasLimit: 300000 });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  console.log("стейкинг ok!");
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
