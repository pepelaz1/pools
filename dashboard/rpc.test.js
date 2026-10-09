const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { rpcUrls, createReadProvider, mapLimit, singleFlight } = require("./rpc");

test("RPC defaults, configured backups and deduplication", () => {
  assert.equal(rpcUrls("arbitrum", "https://primary", {}).length, 3);
  assert.deepEqual(rpcUrls("arbitrum", "https://primary", {
    RPC_ARBITRUM_BACKUPS: "https://primary, https://backup,https://backup",
  }), ["https://primary", "https://backup"]);
  assert.deepEqual(rpcUrls("arbitrum", "https://primary", { RPC_ARBITRUM_BACKUPS: "" }), ["https://primary"]);
});

test("bounded mapping preserves order and concurrency", async () => {
  let active = 0, peak = 0;
  const result = await mapLimit([1, 2, 3, 4, 5], 2, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  assert.deepEqual(await mapLimit([], 2, async v => v), []);
  await assert.rejects(mapLimit([1], 0, async v => v));
});

test("single flight coalesces refreshes and resets after failure", async () => {
  let calls = 0;
  const refresh = singleFlight(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (calls === 1) throw new Error("offline");
    return calls;
  });
  const first = refresh();
  assert.equal(first, refresh());
  await assert.rejects(first, /offline/);
  assert.equal(await refresh(), 2);
});

test("read-only fallback succeeds when primary RPC returns HTTP 500", async () => {
  let primaryReads = 0, backupReads = 0;
  const primary = http.createServer((req, res) => {
    primaryReads++;
    res.writeHead(500); res.end("offline");
  });
  const backup = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const answer = message => {
        backupReads++;
        const result = message.method === "eth_chainId" ? "0xa4b1"
          : message.method === "eth_blockNumber" ? "0x100" : "0x1234";
        return { jsonrpc: "2.0", id: message.id, result };
      };
      const message = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.isArray(message) ? message.map(answer) : answer(message)));
    });
  });
  await new Promise(resolve => primary.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => backup.listen(0, "127.0.0.1", resolve));
  const provider = createReadProvider("arbitrum", `http://127.0.0.1:${primary.address().port}`, {
    RPC_ARBITRUM_BACKUPS: `http://127.0.0.1:${backup.address().port}`,
  });
  try {
    assert.equal(await provider.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" }), "0x1234");
    assert.ok(primaryReads > 0);
    assert.ok(backupReads > 0);
  } finally {
    provider.destroy();
    await Promise.all([primary, backup].map(server => new Promise(resolve => server.close(resolve))));
  }
});
