import { bootstrap } from "./bootstrap";

async function main(): Promise<void> {
  const { config, store, ai, app, warning } = await bootstrap();
  const database = await store.health();

  if (warning) {
    console.warn(warning);
  }

  const server = app.listen(config.port, () => {
    console.log(`Tempu Tracker API listening on http://localhost:${config.port}`);
    console.log(
      `Tracking store: ${database.mode}; configured=${database.configured}; connected=${database.connected}; persistent=${database.persistent}`
    );
    console.log(
      `Meta AI: configured=${ai.configured}; model=${config.metaModel}; baseUrl=${config.metaBaseUrl}`
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);

    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      process.exit(1);
    }, 10000);
    forceExit.unref();

    server.close(() => {
      void store
        .close()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error(
    "Failed to start Tempu Tracker API:",
    error instanceof Error ? error.name : "UnknownError"
  );
  process.exit(1);
});
