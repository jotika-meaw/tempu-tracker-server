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
} from "./types";

type MemoryStoreOptions = {
  mode?: Extract<StoreMode, "memory" | "memory-fallback">;
  configured?: boolean;
  connected?: boolean;
  errorCode?: string | null;
};

function cloneRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    segmentStops: [...record.segmentStops],
    startedAt: new Date(record.startedAt),
    lastLocationAt: new Date(record.lastLocationAt),
    expiresAt: new Date(record.expiresAt),
  };
}

export class MemoryTrackingStore implements TrackingStore {
  readonly mode: StoreMode;
  private readonly records = new Map<string, SessionRecord>();
  private readonly configured: boolean;
  private readonly connected: boolean;
  private readonly errorCode: string | null;

  constructor(options: MemoryStoreOptions = {}) {
    this.mode = options.mode ?? "memory";
    this.configured = options.configured ?? false;
    this.connected = options.connected ?? true;
    this.errorCode = options.errorCode ?? null;
  }

  async init(): Promise<void> {
    return;
  }

  async health(): Promise<StoreHealth> {
    return {
      configured: this.configured,
      connected: this.connected,
      mode: this.mode,
      persistent: false,
      latencyMs: 0,
      errorCode: this.errorCode,
    };
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    this.purgeExpired(input.now);
    const record: SessionRecord = {
      ...input,
      segmentStops: [...input.segmentStops],
      status: "active",
      startedAt: new Date(input.now),
      lastLocationAt: new Date(input.now),
      expiresAt: new Date(input.expiresAt),
    };
    this.records.set(record.tokenHash, record);
    return cloneRecord(record);
  }

  async updateLocation(
    tokenHash: string,
    location: LocationInput,
    now: Date,
    minIntervalMs: number,
    ttlSeconds: number
  ): Promise<UpdateLocationResult> {
    this.purgeExpired(now);
    const record = this.records.get(tokenHash);

    if (!record || record.status !== "active" || record.expiresAt <= now) {
      return { status: "not_found" };
    }

    const elapsedMs = now.getTime() - record.lastLocationAt.getTime();
    if (elapsedMs < minIntervalMs) {
      return {
        status: "too_frequent",
        retryAfterMs: Math.max(0, minIntervalMs - elapsedMs),
      };
    }

    record.latitude = location.latitude;
    record.longitude = location.longitude;
    record.accuracy = location.accuracy;
    record.lastLocationAt = new Date(now);
    record.expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    return { status: "updated", record: cloneRecord(record) };
  }

  async stopSession(tokenHash: string): Promise<void> {
    this.records.delete(tokenHash);
  }

  async listActive(
    routeNumber: string | undefined,
    now: Date,
    staleSeconds: number
  ): Promise<ActiveVehicles> {
    this.purgeExpired(now);
    const staleCutoff = now.getTime() - staleSeconds * 1000;
    const fresh: SessionRecord[] = [];
    let staleHidden = 0;

    for (const record of this.records.values()) {
      if (record.status !== "active" || record.expiresAt <= now) continue;
      if (routeNumber && record.routeNumber !== routeNumber) continue;

      if (record.lastLocationAt.getTime() < staleCutoff) {
        staleHidden += 1;
      } else {
        fresh.push(record);
      }
    }

    fresh.sort(
      (left, right) => right.lastLocationAt.getTime() - left.lastLocationAt.getTime()
    );

    return {
      vehicles: fresh.slice(0, 100).map((record) => toPublicVehicle(record, now)),
      staleHidden,
    };
  }

  async close(): Promise<void> {
    this.records.clear();
  }

  private purgeExpired(now: Date): void {
    for (const [tokenHash, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(tokenHash);
      }
    }
  }
}
