import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.ts";
import { buildHealth, isTrackingOperational } from "../health.ts";
import type { StoreHealth } from "../tracking/types.ts";

test("config has safe defaults and clamps unsafe values", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.port, 3001);
  assert.equal(defaults.mongoUri, null);
  assert.equal(defaults.mongoDbName, "tempu_tracker");
  assert.equal(defaults.mongoRequired, false);
  assert.equal(defaults.modelApiKey, null);
  assert.equal(defaults.metaBaseUrl, "https://api.meta.ai/v1");
  assert.equal(defaults.metaModel, "muse-spark-1.2-contributor");
  assert.equal(defaults.trackingStaleSeconds, 30);
  assert.equal(defaults.trackingSessionTtlSeconds, 3600);
  assert.equal(defaults.locationMinIntervalMs, 3000);
  assert.ok(defaults.corsOrigins.includes("http://localhost:5173"));

  const clamped = loadConfig({
    PORT: "999999",
    TRACKING_STALE_SECONDS: "0",
    TRACKING_SESSION_TTL_SECONDS: "99999999",
    LOCATION_MIN_INTERVAL_MS: "1",
    CORS_ORIGINS: "https://one.example,*,https://two.example",
    MONGODB_DB_NAME: "bad/name",
  });
  assert.equal(clamped.port, 65535);
  assert.equal(clamped.trackingStaleSeconds, 5);
  assert.equal(clamped.trackingSessionTtlSeconds, 86400);
  assert.equal(clamped.locationMinIntervalMs, 500);
  assert.equal(clamped.mongoDbName, "tempu_tracker");
  assert.deepEqual(clamped.corsOrigins, [
    "https://one.example",
    "https://two.example",
  ]);
});

test("health marks memory mode degraded but ready", () => {
  const database: StoreHealth = {
    configured: false,
    connected: true,
    mode: "memory",
    persistent: false,
    latencyMs: 0,
    errorCode: null,
  };
  const health = buildHealth(
    database,
    { configured: true, model: "muse-spark-1.2-contributor", baseUrl: "https://api.meta.ai/v1" },
    new Date("2026-01-01T00:00:00.000Z")
  );
  assert.equal(health.status, "degraded");
  assert.equal(isTrackingOperational(database), true);
});

test("health marks connected MongoDB and AI as healthy", () => {
  const database: StoreHealth = {
    configured: true,
    connected: true,
    mode: "mongodb",
    persistent: true,
    latencyMs: 12,
    errorCode: null,
  };
  const health = buildHealth(
    database,
    { configured: true, model: "muse-spark-1.2-contributor", baseUrl: "https://api.meta.ai/v1" },
    new Date("2026-01-01T00:00:00.000Z")
  );
  assert.equal(health.status, "ok");
  assert.equal(isTrackingOperational(database), true);
});

test("health marks unavailable tracking as unavailable and not ready", () => {
  const database: StoreHealth = {
    configured: true,
    connected: false,
    mode: "unavailable",
    persistent: false,
    latencyMs: null,
    errorCode: "MONGO_CONNECT_FAILED",
  };
  const health = buildHealth(
    database,
    { configured: true, model: "muse-spark-1.2-contributor", baseUrl: "https://api.meta.ai/v1" },
    new Date("2026-01-01T00:00:00.000Z")
  );
  assert.equal(health.status, "unavailable");
  assert.equal(isTrackingOperational(database), false);
});

test("health marks runtime MongoDB disconnection as unavailable", () => {
  const database: StoreHealth = {
    configured: true,
    connected: false,
    mode: "mongodb",
    persistent: true,
    latencyMs: null,
    errorCode: "MONGO_PING_FAILED",
  };
  const health = buildHealth(
    database,
    { configured: true, model: "muse-spark-1.2-contributor", baseUrl: "https://api.meta.ai/v1" },
    new Date("2026-01-01T00:00:00.000Z")
  );
  assert.equal(health.status, "unavailable");
  assert.equal(isTrackingOperational(database), false);
});

test("health stays ready when only AI is not configured", () => {
  const database: StoreHealth = {
    configured: true,
    connected: true,
    mode: "mongodb",
    persistent: true,
    latencyMs: 12,
    errorCode: null,
  };
  const health = buildHealth(
    database,
    { configured: false, model: "muse-spark-1.2-contributor", baseUrl: "https://api.meta.ai/v1" },
    new Date("2026-01-01T00:00:00.000Z")
  );
  assert.equal(health.status, "degraded");
  assert.equal(isTrackingOperational(database), true);
});
