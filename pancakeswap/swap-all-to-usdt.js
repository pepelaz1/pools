#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { RPC, WBNB, CAKE, WBNB_USDT_FEE, CAKE_USDT_FEE, swapToUsdt, promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const ERC20_ABI = ["function balanceOf(address) view returns(uint256)"];
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;

function usage() {
  console.log("использование: node swap-all-to-usdt.js --wallet <имя|адрес>");
}

async function main() {
  const args = process.argv.slice(2);
  const walletIndex = args.indexOf("--wallet");
  if (walletIndex === -1 || !args[walletIndex + 1] || args.length !== 2) {
    usage();
    process.exit(1);
  }
  const selector = args[walletIndex + 1];
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const selected = wallets.find((item) => item.name === selector || item.address.toLowerCase() === selector.toLowerCase());
  if (!selected?.keystore) throw new Error(`кошелёк '${selector}' не найден`);

  const password = await promptHidden("мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(RPC, 56);
  const wallet = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
  const tokens = [
    { name: "WBNB", address: WBNB, fee: WBNB_USDT_FEE },
    { name: "CAKE", address: CAKE, fee: CAKE_USDT_FEE },
  ];

  console.log(`кошелёк: ${wallet.address}`);
  let totalUsdt = 0n;
  for (const token of tokens) {
    const balance = await new ethers.Contract(token.address, ERC20_ABI, wallet).balanceOf(wallet.address);
    if (balance === 0n) {
      console.log(`${token.name}: 0, пропуск`);
      continue;
    }
    console.log(`${token.name}: ${ethers.formatUnits(balance, 18)} -> USDT...`);
    const received = await swapToUsdt(wallet, token.address, balance, token.fee, SLIPPAGE_BPS);
    totalUsdt += received;
    console.log(`получено: ${ethers.formatUnits(received, 18)} USDT`);
  }
  console.log(`итого: ${ethers.formatUnits(totalUsdt, 18)} USDT`);
}

main().catch((error) => {
  console.error(`ошибка: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
});
