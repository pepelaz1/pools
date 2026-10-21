const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DIRECTORY = path.join(__dirname, "closed-position-income");
const finite = value => typeof value === "number" && Number.isFinite(value);

function withdrawnPrincipal(receipt, contractInterface, manager, tokenId) {
  let principal = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== manager.toLowerCase()) continue;
    try {
      const event = contractInterface.parseLog(log);
      if (event?.name !== "DecreaseLiquidity" || event.args.tokenId !== BigInt(tokenId)) continue;
      principal ||= { amount0:0n, amount1:0n };
      principal.amount0 += event.args.amount0;
      principal.amount1 += event.args.amount1;
    } catch {}
  }
  return principal;
}

function principalProceeds({ stablePrincipal, nativePrincipal, stableCollected, nativeCollected, swapReceived }) {
  const values = [stablePrincipal, nativePrincipal, stableCollected, nativeCollected, swapReceived];
  if (values.some(value => typeof value !== "bigint" || value < 0n)
    || stablePrincipal > stableCollected || nativePrincipal > nativeCollected) return null;
  return stablePrincipal + (nativeCollected > 0n ? swapReceived * nativePrincipal / nativeCollected : 0n);
}

function recordCloseIncome(input, directory = DIRECTORY) {
  if (!["uniswap", "pancakeswap"].includes(input.dex)
    || !["arbitrum", "avalanche", "bsc"].includes(input.chain)
    || !/^\d+$/.test(String(input.tokenId)) || !finite(input.receivedUsd)) {
    throw new Error("Invalid closed-position income record");
  }
  const known = finite(input.initialUsd) && input.initialUsd > 0
    && finite(input.principalReceivedUsd) && input.principalReceivedUsd >= 0
    && input.principalReceivedUsd <= input.receivedUsd + 0.000001;
  const event = {
    ...input, tokenId:String(input.tokenId), closedAt:input.closedAt || new Date().toISOString(),
    gainUsd:known ? Math.max(0, input.principalReceivedUsd - input.initialUsd) : null,
  };
  if (!Number.isFinite(Date.parse(event.closedAt))) throw new Error("Invalid closing date");
  fs.mkdirSync(directory, { recursive:true });
  const file = path.join(directory, `${event.dex}-${event.chain}-${event.tokenId}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(event, null, 2)}\n`, { flag:"wx" });
  try {
    // Publish a complete immutable event; the same NFT can only be credited once.
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally { fs.unlinkSync(temporary); }
}

function closingIncomeSinceFriday(today, directory = DIRECTORY) {
  const friday = new Date(`${today}T00:00:00Z`);
  friday.setUTCDate(friday.getUTCDate() - (friday.getUTCDay() + 2) % 7);
  const start = friday.toISOString().slice(0, 10);
  const summary = { start, end:today, totalUsd:0, count:0, unknownCount:0 };
  if (!fs.existsSync(directory)) return summary;
  const formatDay = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Asia/Tomsk", year:"numeric", month:"2-digit", day:"2-digit",
  });
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
    try {
      const event = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const day = formatDay.format(new Date(event.closedAt));
      if (day < start || day > today) continue;
      if (!finite(event.gainUsd) || event.gainUsd < 0) { summary.unknownCount++; continue; }
      summary.totalUsd += event.gainUsd;
      summary.count++;
    } catch {
      summary.totalUsd = null;
      return summary;
    }
  }
  return summary;
}

module.exports = { withdrawnPrincipal, principalProceeds, recordCloseIncome, closingIncomeSinceFriday };
