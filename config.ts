import dotenv from "dotenv";

dotenv.config();

export type AppConfig = {
  port: number;
  isProduction: boolean;
  corsOrigins: string[];
  trustProxy: boolean;
  mongoUri: string | null;
  mongoDbName: string;
  mongoRequired: boolean;
  modelApiKey: string | null;
  metaBaseUrl: string;
  metaModel: string;
  aiTimeoutMs: number;
  aiMaxOutputTokens: number;
  trackingStaleSeconds: number;
  trackingSessionTtlSeconds: number;
  locationMinIntervalMs: number;
  rateLimitEnabled: boolean;
};

function numberFromEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function dbNameFromEnv(value: string | undefined, fallback: string): string {
  const candidate = (value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : fallback;
}

function corsOriginsFromEnv(value: string | undefined): string[] {
  const source =
    value ??
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost,https://localhost,capacitor://localhost";
  return [
    ...new Set(
      source
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin && origin !== "*")
    ),
  ];
}

/**
 * The assistant chat feature is pinned to this contributor model. META_MODEL
 * is intentionally not read from the environment so no deployment can
 * silently switch the chat to a different model.
 */
export const CHAT_MODEL = "muse-spark-1.2-contributor";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  const mongoUri = (env.MONGODB_URI ?? "").trim();

  return {
    port: numberFromEnv(env.PORT, 3001, 1, 65535),
    isProduction,
    corsOrigins: corsOriginsFromEnv(env.CORS_ORIGINS),
    trustProxy: boolFromEnv(env.TRUST_PROXY, false),
    mongoUri: mongoUri || null,
    mongoDbName: dbNameFromEnv(env.MONGODB_DB_NAME, "tempu_tracker"),
    mongoRequired: boolFromEnv(env.MONGODB_REQUIRED, false),
    modelApiKey: (env.MODEL_API_KEY ?? "").trim() || null,
    metaBaseUrl: (env.META_BASE_URL ?? "https://api.meta.ai/v1").trim(),
    metaModel: CHAT_MODEL,
    aiTimeoutMs: numberFromEnv(env.AI_TIMEOUT_MS, 20000, 3000, 60000),
    // Reasoning-style contributor models spend part of the output budget on
    // hidden reasoning tokens, so the default leaves headroom for the answer.
    aiMaxOutputTokens: numberFromEnv(env.AI_MAX_OUTPUT_TOKENS, 2000, 50, 2000),
    trackingStaleSeconds: numberFromEnv(env.TRACKING_STALE_SECONDS, 30, 5, 300),
    trackingSessionTtlSeconds: numberFromEnv(
      env.TRACKING_SESSION_TTL_SECONDS,
      3600,
      60,
      86400
    ),
    locationMinIntervalMs: numberFromEnv(
      env.LOCATION_MIN_INTERVAL_MS,
      3000,
      500,
      60000
    ),
    rateLimitEnabled: boolFromEnv(env.RATE_LIMIT_ENABLED, true),
  };
}

export const config = loadConfig();
