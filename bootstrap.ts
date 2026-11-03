import type { Express } from "express";
import { loadConfig, type AppConfig } from "./config";
import { createTrackingStore } from "./tracking/factory";
import type { TrackingStore } from "./tracking/types";
import { createMetaClient } from "./ai/meta-client";
import { MetaAIService } from "./ai/service";
import { createApp } from "./app";
import { TEMPU_ROUTE_NUMBERS } from "./shared/routes";

export type Bootstrapped = {
  config: AppConfig;
  store: TrackingStore;
  ai: MetaAIService;
  app: Express;
  warning: string | null;
};

// Shared startup used by the local dev server (index.ts, app.listen) and the
// Vercel zero-configuration Express entrypoint (server.ts, default export).
export async function bootstrap(): Promise<Bootstrapped> {
  const config = loadConfig(process.env);
  const { store, warning } = await createTrackingStore(config);

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
  return { config, store, ai, app, warning };
}
