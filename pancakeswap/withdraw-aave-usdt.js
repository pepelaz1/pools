#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { RPC, USDT, promptHidden } = require("./lib");

// Aave Address Book: AaveV3BNB.sol. Only BNB Chain, USDT, own recipient.
const POOL = "0x6807dc923806fe8fd134338eabca509979a7e0cb";
const DATA_PROVIDER = "0xc90df74a7c16245c5f5c5870327ceb38fe5d5328";
const POOL_ABI = [
  "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)",
  "function withdraw(address asset,uint256 amount,address to) returns(uint256)",
  "event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)",
];
const TOKEN_ABI = ["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"];

function parseArgs(argv) {
  const args = [...argv];
  const dryIndex = args.indexOf("--dry-run");
  const dryRun = dryIndex !== -1;
  if (dryRun) args.splice(dryIndex, 1);
  const index = args.indexOf("--wallet");
  if (index === -1 || !args[index + 1]) throw new Error("укажите --wallet <имя|адрес>");
  const selector = args[index + 1];
  args.splice(index, 2);
  if (args.length !== 1 || !/^\d+(\.\d{1,18})?$/.test(args[0]) || ethers.parseUnits(args[0], 18) <= 0n) {
    throw new Error("использование: node withdraw-aave-usdt.js [--dry-run] --wallet <имя|адрес> <сумма USDT>");
  }
  return { selector, amount: args[0], dryRun };
}

async function preflight({ provider, pool, usdt, aToken, address, amountRaw }) {
  if ((await provider.getNetwork()).chainId !== 56n) throw new Error("RPC подключён не к BNB Chain (56)");
  const [decimals, supplied, account, native] = await Promise.all([
    usdt.decimals(), aToken.balanceOf(address), pool.getUserAccountData(address), provider.getBalance(address),
  ]);
  if (Number(decimals) !== 18) throw new Error("неожиданная точность USDT BSC");
  if (supplied < amountRaw) throw new Error(`недостаточно USDT в Aave: ${ethers.formatUnits(supplied, 18)}`);
  const params = [USDT.toLowerCase(), amountRaw, address];
  // Simulates the actual Aave risk/liquidity validation, without signing.
  const received = await pool.withdraw.staticCall(...params, { from: address });
  if (received !== amountRaw) throw new Error("симуляция вернула другую сумму вывода");
  const estimate = await pool.withdraw.estimateGas(...params, { from: address });
  const gasLimit = (estimate * 120n + 99n) / 100n;
  const fees = await provider.getFeeData();
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
  if (gasPrice === null || gasPrice <= 0n) throw new Error("не удалось оценить стоимость газа");
  if (native < gasLimit * gasPrice) throw new Error("недостаточно BNB для газа");
  return { supplied, account, params, gasLimit };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const entries = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8")).wallets || [];
  const matches = entries.filter(w => w.name?.toLowerCase() === options.selector.toLowerCase()
    || w.address?.toLowerCase() === options.selector.toLowerCase());
  if (matches.length !== 1) throw new Error("кошелёк не найден или имя неоднозначно");
  const selected = matches[0];
  const address = ethers.getAddress(selected.address);
  const provider = new ethers.JsonRpcProvider(process.env.RPC_BSC || RPC);
  try {
    if ((await provider.getNetwork()).chainId !== 56n) throw new Error("ожидалась BNB Chain (56)");
    const data = new ethers.Contract(DATA_PROVIDER, [
      "function getReserveTokensAddresses(address) view returns(address,address,address)",
    ], provider);
    const [aTokenAddress] = await data.getReserveTokensAddresses(USDT.toLowerCase());
    if (aTokenAddress === ethers.ZeroAddress) throw new Error("резерв USDT не найден");
    const pool = new ethers.Contract(POOL, POOL_ABI, provider);
    const context = { provider, pool, address, amountRaw: ethers.parseUnits(options.amount, 18),
      usdt: new ethers.Contract(USDT.toLowerCase(), TOKEN_ABI, provider),
      aToken: new ethers.Contract(aTokenAddress, TOKEN_ABI, provider) };
    const preview = await preflight(context);
    console.log(`Aave V3 BNB Chain; кошелёк: ${address}`);
    console.log(`депозит USDT: ${ethers.formatUnits(preview.supplied, 18)}`);
    console.log(`вывод: ${options.amount} USDT на этот же кошелёк`);
    console.log(`долг: ${ethers.formatUnits(preview.account[1], 8)} USD`);
    console.log(`текущий HF: ${preview.account[1] === 0n ? "∞ (нет долга)" : ethers.formatUnits(preview.account[5], 18)}`);
    console.log("симуляция вывода успешна; новый заём не создаётся");
    if (options.dryRun) return console.log("dry-run: ключ не расшифрован, транзакций нет");

    const password = await promptHidden("мастер-пароль: ");
    const signer = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
    if (signer.address.toLowerCase() !== address.toLowerCase()) throw new Error("ключ не соответствует выбранному адресу");
    // Refresh validation after password entry, then send exactly once.
    const checked = await preflight(context);
    const tx = await pool.connect(signer).withdraw(...checked.params, { gasLimit: checked.gasLimit });
    console.log(`withdraw tx: ${tx.hash}`);
    console.log("не повторяйте команду при неопределённом статусе — проверьте этот хеш");
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("транзакция неуспешна");
    const event = receipt.logs.map(log => {
      if (log.address.toLowerCase() !== POOL) return null;
      try { return pool.interface.parseLog(log); } catch { return null; }
    }).find(log => log?.name === "Withdraw" && log.args.user.toLowerCase() === address.toLowerCase()
      && log.args.reserve.toLowerCase() === USDT.toLowerCase() && log.args.to.toLowerCase() === address.toLowerCase());
    console.log(event ? `выведено: ${ethers.formatUnits(event.args.amount, 18)} USDT` : "транзакция подтверждена; проверьте сумму по хешу");
    const after = await pool.getUserAccountData(address);
    console.log(`HF после: ${after[1] === 0n ? "∞ (нет долга)" : ethers.formatUnits(after[5], 18)}`);
  } finally {
    provider.destroy();
  }
}

if (require.main === module) main().catch(error => {
  console.error(`ошибка: ${error.shortMessage || error.message}`);
  process.exitCode = 1;
});
module.exports = { parseArgs, preflight };
