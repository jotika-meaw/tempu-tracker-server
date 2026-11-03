import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../app.ts";
import { createTrackingStore } from "../tracking/factory.ts";
import {
  bearer,
  createFakeMetaClient,
  createMemoryStore,
  createTestAi,
  createTestConfig,
  validStartBody,
} from "./helpers.ts";

function setup(overrides: Parameters<typeof createTestConfig>[0] = {}) {
  const store = createMemoryStore();
  const fake = createFakeMetaClient(async () => ({
    output_text: "রুট ০১-এ অক্সিজেন থেকে বারেক বিল্ডিং মোড় যাওয়া যায়।",
  }));
  const ai = createTestAi(fake.client);
  const config = createTestConfig(overrides);
  let now = new Date("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(now);
  const app = createApp({ config, store, ai, rateLimitEnabled: false, clock });

  return {
    app,
    store,
    ai,
    fake,
    config,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    now: () => new Date(now),
  };
}

async function startJourney(
  app: ReturnType<typeof createApp>,
  overrides: Record<string, unknown> = {}
) {
  const response = await request(app)
    .post("/api/tracking/start")
    .send(validStartBody(overrides));
  assert.equal(response.status, 201);
  return response.body as {
    sessionToken: string;
    publicId: string;
    journey: Record<string, unknown>;
    expiresAt: string;
    staleSeconds: number;
  };
}

test("health exposes separate database and AI status without secrets", async () => {
  const { app } = setup();
  const response = await request(app).get("/api/health");

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "degraded");
  assert.equal(response.body.services.api.status, "ok");
  assert.equal(response.body.services.database.mode, "memory");
  assert.equal(response.body.services.database.persistent, false);
  assert.equal(response.body.services.ai.configured, true);
  assert.equal(response.body.services.ai.model, "muse-spark-1.2-contributor");

  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /MONGODB_URI|MODEL_API_KEY|mongodb\+srv/);
  assert.doesNotMatch(serialized, /tokenHash|sessionToken/);
});

test("readiness is true for explicit memory mode", async () => {
  const { app } = setup();
  const response = await request(app).get("/api/health/ready");
  assert.equal(response.status, 200);
  assert.equal(response.body.services.database.mode, "memory");
});

test("driver can start a validated partial journey and stop it", async () => {
  const { app, advance } = setup();
  const started = await startJourney(app);

  assert.equal(started.sessionToken.length, 43);
  assert.ok(started.publicId.length >= 8);
  assert.equal(started.journey.routeNumber, "01");
  assert.equal(started.journey.direction, "outbound");
  assert.equal(started.journey.startStop, "অক্সিজেন");
  assert.equal(started.journey.endStop, "চকবাজার");
  assert.deepEqual(started.journey.segmentStops, [
    "অক্সিজেন",
    "আতুরার ডিপো",
    "মুরাদপুর",
    "চকবাজার",
  ]);
  assert.equal(started.journey.confidence, "verified");
  assert.equal(started.staleSeconds, 30);

  const active = await request(app).get("/api/tracking/active");
  assert.equal(active.status, 200);
  assert.equal(active.body.vehicles.length, 1);
  assert.equal(active.body.vehicles[0].publicId, started.publicId);
  assert.equal(active.body.vehicles[0].source, "driver-device-gps");
  assert.equal(active.body.vehicles[0].freshness, "live");

  advance(4000);
  const update = await request(app)
    .post("/api/tracking/location")
    .set("Authorization", bearer(started.sessionToken))
    .send({ latitude: 22.36, longitude: 91.79, accuracy: 9 });
  assert.equal(update.status, 200);
  assert.equal(update.body.accepted, true);
  assert.equal(update.body.vehicle.latitude, 22.36);

  const stop = await request(app)
    .post("/api/tracking/stop")
    .set("Authorization", bearer(started.sessionToken));
  assert.equal(stop.status, 204);

  const afterStop = await request(app).get("/api/tracking/active");
  assert.equal(afterStop.body.vehicles.length, 0);
});

test("active responses never expose session tokens, hashes, or consent records", async () => {
  const { app } = setup();
  const started = await startJourney(app);
  const response = await request(app).get("/api/tracking/active");
  const serialized = JSON.stringify(response.body);

  assert.ok(!serialized.includes(started.sessionToken));
  assert.doesNotMatch(serialized, /tokenHash|consentVersion|consentAt/);
  assert.doesNotMatch(serialized, /phone|plate/i);
});

test("location updates reject missing, malformed, and unknown session tokens", async () => {
  const { app } = setup();
  const noToken = await request(app)
    .post("/api/tracking/location")
    .send({ latitude: 22.36, longitude: 91.79 });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.error.code, "UNAUTHORIZED_SESSION");

  const malformed = await request(app)
    .post("/api/tracking/location")
    .set("Authorization", "Bearer short")
    .send({ latitude: 22.36, longitude: 91.79 });
  assert.equal(malformed.status, 401);

  const unknown = await request(app)
    .post("/api/tracking/location")
    .set("Authorization", bearer("a".repeat(43)))
    .send({ latitude: 22.36, longitude: 91.79 });
  assert.equal(unknown.status, 401);
});

test("server enforces the per-session update interval", async () => {
  const { app, advance } = setup();
  const started = await startJourney(app);
  advance(1000);

  const response = await request(app)
    .post("/api/tracking/location")
    .set("Authorization", bearer(started.sessionToken))
    .send({ latitude: 22.36, longitude: 91.79 });

  assert.equal(response.status, 429);
  assert.equal(response.body.error.code, "UPDATE_TOO_FREQUENT");
  assert.ok(Number(response.headers["retry-after"]) >= 1);
});

test("start endpoint rejects invalid routes, journeys, consent, and coordinates", async () => {
  const { app } = setup();
  const cases: Array<{ body: Record<string, unknown>; code: string }> = [
    { body: validStartBody({ routeNumber: "09" }), code: "UNKNOWN_ROUTE" },
    { body: validStartBody({ direction: "sideways" }), code: "INVALID_DIRECTION" },
    { body: validStartBody({ startIndex: 2, endIndex: 2 }), code: "SAME_STOP" },
    { body: validStartBody({ startIndex: 3, endIndex: 2 }), code: "END_BEFORE_START" },
    { body: validStartBody({ startIndex: 0.5 }), code: "INVALID_INDEX" },
    { body: validStartBody({ consent: false }), code: "CONSENT_REQUIRED" },
    {
      body: validStartBody({
        initialLocation: { latitude: 91, longitude: 91.7 },
      }),
      code: "INVALID_COORDINATES",
    },
    {
      body: validStartBody({
        initialLocation: { latitude: 22.3, longitude: 91.7, accuracy: -1 },
      }),
      code: "INVALID_ACCURACY",
    },
  ];

  for (const item of cases) {
    const response = await request(app).post("/api/tracking/start").send(item.body);
    assert.equal(response.status, 400, item.code);
    assert.equal(response.body.error.code, item.code);
  }
});

test("malformed JSON and oversized bodies return structured errors", async () => {
  const { app } = setup();
  const malformed = await request(app)
    .post("/api/tracking/start")
    .set("Content-Type", "application/json")
    .send("{not-json");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "INVALID_JSON");

  const oversized = await request(app)
    .post("/api/ai-test")
    .send({ message: "x".repeat(20000) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("two vehicles remain independent and can be filtered by route", async () => {
  const { app, advance } = setup();
  const first = await startJourney(app, {
    routeNumber: "01",
    direction: "outbound",
    startIndex: 0,
    endIndex: 3,
  });
  const second = await startJourney(app, {
    routeNumber: "02",
    direction: "outbound",
    startIndex: 0,
    endIndex: 2,
  });

  advance(4000);
  await request(app)
    .post("/api/tracking/location")
    .set("Authorization", bearer(first.sessionToken))
    .send({ latitude: 22.4, longitude: 91.8, accuracy: 5 });
  await request(app)
    .post("/api/tracking/location")
    .set("Authorization", bearer(second.sessionToken))
    .send({ latitude: 22.5, longitude: 91.9, accuracy: 5 });

  const all = await request(app).get("/api/tracking/active");
  assert.equal(all.body.vehicles.length, 2);

  const routeOne = await request(app).get("/api/tracking/active?routeNumber=01");
  assert.equal(routeOne.body.vehicles.length, 1);
  assert.equal(routeOne.body.vehicles[0].routeNumber, "01");

  await request(app)
    .post("/api/tracking/stop")
    .set("Authorization", bearer(first.sessionToken));
  const afterStop = await request(app).get("/api/tracking/active");
  assert.equal(afterStop.body.vehicles.length, 1);
  assert.equal(afterStop.body.vehicles[0].routeNumber, "02");
});

test("stale locations disappear from the live list and are counted as hidden", async () => {
  const { app, advance } = setup();
  await startJourney(app);
  advance(31_000);

  const response = await request(app).get("/api/tracking/active");
  assert.equal(response.body.vehicles.length, 0);
  assert.equal(response.body.staleHidden, 1);
});

test("expired sessions cannot update or appear as live", async () => {
  const { app, advance } = setup();
  const started = await startJourney(app);
  advance(3601_000);

  const active = await request(app).get("/api/tracking/active");
  assert.equal(active.body.vehicles.length, 0);

  const update = await request(app)
    .post("/api/tracking/location")
    .set("Authorization", bearer(started.sessionToken))
    .send({ latitude: 22.36, longitude: 91.79 });
  assert.equal(update.status, 401);
});

test("unavailable tracking store produces clear 503s without taking AI down", async () => {
  const { store } = await createTrackingStore(
    createTestConfig({ mongoRequired: true, mongoUri: null })
  );
  const fake = createFakeMetaClient(async () => ({
    output_text: "লাইভ তথ্য এখন যাচাই করা যাচ্ছে না।",
  }));
  const ai = createTestAi(fake.client);
  const config = createTestConfig({ mongoRequired: true, mongoUri: null });
  const app = createApp({
    config,
    store,
    ai,
    rateLimitEnabled: false,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  const health = await request(app).get("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "unavailable");
  assert.equal(health.body.services.database.mode, "unavailable");

  const ready = await request(app).get("/api/health/ready");
  assert.equal(ready.status, 503);

  const start = await request(app).post("/api/tracking/start").send(validStartBody());
  assert.equal(start.status, 503);
  assert.equal(start.body.error.code, "TRACKING_STORE_UNAVAILABLE");

  const aiResponse = await request(app)
    .post("/api/ai-test")
    .send({ message: "রুট ০১ সম্পর্কে বলুন", language: "bn" });
  assert.equal(aiResponse.status, 200);
  const prompt = String(fake.calls[0]?.instructions);
  assert.match(prompt, /currently unavailable/);
  assert.match(prompt, /Do not claim zero vehicles/);
  assert.doesNotMatch(prompt, /Fresh sessions by route/);

  await store.close();
});

test("AI not configured does not affect route tracking", async () => {
  const { app } = setup();
  const aiApp = createApp({
    config: createTestConfig(),
    store: createMemoryStore(),
    ai: createTestAi(null),
    rateLimitEnabled: false,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  const aiResponse = await request(aiApp)
    .post("/api/ai-test")
    .send({ message: "রুট ০১", language: "bn" });
  assert.equal(aiResponse.status, 503);
  assert.equal(aiResponse.body.error.code, "AI_NOT_CONFIGURED");

  const start = await request(app).post("/api/tracking/start").send(validStartBody());
  assert.equal(start.status, 201);
});

test("AI provider auth failure is mapped safely while tracking keeps working", async () => {
  const store = createMemoryStore();
  const fake = createFakeMetaClient(async () => {
    throw Object.assign(new Error("provider secret detail"), { status: 401 });
  });
  const app = createApp({
    config: createTestConfig(),
    store,
    ai: createTestAi(fake.client),
    rateLimitEnabled: false,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  const aiResponse = await request(app)
    .post("/api/ai-test")
    .send({ message: "রুট ০১", language: "bn" });
  assert.equal(aiResponse.status, 502);
  assert.equal(aiResponse.body.error.code, "AI_AUTH_FAILED");
  assert.doesNotMatch(JSON.stringify(aiResponse.body), /secret detail/);

  const start = await request(app).post("/api/tracking/start").send(validStartBody());
  assert.equal(start.status, 201);
});

test("AI receives aggregate live data but never precise driver coordinates", async () => {
  const { app, fake } = setup();
  const started = await startJourney(app, {
    initialLocation: { latitude: 22.3569, longitude: 91.7832, accuracy: 12 },
  });

  const response = await request(app)
    .post("/api/ai-test")
    .send({ message: "এখন রুট ০১-এ গাড়ি আছে?", language: "bn" });
  assert.equal(response.status, 200);

  const prompt = String(fake.calls[0]?.instructions);
  assert.match(prompt, /Fresh driver-reported GPS sessions: 1/);
  assert.match(prompt, /route 01: 1/);
  assert.doesNotMatch(prompt, /22\.3569/);
  assert.doesNotMatch(prompt, /91\.7832/);
  assert.ok(!prompt.includes(started.sessionToken));
  assert.doesNotMatch(prompt, /publicId|tokenHash/);
});

test("AI request validation rejects empty, huge, and invalid-language questions", async () => {
  const { app } = setup();
  for (const body of [
    { message: "" },
    { message: "x".repeat(1001) },
    { message: "রুট ০১", language: "fr" },
    { message: 42 },
  ]) {
    const response = await request(app).post("/api/ai-test").send(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_AI_REQUEST");
  }
});

test("CORS allows configured origins and rejects unknown browser origins", async () => {
  const { app } = setup();
  const allowed = await request(app)
    .get("/api/health")
    .set("Origin", "http://localhost:5173");
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers["access-control-allow-origin"],
    "http://localhost:5173"
  );

  const blocked = await request(app)
    .get("/api/health")
    .set("Origin", "https://evil.example");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, "CORS_NOT_ALLOWED");
});

test("unknown API endpoints return structured 404 responses", async () => {
  const { app } = setup();
  const response = await request(app).get("/api/does-not-exist");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "NOT_FOUND");
});
