const { promptHidden } = require("./lib");

function publicArgs(argv = process.argv.slice(2)) {
  const count = argv.filter(arg => arg === "--password-ipc").length;
  if (count > 1 || (count && typeof process.send !== "function")) {
    throw new Error("Password IPC requires a parent process");
  }
  return argv.filter(arg => arg !== "--password-ipc");
}

async function readMasterPassword(prompt) {
  if (!process.argv.includes("--password-ipc")) return promptHidden(prompt);
  return receivePassword(process);
}

function receivePassword(channel) {
  if (typeof channel.send !== "function") return Promise.reject(new Error("Password IPC unavailable"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeListener("message", onMessage);
      channel.removeListener("disconnect", onDisconnect);
    };
    const onDisconnect = () => { cleanup(); reject(new Error("Password channel disconnected")); };
    const onMessage = message => {
      if (message?.type !== "master-password" || typeof message.value !== "string") return;
      cleanup();
      resolve(message.value);
      channel.disconnect();
    };
    const timer = setTimeout(() => {
      cleanup(); reject(new Error("Password channel timeout"));
      channel.disconnect();
    }, 30000);
    channel.on("message", onMessage);
    channel.once("disconnect", onDisconnect);
    channel.send({ type: "password-request" }, error => {
      if (error) {
        cleanup(); reject(new Error("Password request failed"));
        if (channel.connected) channel.disconnect();
      }
    });
  });
}

module.exports = { publicArgs, readMasterPassword, receivePassword };
