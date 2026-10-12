const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { publicArgs, receivePassword } = require("./password-input");

test("standalone arguments unchanged; IPC option rejected without parent", () => {
  assert.deepEqual(publicArgs(["--wallet", "7d13", "250"]), ["--wallet", "7d13", "250"]);
  assert.throws(() => publicArgs(["--password-ipc"]));
});

test("password requested only on demand and channel disconnected after response", async () => {
  const channel = new EventEmitter();
  let disconnected = false;
  channel.send = (message, callback) => {
    assert.deepEqual(message, { type: "password-request" });
    callback();
    queueMicrotask(() => channel.emit("message", { type: "master-password", value: "test-only" }));
  };
  channel.disconnect = () => { disconnected = true; };
  assert.equal(await receivePassword(channel), "test-only");
  assert.equal(disconnected, true);
  assert.equal(channel.listenerCount("message"), 0);
});

test("missing or disconnected channel fails instead of prompting again", async () => {
  await assert.rejects(receivePassword({}));
  const channel = new EventEmitter();
  channel.send = () => queueMicrotask(() => channel.emit("disconnect"));
  await assert.rejects(receivePassword(channel), /disconnected/);
});

test("real Node IPC transmits a dummy password without argv or environment", async () => {
  const code = "require('./password-input').receivePassword(process).then(value => { if (value !== 'test-only') process.exitCode = 1; }).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });";
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code], {
      cwd: __dirname, stdio: ["ignore", "ignore", "pipe", "ipc"], shell: false,
    });
    let requested = false;
    child.on("message", message => {
      if (message.type !== "password-request") return;
      requested = true;
      child.send({ type: "master-password", value: "test-only" });
    });
    child.once("error", reject);
    child.once("close", code => {
      try { assert.equal(code, 0); assert.equal(requested, true); resolve(); }
      catch (error) { reject(error); }
    });
  });
});
