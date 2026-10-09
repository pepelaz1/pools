const { ethers } = require("ethers");

const NETWORKS = { arbitrum: 42161, avalanche: 43114, bsc: 56 };
const BACKUPS = {
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
};
const providers = new Map();

function rpcUrls(chain, primary, env = process.env) {
  const configured = env[`RPC_${chain.toUpperCase()}_BACKUPS`];
  const backups = configured === undefined ? BACKUPS[chain] || []
    : configured.split(",").map(value => value.trim()).filter(Boolean);
  return [...new Set([primary, ...backups])];
}

function createReadProvider(chain, primary, env = process.env) {
  const chainId = NETWORKS[chain];
  if (!chainId) throw new Error(`Unknown RPC chain: ${chain}`);
  const nodes = rpcUrls(chain, primary, env).map((url, index) => {
    const request = new ethers.FetchRequest(url);
    request.timeout = 12_000;
    return {
      provider: new ethers.JsonRpcProvider(request, chainId, {
        // Keep network validation enabled; avoid oversized JSON-RPC batches.
        batchMaxCount: 5,
      }),
      priority: index + 1, weight: 1, stallTimeout: 1_500,
    };
  });
  return nodes.length === 1 ? nodes[0].provider
    : new ethers.FallbackProvider(nodes, chainId, { quorum: 1 });
}

function readProvider(chain, primary) {
  const key = `${chain}:${primary}`;
  if (!providers.has(key)) providers.set(key, createReadProvider(chain, primary));
  return providers.get(key);
}

async function mapLimit(items, concurrency, mapper) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function singleFlight(task) {
  let pending = null;
  return (...args) => {
    if (!pending) pending = Promise.resolve().then(() => task(...args)).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { rpcUrls, createReadProvider, readProvider, mapLimit, singleFlight };
