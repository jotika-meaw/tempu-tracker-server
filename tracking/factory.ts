import type { AppConfig } from "../config";
import { MemoryTrackingStore } from "./memory-store";
import { MongoTrackingStore } from "./mongo-store";
import {
  TrackingStoreUnavailableError,
  type ActiveVehicles,
  type CreateSessionInput,
  type LocationInput,
  type SessionRecord,
  type StoreHealth,
  type StoreMode,
  type TrackingStore,
  type UpdateLocationResult,
} from "./types";

class UnavailableTrackingStore implements TrackingStore {
  readonly mode: StoreMode = "unavailable";
  private readonly configured: boolean;
  private readonly errorCode: string;

  constructor(configured: boolean, errorCode: string) {
    this.configured = configured;
    this.errorCode = errorCode;
  }

  async init(): Promise<void> {
    return;
  }

  async health(): Promise<StoreHealth> {
    return {
      configured: this.configured,
      connected: false,
      mode: "unavailable",
      persistent: false,
      latencyMs: null,
      errorCode: this.errorCode,
    };
  }

  async createSession(_input: CreateSessionInput): Promise<SessionRecord> {
    throw new TrackingStoreUnavailableError();
  }

  async updateLocation(
    _tokenHash: string,
    _location: LocationInput,
    _now: Date,
    _minIntervalMs: number,
    _ttlSeconds: number
  ): Promise<UpdateLocationResult> {
    throw new TrackingStoreUnavailableError();
  }

  async stopSession(_tokenHash: string): Promise<void> {
    throw new TrackingStoreUnavailableError();
  }

  async listActive(
    _routeNumber: string | undefined,
    _now: Date,
    _staleSeconds: number
  ): Promise<ActiveVehicles> {
    throw new TrackingStoreUnavailableError();
  }

  async close(): Promise<void> {
    return;
  }
}

export type TrackingStoreFactoryResult = {
  store: TrackingStore;
  warning: string | null;
};

export async function createTrackingStore(
  config: AppConfig
): Promise<TrackingStoreFactoryResult> {
  if (!config.mongoUri) {
    if (config.mongoRequired) {
      return {
        store: new UnavailableTrackingStore(
          false,
          "MONGO_REQUIRED_BUT_NOT_CONFIGURED"
        ),
        warning:
          "MONGODB_REQUIRED=true but MONGODB_URI is not configured. Tracking endpoints will return 503.",
      };
    }
    return {
      store: new MemoryTrackingStore({ mode: "memory" }),
      warning:
        "MongoDB is not configured. Using explicit non-persistent memory mode.",
    };
  }

  const mongoStore = new MongoTrackingStore(config.mongoUri, config.mongoDbName);
  try {
    await mongoStore.init();
    return { store: mongoStore, warning: null };
  } catch {
    await mongoStore.close().catch(() => undefined);

    if (config.mongoRequired) {
      return {
        store: new UnavailableTrackingStore(true, "MONGO_CONNECT_FAILED"),
        warning:
          "MongoDB is configured but unavailable. Tracking endpoints will return 503 because MONGODB_REQUIRED=true.",
      };
    }

    return {
      store: new MemoryTrackingStore({
        mode: "memory-fallback",
        configured: true,
        connected: false,
        errorCode: "MONGO_CONNECT_FAILED",
      }),
      warning:
        "MongoDB is configured but unavailable. Using explicit memory fallback; data is not persistent.",
    };
  }
}
