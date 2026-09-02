# База знаний: как это устроено

Техническая памятка о том, как устроены сборщики комиссий и дашборд. Писалась «на будущее», чтобы не разбирать всё заново.

## 1. Общая логика сбора (Uniswap V3 и форки)

Позиция Uniswap V3 — это NFT в контракте `NonfungiblePositionManager`. Сбор комиссий:

1. `positions(tokenId)` возвращает `token0`, `token1`, `fee`, `tickLower`, `tickUpper`, `liquidity`, `tokensOwed0/1`.
2. `collect((tokenId, recipient, amount0Max, amount1Max))` переводит накопленные комиссии.

**Важно:** `tokensOwed0/1` из `positions()` бывают **устаревшими** (обновляются только при mint/burn/collect). Точную сумму возвращает сам `collect`. Поэтому в скриптах сначала делается `collect.staticCall(params)` — это read-only симуляция, которая возвращает реальные `(amount0, amount1)`, и уже их используем для порога и свопа. См. `lib.js` → `collectAndSwap`.

`ethers.MaxUint128` в ethers v6 **не существует** (`undefined`) — используется `2n ** 128n - 1n`.

## 2. Своп

Своп через `SwapRouter02.exactInputSingle`:

```
exactInputSingle((tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96))
```

- `amountOutMinimum` берём из `QuoterV2.quoteExactInputSingle.staticCall(...)` с учётом проскальзывания `SLIPPAGE_BPS`.
- Fee-тир для свопа нативного токена = fee самого пула позиции.
- Для CAKE → USDT используем самый ликвидный V3-пул `CAKE/USDT` с fee = **2500**.

## 3. Адреса контрактов

### Uniswap V3 — Arbitrum
| Контракт | Адрес |
|----------|-------|
| NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| USDC (нативный) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |

### Uniswap V3 — Avalanche
| Контракт | Адрес |
|----------|-------|
| NonfungiblePositionManager | `0x655C406EBFa14EE2006250925e54ec43AD184f8B` |
| SwapRouter02 | `0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE` |
| QuoterV2 | `0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F` |
| WAVAX | `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7` |
| USDC (нативный) | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |

> На Avalanche адреса **отличаются** от Ethereum/Arbitrum (не CREATE2-одинаковые).
> WAVAX легко перепутать — правильный `...7E27b85FD66c7`, а не `...6F658296A946D0a472808d5`.

### PancakeSwap V3 — BSC (chainId 56)
| Контракт | Адрес |
|----------|-------|
| NonfungiblePositionManager | `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` |
| SwapRouter | `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` |
| QuoterV2 | `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` |
| MasterChefV3 (фарминг) | `0x556B9306565093C855AEA9AE92A594704c2Cd59e` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` |
| CAKE | `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` |

> BSC USDT имеет **18** decimals (в отличие от Ethereum USDT = 6).

## 4. PancakeSwap и награды CAKE

Позиция может быть застейкана в фарминг. Тогда:

- `NonfungiblePositionManager.ownerOf(tokenId)` возвращает **MasterChefV3** (не пользователя).
- Реальный владелец лежит в `MasterChefV3.userPositionInfos(tokenId)`.

### Структура `userPositionInfos` (9 слов, по 32 байта)

Функция возвращает 288 байт (9 слотов). Поле `user` (адрес владельца) — **7-е по счёту** (индекс 6):

```
[0] liquidity          (uint256, правый край)
[1] boostLiquidity     (= liquidity без буста)
[2] tickLower          (int24, знаково расширен)
[3] tickUpper          (int24)
[4] rewardGrowthInside (uint256)
[5] 0                  (uint256)
[6] user               (address)  <-- владелец
[7] boostMultiplier    (uint256, напр. 137)
[8] precision          (uint256 = 1e12)
```

ABI в `pancakeswap/lib.js` объявлен с 9 полями, чтобы `user` декодировался по правильному смещению.

Награды CAKE:
- `pendingCake(tokenId)` — сколько накапало (view).
- `harvest(tokenId, to)` — снять награду.
- `collect((tokenId, recipient, ...))` на MasterChefV3 — собрать комиссии застейканной позиции.

Если позиция **не** застейкана — `collect` делаем напрямую через `NonfungiblePositionManager`.

## 5. Порог минимальной комиссии

Перед сбором считаем оценку в стейбле: `usdCollected + quote(native->usd) + quote(reward->usd)`.
Если меньше `MIN_USD` (по умолчанию `1`) — позицию пропускаем.

## 6. Хранение ключей

- `setup.js` шифрует приватные ключи через `ethers.Wallet.encrypt(password)` → `wallets.json` (`{name, address, keystore}`).
- `collect-all.js` расшифровывает через `ethers.Wallet.fromEncryptedJson(json, password)`.
- В ethers v6 `wallet.connect(provider)` **возвращает новый объект** — нужно переприсваивать: `wallet = wallet.connect(provider)`.

## 7. Граблы, которые уже ловили

1. `tokensOwed` устаревший → всегда `collect.staticCall`.
2. `ethers.MaxUint128` == undefined → `2n**128n - 1n`.
3. `wallet.connect()` не мутирует → переприсваивать.
4. WAVAX-адрес: `0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7`.
5. PancakeSwap `userPositionInfos` — поле user на 7-м слоте.
6. Застейканная позиция: `ownerOf` = MasterChefV3.
7. BSC USDT = 18 decimals.
8. `positions.example.json` — шаблон; реальные `positions.json`/`wallets.json` в git не попадают.

## 8. Формула невыплаченных комиссий (для дашборда)

Читается без ключей (view-вызовы):

```
feeGrowthInside = getFeeGrowthInside(tickLower, tickUpper, tickCurrent,
                                      feeGrowthGlobal0/1,
                                      ticks(tickLower).feeGrowthOutside0/1,
                                      ticks(tickUpper).feeGrowthOutside0/1)

fees_i = liquidity * (feeGrowthInside_i - feeGrowthInsideLast_i) / 2^128
```

Логика `getFeeGrowthInside` совпадает с `Tick.getFeeGrowthInside` из Uniswap V3:

```
if tickCurrent >= tickLower: below = lower.feeGrowthOutside
else:                        below = feeGrowthGlobal - lower.feeGrowthOutside

if tickCurrent < tickUpper:  above = upper.feeGrowthOutside
else:                        above = feeGrowthGlobal - upper.feeGrowthOutside

inside = feeGrowthGlobal - below - above
```
