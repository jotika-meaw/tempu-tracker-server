import type { AppConfig } from "../config.js";
import { MetaAIService, type MetaClient } from "../ai/service.js";
import { MemoryTrackingStore } from "../tracking/memory-store.js";
import { TEMPU_ROUTE_NUMBERS } from "../shared/routes.js";

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    isProduction: false,
    corsOrigins: ["http://localhost:5173"],
    trustProxy: false,
    mongoUri: null,
    mongoDbName: "tempu_tracker_test",
    mongoRequired: false,
    modelApiKey: null,
    metaBaseUrl: "https://api.meta.ai/v1",
    metaModel: "muse-spark-1.2-contributor",
    aiTimeoutMs: 1000,
    aiMaxOutputTokens: 100,
    trackingStaleSeconds: 30,
    trackingSessionTtlSeconds: 3600,
    locationMinIntervalMs: 3000,
    rateLimitEnabled: false,
    ...overrides,
  };
}

export function createMemoryStore(): MemoryTrackingStore {
  return new MemoryTrackingStore({ mode: "memory" });
}

export type FakeMetaClient = {
  client: MetaClient;
  calls: Array<Parameters<MetaClient["create"]>[0]>;
};

export function createFakeMetaClient(
  responder: (callNumber: number) => Promise<{ output_text?: string }>
): FakeMetaClient {
  const calls: Array<Parameters<MetaClient["create"]>[0]> = [];
  return {
    calls,
    client: {
      async create(params) {
        calls.push(params);
        return responder(calls.length);
      },
    },
  };
}

export function createTestAi(
  client: MetaClient | null,
  overrides: Partial<ConstructorParameters<typeof MetaAIService>[0]> = {}
): MetaAIService {
  return new MetaAIService({
    client,
    model: "muse-spark-1.2-contributor",
    baseUrl: "https://api.meta.ai/v1",
    maxOutputTokens: 100,
    timeoutMs: 1000,
    allowedRouteNumbers: TEMPU_ROUTE_NUMBERS,
    maxRetries: 0,
    sleep: async () => undefined,
    ...overrides,
  });
}

export function validStartBody(overrides: Record<string, unknown> = {}) {
  return {
    routeNumber: "01",
    direction: "outbound",
    startIndex: 0,
    endIndex: 3,
    consent: true,
    initialLocation: {
      latitude: 22.3569,
      longitude: 91.7832,
      accuracy: 12,
    },
    ...overrides,
  };
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}
