import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import { MongoTrackingStore } from "../tracking/mongo-store.ts";
import type { CreateSessionInput } from "../tracking/types.ts";
import { hashSessionToken } from "../validation.ts";

function mongoSession(
  index: number,
  now: Date,
  overrides: Partial<CreateSessionInput> = {}
): CreateSessionInput {
  return {
    tokenHash: hashSessionToken(randomBytes(32).toString("base64url")),
    publicId: randomBytes(8).toString("base64url"),
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

test(
  "MongoDB store persists sessions, indexes, validation, and isolation",
  { skip: !process.env.MONGODB_URI_TEST },
  async () => {
    const uri = process.env.MONGODB_URI_TEST;
    if (!uri) return;

    const dbName = `tempu_tracker_test_${randomBytes(4).toString("hex")}`;
    const store = new MongoTrackingStore(uri, dbName);
    const inspector = new MongoClient(uri);
    const now = new Date("2026-01-01T00:00:00.000Z");

    try {
      await store.init();
      const health = await store.health();
      assert.equal(health.mode, "mongodb");
      assert.equal(health.connected, true);
      assert.equal(health.persistent, true);

      const first = mongoSession(1, now);
      const second = mongoSession(2, now, {
        routeNumber: "02",
        routeName: "বায়েজিদ বোস্তামী – টাইগারপাস",
        startStop: "বায়েজিদ বোস্তামী",
        endStop: "জিইসি",
        segmentStops: ["বায়েজিদ বোস্তামী", "ষোলশহর ২নং গেট", "জিইসি"],
      });

      await store.createSession(first);
      await store.createSession(second);

      const initial = await store.listActive(undefined, now, 30);
      assert.equal(initial.vehicles.length, 2);
      assert.equal(initial.staleHidden, 0);

      const updated = await store.updateLocation(
        first.tokenHash,
        { latitude: 22.4, longitude: 91.8, accuracy: 5 },
        new Date(now.getTime() + 4000),
        3000,
        3600
      );
      assert.equal(updated.status, "updated");

      const afterUpdate = await store.listActive(
        undefined,
        new Date(now.getTime() + 4000),
        30
      );
      const firstVehicle = afterUpdate.vehicles.find(
        (vehicle) => vehicle.publicId === first.publicId
      );
      const secondVehicle = afterUpdate.vehicles.find(
        (vehicle) => vehicle.publicId === second.publicId
      );
      assert.ok(firstVehicle);
      assert.ok(secondVehicle);
      assert.equal(firstVehicle.latitude, 22.4);
      assert.equal(secondVehicle.latitude, second.latitude);

      const filtered = await store.listActive(
        "02",
        new Date(now.getTime() + 4000),
        30
      );
      assert.deepEqual(
        filtered.vehicles.map((vehicle) => vehicle.publicId),
        [second.publicId]
      );

      await store.stopSession(first.tokenHash);
      const afterStop = await store.listActive(
        undefined,
        new Date(now.getTime() + 4000),
        30
      );
      assert.deepEqual(
        afterStop.vehicles.map((vehicle) => vehicle.publicId),
        [second.publicId]
      );

      await inspector.connect();
      const collection = inspector.db(dbName).collection("tracking_sessions");
      const indexes = await collection.indexes();
      const names = indexes.map((index) => index.name);
      assert.ok(names.includes("uniq_token_hash"));
      assert.ok(names.includes("uniq_public_id"));
      assert.ok(names.includes("route_status_last_location"));
      assert.ok(names.includes("ttl_expires_at"));

      await assert.rejects(
        collection.insertOne({ tokenHash: "not-a-valid-hash" }),
        /validation/i
      );
    } finally {
      await store.close().catch(() => undefined);
      await inspector
        .db(dbName)
        .dropDatabase()
        .catch(() => undefined);
      await inspector.close().catch(() => undefined);
    }
  }
);
