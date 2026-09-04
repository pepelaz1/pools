#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const RPC = "https://data-seed-prebsc-1-s1.binance.org:8545";
const CHAIN_ID = 97;
const ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const USDT = "0xd308dd50e00dafe6a6a77dd7c3e79c17f37de1ee";

const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
  "function factory() view returns (address)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];

async function main() {
  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
  const keystore = walletsRaw.wallets[0].keystore;
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = (await ethers.Wallet.fromEncryptedJson(keystore, password)).connect(provider);

  console.log(`кошелёк: ${wallet.address}`);

  const bnbBal = await provider.getBalance(wallet.address);
  console.log(`tBNB: ${ethers.formatEther(bnbBal)}`);

  // оставляем 0.05 tBNB на газ
  const gasReserve = ethers.parseEther("0.05");
  const swapAmount = bnbBal - gasReserve;

  if (swapAmount <= 0n) {
    console.log("недостаточно tBNB (нужно минимум 0.05 на газ)");
    return;
  }

  // проверяем пул
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const factoryAddr = await router.factory();
  const fc = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const pool = await fc.getPool(WBNB, USDT, 2500);
  console.log(`пул WBNB/USDT (2500): ${pool === ethers.ZeroAddress ? "нет" : pool}`);

  if (pool === ethers.ZeroAddress) {
    console.log("пул не найден, попробуйте другой fee tier");
    return;
  }

  console.log(`свапаю ${ethers.formatEther(swapAmount)} tBNB -> USDT (оставляю 0.05 на газ)...`);
  const tx = await router.exactInputSingle({
    tokenIn: WBNB,
    tokenOut: USDT,
    fee: 2500,
    recipient: wallet.address,
    amountIn: swapAmount,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  });
  console.log(`tx: ${tx.hash}`);
  await tx.wait();

  const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
  const usdtBal = await usdt.balanceOf(wallet.address);
  console.log(`USDT: ${ethers.formatUnits(usdtBal, await usdt.decimals())}`);
  console.log("готово");
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
