import type { Direction } from "../shared/routes";

export type StoreMode =
  | "mongodb"
  | "memory"
  | "memory-fallback"
  | "unavailable";

export type StoreHealth = {
  configured: boolean;
  connected: boolean;
  mode: StoreMode;
  persistent: boolean;
  latencyMs: number | null;
  errorCode: string | null;
};

export type LocationInput = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
};

export type SessionRecord = {
  tokenHash: string;
  publicId: string;
  routeNumber: string;
  routeName: string;
  direction: Direction;
  startIndex: number;
  endIndex: number;
  startStop: string;
  endStop: string;
  segmentStops: string[];
  latitude: number;
  longitude: number;
  accuracy: number | null;
  status: "active";
  startedAt: Date;
  lastLocationAt: Date;
  expiresAt: Date;
  consentVersion: string;
};

export type CreateSessionInput = Omit<
  SessionRecord,
  "status" | "startedAt" | "lastLocationAt"
> & {
  now: Date;
};

export type PublicVehicle = {
  publicId: string;
  routeNumber: string;
  routeName: string;
  direction: Direction;
  startStop: string;
  endStop: string;
  segmentStops: string[];
  latitude: number;
  longitude: number;
  accuracy: number | null;
  lastLocationAt: string;
  ageSeconds: number;
  freshness: "live";
  source: "driver-device-gps";
};

export type ActiveVehicles = {
  vehicles: PublicVehicle[];
  staleHidden: number;
};

export type UpdateLocationResult =
  | { status: "updated"; record: SessionRecord }
  | { status: "not_found" }
  | { status: "too_frequent"; retryAfterMs: number };

export interface TrackingStore {
  readonly mode: StoreMode;
  init(): Promise<void>;
  health(): Promise<StoreHealth>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  updateLocation(
    tokenHash: string,
    location: LocationInput,
    now: Date,
    minIntervalMs: number,
    ttlSeconds: number
  ): Promise<UpdateLocationResult>;
  stopSession(tokenHash: string): Promise<void>;
  listActive(
    routeNumber: string | undefined,
    now: Date,
    staleSeconds: number
  ): Promise<ActiveVehicles>;
  close(): Promise<void>;
}

export class TrackingStoreUnavailableError extends Error {
  readonly code = "TRACKING_STORE_UNAVAILABLE";

  constructor() {
    super("The tracking database is currently unavailable.");
    this.name = "TrackingStoreUnavailableError";
  }
}

export function toPublicVehicle(
  record: SessionRecord,
  now: Date
): PublicVehicle {
  return {
    publicId: record.publicId,
    routeNumber: record.routeNumber,
    routeName: record.routeName,
    direction: record.direction,
    startStop: record.startStop,
    endStop: record.endStop,
    segmentStops: [...record.segmentStops],
    latitude: record.latitude,
    longitude: record.longitude,
    accuracy: record.accuracy,
    lastLocationAt: record.lastLocationAt.toISOString(),
    ageSeconds: Math.max(
      0,
      Math.floor((now.getTime() - record.lastLocationAt.getTime()) / 1000)
    ),
    freshness: "live",
    source: "driver-device-gps",
  };
}
