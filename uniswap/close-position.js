#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CHAINS, promptHidden } = require("./lib");
const { withdrawnPrincipal, principalProceeds, recordCloseIncome } = require("../close-income");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const POSITIONS_FILE = path.join(__dirname, "positions.json");
const MAX_UINT128 = 2n ** 128n - 1n;

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function withdraw(uint256)",
];
const PM_ABI = [
  "event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function positions(uint256) view returns(uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function ownerOf(uint256) view returns(address)",
  "function decreaseLiquidity(tuple(uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) returns(uint256 amount0,uint256 amount1)",
  "function collect(tuple(uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) returns(uint256 amount0,uint256 amount1)",
  "function burn(uint256 tokenId)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160,uint32,uint256)",
];
const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut)",
];

function usage() {
  console.log("использование: node close-position.js <tokenId> [arbitrum|avalanche] [--keep-eth]");
  console.log("--keep-eth: только Arbitrum; обменять USDC от позиции в WETH и получить обычный ETH");
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help:true };
  let keepEth = false;
  const values = [];
  for (const arg of argv) {
    if (arg === "--keep-eth" && !keepEth) keepEth = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown or duplicate option: ${arg}`);
    else values.push(arg);
  }
  const [tokenIdArg, requestedChain] = values;
  if (values.length < 1 || values.length > 2 || !/^[1-9]\d*$/.test(tokenIdArg)
    || (requestedChain && !CHAINS[requestedChain])) throw new Error("Use <tokenId> [arbitrum|avalanche] [--keep-eth]");
  if (keepEth && requestedChain === "avalanche") throw new Error("--keep-eth supports Arbitrum only");
  return { tokenIdArg, requestedChain, keepEth };
}

async function settleInEth({ stable, native, quoter, router, cfg, owner, fee, stableBefore, nativeBefore, log = console.log }) {
  if (cfg.chainId !== 42161) throw new Error("--keep-eth supports Arbitrum only");
  const stableAmount = (await stable.balanceOf(owner)) - stableBefore;
  if (stableAmount < 0n) throw new Error("USDC balance changed unexpectedly");
  if (stableAmount > 0n) {
    const quote = await quoter.quoteExactInputSingle.staticCall({
      tokenIn:cfg.stable, tokenOut:cfg.native, amountIn:stableAmount, fee, sqrtPriceLimitX96:0,
    });
    const minimum = quote[0] * 9900n / 10000n;
    if (minimum <= 0n) throw new Error("No valid USDC -> WETH quote");
    if (await stable.allowance(owner, cfg.swapRouter) < stableAmount) {
      await stable.approve.staticCall(cfg.swapRouter, stableAmount);
      const gas = await stable.approve.estimateGas(cfg.swapRouter, stableAmount);
      const tx = await stable.approve(cfg.swapRouter, stableAmount, { gasLimit:gas * 120n / 100n });
      log(`approve tx: ${tx.hash}`);
      await tx.wait();
    }
    const params = { tokenIn:cfg.stable, tokenOut:cfg.native, fee, recipient:owner,
      amountIn:stableAmount, amountOutMinimum:minimum, sqrtPriceLimitX96:0 };
    await router.exactInputSingle.staticCall(params);
    const gas = await router.exactInputSingle.estimateGas(params);
    const tx = await router.exactInputSingle(params, { gasLimit:gas * 120n / 100n });
    log(`swap USDC -> WETH tx: ${tx.hash}`);
    await tx.wait();
  }
  const ethReceived = (await native.balanceOf(owner)) - nativeBefore;
  if (ethReceived < 0n) throw new Error("WETH balance changed unexpectedly");
  if (ethReceived > 0n) {
    await native.withdraw.staticCall(ethReceived);
    const gas = await native.withdraw.estimateGas(ethReceived);
    const tx = await native.withdraw(ethReceived, { gasLimit:gas * 120n / 100n });
    log(`unwrap WETH -> ETH tx: ${tx.hash}`);
    await tx.wait();
  }
  if (await stable.balanceOf(owner) !== stableBefore || await native.balanceOf(owner) !== nativeBefore) {
    throw new Error("Settlement incomplete: check remaining position tokens before retrying");
  }
  return ethReceived;
}

function removePosition(data, tokenId, chain) {
  data.positions = (data.positions || []).filter((item) => !(String(item.tokenId) === String(tokenId) && (item.chain || "arbitrum") === chain));
  const temporary = `${POSITIONS_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temporary, POSITIONS_FILE);
}

function closeComparison(opened, receivedRaw, stableDecimals) {
  if (opened?.valueUsd == null) return null;
  const initialUsd = Number(opened.valueUsd);
  if (!Number.isFinite(initialUsd) || initialUsd <= 0) return null;
  const receivedUsd = Number(ethers.formatUnits(receivedRaw, stableDecimals));
  const differenceUsd = receivedUsd - initialUsd;
  return { initialUsd, differenceUsd, differencePct: differenceUsd / initialUsd * 100 };
}

async function main(argv = process.argv.slice(2), passwordOverride) {
  const options = parseArgs(argv);
  if (options.help) return usage();
  const { tokenIdArg, requestedChain, keepEth } = options;
  if (!fs.existsSync(WALLETS_FILE) || !fs.existsSync(POSITIONS_FILE)) throw new Error("wallets.json или positions.json не найден");
  const positionsData = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  const matches = (positionsData.positions || []).filter((item) => String(item.tokenId) === tokenIdArg && (!requestedChain || (item.chain || "arbitrum") === requestedChain));
  if (matches.length !== 1) throw new Error(matches.length ? "укажите сеть: arbitrum или avalanche" : "позиция не найдена в positions.json");
  const item = matches[0];
  const chain = item.chain || "arbitrum";
  if (keepEth && chain !== "arbitrum") throw new Error("--keep-eth supports Arbitrum only");
  const cfg = CHAINS[chain];
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")).wallets || [];
  const key = wallets.find((wallet) => wallet.address.toLowerCase() === item.address.toLowerCase());
  if (!key?.keystore) throw new Error("для позиции не найден keystore в wallets.json");

  const password = passwordOverride ?? await promptHidden("мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
  try {
  const wallet = (await ethers.Wallet.fromEncryptedJson(key.keystore, password)).connect(provider);
  const pm = new ethers.Contract(cfg.positionManager, PM_ABI, wallet);
  const tokenId = BigInt(tokenIdArg);
  if ((await pm.ownerOf(tokenId)).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("позиция принадлежит другому кошельку");
  const pos = await pm.positions(tokenId);
  const hasPair = [pos.token0.toLowerCase(), pos.token1.toLowerCase()].includes(cfg.native.toLowerCase()) && [pos.token0.toLowerCase(), pos.token1.toLowerCase()].includes(cfg.stable.toLowerCase());
  if (!hasPair) throw new Error(`позиция не является парой ${cfg.nativeName}/${cfg.stableName}`);

  const stable = new ethers.Contract(cfg.stable, ERC20_ABI, wallet);
  const native = new ethers.Contract(cfg.native, ERC20_ABI, wallet);
  const [stableDecRaw, nativeDecRaw, stableBefore, nativeBefore] = await Promise.all([
    stable.decimals(), native.decimals(), stable.balanceOf(wallet.address), native.balanceOf(wallet.address),
  ]);
  const stableDec = Number(stableDecRaw);
  const nativeDec = Number(nativeDecRaw);
  console.log(`\nсеть: ${chain}; кошелёк: ${wallet.address}`);
  console.log(`закрываю позицию ${tokenId}\n`);
  console.log(`результат закрытия: ${keepEth ? "ETH (--keep-eth)" : cfg.stableName}`);

  let principal = null;
  if (pos.liquidity > 0n) {
    console.log("withdraw...");
    const withdrawParams = { tokenId, liquidity: pos.liquidity, amount0Min: 0, amount1Min: 0, deadline: Math.floor(Date.now() / 1000) + 1800 };
    await pm.decreaseLiquidity.staticCall(withdrawParams);
    const withdrawGas = await pm.decreaseLiquidity.estimateGas(withdrawParams);
    const withdrawTx = await pm.decreaseLiquidity(withdrawParams, { gasLimit: withdrawGas * 120n / 100n });
    console.log(`withdraw tx: ${withdrawTx.hash}`);
    const receipt = await withdrawTx.wait();
    principal = withdrawnPrincipal(receipt, pm.interface, cfg.positionManager, tokenId);
  }
  console.log("collect...");
  const collectTx = await pm.collect({ tokenId, recipient: wallet.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 });
  console.log(`collect tx: ${collectTx.hash}`);
  await collectTx.wait();

  const stableCollected = (await stable.balanceOf(wallet.address)) - stableBefore;
  const nativeDelta = (await native.balanceOf(wallet.address)) - nativeBefore;
  let ethReceived = 0n;
  if (keepEth) {
    ethReceived = await settleInEth({ stable, native, cfg, owner:wallet.address, fee:pos.fee,
      stableBefore, nativeBefore,
      quoter:new ethers.Contract(cfg.quoter, QUOTER_ABI, provider),
      router:new ethers.Contract(cfg.swapRouter, ROUTER_ABI, wallet) });
  } else if (nativeDelta > 0n) {
    console.log(`swap ${cfg.nativeName} -> ${cfg.stableName}...`);
    if (await native.allowance(wallet.address, cfg.swapRouter) < nativeDelta) {
      await (await native.approve(cfg.swapRouter, nativeDelta)).wait();
    }
    const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
    const quote = await quoter.quoteExactInputSingle.staticCall({ tokenIn: cfg.native, tokenOut: cfg.stable, amountIn: nativeDelta, fee: pos.fee, sqrtPriceLimitX96: 0 });
    const minimum = (quote[0] * 9900n) / 10000n;
    if (minimum === 0n) throw new Error("No valid swap quote; refusing a swap without minimum output");
    const router = new ethers.Contract(cfg.swapRouter, ROUTER_ABI, wallet);
    const swapParams = { tokenIn: cfg.native, tokenOut: cfg.stable, fee: pos.fee, recipient: wallet.address, amountIn: nativeDelta, amountOutMinimum: minimum, sqrtPriceLimitX96: 0 };
    await router.exactInputSingle.staticCall(swapParams);
    const gas = await router.exactInputSingle.estimateGas(swapParams);
    const tx = await router.exactInputSingle(swapParams, { gasLimit: gas * 120n / 100n });
    console.log(`swap tx: ${tx.hash}`);
    await tx.wait();
  }
  try {
    const burnTx = await pm.burn(tokenId);
    console.log(`burn tx: ${burnTx.hash}`);
    await burnTx.wait();
  } catch (error) {
    console.warn("NFT не сожжён, но ликвидность забрана:", error.shortMessage || error.message);
  }

  const stableAfter = await stable.balanceOf(wallet.address);
  const receivedRaw = stableAfter - stableBefore;
  const stableIs0 = pos.token0.toLowerCase() === cfg.stable.toLowerCase();
  const principalRaw = !keepEth && principal ? principalProceeds({
    stablePrincipal:stableIs0 ? principal.amount0 : principal.amount1,
    nativePrincipal:stableIs0 ? principal.amount1 : principal.amount0,
    stableCollected, nativeCollected:nativeDelta, swapReceived:receivedRaw - stableCollected,
  }) : null;
  if (!keepEth) recordCloseIncome({
    dex:"uniswap", chain, tokenId:String(tokenId), address:wallet.address,
    initialUsd:item.opened?.valueUsd == null ? null : Number(item.opened.valueUsd),
    receivedUsd:Number(ethers.formatUnits(receivedRaw, stableDec)),
    principalReceivedUsd:principalRaw == null ? null : Number(ethers.formatUnits(principalRaw, stableDec)),
  });
  removePosition(positionsData, tokenId, chain);
  console.log("позиция удалена из positions.json");
  if (keepEth) {
    console.log(`готово. получено: ${ethers.formatUnits(ethReceived, nativeDec)} ETH (без вычета газа)`);
    if (item.opened?.valueUsd != null && Number.isFinite(Number(item.opened.valueUsd))) {
      console.log(`внесено в пул: ~$${Number(item.opened.valueUsd).toFixed(2)} (включая довнесения)`);
    }
    console.log("разница в USD не фиксируется: результат закрытия получен в ETH");
    return;
  }
  console.log(`готово. получено: ${ethers.formatUnits(receivedRaw, stableDec)} ${cfg.stableName}`);
  const comparison = closeComparison(item.opened, receivedRaw, stableDec);
  if (comparison) {
    const sign = comparison.differenceUsd >= 0 ? "+" : "-";
    console.log(`внесено в пул: ~$${comparison.initialUsd.toFixed(2)} (включая довнесения)`);
    console.log(`разница с полученным: ${sign}$${Math.abs(comparison.differenceUsd).toFixed(4)} (${sign}${Math.abs(comparison.differencePct).toFixed(2)}%), без газа`);
  } else console.log("внесено в пул и разница: нет исходных данных в positions.json");
  console.log(`остаток ${cfg.nativeName} от позиции: ${ethers.formatUnits((await native.balanceOf(wallet.address)) - nativeBefore, nativeDec)}`);
  } finally { provider.destroy(); }
}

if (require.main === module) main().catch((error) => { console.error("ошибка:", error.shortMessage || error.message); process.exitCode = 1; });
module.exports = { main, closeComparison, parseArgs, settleInEth };
