#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");
const POSITIONS = path.join(__dirname, "positions.json");
const TX_ATTEMPTS = Math.max(1, Number(process.env.TX_ATTEMPTS) || 3);

const CFG = {
  rpc: "https://bsc-dataseed.binance.org/",
  positionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  masterChef: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
  factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
};

const PM_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool) returns (bool)",
  "function safeTransferFrom(address,address,uint256)",
  "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
];
const FACTORY_ABI = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const walletIndex = args.indexOf("--wallet");
  if (walletIndex === -1 || !args[walletIndex + 1]) throw new Error("укажите кошелёк: --wallet <имя|адрес>");
  const walletSelector = args[walletIndex + 1];
  args.splice(walletIndex, 2);

  const readFlag = (name) => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };
  const openedTx = readFlag("--opened-tx");
  const increaseTx = readFlag("--increase-tx");
  const openedValue = readFlag("--opened-value");
  if (args.length !== 1 || !/^\d+$/.test(args[0])) {
    throw new Error("использование: node stake-position.js --wallet <имя|адрес> <tokenId> [--opened-tx <tx>] [--increase-tx <tx>] [--opened-value <USDT>]");
  }
  if (openedValue !== undefined && (!Number.isFinite(Number(openedValue)) || Number(openedValue) <= 0)) {
    throw new Error("--opened-value должна быть положительным числом");
  }
  return { walletSelector, tokenId: BigInt(args[0]), openedTx, increaseTx, openedValue: openedValue && Number(openedValue) };
}

function savePosition(address, tokenId, opened) {
  let data = { toAddress: address, positions: [] };
  if (fs.existsSync(POSITIONS)) {
    const raw = JSON.parse(fs.readFileSync(POSITIONS, "utf8"));
    data = Array.isArray(raw) ? { toAddress: address, positions: raw } : raw;
  }
  if (!Array.isArray(data.positions)) data.positions = [];
  const existing = data.positions.find((item) => String(item.tokenId) === String(tokenId));
  if (existing) {
    existing.address = address;
    if (opened && !existing.opened) existing.opened = opened;
  } else {
    data.positions.push({ address, tokenId: Number(tokenId), ...(opened ? { opened } : {}) });
  }
  const temporaryPath = `${POSITIONS}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporaryPath, POSITIONS);
}

async function readOpening(provider, pm, position, hashes, knownValueUsd) {
  if (!hashes.length) return undefined;
  let amount0 = 0n;
  let amount1 = 0n;
  let latestReceipt;
  for (const hash of hashes) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1) throw new Error(`не найдена успешная транзакция ${hash}`);
    if (!latestReceipt || receipt.blockNumber > latestReceipt.blockNumber) latestReceipt = receipt;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== CFG.positionManager.toLowerCase()) continue;
      try {
        const event = pm.interface.parseLog(log);
        if (event?.name === "IncreaseLiquidity") {
          amount0 += event.args.amount0;
          amount1 += event.args.amount1;
        }
      } catch {}
    }
  }
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const token0IsUsdt = position.token0.toLowerCase() === CFG.usdt.toLowerCase();
  const token0Amount = Number(ethers.formatUnits(amount0, 18));
  const token1Amount = Number(ethers.formatUnits(amount1, 18));
  let price;
  try {
    const slot0 = await pool.slot0({ blockTag: latestReceipt.blockNumber });
    price = (Number(slot0.sqrtPriceX96) / 2 ** 96) ** 2;
  } catch (error) {
    if (!knownValueUsd) throw new Error("историческая цена недоступна в этом RPC; укажите --opened-value <USDT>");
    price = token0IsUsdt
      ? token1Amount / (knownValueUsd - token0Amount)
      : (knownValueUsd - token1Amount) / token0Amount;
    console.log("историческая цена недоступна в RPC; восстановлена из фактической стоимости позиции");
  }
  const valueUsd = knownValueUsd || (token0IsUsdt ? token0Amount + token1Amount / price : token1Amount + token0Amount * price);
  const block = await provider.getBlock(latestReceipt.blockNumber);
  return { at: new Date(Number(block.timestamp) * 1000).toISOString(), price, amount0: amount0.toString(), amount1: amount1.toString(), valueUsd };
}

async function stakeWithRetries(pm, walletAddress, tokenId) {
  for (let attempt = 1; attempt <= TX_ATTEMPTS; attempt += 1) {
    try {
      const estimatedGas = await pm.safeTransferFrom.estimateGas(walletAddress, CFG.masterChef, tokenId);
      const tx = await pm.safeTransferFrom(walletAddress, CFG.masterChef, tokenId, { gasLimit: estimatedGas * 120n / 100n });
      console.log(`tx: ${tx.hash}`);
      await tx.wait();
      return;
    } catch (error) {
      const retryable = error.code === "CALL_EXCEPTION" || /transaction execution reverted/i.test(error.message || "");
      if (!retryable || attempt === TX_ATTEMPTS) throw error;
      console.log(`попытка ${attempt}/${TX_ATTEMPTS} откатилась; повторяю через ${attempt * 2} с...`);
      await sleep(attempt * 2_000);
    }
  }
}

async function main() {
  const { walletSelector, tokenId, openedTx, increaseTx, openedValue } = parseArgs();
  const password = await promptHidden("мастер-пароль: ");
  const wallets = JSON.parse(fs.readFileSync(KEYSTORE, "utf8")).wallets || [];
  const selected = wallets.find((item) => item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase());
  if (!selected?.keystore) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const provider = new ethers.JsonRpcProvider(CFG.rpc);
  const wallet = await ethers.Wallet.fromEncryptedJson(selected.keystore, password);
  const signer = wallet.connect(provider);
  const pm = new ethers.Contract(CFG.positionManager, PM_ABI, signer);
  const position = await pm.positions(tokenId);
  if (position.liquidity === 0n) throw new Error(`позиция #${tokenId} не содержит ликвидности`);

  const opened = await readOpening(provider, pm, position, [openedTx, increaseTx].filter(Boolean), openedValue);
  const owner = await pm.ownerOf(tokenId);
  if (owner.toLowerCase() === CFG.masterChef.toLowerCase()) {
    console.log(`NFT #${tokenId} уже застейкана в MasterChef`);
  } else {
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`NFT принадлежит ${owner}, а не выбранному кошельку`);
    if (!await pm.isApprovedForAll(wallet.address, CFG.masterChef)) {
      console.log("выдаю разрешение MasterChef...");
      await (await pm.setApprovalForAll(CFG.masterChef, true)).wait();
    }
    console.log(`стейкаю NFT #${tokenId}...`);
    await stakeWithRetries(pm, wallet.address, tokenId);
    console.log("стейкинг ok");
  }
  savePosition(wallet.address, tokenId, opened);
  console.log("позиция сохранена в positions.json");
}

main().catch((error) => { console.error("ошибка:", error.shortMessage || error.message); process.exit(1); });
