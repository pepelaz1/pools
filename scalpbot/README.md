# ETH/USDC paper scalping bot

This is an experiment, not a profitable strategy or a capital guarantee.
There is no live mode, signer, wallet access, approval, or transaction submission.
The bot observes Uniswap v3 ETH/USDC 0.05% on Arbitrum and simulates trades.

## Run

Requires Node.js with `node:test` and `structuredClone` support and the existing
`../uniswap/node_modules/ethers` dependency. No new packages are required.

```powershell
cd C:\work\crypto\scalpbot
node bot.js
```

Default virtual capital: 100 USDC; size: 25 USDC; poll: 10 seconds.
For a 250-USDC virtual experiment (this does not use a real wallet):

```powershell
node bot.js --capital 250 --trade-usd 25 --state data/experiment-250.json
```

One read-only iteration and the test suite:

```powershell
node bot.js --once --state data/smoke.json
node --test engine.test.js
node bot.js --help
```

Ctrl+C stops monitoring. Restart with the same arguments to resume. Changing
parameters requires a different state file; the bot refuses to silently reset
capital or overwrite another experiment. Only one process per state is allowed.
If the machine crashes, a `.lock` file may remain. Check that the recorded PID
is no longer running before manually removing that lock. Do not remove the state.

## Strategy (unvalidated starting hypothesis)

- Build sampled one-minute OHLC from pool spot observations; use 51 closed
  candles for warmup (approximately 52 minutes starting from an empty state).
- Enter on a close crossing back above EMA20, with EMA20 above EMA50, a positive
  candle, RSI14 between 45 and 65, and sampled ATR14 between 0.05% and 2%.
- RSI/ATR use the latest 14 changes (simple averaging, not Wilder smoothing).
- Enter only after candle close and use current-block swap quotes, never the
  historical candle closing price as a fictitious executable fill.
- Exit when net return reaches +0.8%, drops to -0.5%, holding exceeds 60 minutes,
  or today's realized P/L plus current open P/L breaches -3 USDC.
- At most 3 entries per UTC day, 15-minute cooldown after exit, one position.
- Before buying, reject modeled immediate round-trip cost above 0.6%.

All parameters are CLI configurable; these are not recommended trading signals.
No historical backfill is invented. Missing observations for over 30 seconds
(or three polling intervals, whichever is larger) restart entry warmup. An open
position is still evaluated when reads resume. Repeated/stale blocks do not
generate trades. Five consecutive failures stop the process; a single failure
in `--once` exits nonzero. There is no automatic liquidation while RPC is down.

## Cost and execution model

Quoter `eth_call` estimates USDC -> WETH and WETH -> USDC using the actual pool
fee and liquidity at one block. Its outputs already include pool fees and price
impact; these fees are not deducted twice. A configurable 10-bps haircut is
applied to each quoted output to model worse execution. This is not a slippage
guarantee and does not simulate MEV, order latency, approvals, or failed swaps.

Gas is a **fixed assumption** of $0.03 per swap, not a live estimate. Both entry
and exit gas are charged to virtual equity. Change `--gas-usd-per-swap` and
`--execution-buffer-bps` to test sensitivity. Quotes do not alter chain state,
so this model cannot capture the lasting impact of its own hypothetical trades.
Spot, sampled candles, and USDC accounting are not a dollar-price oracle or full
exchange OHLC. USDC depegging and Aave interest are not modeled; use no borrowed
capital when eventually considering real trading.

At the default 25-USDC size, a 0.05%-fee pool, two 10-bps haircuts, and $0.06
round-trip gas already imply roughly 0.54% immediate modeled costs. A +0.8%
net target therefore needs considerably more than a +0.8% spot move. Defaults
are for experimentation, not evidence that this strategy can cover its costs.

## Data

`data/state.json` contains config, candles, current virtual position, virtual
cash, UTC daily counters, and every closed trade with net P/L. The state is saved
atomically after each accepted sample. Data is ignored by Git. Read failures
leave the last committed state unchanged. There is deliberately no real-money
or keystore option. `SCALP_RPC_URL` may override the Arbitrum read-only RPC.

Observe forward results, compare against holding USDC/ETH, and validate on an
independent period before considering any real execution. A few winning trades
do not prove an edge. Stop-loss execution prices are not guaranteed in reality.
