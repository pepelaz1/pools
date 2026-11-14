const fs = require("fs");
const path = require("path");
const DIRECTORY = path.join(__dirname, "close-jobs");

async function runCloseJob(job, resume, run, directory = DIRECTORY) {
  fs.mkdirSync(directory, { recursive:true });
  const file = path.join(directory, `${job.tokenId}.json`);
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, "wx");
  let state;
  let started = false;
  const save = () => {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);
  };
  try {
    if (fs.existsSync(file)) {
      state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!resume || state.stage === "complete") throw Error("Close journal exists; inspect it before continuing with --resume");
      if (state.address.toLowerCase() !== job.address.toLowerCase() || String(state.tokenId) !== String(job.tokenId) || state.keepBnb !== true) throw Error("Close journal does not match this wallet/position");
      for (const key of ["wbnbBefore", "cakeBefore", "usdtBefore"]) {
        if (!/^\d+$/.test(state.balances?.[key])) throw Error("Invalid saved balance in close journal");
      }
    } else if (resume) throw Error("No close journal; cannot resume safely");
    else state = { ...job };
    started = true;
    const stats = await run({
      resumeBalances:resume ? state.balances : undefined,
      onBaseline(balances) { state.balances = balances; state.stage = "closing"; save(); },
      onStage(stage) { state.stage = stage; save(); },
    });
    if (stats.status === "ok") { state.stage = "complete"; save(); }
    return stats;
  } catch (error) {
    if (started && state?.balances && state.stage !== "complete") {
      state.lastStage = state.stage;
      state.stage = "failed";
      state.error = error.shortMessage || error.message;
      save();
    }
    throw error;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

module.exports = { runCloseJob, DIRECTORY };
