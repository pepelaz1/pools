#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS, promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const POSITIONS_FILE = path.join(__dirname, "positions.json");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const ERC20_ABI = [
  "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
];
const PM_ABI = [
  "function ownerOf(uint256) view returns(address)",
  "function positions(uint256) view returns(uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
  "function increaseLiquidity(tuple(uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) returns(uint128 liquidity,uint256 amount0,uint256 amount1)",
  "event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];
const POOL_ABI = ["function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)"];
const QUOTER_ABI = ["function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32,uint256)"];
const ROUTER_ABI = ["function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut)"];

function usage() {
  console.log("использование: node increase-position.js --wallet <имя|адрес> <tokenId> <сумма USDC> <arbitrum|avalanche>");
  console.log("пример: node increase-position.js --wallet 697e 87003 2.7622 avalanche");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const walletIndex = args.indexOf("--wallet");
  if (walletIndex === -1 || !args[walletIndex + 1]) { usage(); process.exit(1); }
  const walletSelector = args[walletIndex + 1];
  args.splice(walletIndex, 2);
  if (args.length !== 3 || !/^\d+$/.test(args[0]) || !Number.isFinite(Number(args[1])) || Number(args[1]) <= 0 || !CHAINS[args[2]]) {
    usage();
    process.exit(1);
  }
  return { walletSelector, tokenId: BigInt(args[0]), amount: args[1], chain: args[2] };
}

function updateOpening(tokenId, chain, amount0, amount1, valueUsd) {
  if (!fs.existsSync(POSITIONS_FILE)) return;
  const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  const item = (data.positions || []).find((entry) => String(entry.tokenId) === String(tokenId) && entry.chain === chain);
  if (!item?.opened) return;
  item.opened.amount0 = (Number(item.opened.amount0) + amount0).toFixed(18);
  item.opened.amount1 = (Number(item.opened.amount1) + amount1).toFixed(18);
  item.opened.valueUsd = Number(item.opened.valueUsd) + valueUsd;
  const temporary = `${POSITIONS_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporary, POSITIONS_FILE);
}

async function main() {
  const { walletSelector, tokenId, amount, chain } = parseArgs();
  const cfg = CHAINS[chain];
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const selected = wallets.find((item) => item.name === walletSelector || item.address.toLowerCase() === walletSelector.toLowerCase());
  if (!selected?.keystore) throw new Error(`кошелёк '${walletSelector}' не найден`);

  const password = await promptHidden("мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  const wallet = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
  const pm = new ethers.Contract(cfg.positionManager, PM_ABI, wallet);
  const pos = await pm.positions(tokenId);
  if ((await pm.ownerOf(tokenId)).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("позиция принадлежит другому кошельку");
  if (pos.liquidity === 0n) throw new Error("в позиции нет ликвидности");

  const stableIs0 = pos.token0.toLowerCase() === cfg.stable.toLowerCase();
  const nativeIs0 = pos.token0.toLowerCase() === cfg.native.toLowerCase();
  if (!stableIs0 && !nativeIs0) throw new Error(`позиция не является парой ${cfg.nativeName}/${cfg.stableName}`);
  const stable = new ethers.Contract(cfg.stable, ERC20_ABI, wallet);
  const native = new ethers.Contract(cfg.native, ERC20_ABI, wallet);
  const [stableDecRaw, nativeDecRaw] = await Promise.all([stable.decimals(), native.decimals()]);
  const stableDec = Number(stableDecRaw);
  const nativeDec = Number(nativeDecRaw);
  const budget = ethers.parseUnits(amount, stableDec);
  if (await stable.balanceOf(wallet.address) < budget) throw new Error(`недостаточно ${cfg.stableName}`);

  const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(pos.token0, pos.token1, pos.fee);
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const slot0 = await pool.slot0();
  const currentTick = Number(slot0.tick);
  const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
  const quoteNative = async (stableIn) => (await quoter.quoteExactInputSingle.staticCall({
    tokenIn: cfg.stable, tokenOut: cfg.native, amountIn: stableIn, fee: pos.fee, sqrtPriceLimitX96: 0,
  }));

  let stableToSwap = 0n;
  let stableToAdd = budget;
  if (currentTick < Number(pos.tickLower)) {
    if (!stableIs0) { stableToSwap = budget; stableToAdd = 0n; }
  } else if (currentTick >= Number(pos.tickUpper)) {
    if (stableIs0) { stableToSwap = budget; stableToAdd = 0n; }
  } else {
    const sqrtLower = Math.pow(1.0001, Number(pos.tickLower) / 2);
    const sqrtUpper = Math.pow(1.0001, Number(pos.tickUpper) / 2);
    const requiredNative = (stableAmount, sqrtPriceX96) => {
      const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
      const token1PerToken0 = (sqrtPrice - sqrtLower) / (1 / sqrtPrice - 1 / sqrtUpper);
      const nativePerStable = stableIs0
        ? token1PerToken0 * Math.pow(10, stableDec - nativeDec)
        : Math.pow(10, stableDec - nativeDec) / token1PerToken0;
      return ethers.parseUnits((Number(ethers.formatUnits(stableAmount, stableDec)) * nativePerStable).toFixed(nativeDec), nativeDec);
    };
    let low = 0n;
    let high = budget;
    for (let i = 0; i < 24 && low < high; i += 1) {
      const candidate = (low + high) / 2n;
      const quote = candidate === 0n ? { 0: 0n, 1: slot0.sqrtPriceX96 } : await quoteNative(candidate);
      if (quote[0] >= requiredNative(budget - candidate, quote[1])) high = candidate;
      else low = candidate + 1n;
    }
    stableToSwap = high;
    stableToAdd = budget - high;
  }

  if (await stable.allowance(wallet.address, cfg.swapRouter) < stableToSwap) await (await stable.approve(cfg.swapRouter, ethers.MaxUint256)).wait();
  if (await stable.allowance(wallet.address, cfg.positionManager) < stableToAdd) await (await stable.approve(cfg.positionManager, ethers.MaxUint256)).wait();
  let nativeReceived = 0n;
  if (stableToSwap > 0n) {
    const before = await native.balanceOf(wallet.address);
    const quote = await quoteNative(stableToSwap);
    const params = { tokenIn: cfg.stable, tokenOut: cfg.native, fee: pos.fee, recipient: wallet.address, amountIn: stableToSwap, amountOutMinimum: quote[0] * BigInt(10000 - SLIPPAGE_BPS) / 10000n, sqrtPriceLimitX96: 0 };
    const router = new ethers.Contract(cfg.swapRouter, ROUTER_ABI, wallet);
    const gas = await router.exactInputSingle.estimateGas(params);
    await (await router.exactInputSingle(params, { gasLimit: gas * 120n / 100n })).wait();
    nativeReceived = (await native.balanceOf(wallet.address)) - before;
  }
  if (await native.allowance(wallet.address, cfg.positionManager) < nativeReceived) await (await native.approve(cfg.positionManager, ethers.MaxUint256)).wait();
  const params = {
    tokenId,
    amount0Desired: stableIs0 ? stableToAdd : nativeReceived,
    amount1Desired: stableIs0 ? nativeReceived : stableToAdd,
    amount0Min: 0,
    amount1Min: 0,
    deadline: Math.floor(Date.now() / 1000) + 1800,
  };
  const preview = await pm.increaseLiquidity.staticCall(params);
  const gas = await pm.increaseLiquidity.estimateGas(params);
  const tx = await pm.increaseLiquidity(params, { gasLimit: gas * 120n / 100n });
  console.log(`tx: ${tx.hash}`);
  const receipt = await tx.wait();
  const log = receipt.logs.find((entry) => {
    try { return entry.address.toLowerCase() === cfg.positionManager.toLowerCase() && pm.interface.parseLog(entry)?.name === "IncreaseLiquidity"; } catch { return false; }
  });
  const actual = log ? pm.interface.parseLog(log).args : preview;
  const current = await pool.slot0();
  const rawPrice = (Number(current.sqrtPriceX96) / 2 ** 96) ** 2;
  const nativeUsd = stableIs0 ? 1 / (rawPrice * Math.pow(10, stableDec - nativeDec)) : rawPrice * Math.pow(10, nativeDec - stableDec);
  const stableAdded = Number(ethers.formatUnits(stableIs0 ? actual.amount0 : actual.amount1, stableDec));
  const nativeAdded = Number(ethers.formatUnits(stableIs0 ? actual.amount1 : actual.amount0, nativeDec));
  const addedUsd = stableAdded + nativeAdded * nativeUsd;
  updateOpening(tokenId, chain, Number(ethers.formatUnits(actual.amount0, stableIs0 ? stableDec : nativeDec)), Number(ethers.formatUnits(actual.amount1, stableIs0 ? nativeDec : stableDec)), addedUsd);
  console.log(`добавлено: ${stableAdded} ${cfg.stableName} + ${nativeAdded} ${cfg.nativeName} = ~$${addedUsd.toFixed(4)}`);
  console.log("стартовая стоимость позиции обновлена в positions.json");
}

main().catch((error) => { console.error("ошибка:", error.shortMessage || error.message); process.exit(1); });
