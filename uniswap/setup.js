const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { prompt } = require("./lib");

const WALLETS_FILE = path.join(__dirname, "wallets.json");
const POSITIONS_FILE = path.join(__dirname, "positions.json");

async function main() {
  let existing = [];
  if (fs.existsSync(WALLETS_FILE)) {
    const data = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
    existing = data.wallets || [];
  }

  const password = await prompt("Мастер-пароль: ");
  const password2 = await prompt("Повторите мастер-пароль: ");
  if (password !== password2) {
    console.error("Пароли не совпадают.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Пароль слишком короткий (минимум 8 символов).");
    process.exit(1);
  }

  if (existing.length > 0) {
    try {
      await ethers.Wallet.fromEncryptedJson(existing[0].keystore, password);
    } catch {
      console.error("Пароль не совпадает с паролем существующих кошельков. Все ключи должны шифроваться одним паролем.");
      process.exit(1);
    }
    console.log(`Найдено ${existing.length} существующих кошельков — они сохранятся.`);
  }

  const wallets = [...existing];
  console.log("\nВводите новые кошельки. Для завершения оставьте имя пустым.\n");

  for (;;) {
    const name = await prompt("Название (пусто — закончить): ");
    if (!name) break;

    const privateKey = await prompt(`Приватный ключ для "${name}": `);
    if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
      console.error("Похоже, это не приватный ключ (нужно 66 символов, начинается с 0x). Пропускаю.");
      continue;
    }

    let wallet;
    try {
      wallet = new ethers.Wallet(privateKey);
    } catch (e) {
      console.error("Не удалось распознать ключ:", e.shortMessage || e.message);
      continue;
    }

    if (wallets.some((w) => w.address.toLowerCase() === wallet.address.toLowerCase())) {
      console.error(`Кошелёк ${wallet.address} уже есть в списке — пропускаю.`);
      continue;
    }

    const keystore = await wallet.encrypt(password);

    wallets.push({
      name,
      address: wallet.address,
      keystore,
    });
    console.log(`Добавлен: ${name} (${wallet.address})\n`);
  }

  fs.writeFileSync(WALLETS_FILE, JSON.stringify({ wallets }, null, 2) + "\n");
  console.log(`Сохранено ${wallets.length} кошельков в wallets.json (ключи зашифрованы).`);

  let posData = { toAddress: "", positions: [] };
  if (fs.existsSync(POSITIONS_FILE)) {
    posData = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
  }

  const existingAddrs = new Set(
    (posData.positions || []).map((p) => (p.address || "").toLowerCase()),
  );

  for (const w of wallets) {
    if (!existingAddrs.has(w.address.toLowerCase())) {
      posData.positions.push({
        address: w.address,
        tokenId: null,
        chain: "arbitrum",
      });
    }
  }

  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(posData, null, 2) + "\n");
  console.log("positions.json обновлён — заполните tokenId и chain (arbitrum/avalanche) для новых кошельков.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
