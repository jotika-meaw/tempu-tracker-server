import type { StoreHealth } from "./tracking/types";

export type AiHealth = {
  configured: boolean;
  model: string;
  baseUrl: string;
};

export type HealthStatus = "ok" | "degraded" | "unavailable";

export type HealthResponse = {
  status: HealthStatus;
  time: string;
  services: {
    api: { status: "ok" };
    database: StoreHealth;
    ai: AiHealth;
  };
};

export function isTrackingOperational(database: StoreHealth): boolean {
  if (database.mode === "unavailable") return false;
  if (database.mode === "mongodb") return database.connected;
  return true;
}

export function buildHealth(
  database: StoreHealth,
  ai: AiHealth,
  now: Date
): HealthResponse {
  const trackingOperational = isTrackingOperational(database);
  let status: HealthStatus = "ok";

  if (!trackingOperational) {
    status = "unavailable";
  } else if (
    database.mode === "memory" ||
    database.mode === "memory-fallback" ||
    !database.connected ||
    !ai.configured
  ) {
    status = "degraded";
  }

  return {
    status,
    time: now.toISOString(),
    services: {
      api: { status: "ok" },
      database,
      ai,
    },
  };
}
