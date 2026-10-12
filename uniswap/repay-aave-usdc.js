#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { CHAINS, promptHidden } = require("./lib");

const AAVE_POOL = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const MODE = 2; // Variable debt, matching borrow-aave-usdc.js.
const POOL_ABI = [
  "function ADDRESSES_PROVIDER() view returns(address)",
  "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)",
  "function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns(uint256)",
  "event Repay(address indexed reserve,address indexed user,address indexed repayer,uint256 amount,bool useATokens)",
];
const TOKEN_ABI = [
  "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
];

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  let walletSelector, amount, all = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wallet" && !walletSelector && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      walletSelector = argv[++i];
    } else if (arg === "--all" && !all) all = true;
    else if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (!arg.startsWith("--") && amount === undefined) amount = arg;
    else throw new Error(`Unknown or duplicate argument: ${arg}`);
  }
  if (!walletSelector || (all && amount !== undefined) || (!all && amount === undefined)) {
    throw new Error("Specify --wallet and either a USDC amount or --all");
  }
  if (!all && (!/^\d+(\.\d{1,6})?$/.test(amount) || ethers.parseUnits(amount, 6) <= 0n)) {
    throw new Error("USDC amount must be positive with at most 6 decimal places");
  }
  return { walletSelector, all, dryRun, amount };
}

function repaymentPlan({ all, amount }, balance, debt) {
  if (debt === 0n) return null;
  if (all) {
    // Allow a small interest-accrual cushion between reading debt and mining.
    const cushion = (debt + 9999n) / 10000n;
    if (balance < debt + cushion) throw new Error("Full repayment needs debt plus a 0.01% USDC cushion; use a fixed amount for partial repayment");
    return { amountRaw: ethers.MaxUint256, approvalRaw: balance, expected: debt };
  }
  const requested = ethers.parseUnits(amount, 6);
  if (requested > balance) throw new Error("Insufficient USDC balance");
  return { amountRaw: requested, approvalRaw: requested, expected: requested < debt ? requested : debt };
}

function formatHf(account) {
  return account[1] === 0n ? "no debt" : (Number(account[5]) / 1e18).toFixed(2);
}

async function executeRepayment({ pool, token, asset, owner, plan, allowance, log = console.log }) {
  if (allowance < plan.approvalRaw) {
    await token.approve.staticCall(AAVE_POOL, plan.approvalRaw);
    const gas = await token.approve.estimateGas(AAVE_POOL, plan.approvalRaw);
    const approval = await token.approve(AAVE_POOL, plan.approvalRaw, { gasLimit: gas * 120n / 100n });
    log(`approve tx: ${approval.hash}`);
    await approval.wait();
  }
  const params = [asset, plan.amountRaw, MODE, owner];
  const simulated = await pool.repay.staticCall(...params);
  if (simulated === 0n) throw new Error("No debt repaid in simulation");
  const gas = await pool.repay.estimateGas(...params);
  const tx = await pool.repay(...params, { gasLimit: gas * 120n / 100n });
  log(`repay tx: ${tx.hash}`);
  return tx.wait();
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("node repay-aave-usdc.js [--dry-run] --wallet <name|address> <USDC amount>");
    console.log("node repay-aave-usdc.js [--dry-run] --wallet <name|address> --all");
    console.log("Arbitrum native USDC variable debt only; no swaps, borrowing or collateral withdrawal.");
    return;
  }
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8")).wallets || [];
  const selector = options.walletSelector.toLowerCase();
  const selected = wallets.find(w => w.name?.toLowerCase() === selector || w.address?.toLowerCase() === selector);
  if (!selected?.address) throw new Error("Wallet not found");
  const cfg = CHAINS.arbitrum;
  const request = new ethers.FetchRequest(process.env.RPC_ARBITRUM || cfg.rpc);
  request.timeout = 15000;
  const provider = new ethers.JsonRpcProvider(request, cfg.chainId);
  try {
    if (Number((await provider.getNetwork()).chainId) !== cfg.chainId) throw new Error("RPC is not Arbitrum");
    const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);
    const token = new ethers.Contract(cfg.stable, TOKEN_ABI, provider);
    if (Number(await token.decimals()) !== 6) throw new Error("Unexpected USDC decimals");
    const addresses = new ethers.Contract(await pool.ADDRESSES_PROVIDER(),
      ["function getPoolDataProvider() view returns(address)"], provider);
    const data = new ethers.Contract(await addresses.getPoolDataProvider(),
      ["function getReserveTokensAddresses(address) view returns(address,address,address)"], provider);
    const reserve = await data.getReserveTokensAddresses(cfg.stable);
    if (reserve[2] === ethers.ZeroAddress) throw new Error("Variable USDC debt token not found");
    const debtToken = new ethers.Contract(reserve[2], TOKEN_ABI, provider);
    const balance = await token.balanceOf(selected.address);
    const debt = await debtToken.balanceOf(selected.address);
    const account = await pool.getUserAccountData(selected.address);
    const gasBalance = await provider.getBalance(selected.address);
    console.log(`\nAave Arbitrum; wallet: ${selected.name || ""} (${selected.address})`);
    console.log(`USDC balance: ${ethers.formatUnits(balance, 6)}`);
    console.log(`Variable USDC debt: ${ethers.formatUnits(debt, 6)}`);
    console.log(`HF: ${formatHf(account)}; ETH for gas: ${ethers.formatEther(gasBalance)}`);
    const plan = repaymentPlan(options, balance, debt);
    if (!plan) return console.log("No variable USDC debt; no transactions required.");
    console.log(`Repayment: ${options.all ? "ALL (including accrued interest)" : options.amount + " USDC"}`);
    console.log(`Expected now: ${ethers.formatUnits(plan.expected, 6)} USDC`);
    const allowance = await token.allowance(selected.address, AAVE_POOL);
    if (allowance >= plan.approvalRaw) {
      const simulated = await pool.repay.staticCall(cfg.stable, plan.amountRaw, MODE,
        selected.address, { from: selected.address });
      console.log(`Simulation: ${ethers.formatUnits(simulated, 6)} USDC repaid`);
    } else console.log("Approve required. Full repay simulation will run after confirmed approval.");
    if (options.dryRun) return console.log("dry-run: no approvals or repayment transactions sent");
    if (gasBalance === 0n) throw new Error("ETH required for gas");
    if (!selected.keystore) throw new Error("Wallet keystore missing");
    const password = await promptHidden("мастер-пароль: ");
    const signer = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
    if (signer.address.toLowerCase() !== selected.address.toLowerCase()) throw new Error("Keystore address mismatch");
    const receipt = await executeRepayment({ pool: pool.connect(signer), token: token.connect(signer),
      asset: cfg.stable, owner: signer.address, plan, allowance });
    for (const event of receipt.logs) {
      if (event.address.toLowerCase() !== AAVE_POOL.toLowerCase()) continue;
      try {
        const parsed = pool.interface.parseLog(event);
        if (parsed?.name === "Repay" && parsed.args.reserve.toLowerCase() === cfg.stable.toLowerCase()
          && parsed.args.user.toLowerCase() === signer.address.toLowerCase()) {
          console.log(`Repaid: ${ethers.formatUnits(parsed.args.amount, 6)} USDC`);
        }
      } catch {}
    }
    // A failed post-transaction RPC read must not look like a failed repayment.
    console.log("Repayment confirmed.");
    try {
      console.log(`Remaining USDC debt: ${ethers.formatUnits(await debtToken.balanceOf(signer.address), 6)}`);
      console.log(`HF after: ${formatHf(await pool.getUserAccountData(signer.address))}`);
    } catch (error) {
      console.warn(`Repayment succeeded, but status refresh failed: ${error.shortMessage || error.message}`);
    }
  } finally { provider.destroy(); }
}

if (require.main === module) main().catch(error => {
  console.error(`error: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
});
module.exports = { parseArgs, repaymentPlan, executeRepayment };
