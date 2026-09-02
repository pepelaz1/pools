const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { collectAndSwap, getOwner, RPC, promptHidden } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const POSITIONS_FILE = path.join(__dirname, "positions.json");
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS) || 100;
const MIN_USD = Number(process.env.MIN_USD) || 1;

async function main() {
  if (!fs.existsSync(WALLETS_FILE)) {
    console.error("Файл wallets.json не найден. Сначала запустите: node setup.js");
    process.exit(1);
  }
  if (!fs.existsSync(POSITIONS_FILE)) {
    console.error("Файл positions.json не найден. Запустите: node setup.js");
    process.exit(1);
  }

  const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  const wallets = walletsData.wallets || [];
  const posData = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  const positions = posData.positions || [];

  const walletsByAddr = new Map();
  for (const w of wallets) {
    walletsByAddr.set(w.address.toLowerCase(), w);
  }

  const toAddress = posData.toAddress || process.env.TO_ADDRESS || "";
  if (toAddress && !ethers.isAddress(toAddress)) {
    console.error("toAddress содержит неверный адрес.");
    process.exit(1);
  }

  const password = await promptHidden("Мастер-пароль: ");
  const provider = new ethers.JsonRpcProvider(process.env.RPC_BSC || RPC);
  const summary = [];
  let grandTotal = 0n;

  for (const p of positions) {
    const addr = (p.address || "").toLowerCase();
    const label = `${p.tokenId ?? "?"}`;

    const w = walletsByAddr.get(addr);
    if (!w) {
      console.log(`\n=== ${p.address} #${label} ===`);
      console.log("Кошелёк не найден в wallets.json — пропущен.");
      summary.push({ name: `${p.address || "?"} #${label}`, result: "кошелёк не найден" });
      continue;
    }

    if (!p.tokenId) {
      console.log(`\n=== ${w.name} (${w.address}) ===`);
      console.log("Нет tokenId в positions.json — пропущен.");
      summary.push({ name: `${w.name} #${label}`, result: "нет tokenId" });
      continue;
    }

    console.log(`\n=== ${w.name} (${w.address}) tokenId=${p.tokenId} ===`);

    let owner;
    try {
      owner = await getOwner(provider, p.tokenId);
    } catch (e) {
      console.error("Не удалось получить владельца позиции:", e.shortMessage || e.message);
      summary.push({ name: `${w.name} #${label}`, result: "ошибка чтения позиции" });
      continue;
    }
    console.log("Владелец позиции:", owner);

    if (owner.toLowerCase() !== w.address.toLowerCase()) {
      console.warn("ВНИМАНИЕ: позиция принадлежит другому кошельку — пропущена.");
      summary.push({ name: `${w.name} #${label}`, result: `владелец ${owner} (не совпадает)` });
      continue;
    }

    try {
      const wallet = (await ethers.Wallet.fromEncryptedJson(w.keystore, password)).connect(provider);

      const res = await collectAndSwap(wallet, p.tokenId, {
        toAddress: toAddress || undefined,
        slippageBps: SLIPPAGE_BPS,
        minUsd: MIN_USD,
      });

      if (res.status === "empty") {
        console.log("Комиссий и наград нет.");
        summary.push({ name: `${w.name} #${label}`, result: "нет комиссий" });
      } else if (res.status === "skip") {
        console.log("Пропущен:", res.reason);
        summary.push({ name: `${w.name} #${label}`, result: res.reason });
      } else if (res.status === "ok") {
        console.log(`Собрано WBNB: ${ethers.formatUnits(res.wbnbCollected, 18)}`);
        console.log(`Собрано USDT: ${ethers.formatUnits(res.usdtCollected, res.usdtDec)}`);
        console.log(`Собрано CAKE: ${ethers.formatUnits(res.cakeReceived, 18)}`);
        console.log(`Свап WBNB -> USDT: ${ethers.formatUnits(res.swappedWbnbUsdt, res.usdtDec)}`);
        console.log(`Свап CAKE -> USDT: ${ethers.formatUnits(res.swappedCakeUsdt, res.usdtDec)}`);
        console.log(`ИТОГО USDT: ${ethers.formatUnits(res.totalUsdt, res.usdtDec)}`);
        if (toAddress) console.log(`Отправлено на ${toAddress}`);
        grandTotal += res.totalUsdt;
        summary.push({
          name: `${w.name} #${label}`,
          result: `${ethers.formatUnits(res.totalUsdt, res.usdtDec)} USDT`,
        });
      } else {
        console.log("Ошибка:", res.reason || res.status);
        summary.push({ name: `${w.name} #${label}`, result: res.reason || res.status });
      }
    } catch (e) {
      console.error("Ошибка:", e.shortMessage || e.message);
      summary.push({ name: `${w.name} #${label}`, result: "ошибка" });
    }
  }

  console.log("\n=== СВОДКА ===");
  for (const s of summary) {
    console.log(`${s.name}: ${s.result}`);
  }
  if (grandTotal > 0n) {
    console.log(`ИТОГО: ${ethers.formatUnits(grandTotal, 18)} USDT`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
