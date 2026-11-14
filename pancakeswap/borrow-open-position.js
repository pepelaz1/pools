#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const { RPC, USDT, promptHidden } = require("./lib");

const POOL = "0x6807dc923806fe8fd134338eabca509979a7e0cb";
const ABI = [
  "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)",
  "function ADDRESSES_PROVIDER() view returns(address)",
  "function borrow(address,uint256,uint256,uint16,address)",
];

function parseArgs(argv) {
  const args = [...argv];
  const options = {};
  for (const flag of ["--dry-run", "--resume", "--new-job"]) {
    const index = args.indexOf(flag);
    options[flag.slice(2)] = index !== -1;
    if (index !== -1) args.splice(index, 1);
  }
  const index = args.indexOf("--wallet");
  if (index === -1 || !args[index + 1]) throw Error("Укажите --wallet <кошелёк>");
  options.wallet = args[index + 1];
  args.splice(index, 2);
  if (args.length !== 3 || !args.every(v => /^\d+(\.\d{1,18})?$/.test(v) && Number.isFinite(Number(v)) && Number(v) > 0)
    || Number(args[0]) >= Number(args[1]) || [options["dry-run"], options.resume, options["new-job"]].filter(Boolean).length > 1) {
    throw Error("node borrow-open-position.js --wallet <кошелёк> <от> <до> <USDT> [--dry-run|--resume|--new-job]");
  }
  [options.lower, options.upper, options.amount] = args;
  return options;
}

function checkRisk(account, addedDebt) {
  if (addedDebt <= 0n || addedDebt > account[2]) throw Error("Недостаточно доступного займа в Aave");
  const nextHf = account[0] * account[3] * 10n ** 18n / (10000n * (account[1] + addedDebt));
  if (nextHf < 15n * 10n ** 17n) throw Error("HF после займа ниже минимального 1.5");
  return nextHf;
}

function validateJob(job, previous, options) {
  if (options.resume) {
    if (!previous || previous.stage !== "borrowed" || !["address", "lower", "upper", "amount"].every(key => previous[key] === job[key])) {
      throw Error("--resume разрешён только после подтверждённого займа, до начала открытия, с теми же параметрами");
    }
  } else if (previous && !(options["new-job"] && previous.stage === "complete")) {
    throw Error(`Этап ${previous.stage}: повторный заём запрещён. --new-job допустим только после complete`);
  }
}

function openPosition(job, password) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "open-position.js"), "--wallet", job.address,
      job.lower, job.upper, job.amount, "--password-ipc"], { cwd:__dirname, shell:false, stdio:["inherit", "inherit", "inherit", "ipc"] });
    let sent = false;
    child.on("message", message => {
      if (sent || message?.type !== "password-request") return;
      sent = true;
      child.send({ type:"master-password", value:password }, error => { if (error) { child.kill(); reject(error); } });
    });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(Error(`Открытие не завершено (код ${code}); заём уже получен. Проверьте транзакции и positions.json`)));
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8")).wallets || [];
  const matches = wallets.filter(w => w.name?.toLowerCase() === options.wallet.toLowerCase() || w.address?.toLowerCase() === options.wallet.toLowerCase());
  if (matches.length !== 1) throw Error("Кошелёк не найден или имя неоднозначно");
  const selected = matches[0];
  const job = { address:ethers.getAddress(selected.address), lower:options.lower, upper:options.upper, amount:options.amount };
  const request = new ethers.FetchRequest(process.env.RPC_BSC || RPC);
  request.timeout = 20000;
  const provider = new ethers.JsonRpcProvider(request, 56, { staticNetwork:true });
  let lockFd, lock;
  try {
    if ((await provider.getNetwork()).chainId !== 56n || BigInt(await provider.send("eth_chainId", [])) !== 56n) throw Error("Ожидалась BNB Chain (56)");
    console.log(`Aave USDT -> PancakeSwap BNB/USDT; BNB Chain; ${selected.name} (${job.address})`);
    console.log(`Заём и инвестиция: ${job.amount} USDT; диапазон ${job.lower}–${job.upper}`);
    const directory = path.join(__dirname, "aave-lp-jobs");
    const file = path.join(directory, `${job.address.toLowerCase()}.json`);
    let previous;
    if (!options["dry-run"]) {
      fs.mkdirSync(directory, { recursive:true });
      lock = `${file}.lock`;
      lockFd = fs.openSync(lock, "wx");
      previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      validateJob(job, previous, options);
      console.log(`Журнал: ${file}`);
    }
    const pool = new ethers.Contract(POOL, ABI, provider);
    const amountRaw = ethers.parseUnits(job.amount, 18);
    const params = [USDT.toLowerCase(), amountRaw, 2, 0, job.address];
    let gasLimit;
    if (!options.resume) {
      const addresses = new ethers.Contract(await pool.ADDRESSES_PROVIDER(), ["function getPriceOracle() view returns(address)"], provider);
      const oracle = new ethers.Contract(await addresses.getPriceOracle(), ["function getAssetPrice(address) view returns(uint256)"], provider);
      const account = await pool.getUserAccountData(job.address);
      const price = await oracle.getAssetPrice(USDT.toLowerCase());
      const nextHf = checkRisk(account, (amountRaw * price + 10n ** 18n - 1n) / 10n ** 18n);
      console.log(`HF после займа: ${ethers.formatUnits(nextHf, 18)} (минимум 1.5)`);
      await pool.borrow.staticCall(...params, { from:job.address });
      gasLimit = await pool.borrow.estimateGas(...params, { from:job.address }) * 130n / 100n;
      const fees = await provider.getFeeData();
      if (!fees.gasPrice || await provider.getBalance(job.address) < gasLimit * fees.gasPrice) throw Error("Недостаточно BNB на газ займа");
    }
    if (options["dry-run"]) return console.log("Симуляция займа успешна. Открытие не симулировано; транзакции не отправлены.");
    let password = await promptHidden("мастер-пароль: ");
    try {
      const wallet = (await ethers.Wallet.fromEncryptedJson(selected.keystore, password)).connect(provider);
      if (wallet.address !== job.address) throw Error("Адрес keystore не совпадает");
      let state = options.resume ? previous : job;
      const save = stage => {
        state = { ...state, ...job, stage, updatedAt:new Date().toISOString() };
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n");
        fs.renameSync(`${file}.tmp`, file);
      };
      if (!options.resume) {
        const freshAccount = await pool.getUserAccountData(job.address);
        const addresses = new ethers.Contract(await pool.ADDRESSES_PROVIDER(), ["function getPriceOracle() view returns(address)"], provider);
        const oracle = new ethers.Contract(await addresses.getPriceOracle(), ["function getAssetPrice(address) view returns(uint256)"], provider);
        checkRisk(freshAccount, (amountRaw * await oracle.getAssetPrice(USDT.toLowerCase()) + 10n ** 18n - 1n) / 10n ** 18n);
        await pool.connect(wallet).borrow.staticCall(...params);
        gasLimit = await pool.connect(wallet).borrow.estimateGas(...params) * 130n / 100n;
        save("borrowing");
        const tx = await pool.connect(wallet).borrow(...params, { gasLimit });
        state.borrowTx = tx.hash;
        save("borrowing");
        console.log(`borrow tx: ${tx.hash}`);
        await tx.wait();
        save("borrowed");
      }
      save("opening");
      await openPosition(job, password);
      save("complete");
      console.log("Готово: заём получен, скрипт открытия завершён.");
    } finally { password = undefined; }
  } finally {
    provider.destroy();
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  }
}

if (require.main === module) main().catch(error => {
  console.error(`ошибка: ${error.shortMessage || error.message}`);
  console.error("После сбоя проверьте журнал aave-lp-jobs, транзакции и positions.json: заём и открытие — отдельные операции.");
  process.exitCode = 1;
});
module.exports = { parseArgs, checkRisk, validateJob };
