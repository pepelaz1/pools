#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { promptHidden } = require("./lib");
const { main: closePosition } = require("./close-position");
const { main: repayDebt } = require("./repay-aave-usdc");

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  let resume = false, chain = "arbitrum", chainSet = false;
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--resume" && !resume) resume = true;
    else if (arg === "--chain" && !chainSet && ["arbitrum", "avalanche"].includes(argv[i + 1])) {
      chain = argv[++i];
      chainSet = true;
    }
    else if (arg.startsWith("--")) throw new Error(`Unknown or duplicate option: ${arg}`);
    else values.push(arg);
  }
  if (values.length < 1 || values.length > 2 || !/^[1-9]\d*$/.test(values[0])) {
    throw new Error("Use <tokenId> [USDC amount] [--chain arbitrum|avalanche] [--resume]");
  }
  const amount = values[1] === undefined ? null : values[1];
  if (amount !== null && (!/^\d+(\.\d{1,6})?$/.test(amount) || ethers.parseUnits(amount, 6) <= 0n)) {
    throw new Error("USDC amount must be positive with at most 6 decimal places");
  }
  return { tokenId: values[0], amount: amount === null ? null : ethers.formatUnits(ethers.parseUnits(amount, 6), 6), chain, resume };
}

function sameJob(a, b) {
  return a.tokenId === b.tokenId && a.chain === b.chain
    && a.address.toLowerCase() === b.address.toLowerCase() && a.amount === b.amount;
}

function validateJob(job, previous, resume) {
  if (resume) {
    if (!previous || previous.stage !== "closed" || !sameJob(job, previous)) {
      throw new Error("Resume allowed only for the same job after confirmed close and before repayment started");
    }
  } else if (previous) {
    throw new Error(`Existing job stage: ${previous.stage}. Do not close the position again; inspect the journal and transactions.`);
  }
}

async function workflow(job, previous, resume, run, save) {
  validateJob(job, previous, resume);
  let state = previous;
  const saveStage = stage => {
    state = { ...job, stage, updatedAt: new Date().toISOString() };
    save(state);
  };
  if (!resume) {
    saveStage("closing");
    await run("close", job);
    saveStage("closed");
  }
  saveStage("repaying");
  await run("repay", job);
  saveStage("complete");
  return state;
}

function failureGuidance(operationStarted, journalExists) {
  if (operationStarted) return "A transaction stage started. Check the journal, transaction hashes, positions.json and Aave debt before recovery.";
  if (journalExists) return "No transactions started in this attempt. Check the existing journal before retrying.";
  return "No transactions started and no journal created. Check the password and retry the same command.";
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("node close-repay-aave-usdc.js <tokenId> [USDC amount] [--chain arbitrum|avalanche] [--resume]");
    console.log("Arbitrum ETH/USDC or Avalanche AVAX/USDC; default chain: arbitrum.");
    console.log("Without an amount, repay with wallet USDC up to the debt on the selected chain.");
    console.log("--resume skips closing only if the journal confirms close and repayment has not started.");
    console.log("Closing and repayment are separate transactions, not an atomic operation.");
    return;
  }

  const directory = path.join(__dirname, "aave-lp-jobs");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `close-repay-${options.chain}-${options.tokenId}.json`);
  const lock = `${file}.lock`;
  let lockFd, operationStarted = false;
  try {
    lockFd = fs.openSync(lock, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (options.resume && (!previous || previous.stage !== "closed")) {
      throw new Error("Resume requires a journal at stage closed; inspect transactions before recovery");
    }
    if (!options.resume && previous) {
      throw new Error(`Existing job stage: ${previous.stage}. Do not close the position again; inspect the journal and transactions.`);
    }
    const positions = JSON.parse(fs.readFileSync(path.join(__dirname, "positions.json"), "utf8")).positions || [];
    const matches = positions.filter(position => String(position.tokenId) === options.tokenId
      && (position.chain || "arbitrum") === options.chain);
    if (options.resume && matches.length) throw new Error("Journal says closed, but the position is still in positions.json");
    if (!options.resume && matches.length !== 1) throw new Error(`${options.chain} position missing or ambiguous in positions.json`);
    const address = options.resume ? previous?.address : matches[0].address;
    if (!address || !ethers.isAddress(address)) throw new Error("Position wallet address missing or invalid");
    const job = { tokenId:options.tokenId, chain:options.chain, address:ethers.getAddress(address), amount:options.amount };
    validateJob(job, previous, options.resume);
    const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8")).wallets || [];
    const selected = wallets.find(wallet => wallet.address?.toLowerCase() === job.address.toLowerCase());
    if (!selected?.keystore) throw new Error("Position wallet keystore missing");

    console.log(`Uniswap close -> Aave repay; ${job.chain}; tokenId ${job.tokenId}; wallet ${selected.name || ""} (${job.address})`);
    console.log(`Repayment: ${job.amount === null ? "available wallet USDC (up to debt)" : `${job.amount} USDC`}`);
    console.log(`Job journal: ${file}`);
    console.log("Separate transactions; password is requested once. If a transaction stage fails, inspect the journal before retrying.");
    let password = await promptHidden("мастер-пароль: ");
    try {
      if ((await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).address.toLowerCase() !== job.address.toLowerCase()) {
        throw new Error("Keystore address mismatch");
      }
      const save = state => {
        fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
        fs.renameSync(`${file}.tmp`, file);
        operationStarted = true;
      };
      await workflow(job, previous, options.resume, async stage => {
        if (stage === "close") await closePosition([job.tokenId, job.chain], password);
        else await repayDebt(["--chain", job.chain, "--wallet", job.address, ...(job.amount === null ? [] : [job.amount])], password);
      }, save);
    } finally { password = undefined; }
    console.log("Complete: position closed and Aave repayment stage finished.");
  } catch (error) {
    if (fs.existsSync(file)) console.error(`Job journal: ${file}`);
    console.error(failureGuidance(operationStarted, fs.existsSync(file)));
    throw error;
  } finally {
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  }
}

if (require.main === module) main().catch(error => {
  console.error(`error: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
});
module.exports = { parseArgs, validateJob, workflow, failureGuidance, main };
