// Daemon entry point — started by CLI via fork()
// Sends IPC signals to parent: { type: "ready", pid } or { type: "error", message }
import { startServer } from "./index.js";

const host = process.env.BOSSMODE_HOST || "127.0.0.1";
const port = parseInt(process.env.BOSSMODE_PORT || "8080", 10);

startServer({ host, port })
  .then(() => {
    process.send?.({ type: "ready", pid: process.pid });
  })
  .catch((err) => {
    process.send?.({ type: "error", message: err.message });
    process.exit(1);
  });
