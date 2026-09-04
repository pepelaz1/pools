#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

async function main() {
  const tokenId = process.argv[2];
  const pw = await promptHidden("пароль: ");
  const w = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
  const p = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/", 56);
  const wallet = (await ethers.Wallet.fromEncryptedJson(w.wallets[0].keystore, pw)).connect(p);
  const MC = "0x556B9306565093C855AEA9AE92A594704c2Cd59e";
  const iface = new ethers.Interface(["function withdraw(uint256 tokenId, address to)"]);
  const data = iface.encodeFunctionData("withdraw", [BigInt(tokenId), wallet.address]);
  console.log("tx data:", data.slice(0, 10));
  const tx = await wallet.sendTransaction({ to: MC, data, gasLimit: 500000 });
  console.log("tx:", tx.hash);
  const r = await tx.wait();
  console.log("ok! gas:", r.gasUsed.toString());
}
main().catch(e => console.error("err:", e.shortMessage || e.message));
