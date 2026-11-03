import { config } from "./config";
import { createTrackingStore } from "./tracking/factory";
import { createMetaClient } from "./ai/meta-client";
import { MetaAIService } from "./ai/service";
import { createApp } from "./app";
import { TEMPU_ROUTE_NUMBERS } from "./shared/routes";

async function main(): Promise<void> {
  const { store, warning } = await createTrackingStore(config);
  const database = await store.health();

  if (warning) {
    console.warn(warning);
  }

  const aiClient = config.modelApiKey
    ? createMetaClient({
        apiKey: config.modelApiKey,
        baseUrl: config.metaBaseUrl,
        timeoutMs: config.aiTimeoutMs,
      })
    : null;

  const ai = new MetaAIService({
    client: aiClient,
    model: config.metaModel,
    baseUrl: config.metaBaseUrl,
    maxOutputTokens: config.aiMaxOutputTokens,
    timeoutMs: config.aiTimeoutMs,
    allowedRouteNumbers: TEMPU_ROUTE_NUMBERS,
  });

  const app = createApp({ config, store, ai });
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
