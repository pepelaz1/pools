const { ethers } = require("ethers");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || "https://arb1.arbitrum.io/rpc";
const TO_ADDRESS = process.env.TO_ADDRESS;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

async function main() {
  if (!PRIVATE_KEY) throw new Error("Задайте PRIVATE_KEY");
  if (!TO_ADDRESS) throw new Error("Задайте TO_ADDRESS");
  if (!ethers.isAddress(TO_ADDRESS)) throw new Error("TO_ADDRESS содержит неверный адрес");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const me = wallet.address;

  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const dec = Number(await usdc.decimals());
  const sym = await usdc.symbol();
  const balance = await usdc.balanceOf(me);

  console.log("Адрес:", me);
  console.log(`Баланс ${sym}:`, ethers.formatUnits(balance, dec));

  if (balance === 0n) {
    console.log("Нечего отправлять.");
    return;
  }

  const tx = await usdc.transfer(TO_ADDRESS, balance);
  console.log("Транзакция отправлена:", tx.hash);
  await tx.wait();
  console.log(`Отправлено ${ethers.formatUnits(balance, dec)} ${sym} на`, TO_ADDRESS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
