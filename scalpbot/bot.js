#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("../uniswap/node_modules/ethers");
const { CHAINS } = require("../uniswap/lib");
const engine = require("./engine");

const POOL = "0xC6962004f452bE9203591991D15f6b388e09E8D0";
const POOL_ABI = [
  "function token0() view returns(address)", "function token1() view returns(address)",
  "function fee() view returns(uint24)",
  "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

function args(argv) {
  const result = { config: { ...engine.DEFAULTS }, once: false,
    statePath: path.join(__dirname, "data", "state.json") };
  const options = { "--capital": "capital", "--trade-usd": "tradeUsd",
    "--poll-seconds": "pollSeconds", "--candle-seconds": "candleSeconds",
    "--take-profit-pct": "takeProfitPct", "--stop-loss-pct": "stopLossPct",
    "--max-hold-minutes": "maxHoldMinutes", "--cooldown-minutes": "cooldownMinutes",
    "--max-daily-loss-usd": "maxDailyLossUsd", "--max-daily-trades": "maxDailyTrades",
    "--gas-usd-per-swap": "gasUsdPerSwap", "--execution-buffer-bps": "executionBufferBps",
    "--max-round-trip-cost-pct": "maxRoundTripCostPct" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--once") { result.once = true; continue; }
    if (arg === "--state") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing state path");
      result.statePath = path.resolve(argv[++i]);
      continue;
    }
    if (!options[arg] || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    result.config[options[arg]] = Number(argv[++i]);
  }
  engine.validateConfig(result.config);
  return result;
}

function save(file, state) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, file);
}

function quoteRaw(quoter, cfg, tokenIn, tokenOut, amountIn, blockTag) {
  return quoter.quoteExactInputSingle.staticCall({
    tokenIn, tokenOut, amountIn, fee: cfg.defaultFee, sqrtPriceLimitX96: 0,
  }, { blockTag }).then(q => q[0]);
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) {
    console.log("PAPER ONLY: node bot.js [--once] [--state path] [--capital 100] [--trade-usd 25]");
    console.log("Other options: --poll-seconds --candle-seconds --take-profit-pct --stop-loss-pct");
    console.log("--max-hold-minutes --cooldown-minutes --max-daily-loss-usd --max-daily-trades");
    console.log("--gas-usd-per-swap --execution-buffer-bps --max-round-trip-cost-pct");
    return;
  }
  const cfg = CHAINS.arbitrum;
  const provider = new ethers.JsonRpcProvider(process.env.SCALP_RPC_URL || cfg.rpc);
  // No signer, key, wallet file, approval, or transaction-sending path exists here.
  const pool = new ethers.Contract(POOL, POOL_ABI, provider);
  const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
  let stop = false, failures = 0;
  let lockFd;
  const lock = `${options.statePath}.lock`;
  const onStop = () => { stop = true; };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  try {
    fs.mkdirSync(path.dirname(options.statePath), { recursive: true });
    lockFd = fs.openSync(lock, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== cfg.chainId) throw new Error("RPC is not Arbitrum");
    const token0 = (await pool.token0()).toLowerCase();
    const token1 = (await pool.token1()).toLowerCase();
    const expected = [cfg.native.toLowerCase(), cfg.stable.toLowerCase()];
    if (![token0, token1].every(t => expected.includes(t)) || token0 === token1
      || Number(await pool.fee()) !== cfg.defaultFee) throw new Error("Unexpected pool tokens/fee");
    const state = fs.existsSync(options.statePath)
      ? JSON.parse(fs.readFileSync(options.statePath, "utf8")) : engine.createState(options.config);
    engine.validateState(state, options.config);
    console.log("PAPER ONLY / Arbitrum ETH-USDC / no real transactions");
    console.log(`State: ${options.statePath}`);
    console.log(`Gas model: $${state.config.gasUsdPerSwap}/swap; execution haircut: ${state.config.executionBufferBps} bps`);
    console.log("Warmup: 51 closed sampled candles; days/limits use UTC.");
    while (!stop) {
      const start = Date.now();
      try {
        const block = await provider.getBlock("latest");
        if (!block || Date.now() / 1000 - block.timestamp > 60 || block.timestamp > Date.now() / 1000 + 30) {
          throw new Error("Stale or future RPC block");
        }
        const slot = await pool.slot0({ blockTag: block.number });
        const ratio = (Number(slot[0]) / 2 ** 96) ** 2;
        const price = token0 === cfg.native.toLowerCase() ? ratio * 1e12 : 1 / (ratio * 1e-12);
        // Work on a copy: failed reads or quotes cannot half-commit a paper trade.
        const next = structuredClone(state);
        const sample = engine.ingest(next, { price, time: block.timestamp, block: block.number });
        if (sample.accepted) {
          if (sample.gap) console.log("Data gap: restarting entry warmup; existing position remains monitored.");
          let liquidationQuote = null, action = "hold";
          if (next.position) {
            const raw = await quoteRaw(quoter, cfg, cfg.native, cfg.stable,
              BigInt(next.position.ethRaw), block.number);
            liquidationQuote = Number(ethers.formatUnits(raw, 6));
            const reason = engine.exitReason(next, block.timestamp, liquidationQuote);
            if (reason) {
              const trade = engine.closePosition(next, block.timestamp, liquidationQuote, reason);
              action = `SELL ${reason} net P/L=$${trade.pnl.toFixed(4)}`;
            }
          } else if (sample.closed && next.lastDecisionBucket !== next.candles.at(-1).bucket) {
            next.lastDecisionBucket = next.candles.at(-1).bucket;
            const signal = engine.entrySignal(next.candles);
            action = signal.reason;
            if (signal.enter && engine.canEnter(next, block.timestamp)) {
              const amount = ethers.parseUnits(next.config.tradeUsd.toFixed(6), 6);
              const bought = await quoteRaw(quoter, cfg, cfg.stable, cfg.native, amount, block.number);
              const conservative = bought * BigInt(10000 - Math.ceil(next.config.executionBufferBps)) / 10000n;
              const back = await quoteRaw(quoter, cfg, cfg.native, cfg.stable, conservative, block.number);
              liquidationQuote = Number(ethers.formatUnits(back, 6));
              const costPct = engine.roundTripCostPct(next, liquidationQuote);
              if (costPct <= next.config.maxRoundTripCostPct) {
                engine.openPosition(next, block.timestamp, conservative.toString(),
                  Number(ethers.formatUnits(conservative, 18)));
                action = `BUY round-trip model cost=${costPct.toFixed(3)}%`;
              } else action = `cost_filter ${costPct.toFixed(3)}%`;
            } else if (signal.enter) action = "risk_limit";
          }
          save(options.statePath, next);
          Object.assign(state, next);
          const equity = state.cash + (state.position && liquidationQuote !== null
            ? engine.netSale(state, liquidationQuote) : 0);
          console.log(`${new Date(block.timestamp * 1000).toISOString()} ETH=$${price.toFixed(2)} `
            + `candles=${state.candles.length} equity=$${equity.toFixed(4)} trades=${state.trades.length} ${action}`);
        }
        failures = 0;
      } catch (error) {
        failures++;
        console.error(`Read/quote/save failed (${failures}): ${error.shortMessage || error.message}`);
        if (options.once || failures >= 5) throw new Error("Stopped after failures; no real transactions sent");
      }
      if (options.once) break;
      const delay = Math.max(0, state.config.pollSeconds * 1000 - (Date.now() - start));
      // Short waits let Ctrl+C stop without waiting for a full polling interval.
      for (let waited = 0; waited < delay && !stop; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, Math.min(250, delay - waited)));
      }
    }
  } finally {
    provider.destroy();
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { args, save };
