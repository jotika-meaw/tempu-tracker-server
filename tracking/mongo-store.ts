import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
  type Document,
} from "mongodb";
import { TEMPU_ROUTE_NUMBERS } from "../shared/routes.js";
import {
  toPublicVehicle,
  type ActiveVehicles,
  type CreateSessionInput,
  type LocationInput,
  type SessionRecord,
  type StoreHealth,
  type StoreMode,
  type TrackingStore,
  type UpdateLocationResult,
} from "./types.js";

type SessionDocument = Omit<SessionRecord, "startedAt" | "lastLocationAt" | "expiresAt"> & {
  _id?: ObjectId;
  startedAt: Date;
  lastLocationAt: Date;
  expiresAt: Date;
};

const COLLECTION_NAME = "tracking_sessions";

const validator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "tokenHash",
      "publicId",
      "routeNumber",
      "routeName",
      "direction",
      "startIndex",
      "endIndex",
      "startStop",
      "endStop",
      "segmentStops",
      "latitude",
      "longitude",
      "accuracy",
      "status",
      "startedAt",
      "lastLocationAt",
      "expiresAt",
      "consentVersion",
    ],
    additionalProperties: false,
    properties: {
      _id: { bsonType: "objectId" },
      tokenHash: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
      publicId: { bsonType: "string", minLength: 8, maxLength: 24 },
      routeNumber: { enum: [...TEMPU_ROUTE_NUMBERS] },
      routeName: { bsonType: "string" },
      direction: { enum: ["outbound", "return"] },
      startIndex: { bsonType: "number", minimum: 0 },
      endIndex: { bsonType: "number", minimum: 0 },
      startStop: { bsonType: "string" },
      endStop: { bsonType: "string" },
      segmentStops: {
        bsonType: "array",
        minItems: 2,
        items: { bsonType: "string" },
      },
      latitude: { bsonType: "number", minimum: -90, maximum: 90 },
      longitude: { bsonType: "number", minimum: -180, maximum: 180 },
      accuracy: { bsonType: ["number", "null"], minimum: 0 },
      status: { enum: ["active"] },
      startedAt: { bsonType: "date" },
      lastLocationAt: { bsonType: "date" },
      expiresAt: { bsonType: "date" },
      consentVersion: { bsonType: "string" },
    },
  },
} as Document;

function toRecord(document: SessionDocument): SessionRecord {
  return {
    tokenHash: document.tokenHash,
    publicId: document.publicId,
    routeNumber: document.routeNumber,
    routeName: document.routeName,
    direction: document.direction,
    startIndex: document.startIndex,
    endIndex: document.endIndex,
    startStop: document.startStop,
    endStop: document.endStop,
    segmentStops: [...document.segmentStops],
    latitude: document.latitude,
    longitude: document.longitude,
    accuracy: document.accuracy,
    status: document.status,
    startedAt: new Date(document.startedAt),
    lastLocationAt: new Date(document.lastLocationAt),
    expiresAt: new Date(document.expiresAt),
    consentVersion: document.consentVersion,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("MONGO_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class MongoTrackingStore implements TrackingStore {
  readonly mode: StoreMode = "mongodb";

  private readonly client: MongoClient;
  private readonly dbName: string;
  private db: Db | null = null;
  private collection: Collection<SessionDocument> | null = null;

  constructor(uri: string, dbName: string) {
    this.dbName = dbName;
    this.client = new MongoClient(uri, {
      appName: "tempu-tracker",
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      maxPoolSize: 10,
      retryWrites: true,
    });
  }

  async init(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    await this.db.command({ ping: 1 });
    await this.ensureCollection();
    this.collection = this.db.collection<SessionDocument>(COLLECTION_NAME);
  }

  private async ensureCollection(): Promise<void> {
    if (!this.db) throw new Error("MONGO_NOT_CONNECTED");

    try {
      await this.db.createCollection(COLLECTION_NAME, {
        validator,
        validationLevel: "strict",
        validationAction: "error",
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 48) throw error;
      try {
        await this.db.command({
          collMod: COLLECTION_NAME,
          validator,
          validationLevel: "strict",
          validationAction: "error",
        });
      } catch {
        // The application-level validation remains authoritative. Some Atlas
        // roles do not allow collMod; this should not prevent startup.
      }
    }

    const collection = this.db.collection<SessionDocument>(COLLECTION_NAME);
    await Promise.all([
      collection.createIndex(
        { tokenHash: 1 },
        { unique: true, name: "uniq_token_hash" }
      ),
      collection.createIndex(
        { publicId: 1 },
        { unique: true, name: "uniq_public_id" }
      ),
      collection.createIndex(
        { routeNumber: 1, status: 1, lastLocationAt: -1 },
        { name: "route_status_last_location" }
      ),
      collection.createIndex(
        { status: 1, lastLocationAt: -1 },
        { name: "status_last_location" }
      ),
      collection.createIndex(
        { expiresAt: 1 },
        { name: "ttl_expires_at", expireAfterSeconds: 0 }
      ),
    ]);
  }

  private get sessionCollection(): Collection<SessionDocument> {
    if (!this.collection) throw new Error("MONGO_NOT_INITIALIZED");
    return this.collection;
  }

  async health(): Promise<StoreHealth> {
    if (!this.db) {
      return {
        configured: true,
        connected: false,
        mode: "mongodb",
        persistent: true,
        latencyMs: null,
        errorCode: "MONGO_NOT_INITIALIZED",
      };
    }

    const startedAt = Date.now();
    try {
      await withTimeout(this.db.command({ ping: 1 }), 2000);
      return {
        configured: true,
        connected: true,
        mode: "mongodb",
        persistent: true,
        latencyMs: Date.now() - startedAt,
        errorCode: null,
      };
    } catch {
      return {
        configured: true,
        connected: false,
        mode: "mongodb",
        persistent: true,
        latencyMs: null,
        errorCode: "MONGO_PING_FAILED",
      };
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const { now, ...sessionFields } = input;
    const document: SessionDocument = {
      ...sessionFields,
      segmentStops: [...input.segmentStops],
      status: "active",
      startedAt: new Date(now),
      lastLocationAt: new Date(now),
      expiresAt: new Date(input.expiresAt),
    };
    await this.sessionCollection.insertOne(document);
    return toRecord(document);
  }

  async updateLocation(
    tokenHash: string,
    location: LocationInput,
    now: Date,
    minIntervalMs: number,
    ttlSeconds: number
  ): Promise<UpdateLocationResult> {
    const cutoff = new Date(now.getTime() - minIntervalMs);
    const update = {
      $set: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        lastLocationAt: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      },
    };

    const updated = await this.sessionCollection.findOneAndUpdate(
      {
        tokenHash,
        status: "active",
        expiresAt: { $gt: now },
        lastLocationAt: { $lte: cutoff },
      },
      update,
      { returnDocument: "after" }
    );

    if (updated) {
      return { status: "updated", record: toRecord(updated) };
    }

    const existing = await this.sessionCollection.findOne({ tokenHash });
    if (!existing || existing.status !== "active" || existing.expiresAt <= now) {
      return { status: "not_found" };
    }

    const retryAfterMs = Math.max(
      0,
      minIntervalMs - (now.getTime() - existing.lastLocationAt.getTime())
    );
    if (retryAfterMs > 0) {
      return { status: "too_frequent", retryAfterMs };
    }

    // An eligible update raced with another update. Treat it as too frequent
    // rather than silently accepting a duplicate point.
    return { status: "too_frequent", retryAfterMs: minIntervalMs };
  }

  async stopSession(tokenHash: string): Promise<void> {
    await this.sessionCollection.deleteOne({ tokenHash });
  }

  async listActive(
    routeNumber: string | undefined,
    now: Date,
    staleSeconds: number
  ): Promise<ActiveVehicles> {
    const baseFilter: Document = {
      status: "active",
      expiresAt: { $gt: now },
      ...(routeNumber ? { routeNumber } : {}),
    };
    const staleCutoff = new Date(now.getTime() - staleSeconds * 1000);

    const [fresh, staleHidden] = await Promise.all([
      this.sessionCollection
        .find({
          ...baseFilter,
          lastLocationAt: { $gte: staleCutoff },
        })
        .sort({ lastLocationAt: -1 })
        .limit(100)
        .toArray(),
      this.sessionCollection.countDocuments({
        ...baseFilter,
        lastLocationAt: { $lt: staleCutoff },
      }),
    ]);

    return {
      vehicles: fresh.map((document) => toPublicVehicle(toRecord(document), now)),
      staleHidden,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
    this.db = null;
    this.collection = null;
  }
}
