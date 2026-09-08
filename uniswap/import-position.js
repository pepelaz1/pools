#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const POSITIONS_FILE = path.join(__dirname, "positions.json");
const PM_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

function usage() {
  console.log("использование: node import-position.js --wallet <имя|адрес> <tokenId> <arbitrum|avalanche>");
  console.log("пример: node import-position.js --wallet 697e 78370 avalanche");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const walletFlag = args.indexOf("--wallet");
  if (walletFlag === -1 || !args[walletFlag + 1]) {
    usage();
    process.exit(1);
  }
  const walletSelector = args[walletFlag + 1];
  args.splice(walletFlag, 2);
  if (args.length !== 2 || !/^\d+$/.test(args[0]) || !CHAINS[args[1]]) {
    usage();
    process.exit(1);
  }
  return { walletSelector, tokenId: args[0], chain: args[1] };
}

function savePosition(address, tokenId, chain) {
  let data = { toAddress: address, positions: [] };
  if (fs.existsSync(POSITIONS_FILE)) data = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  if (!Array.isArray(data.positions)) data.positions = [];
  if (data.positions.some((item) => String(item.tokenId) === String(tokenId) && item.chain === chain)) return false;

  data.positions.push({ address, tokenId: Number(tokenId), chain });
  const temporary = `${POSITIONS_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporary, POSITIONS_FILE);
  return true;
}

async function main() {
  const { walletSelector, tokenId, chain } = parseArgs();
  if (!fs.existsSync(WALLETS_FILE)) throw new Error("wallets.json не найден");
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const wallet = wallets.find((item) =>
    item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase(),
  );
  if (!wallet) throw new Error(`кошелёк '${walletSelector}' не найден в wallets.json`);

  const cfg = CHAINS[chain];
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  const manager = new ethers.Contract(cfg.positionManager, PM_ABI, provider);
  const [owner, position] = await Promise.all([manager.ownerOf(tokenId), manager.positions(tokenId)]);
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`NFT принадлежит ${owner}, а не выбранному кошельку ${wallet.address}`);
  }
  if (position.liquidity === 0n) throw new Error("у NFT нулевая ликвидность: позиция уже закрыта");

  if (savePosition(wallet.address, tokenId, chain)) {
    console.log(`позиция ${tokenId} добавлена: ${chain}, кошелёк ${wallet.address}`);
  } else {
    console.log(`позиция ${tokenId} уже есть в positions.json`);
  }
}

main().catch((error) => {
  console.error(`ошибка: ${error.shortMessage || error.message}`);
  process.exit(1);
});
