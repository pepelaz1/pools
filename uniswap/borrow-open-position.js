#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  let wallet, chain = "arbitrum", chainSet = false, dryRun = false, resume = false, newJob = false;
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wallet" && !wallet && argv[i + 1] && !argv[i + 1].startsWith("--")) wallet = argv[++i];
    else if (arg === "--chain" && !chainSet && argv[i + 1] && !argv[i + 1].startsWith("--")) { chain = argv[++i]; chainSet = true; }
    else if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg === "--resume" && !resume) resume = true;
    else if (arg === "--new-job" && !newJob) newJob = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown or duplicate option: ${arg}`);
    else values.push(arg);
  }
  if (!wallet || !["arbitrum", "avalanche"].includes(chain) || values.length !== 3 || (resume && newJob) || (dryRun && (resume || newJob))) {
    throw new Error("Use --wallet <wallet> <lower> <upper> <USDC> [--chain arbitrum|avalanche] [--dry-run|--resume|--new-job]");
  }
  const [lower, upper, amount] = values;
  if (![lower, upper].every(v => /^\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v)) && Number(v) > 0)
    || Number(upper) <= Number(lower)) throw new Error("Invalid price range");
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || ethers.parseUnits(amount, 6) <= 0n) throw new Error("Invalid USDC amount (maximum 6 decimals)");
  return { wallet, chain, lower: String(Number(lower)), upper: String(Number(upper)),
    amount: ethers.formatUnits(ethers.parseUnits(amount, 6), 6), dryRun, resume, newJob };
}

function child(script, args, password) {
  return new Promise((resolve, reject) => {
    const ipc = password !== undefined;
    const processChild = spawn(process.execPath,
      [path.join(__dirname, script), ...args, ...(ipc ? ["--password-ipc"] : [])], {
        cwd: __dirname, stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit", shell: false,
      });
    let sent = false;
    processChild.on("message", message => {
      if (!ipc || sent || message?.type !== "password-request") return;
      sent = true;
      processChild.send({ type: "master-password", value: password }, error => {
        if (error) { processChild.kill(); reject(new Error("Password delivery failed")); }
      });
    });
    processChild.once("error", reject);
    processChild.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} did not finish successfully (${signal || code})`));
    });
  });
}

function sameJob(a, b) {
  return (a.chain || "arbitrum") === (b.chain || "arbitrum")
    && ["address", "lower", "upper", "amount"].every(key => a[key] === b[key]);
}

// Mark each stage before invoking a child: an interrupted run must never borrow twice.
function validateJob(job, state, options) {
  if (options.resume) {
    if (!state || !sameJob(state, job) || state.stage !== "borrowed") {
      throw new Error("Resume allowed only after a confirmed borrow and before opening started. Inspect transactions/positions before any manual retry.");
    }
  } else if (state && !(options.newJob && state.stage === "complete")) {
    throw new Error(`Existing job stage: ${state.stage}. Refusing a duplicate borrow. Use --resume only for stage borrowed, or --new-job after complete.`);
  }
}

async function workflow(job, previous, options, run, save) {
  let state = previous;
  validateJob(job, state, options);
  const saveStage = stage => {
    state = { ...job, stage, updatedAt: new Date().toISOString() };
    save(state);
  };
  if (!options.resume) {
    saveStage("borrowing");
    await run("borrow-aave-usdc.js", ["--chain", job.chain || "arbitrum", "--wallet", job.address, job.amount]);
    saveStage("borrowed");
  }
  saveStage("opening");
  await run("open-position.js", ["--wallet", job.address, job.lower, job.upper, job.amount, job.chain || "arbitrum"]);
  saveStage("complete");
  return state;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("node borrow-open-position.js --wallet <wallet> <lower> <upper> <USDC> [--chain arbitrum|avalanche] [--dry-run]");
    console.log("Examples: node borrow-open-position.js --wallet 7d13 2400 2500 250");
    console.log("          node borrow-open-position.js --wallet 697e 9 10 250 --chain avalanche");
    console.log("--resume: confirmed borrow, opening not yet started. --new-job: start again after complete.");
    console.log("Two separate scripts/transactions; NOT atomic. A failed opening does not repay the loan.");
    return;
  }
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8")).wallets || [];
  const matches = wallets.filter(w => w.name?.toLowerCase() === options.wallet.toLowerCase()
    || w.address?.toLowerCase() === options.wallet.toLowerCase());
  if (matches.length !== 1) throw new Error("Source wallet missing or ambiguous");
  const address = ethers.getAddress(matches[0].address);
  const job = { address, chain: options.chain, lower: options.lower, upper: options.upper, amount: options.amount };
  console.log(`Aave borrow -> Uniswap ${options.chain === "avalanche" ? "AVAX" : "ETH"}/USDC; ${options.chain}; wallet ${matches[0].name} (${address})`);
  console.log(`Borrow ${job.amount} USDC; range ${job.lower}-${job.upper}; investment ${job.amount} USDC`);
  console.log("Borrowing and opening are separate operations. Password is requested once before both stages.");
  if (options.dryRun) {
    await child("borrow-aave-usdc.js", ["--dry-run", "--chain", job.chain, "--wallet", address, job.amount]);
    console.log("Dry-run checked borrowing only. Opening requires funds and fresh pool quotes; no transactions sent.");
    return;
  }
  const directory = path.join(__dirname, "aave-lp-jobs");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${address.toLowerCase()}${job.chain === "arbitrum" ? "" : `-${job.chain}`}.json`);
  const lock = `${file}.lock`;
  let lockFd;
  try {
    lockFd = fs.openSync(lock, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    validateJob(job, previous, options);
    if (!matches[0].keystore) throw new Error("Source wallet keystore missing");
    let password = await promptHidden("мастер-пароль: ");
    if ((await ethers.Wallet.fromEncryptedJson(matches[0].keystore, password)).address !== address) {
      throw new Error("Keystore address mismatch");
    }
    const save = state => {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    };
    try {
      await workflow(job, previous, options, (script, args) => child(script, args, password), save);
    } finally { password = undefined; }
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
  main().catch(error => {
    console.error(`error: ${error.shortMessage || error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { parseArgs, workflow };
