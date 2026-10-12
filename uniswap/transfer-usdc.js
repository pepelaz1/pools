#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { CHAINS, promptHidden } = require("./lib");

const TOKEN_ABI = [
  "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
];

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  let dryRun = false;
  const positional = [];
  for (const arg of argv) {
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown or duplicate option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 3) throw new Error("Specify source wallet, recipient wallet/address and USDC amount");
  const [from, to, amount] = positional;
  if (!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error("USDC amount must have at most 6 decimal places");
  const amountRaw = ethers.parseUnits(amount, 6);
  if (amountRaw <= 0n || amountRaw > ethers.MaxUint256) throw new Error("Invalid USDC amount");
  return { from, to, amount, amountRaw, dryRun };
}

function resolveTransfer(wallets, from, to) {
  const find = selector => {
    const matches = wallets.filter(w => w.name?.toLowerCase() === selector.toLowerCase()
      || w.address?.toLowerCase() === selector.toLowerCase());
    if (matches.length > 1) throw new Error(`Ambiguous wallet: ${selector}`);
    return matches[0];
  };
  const source = find(from);
  if (!source?.address) throw new Error(`Source wallet not found: ${from}`);
  const recipient = find(to);
  const address = ethers.getAddress(recipient?.address || to);
  const sourceAddress = ethers.getAddress(source.address);
  if (address === ethers.ZeroAddress) throw new Error("Zero recipient address");
  if (address === sourceAddress) throw new Error("Source and recipient are the same");
  if (address.toLowerCase() === CHAINS.arbitrum.stable.toLowerCase()) throw new Error("Recipient cannot be the USDC token contract");
  return { source, sourceAddress, recipientAddress: address, recipientName: recipient?.name || "external address" };
}

async function transferPreflight(token, from, to, amountRaw) {
  const balance = await token.balanceOf(from);
  if (balance < amountRaw) throw new Error(`Insufficient USDC: ${ethers.formatUnits(balance, 6)}`);
  if (!await token.transfer.staticCall(to, amountRaw, { from })) throw new Error("Transfer simulation returned false");
  const gas = await token.transfer.estimateGas(to, amountRaw, { from });
  return { balance, gasLimit: gas * 120n / 100n };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("node transfer-usdc.js [--dry-run] <from wallet> <to wallet|address> <USDC amount>");
    console.log("Example: node transfer-usdc.js d71f 1bcb 250");
    console.log("Arbitrum native USDC only. Not a bridge; no swaps or Aave operations.");
    return;
  }
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8")).wallets || [];
  const resolved = resolveTransfer(wallets, options.from, options.to);
  const cfg = CHAINS.arbitrum;
  const request = new ethers.FetchRequest(process.env.RPC_ARBITRUM || cfg.rpc);
  request.timeout = 15000;
  const provider = new ethers.JsonRpcProvider(request, cfg.chainId);
  try {
    if (Number((await provider.getNetwork()).chainId) !== cfg.chainId) throw new Error("RPC is not Arbitrum");
    const token = new ethers.Contract(cfg.stable, TOKEN_ABI, provider);
    if (Number(await token.decimals()) !== 6) throw new Error("Unexpected USDC decimals");
    console.log("\nArbitrum native USDC transfer");
    console.log(`Token: ${cfg.stable}`);
    console.log(`From: ${resolved.source.name || ""} (${resolved.sourceAddress})`);
    console.log(`To: ${resolved.recipientName} (${resolved.recipientAddress})`);
    console.log(`Amount: ${options.amount} USDC`);
    const preview = await transferPreflight(token, resolved.sourceAddress, resolved.recipientAddress, options.amountRaw);
    const ethBalance = await provider.getBalance(resolved.sourceAddress);
    console.log(`USDC balance: ${ethers.formatUnits(preview.balance, 6)}; ETH for gas: ${ethers.formatEther(ethBalance)}`);
    console.log(`Simulation successful; gas limit with buffer: ${preview.gasLimit}`);
    if (options.dryRun) return console.log("dry-run: no transfer transaction sent");
    if (ethBalance === 0n) throw new Error("ETH required for gas on Arbitrum");
    if (!resolved.source.keystore) throw new Error("Source wallet keystore missing");
    const password = await promptHidden("мастер-пароль: ");
    const signer = (await ethers.Wallet.fromEncryptedJson(resolved.source.keystore, password)).connect(provider);
    if (signer.address !== resolved.sourceAddress) throw new Error("Keystore address mismatch");
    const signedToken = token.connect(signer);
    // Re-check after password entry: balances can change while the user is typing.
    const fresh = await transferPreflight(signedToken, signer.address, resolved.recipientAddress, options.amountRaw);
    const tx = await signedToken.transfer(resolved.recipientAddress, options.amountRaw, { gasLimit: fresh.gasLimit });
    console.log(`transfer tx: ${tx.hash}`);
    await tx.wait();
    console.log(`Confirmed: ${options.amount} USDC sent to ${resolved.recipientAddress}`);
    try {
      console.log(`Sender USDC remaining: ${ethers.formatUnits(await token.balanceOf(signer.address), 6)}`);
    } catch (error) {
      console.warn(`Transfer succeeded, but balance refresh failed: ${error.shortMessage || error.message}`);
    }
  } finally { provider.destroy(); }
}

if (require.main === module) main().catch(error => {
  console.error(`error: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
});
module.exports = { parseArgs, resolveTransfer, transferPreflight };
