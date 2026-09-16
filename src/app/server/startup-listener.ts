import type { Server } from "node:http";

/** Publish readiness only after listening. Failed publication/listen awaits owned-resource cleanup. */
export async function listenAndPublish(
  server: Server, options: { host: string; port: number },
  publish: () => void, cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(error.code === "EADDRINUSE" ? new Error(`Port ${options.port} is already in use`) : error);
      };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListening);
      try { server.listen(options.port, options.host); }
      catch (error) { server.off("error", onError); server.off("listening", onListening); reject(error); }
    });
    publish();
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Startup and cleanup failed"); }
    throw error;
  }
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
