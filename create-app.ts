import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import type { AppConfig } from "./config.js";
import type { TrackingStore, StoreHealth } from "./tracking/types.js";
import {
  TrackingStoreUnavailableError,
  toPublicVehicle,
} from "./tracking/types.js";
import type { MetaAIService } from "./ai/service.js";
import { AiError } from "./ai/errors.js";
import { buildHealth, isTrackingOperational } from "./health.js";
import {
  ApiError,
  generateSessionSecrets,
  hashSessionToken,
  parseAiRequest,
  parseBearerToken,
  parseLocationRequest,
  parseRouteNumberQuery,
  parseStartRequest,
} from "./validation.js";
import { validateJourney } from "./shared/journey.js";
import type { Direction } from "./shared/routes.js";

export type CreateAppOptions = {
  config: AppConfig;
  store: TrackingStore;
  ai: MetaAIService;
  rateLimitEnabled?: boolean;
  clock?: () => Date;
};

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function limiterFor(
  windowMs: number,
  limit: number,
  code: string,
  message: string
) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code,
          message,
        },
      });
    },
  });
}

export function createApp(options: CreateAppOptions) {
  const { config, store, ai } = options;
  const clock = options.clock ?? (() => new Date());
  const rateLimitEnabled = options.rateLimitEnabled ?? config.rateLimitEnabled;
  const app = express();

  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  const allowedOrigins = new Set(config.corsOrigins);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(
          new ApiError(403, "CORS_NOT_ALLOWED", "This browser origin is not allowed.")
        );
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
    })
  );

  app.use(express.json({ limit: "16kb", strict: true }));

  if (rateLimitEnabled) {
    app.use(
      "/api",
      limiterFor(
        60_000,
        300,
        "RATE_LIMITED",
        "Too many requests. Please wait and try again."
      )
    );
    app.use(
      "/api/ai-test",
      limiterFor(
        60_000,
        10,
        "AI_RATE_LIMITED",
        "Too many AI requests. Please wait and try again."
      )
    );
    app.use(
      "/api/tracking/start",
      limiterFor(
        60_000,
        10,
        "RATE_LIMITED",
        "Too many tracking start requests. Please wait."
      )
    );
    app.use(
      "/api/tracking/location",
      limiterFor(
        60_000,
        240,
        "RATE_LIMITED",
        "Too many GPS updates. Please wait."
      )
    );
    app.use(
      "/api/tracking/active",
      limiterFor(
        60_000,
        120,
        "RATE_LIMITED",
        "Too many live-map requests. Please wait."
      )
    );
  }

  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      console.log(
        `${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`
      );
    });
    next();
  });

  async function databaseHealth(): Promise<StoreHealth> {
    try {
      return await store.health();
    } catch {
      return {
        configured: store.mode !== "memory",
        connected: false,
        mode: store.mode,
        persistent: store.mode === "mongodb",
        latencyMs: null,
        errorCode: "HEALTH_CHECK_FAILED",
      };
    }
  }

  app.get(
    "/api/health",
    asyncRoute(async (_req, res) => {
      const database = await databaseHealth();
      res.status(200).json(buildHealth(database, ai.health(), clock()));
    })
  );

  app.get(
    "/api/health/ready",
    asyncRoute(async (_req, res) => {
      const database = await databaseHealth();
      const health = buildHealth(database, ai.health(), clock());
      res.status(isTrackingOperational(database) ? 200 : 503).json(health);
    })
  );

  app.post(
    "/api/tracking/start",
    asyncRoute(async (req, res) => {
      const parsed = parseStartRequest(req.body);
      const journey = validateJourney(
        parsed.routeNumber,
        parsed.direction as Direction,
        parsed.startIndex,
        parsed.endIndex
      );

      if (!journey.ok) {
        throw new ApiError(400, journey.code, journey.message);
      }

      const now = clock();
      const secrets = generateSessionSecrets();
      const expiresAt = new Date(
        now.getTime() + config.trackingSessionTtlSeconds * 1000
      );
      const record = await store.createSession({
        tokenHash: secrets.tokenHash,
        publicId: secrets.publicId,
        routeNumber: journey.journey.route.number,
        routeName: journey.journey.route.name,
        direction: journey.journey.direction,
        startIndex: journey.journey.startIndex,
        endIndex: journey.journey.endIndex,
        startStop: journey.journey.startStop,
        endStop: journey.journey.endStop,
        segmentStops: journey.journey.segmentStops,
        latitude: parsed.initialLocation.latitude,
        longitude: parsed.initialLocation.longitude,
        accuracy: parsed.initialLocation.accuracy,
        expiresAt,
        consentVersion: parsed.consentVersion,
        now,
      });

      res.status(201).json({
        sessionToken: secrets.sessionToken,
        publicId: record.publicId,
        journey: {
          routeNumber: record.routeNumber,
          routeName: record.routeName,
          direction: record.direction,
          startIndex: record.startIndex,
          endIndex: record.endIndex,
          startStop: record.startStop,
          endStop: record.endStop,
          segmentStops: record.segmentStops,
          confidence: journey.journey.directionData.confidence,
          via: journey.journey.directionData.via ?? [],
          note: journey.journey.directionData.note ?? null,
        },
        startedAt: record.startedAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
        staleSeconds: config.trackingStaleSeconds,
      });
    })
  );

  app.post(
    "/api/tracking/location",
    asyncRoute(async (req, res) => {
      const token = parseBearerToken(req.headers.authorization);
      const location = parseLocationRequest(req.body);
      const now = clock();
      const result = await store.updateLocation(
        hashSessionToken(token),
        location,
        now,
        config.locationMinIntervalMs,
        config.trackingSessionTtlSeconds
      );

      if (result.status === "not_found") {
        throw new ApiError(
          401,
          "UNAUTHORIZED_SESSION",
          "The driver session is invalid, stopped, or expired."
        );
      }

      if (result.status === "too_frequent") {
        const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        res.setHeader("Retry-After", String(retryAfterSeconds));
        throw new ApiError(
          429,
          "UPDATE_TOO_FREQUENT",
          "GPS updates are arriving too quickly for this session.",
          retryAfterSeconds
        );
      }

      res.json({
        accepted: true,
        vehicle: toPublicVehicle(result.record, now),
      });
    })
  );

  app.post(
    "/api/tracking/stop",
    asyncRoute(async (req, res) => {
      const token = parseBearerToken(req.headers.authorization);
      await store.stopSession(hashSessionToken(token));
      res.status(204).end();
    })
  );

  app.get(
    "/api/tracking/active",
    asyncRoute(async (req, res) => {
      const routeNumber = parseRouteNumberQuery(req.query.routeNumber);
      const now = clock();
      const active = await store.listActive(
        routeNumber,
        now,
        config.trackingStaleSeconds
      );

      res.json({
        serverTime: now.toISOString(),
        staleSeconds: config.trackingStaleSeconds,
        staleHidden: active.staleHidden,
        vehicles: active.vehicles,
      });
    })
  );

  app.post(
    "/api/ai-test",
    asyncRoute(async (req, res) => {
      const parsed = parseAiRequest(req.body);
      const now = clock();
      let liveSummary = {
        liveDataAvailable: false,
        totalFresh: 0,
        staleHidden: 0,
        byRoute: [] as Array<{ routeNumber: string; count: number }>,
        serverTime: now.toISOString(),
      };

      try {
        const active = await store.listActive(
          undefined,
          now,
          config.trackingStaleSeconds
        );
        const counts = new Map<string, number>();
        for (const vehicle of active.vehicles) {
          counts.set(vehicle.routeNumber, (counts.get(vehicle.routeNumber) ?? 0) + 1);
        }
        liveSummary = {
          liveDataAvailable: true,
          totalFresh: active.vehicles.length,
          staleHidden: active.staleHidden,
          byRoute: [...counts.entries()]
            .map(([routeNumber, count]) => ({ routeNumber, count }))
            .sort((left, right) => left.routeNumber.localeCompare(right.routeNumber)),
          serverTime: now.toISOString(),
        };
      } catch {
        // The AI feature is independent from tracking. If the tracking store is
        // down, the assistant must say live data cannot be verified.
      }

      const result = await ai.ask({
        message: parsed.message,
        language: parsed.language,
        liveSummary,
      });

      res.json({
        answer: result.answer,
        model: result.model,
      });
    })
  );

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "The requested API endpoint does not exist.",
      },
    });
  });

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof ApiError) {
        if (error.retryAfterSeconds !== undefined) {
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        }
        res.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: error.retryAfterSeconds }
              : {}),
          },
        });
        return;
      }

      if (error instanceof AiError) {
        if (error.retryAfterSeconds !== undefined) {
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        }
        res.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: error.retryAfterSeconds }
              : {}),
          },
        });
        return;
      }

      if (error instanceof TrackingStoreUnavailableError) {
        res.status(503).json({
          error: {
            code: "TRACKING_STORE_UNAVAILABLE",
            message:
              "The tracking database is unavailable. Live GPS is temporarily unavailable.",
          },
        });
        return;
      }

      const bodyError = error as { type?: string; status?: number };
      if (bodyError.type === "entity.too.large") {
        res.status(413).json({
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The request body is too large.",
          },
        });
        return;
      }

      if (bodyError.type === "entity.parse.failed" || error instanceof SyntaxError) {
        res.status(400).json({
          error: {
            code: "INVALID_JSON",
            message: "The request body must be valid JSON.",
          },
        });
        return;
      }

      console.error(
        "Unhandled API error:",
        error instanceof Error ? error.name : "UnknownError"
      );
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected server error occurred.",
        },
      });
    }
  );

  return app;
}
