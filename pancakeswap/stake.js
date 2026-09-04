#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const RPC = "https://bsc-dataseed.binance.org/";
const MC = "0x556B9306565093C855AEA9AE92A594704c2Cd59e";
const PM = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";

const NFT_ABI = [
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
];

async function main() {
  const tokenId = process.argv[2];
  if (!tokenId) { console.log("usage: node stake.js <tokenId>"); process.exit(1); }

  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, 56);
  const wallet = (await ethers.Wallet.fromEncryptedJson(walletsRaw.wallets[0].keystore, password)).connect(provider);

  console.log(`кошелёк: ${wallet.address}`);

  const pm = new ethers.Contract(PM, NFT_ABI, wallet);

  const owner = await pm.ownerOf(tokenId);
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`позиция не принадлежит кошельку! owner: ${owner}`);
    process.exit(1);
  }

  const isApproved = await pm.isApprovedForAll(wallet.address, MC);
  if (!isApproved) {
    console.log("setApprovalForAll...");
    await (await pm.setApprovalForAll(MC, true)).wait();
    console.log("  ok");
  }

  console.log(`отправляю NFT ${tokenId} в MasterChef...`);
  await (await pm.safeTransferFrom(wallet.address, MC, tokenId)).wait();
  console.log("стейкинг ok!");
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
