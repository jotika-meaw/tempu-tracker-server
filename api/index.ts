import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Express } from "express";
import { loadConfig } from "../config";
import { createTrackingStore } from "../tracking/factory";
import { createMetaClient } from "../ai/meta-client";
import { MetaAIService } from "../ai/service";
import { createApp } from "../app";
import { TEMPU_ROUTE_NUMBERS } from "../shared/routes";

// Serverless entry point: the Express app is created lazily once per
// function instance and reused across warm invocations. Rate limiting is
// disabled here because each instance has isolated memory.
let appPromise: Promise<Express> | null = null;

function getApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = initApp().catch((error: unknown) => {
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

async function initApp(): Promise<Express> {
  const appConfig = loadConfig(process.env);
  const { store } = await createTrackingStore(appConfig);
  const aiClient = appConfig.modelApiKey
    ? createMetaClient({
        apiKey: appConfig.modelApiKey,
        baseUrl: appConfig.metaBaseUrl,
        timeoutMs: appConfig.aiTimeoutMs,
      })
    : null;
  const ai = new MetaAIService({
    client: aiClient,
    model: appConfig.metaModel,
    baseUrl: appConfig.metaBaseUrl,
    maxOutputTokens: appConfig.aiMaxOutputTokens,
    timeoutMs: appConfig.aiTimeoutMs,
    allowedRouteNumbers: TEMPU_ROUTE_NUMBERS,
  });
  return createApp({ config: appConfig, store, ai, rateLimitEnabled: false });
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const app = await getApp();
    app(req as never, res as never);
  } catch {
    res.status(503).json({
      error: {
        code: "TRACKING_STORE_UNAVAILABLE",
        message: "The tracking service failed to start. Please try again.",
      },
    });
  }
}
