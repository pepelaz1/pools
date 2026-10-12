#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ethers } = require("ethers");

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  let wallet, dryRun = false, resume = false, newJob = false;
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wallet" && !wallet && argv[i + 1] && !argv[i + 1].startsWith("--")) wallet = argv[++i];
    else if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg === "--resume" && !resume) resume = true;
    else if (arg === "--new-job" && !newJob) newJob = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown or duplicate option: ${arg}`);
    else values.push(arg);
  }
  if (!wallet || values.length !== 3 || (resume && newJob) || (dryRun && (resume || newJob))) {
    throw new Error("Use --wallet <wallet> <lower> <upper> <USDC> [--dry-run|--resume|--new-job]");
  }
  const [lower, upper, amount] = values;
  if (![lower, upper].every(v => /^\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v)) && Number(v) > 0)
    || Number(upper) <= Number(lower)) throw new Error("Invalid ETH price range");
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || ethers.parseUnits(amount, 6) <= 0n) throw new Error("Invalid USDC amount (maximum 6 decimals)");
  return { wallet, lower: String(Number(lower)), upper: String(Number(upper)),
    amount: ethers.formatUnits(ethers.parseUnits(amount, 6), 6), dryRun, resume, newJob };
}

function child(script, args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: __dirname, stdio: "inherit", shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} did not finish successfully (${result.signal || result.status})`);
}

function sameJob(a, b) {
  return ["address", "lower", "upper", "amount"].every(key => a[key] === b[key]);
}

// Mark each stage before invoking a child: an interrupted run must never borrow twice.
function workflow(job, previous, options, run, save) {
  let state = previous;
  if (options.resume) {
    if (!state || !sameJob(state, job) || state.stage !== "borrowed") {
      throw new Error("Resume allowed only after a confirmed borrow and before opening started. Inspect transactions/positions before any manual retry.");
    }
  } else if (state && !(options.newJob && state.stage === "complete")) {
    throw new Error(`Existing job stage: ${state.stage}. Refusing a duplicate borrow. Use --resume only for stage borrowed, or --new-job after complete.`);
  }
  const saveStage = stage => {
    state = { ...job, stage, updatedAt: new Date().toISOString() };
    save(state);
  };
  if (!options.resume) {
    saveStage("borrowing");
    run("borrow-aave-usdc.js", ["--wallet", job.address, job.amount]);
    saveStage("borrowed");
  }
  saveStage("opening");
  run("open-position.js", ["--wallet", job.address, job.lower, job.upper, job.amount, "arbitrum"]);
  saveStage("complete");
  return state;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("node borrow-open-position.js --wallet <wallet> <lower> <upper> <USDC> [--dry-run]");
    console.log("Example: node borrow-open-position.js --wallet 7d13 2400 2500 250");
    console.log("Arbitrum only. --resume: confirmed borrow, opening not yet started. --new-job: start again after complete.");
    console.log("Two separate scripts/transactions; NOT atomic. A failed opening does not repay the loan.");
    return;
  }
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8")).wallets || [];
  const matches = wallets.filter(w => w.name?.toLowerCase() === options.wallet.toLowerCase()
    || w.address?.toLowerCase() === options.wallet.toLowerCase());
  if (matches.length !== 1) throw new Error("Source wallet missing or ambiguous");
  const address = ethers.getAddress(matches[0].address);
  const job = { address, lower: options.lower, upper: options.upper, amount: options.amount };
  console.log(`Aave borrow -> Uniswap ETH/USDC; Arbitrum; wallet ${matches[0].name} (${address})`);
  console.log(`Borrow ${job.amount} USDC; range ${job.lower}-${job.upper}; investment ${job.amount} USDC`);
  console.log("Borrowing and opening are separate operations. Password is requested by each script.");
  if (options.dryRun) {
    child("borrow-aave-usdc.js", ["--dry-run", "--wallet", address, job.amount]);
    console.log("Dry-run checked borrowing only. Opening requires funds and fresh pool quotes; no transactions sent.");
    return;
  }
  const directory = path.join(__dirname, "aave-lp-jobs");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${address.toLowerCase()}.json`);
  const lock = `${file}.lock`;
  let lockFd;
  try {
    lockFd = fs.openSync(lock, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const save = state => {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    };
    workflow(job, previous, options, child, save);
    console.log("Complete: loan received and opening script finished. See positions.json and the mint receipt.");
  } catch (error) {
    console.error(`Job journal: ${file}`);
    console.error("Do not rerun blindly: loan/swaps/mint may already be confirmed. Check child transaction hashes and positions.json.");
    throw error;
  } finally {
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`error: ${error.shortMessage || error.message}`);
    process.exitCode = 1;
  }
}
module.exports = { parseArgs, workflow };
