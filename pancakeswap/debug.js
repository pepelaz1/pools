#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { RPC, WBNB, USDT, CAKE, promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");
const POSITIONS = path.join(__dirname, "positions.json");

const PM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];
const MASTERCHEF = "0x556B9306565093C855AEA9AE92A594704c2Cd59e";
const MC_ABI = [
  "function userPositionInfos(uint256 tokenId) view returns (uint256 liquidity, uint256 boostLiquidity, int24 tickLower, int24 tickUpper, uint256 rewardGrowthInside, uint256 rewardGrowthInside2, address owner, uint256 boostMultiplier, uint256 precision)",
  "function pendingCake(uint256 tokenId) view returns (uint256)",
];

async function main() {
  const tokenId = process.argv[2];
  if (!tokenId) { console.log("usage: node debug.js <tokenId>"); process.exit(1); }

  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(KEYSTORE, "utf8"));
  const keystore = walletsRaw.wallets[0].keystore;
  const wallet = await ethers.Wallet.fromEncryptedJson(keystore, password);
  const provider = new ethers.JsonRpcProvider(RPC);

  console.log(`\nкошелёк: ${wallet.address}`);
  console.log(`MasterChef: ${MASTERCHEF}`);
  console.log();

  const pm = new ethers.Contract("0x46A15B0b27311cedF172AB29E4f4766fbE7F4364", PM_ABI, provider);
  const mc = new ethers.Contract(MASTERCHEF, MC_ABI, provider);

  const owner = await pm.ownerOf(tokenId);
  console.log(`NFT владелец: ${owner}`);
  console.log(`это MasterChef? ${owner.toLowerCase() === MASTERCHEF.toLowerCase()}`);
  console.log(`это кошелёк? ${owner.toLowerCase() === wallet.address.toLowerCase()}`);

  const pos = await pm.positions(tokenId);
  console.log(`\nпозиция:`);
  console.log(`  token0: ${pos.token0}`);
  console.log(`  token1: ${pos.token1}`);
  console.log(`  fee: ${pos.fee}`);
  console.log(`  liquidity: ${pos.liquidity}`);
  console.log(`  tickLower: ${pos.tickLower}`);
  console.log(`  tickUpper: ${pos.tickUpper}`);
  console.log(`  tokensOwed0: ${pos.tokensOwed0}`);
  console.log(`  tokensOwed1: ${pos.tokensOwed1}`);

  try {
    const info = await mc.userPositionInfos(tokenId);
    console.log(`\nMasterChef userPositionInfo:`);
    console.log(`  liquidity: ${info.liquidity}`);
    console.log(`  owner: ${info.owner}`);
  } catch (e) {
    console.log(`\nuserPositionInfos ошибка: ${e.shortMessage || e.message}`);
  }

  try {
    const pending = await mc.pendingCake(tokenId);
    console.log(`\npendingCake: ${ethers.formatUnits(pending, 18)}`);
  } catch (e) {
    console.log(`\npendingCake ошибка: ${e.shortMessage || e.message}`);
  }
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
