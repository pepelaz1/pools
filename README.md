# crypto-pools

Автосборщик комиссий и наград из позиций на Uniswap V3 и PancakeSwap V3.

## Что делает

Собирает торговые комиссии из LP-позиций, конвертирует всё в стейблкоин и (опционально) переводит на один адрес:

| Папка | Протокол | Сети | Пары | Выход |
|-------|----------|------|------|-------|
| `uniswap/` | Uniswap V3 | Arbitrum, Avalanche | WETH/USDC, WAVAX/USDC | USDC |
| `pancakeswap/` | PancakeSwap V3 | BSC | USDT/WBNB | USDT |

PancakeSwap дополнительно забирает награды в CAKE и конвертирует их в USDT.

## Структура

```
crypto/
├── uniswap/          # сборщик для Uniswap V3
│   ├── setup.js      # шифрует ключи -> wallets.json, создаёт positions.json
│   ├── collect-all.js# запускает сбор по всем позициям
│   └── lib.js        # общая логика
├── pancakeswap/      # сборщик для PancakeSwap V3 (BSC)
│   ├── setup.js
│   ├── collect-all.js
│   └── lib.js
└── dashboard/        # HTML-дашборд по всем пулам
```

## Быстрый старт

```powershell
cd uniswap          # или pancakeswap
npm install         # один раз
node setup.js       # ввести мастер-пароль и приватные ключи
# отредактировать positions.json (tokenId, toAddress)
node collect-all.js # ежедневный запуск
```

## Безопасность

- `wallets.json` — приватные ключи в зашифрованном виде (ethers keystore), мастер-пароль вводится при запуске.
- `wallets.json` и `positions.json` добавлены в `.gitignore` и **не** попадают в git.

## Переменные окружения

| Переменная | Назначение | По умолчанию |
|------------|-----------|--------------|
| `MIN_USD` | порог комиссии: если меньше — пропустить | `1` |
| `SLIPPAGE_BPS` | проскальзывание (100 = 1%) | `100` |
| `TO_ADDRESS` | куда слать стейблкоин (можно задать в positions.json) | — |
| `RPC_ARBITRUM` / `RPC_AVALANCHE` / `RPC_BSC` | свой RPC | публичные |

Подробности реализации — в [`docs/KNOWLEDGE.md`](docs/KNOWLEDGE.md).

## Дашборд

Живой дашборд по всем позициям (ликвидность, накопленные комиссии, награды CAKE, границы диапазона) в браузере:

```powershell
cd dashboard
npm install        # один раз
node server.js     # или npm start
# открыть http://localhost:3000
```

Дашборд работает только на чтение (ключи не нужны): комиссии берутся через симуляцию `collect` от имени владельца. Есть кнопка «Обновить всё» и кнопка обновления у каждой позиции.

