import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTrackingStore } from "../tracking/memory-store.ts";
import {
  toPublicVehicle,
  type CreateSessionInput,
  type SessionRecord,
} from "../tracking/types.ts";
import { hashSessionToken } from "../validation.ts";

const baseTime = new Date("2026-01-01T00:00:00.000Z");

function sessionInput(
  index: number,
  overrides: Partial<CreateSessionInput> = {}
): CreateSessionInput {
  const now = overrides.now ?? baseTime;
  return {
    tokenHash: hashSessionToken(`session-token-${index}`),
    publicId: `public-${index}`,
    routeNumber: "01",
    routeName: "অক্সিজেন – বারেক বিল্ডিং",
    direction: "outbound",
    startIndex: 0,
    endIndex: 3,
    startStop: "অক্সিজেন",
    endStop: "চকবাজার",
    segmentStops: ["অক্সিজেন", "আতুরার ডিপো", "মুরাদপুর", "চকবাজার"],
    latitude: 22.35 + index / 1000,
    longitude: 91.78 + index / 1000,
    accuracy: 10,
    expiresAt: new Date(now.getTime() + 3600_000),
    consentVersion: "demo-v1",
    now,
    ...overrides,
  };
}

function publicKeys(record: SessionRecord): string[] {
  return Object.keys(toPublicVehicle(record, baseTime));
}

test("memory store creates a session with only the latest GPS point", async () => {
  const store = new MemoryTrackingStore({ mode: "memory" });
  const input = sessionInput(1);
  const record = await store.createSession(input);

  assert.equal(record.publicId, "public-1");
  assert.equal(record.lastLocationAt.toISOString(), baseTime.toISOString());
  assert.equal(record.latitude, input.latitude);

  const active = await store.listActive(undefined, baseTime, 30);
  assert.equal(active.vehicles.length, 1);
  assert.equal(active.staleHidden, 0);
  assert.deepEqual(publicKeys(record), [
    "publicId",
    "routeNumber",
    "routeName",
    "direction",
    "startStop",
    "endStop",
    "segmentStops",
    "latitude",
    "longitude",
    "accuracy",
    "lastLocationAt",
    "ageSeconds",
    "freshness",
    "source",
  ]);
  assert.ok(!("tokenHash" in toPublicVehicle(record, baseTime)));
  assert.ok(!("consentVersion" in toPublicVehicle(record, baseTime)));
});

test("memory store rejects updates that arrive too frequently", async () => {
  const store = new MemoryTrackingStore();
  const input = sessionInput(1);
  await store.createSession(input);

  const tooSoon = await store.updateLocation(
    input.tokenHash,
    { latitude: 22.36, longitude: 91.79, accuracy: 8 },
    new Date(baseTime.getTime() + 1000),
    3000,
    3600
  );
  assert.equal(tooSoon.status, "too_frequent");
  if (tooSoon.status === "too_frequent") {
    assert.equal(tooSoon.retryAfterMs, 2000);
  }

  const accepted = await store.updateLocation(
    input.tokenHash,
    { latitude: 22.36, longitude: 91.79, accuracy: 8 },
    new Date(baseTime.getTime() + 4000),
    3000,
    3600
  );
  assert.equal(accepted.status, "updated");
  if (accepted.status === "updated") {
    assert.equal(accepted.record.latitude, 22.36);
    assert.equal(accepted.record.accuracy, 8);
  }
});

test("memory store keeps two vehicles independent", async () => {
  const store = new MemoryTrackingStore();
  const first = sessionInput(1, { routeNumber: "01" });
  const second = sessionInput(2, { routeNumber: "02", publicId: "public-2" });
  await store.createSession(first);
  await store.createSession(second);

  await store.updateLocation(
    first.tokenHash,
    { latitude: 22.4, longitude: 91.8, accuracy: 5 },
    new Date(baseTime.getTime() + 4000),
    3000,
    3600
  );

  const both = await store.listActive(undefined, new Date(baseTime.getTime() + 4000), 30);
  assert.equal(both.vehicles.length, 2);

  const secondVehicle = both.vehicles.find((vehicle) => vehicle.publicId === "public-2");
  const firstVehicle = both.vehicles.find((vehicle) => vehicle.publicId === "public-1");
  assert.ok(firstVehicle);
  assert.ok(secondVehicle);
  assert.equal(firstVehicle.latitude, 22.4);
  assert.equal(secondVehicle.latitude, second.latitude);

  const routeOne = await store.listActive(
    "01",
    new Date(baseTime.getTime() + 4000),
    30
  );
  assert.deepEqual(
    routeOne.vehicles.map((vehicle) => vehicle.publicId),
    ["public-1"]
  );

  await store.stopSession(first.tokenHash);
  const afterStop = await store.listActive(
    undefined,
    new Date(baseTime.getTime() + 4000),
    30
  );
  assert.deepEqual(
    afterStop.vehicles.map((vehicle) => vehicle.publicId),
    ["public-2"]
  );
});

test("memory store hides stale locations but reports the aggregate count", async () => {
  const store = new MemoryTrackingStore();
  const input = sessionInput(1);
  await store.createSession(input);

  const staleTime = new Date(baseTime.getTime() + 31_000);
  const active = await store.listActive(undefined, staleTime, 30);
  assert.equal(active.vehicles.length, 0);
  assert.equal(active.staleHidden, 1);
});

test("memory store expires sessions and rejects updates after expiry", async () => {
  const store = new MemoryTrackingStore();
  const input = sessionInput(1, {
    expiresAt: new Date(baseTime.getTime() + 1000),
  });
  await store.createSession(input);

  const expiredTime = new Date(baseTime.getTime() + 2000);
  const active = await store.listActive(undefined, expiredTime, 30);
  assert.equal(active.vehicles.length, 0);

  const update = await store.updateLocation(
    input.tokenHash,
    { latitude: 22.36, longitude: 91.79, accuracy: 8 },
    expiredTime,
    0,
    3600
  );
  assert.equal(update.status, "not_found");
});

test("memory health clearly distinguishes memory and memory-fallback", async () => {
  const memory = new MemoryTrackingStore({ mode: "memory" });
  assert.deepEqual(await memory.health(), {
    configured: false,
    connected: true,
    mode: "memory",
    persistent: false,
    latencyMs: 0,
    errorCode: null,
  });

  const fallback = new MemoryTrackingStore({
    mode: "memory-fallback",
    configured: true,
    connected: false,
    errorCode: "MONGO_CONNECT_FAILED",
  });
  assert.deepEqual(await fallback.health(), {
    configured: true,
    connected: false,
    mode: "memory-fallback",
    persistent: false,
    latencyMs: 0,
    errorCode: "MONGO_CONNECT_FAILED",
  });
});
