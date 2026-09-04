#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

const KEYSTORE = path.join(__dirname, "wallets.json");

const TESTNET = process.argv.includes("--testnet");

const CFG = TESTNET
  ? {
      rpc: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      swapRouter: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
      positionManager: "0x427bF5b37357632377eCbEC9de3626C71A5396c1",
      masterChef: "0x4c650FB471fe4e0f476fD3437C3411B1122c4e3B",
      factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      usdt: "0x337610d47C3Ff20e1079C628Aa4D98798Ca7d52d",
      wbnb: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd",
      usdtDec: 18,
      wbnbDec: 18,
    }
  : {
      rpc: "https://bsc-dataseed.binance.org/",
      chainId: 56,
      swapRouter: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
      positionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
      masterChef: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
      factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      usdt: "0x55d398326f99059fF775485246999027B3197955",
      wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      usdtDec: 18,
      wbnbDec: 18,
    };

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
];

const PM_ABI = [
  "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

const MC_ABI = [
  "function mint(uint256 tokenId) external",
  "function pendingCake(uint256 tokenId) view returns (uint256)",
];

function parseArgs() {
  const args = process.argv.filter((a) => !a.startsWith("--") && a !== __filename && a !== "node");
  if (args.length < 3) {
    console.log("использование: node open-position.js [--testnet] <tickLower> <tickUpper> <сумма USDT>");
    console.log("пример: node open-position.js --testnet -65796 -65077 500");
    process.exit(1);
  }
  return {
    tickLower: parseInt(args[0]),
    tickUpper: parseInt(args[1]),
    amountUsd: parseFloat(args[2]),
  };
}

async function ensureAllowance(token, wallet, spender, amount) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, wallet);
  const current = await erc20.allowance(wallet.address, spender);
  if (current >= amount) return;
  console.log(`  approve ${await erc20.symbol()}...`);
  await (await erc20.approve(spender, ethers.MaxUint256)).wait();
  console.log("  approve ok");
}

async function getPoolState(factory, token0, token1, fee) {
  const f = new ethers.Contract(factory, FACTORY_ABI, wallet);
  const poolAddr = await f.getPool(token0, token1, fee);
  if (poolAddr === ethers.ZeroAddress) return null;
  const pool = new ethers.Contract(poolAddr, POOL_ABI, wallet);
  const s0 = await pool.slot0();
  return { sqrtPriceX96: s0.sqrtPriceX96, tick: Number(s0.tick) };
}

async function swapExactInput(router, tokenIn, tokenOut, fee, amountIn, recipient) {
  const r = new ethers.Contract(router, ROUTER_ABI, wallet);
  const params = {
    tokenIn,
    tokenOut,
    fee,
    recipient,
    amountIn,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  };
  const tx = await r.exactInputSingle(params);
  const receipt = await tx.wait();
  return receipt;
}

let wallet;

async function main() {
  const { tickLower, tickUpper, amountUsd } = parseArgs();

  const password = await promptHidden("мастер-пароль: ");
  const walletsRaw = JSON.parse(fs.readFileSync(KEYSTORE, "utf8"));
  const keystore = walletsRaw.wallets[0].keystore;
  const provider = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId);
  wallet = (await ethers.Wallet.fromEncryptedJson(keystore, password)).connect(provider);

  console.log(`\nсеть: ${TESTNET ? "BSC Testnet" : "BSC Mainnet"}`);
  console.log(`кошелёк: ${wallet.address}`);
  console.log(`диапазон: [${tickLower}, ${tickUpper}]`);
  console.log(`сумма: ${amountUsd} USDT\n`);

  // ensure token order: token0 < token1
  const [t0, t1] = CFG.usdt.toLowerCase() < CFG.wbnb.toLowerCase()
    ? [CFG.usdt, CFG.wbnb]
    : [CFG.wbnb, CFG.usdt];
  const usdtIs0 = CFG.usdt.toLowerCase() === t0.toLowerCase();

  const amountIn = ethers.parseUnits(amountUsd.toString(), CFG.usdtDec);
  const halfAmount = amountIn / 2n;

  // 1. approve USDT
  console.log("1. проверяю allowance...");
  await ensureAllowance(CFG.usdt, wallet, CFG.swapRouter, amountIn);

  // 2. swap half USDT -> WBNB
  console.log("2. свапаю половину USDT в WBNB...");
  const wbnbBefore = await new ethers.Contract(CFG.wbnb, ERC20_ABI, wallet).balanceOf(wallet.address);
  await swapExactInput(CFG.swapRouter, CFG.usdt, CFG.wbnb, 100, halfAmount, wallet.address);
  const wbnbAfter = await new ethers.Contract(CFG.wbnb, ERC20_ABI, wallet).balanceOf(wallet.address);
  const wbnbReceived = wbnbAfter - wbnbBefore;
  console.log(`   получено WBNB: ${ethers.formatUnits(wbnbReceived, CFG.wbnbDec)}`);

  // 3. calculate amounts for mint
  const usdtLeft = amountIn - halfAmount;
  let amount0Desired, amount1Desired;
  if (usdtIs0) {
    amount0Desired = usdtLeft;
    amount1Desired = wbnbReceived;
  } else {
    amount0Desired = wbnbReceived;
    amount1Desired = usdtLeft;
  }

  // 4. check/create pool
  console.log("3. проверяю пул...");
  const state = await getPoolState(CFG.factory, t0, t1, 500);
  if (!state) {
    console.log("   пул не найден, создаю...");
    const sqrtPrice = ethers.parseUnits("79228162514264337593543950336", 0);
    const pm = new ethers.Contract(CFG.positionManager, PM_ABI, wallet);
    await (await pm.createAndInitializePoolIfNecessary(t0, t1, 500, sqrtPrice)).wait();
    console.log("   пул создан");
  } else {
    console.log(`   пул найден, tick=${state.tick}`);
  }

  // 5. mint position
  console.log("4. создаю позицию...");
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  const mintParams = {
    token0: t0,
    token1: t1,
    fee: 500,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: 0,
    amount1Min: 0,
    recipient: wallet.address,
    deadline,
  };
  const pm = new ethers.Contract(CFG.positionManager, PM_ABI, wallet);
  const mintTx = await pm.mint(mintParams, { value: 0 });
  const mintReceipt = await mintTx.wait();

  // parse tokenId from events
  let tokenId = null;
  for (const log of mintReceipt.logs) {
    try {
      const iface = new ethers.Interface(["event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)"]);
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "IncreaseLiquidity") {
        tokenId = parsed.args.tokenId;
        break;
      }
    } catch {}
  }
  if (!tokenId) {
    // try Transfer event from position manager
    for (const log of mintReceipt.logs) {
      if (log.address.toLowerCase() === CFG.positionManager.toLowerCase() && log.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
        tokenId = BigInt(log.topics[3]);
        break;
      }
    }
  }
  if (!tokenId) {
    console.log("   не удалось извлечь tokenId из логов");
    console.log("   tx hash:", mintReceipt.hash);
    process.exit(1);
  }
  console.log(`   tokenId: ${tokenId}`);

  // 6. stake in MasterChef
  console.log("5. стейкаю в MasterChef...");
  const mc = new ethers.Contract(CFG.masterChef, MC_ABI, wallet);

  // approve NFT to MasterChef
  const PM_APPROVE_ABI = [
    "function approve(address,uint256) returns (bool)",
    "function setApprovalForAll(address,bool) returns (bool)",
    "function getApproved(uint256) view returns (address)",
    "function isApprovedForAll(address,address) view returns (bool)",
  ];
  const pmApproval = new ethers.Contract(CFG.positionManager, PM_APPROVE_ABI, wallet);
  const isApproved = await pmApproval.isApprovedForAll(wallet.address, CFG.masterChef);
  if (!isApproved) {
    const approved = await pmApproval.getApproved(tokenId);
    if (approved.toLowerCase() !== CFG.masterChef.toLowerCase()) {
      console.log("   approveAll...");
      await (await pmApproval.setApprovalForAll(CFG.masterChef, true)).wait();
      console.log("   approveAll ok");
    }
  }

  await (await mc.mint(tokenId)).wait();
  console.log("   стейкинг ok");

  console.log(`\n=== готово ===`);
  console.log(`tokenId: ${tokenId}`);
  console.log(`добавьте в positions.json:`);
  console.log(JSON.stringify({ address: wallet.address, tokenId: Number(tokenId) }, null, 2));
}

main().catch((e) => { console.error("ошибка:", e.shortMessage || e.message); process.exit(1); });
