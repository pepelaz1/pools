const test = require("node:test");
const assert = require("node:assert/strict");
const { closeComparison, parseArgs, settleInEth } = require("./close-position");
const { ethers } = require("ethers");
const { withdrawnPrincipal } = require("../close-income");

test("withdrawal principal is decoded from confirmed events for the selected NFT only", () => {
  const iface = new ethers.Interface([
    "event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  ]);
  const manager = "0x0000000000000000000000000000000000000001";
  const makeLog = (tokenId, address = manager) => ({ address,
    ...iface.encodeEventLog(iface.getEvent("DecreaseLiquidity"), [tokenId, 10n, 100n, 200n]) });
  assert.deepEqual(withdrawnPrincipal({ logs:[makeLog(2n), makeLog(1n)] }, iface, manager, 1n),
    { amount0:100n, amount1:200n });
  assert.equal(withdrawnPrincipal({ logs:[makeLog(1n, ethers.ZeroAddress)] }, iface, manager, 1n), null);
  assert.equal(withdrawnPrincipal({ logs:[] }, iface, manager, 1n), null);
});

test("closing comparison uses the stored opening value including top-ups", () => {
  const result = closeComparison({ valueUsd: 249.75 }, 250772901n, 6);
  assert.equal(result.initialUsd, 249.75);
  assert.ok(Math.abs(result.differenceUsd - 1.022901) < 1e-9);
  assert.ok(Math.abs(result.differencePct - (1.022901 / 249.75 * 100)) < 1e-9);
});

test("closing comparison reports losses without treating missing cost basis as zero", () => {
  const loss = closeComparison({ valueUsd: 300 }, 250000000n, 6);
  assert.equal(loss.differenceUsd, -50);
  assert.equal(loss.differencePct, -50 / 300 * 100);
  for (const opened of [undefined, {}, { valueUsd: null }, { valueUsd: "invalid" }, { valueUsd: 0 }]) {
    assert.equal(closeComparison(opened, 250000000n, 6), null);
  }
});

test("keep-eth is explicit, supports Arbitrum only and rejects ignored extra options", () => {
  assert.equal(parseArgs(["5738364", "arbitrum", "--keep-eth"]).keepEth, true);
  assert.equal(parseArgs(["5738364", "--keep-eth"]).keepEth, true);
  assert.equal(parseArgs(["5738364", "avalanche"]).keepEth, false);
  assert.equal(parseArgs(["--help"]).help, true);
  for (const argv of [[], ["0"], ["5738364", "avalanche", "--keep-eth"],
    ["5738364", "--keep-eth", "--keep-eth"], ["5738364", "arbitrum", "extra"],
    ["5738364", "arbitrum", "--keep-eht"]]) assert.throws(() => parseArgs(argv));
});

function ethMocks({ collectedUsdc = 50n, collectedWeth = 20n, quoteFails = false,
  quoteAmount = 25n, swapFails = false } = {}) {
  const state = { usdc:100n + collectedUsdc, weth:1000n + collectedWeth };
  const calls = [];
  let swapped, approved, unwrapped;
  const transaction = (kind, confirm) => ({ hash:kind, wait:async () => { calls.push(`${kind}-confirmed`); confirm(); } });
  const approve = async (spender, amount) => {
    approved = amount;
    return transaction("approve", () => {});
  };
  approve.staticCall = async () => true;
  approve.estimateGas = async () => 100n;
  const swap = async params => {
    swapped = params;
    return transaction("swap", () => { state.usdc -= params.amountIn; state.weth += quoteAmount; });
  };
  swap.staticCall = async () => { if (swapFails) throw new Error("swap simulation failed"); };
  swap.estimateGas = async () => 100n;
  const withdraw = async amount => {
    unwrapped = amount;
    return transaction("unwrap", () => { state.weth -= amount; });
  };
  withdraw.staticCall = async () => {};
  withdraw.estimateGas = async () => 100n;
  const args = {
    cfg:{ chainId:42161, stable:"USDC", native:"WETH", swapRouter:"router" }, owner:"wallet", fee:500,
    stableBefore:100n, nativeBefore:1000n, log:() => {},
    stable:{ balanceOf:async () => state.usdc, allowance:async () => 0n, approve },
    native:{ balanceOf:async () => state.weth, withdraw },
    router:{ exactInputSingle:swap },
    quoter:{ quoteExactInputSingle:{ staticCall:async params => {
      calls.push("quote");
      assert.equal(params.tokenIn, "USDC");
      assert.equal(params.tokenOut, "WETH");
      if (quoteFails) throw new Error("quote failed");
      return [quoteAmount];
    } } },
  };
  return { args, state, calls, result:() => ({ swapped, approved, unwrapped }) };
}

test("keep-eth swaps only position USDC and unwraps only position WETH", async () => {
  const mock = ethMocks();
  assert.equal(await settleInEth(mock.args), 45n);
  assert.equal(mock.state.usdc, 100n);
  assert.equal(mock.state.weth, 1000n);
  const result = mock.result();
  assert.equal(result.approved, 50n);
  assert.equal(result.swapped.amountIn, 50n);
  assert.equal(result.swapped.amountOutMinimum, 24n);
  assert.equal(result.swapped.tokenIn, "USDC");
  assert.equal(result.swapped.tokenOut, "WETH");
  assert.equal(result.unwrapped, 45n);
  assert.deepEqual(mock.calls, ["quote", "approve-confirmed", "swap-confirmed", "unwrap-confirmed"]);
});

test("an all-WETH position needs only unwrapping; an empty position sends nothing", async () => {
  const wethOnly = ethMocks({ collectedUsdc:0n });
  assert.equal(await settleInEth(wethOnly.args), 20n);
  assert.deepEqual(wethOnly.calls, ["unwrap-confirmed"]);
  const empty = ethMocks({ collectedUsdc:0n, collectedWeth:0n });
  assert.equal(await settleInEth(empty.args), 0n);
  assert.deepEqual(empty.calls, []);
});

test("bad quotes, failed swaps and balance drops never unwrap old wallet funds", async () => {
  for (const options of [{ quoteFails:true }, { quoteAmount:0n }, { swapFails:true }]) {
    const mock = ethMocks(options);
    await assert.rejects(settleInEth(mock.args));
    assert.equal(mock.result().unwrapped, undefined);
    assert.equal(mock.state.weth, 1020n);
  }
  const changed = ethMocks();
  changed.state.usdc = 99n;
  await assert.rejects(settleInEth(changed.args), /USDC balance changed/);
  assert.deepEqual(changed.calls, []);
  const wrongChain = ethMocks();
  wrongChain.args.cfg.chainId = 43114;
  await assert.rejects(settleInEth(wrongChain.args), /Arbitrum only/);
  assert.deepEqual(wrongChain.calls, []);
});
