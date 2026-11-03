import { createHash, randomBytes } from "node:crypto";
import {
  TEMPU_ROUTE_NUMBERS,
  type Direction,
} from "./shared/routes.js";
import { validateJourney } from "./shared/journey.js";

export const DEMO_CONSENT_VERSION = "demo-v1";
export const AI_LANGUAGES = ["bn", "en", "ctg"] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseLocationObject(value: unknown): {
  latitude: number;
  longitude: number;
  accuracy: number | null;
} {
  if (!isPlainObject(value)) {
    throw new ApiError(
      400,
      "INVALID_COORDINATES",
      "A location object with latitude and longitude is required."
    );
  }

  const { latitude, longitude, accuracy } = value;

  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new ApiError(
      400,
      "INVALID_COORDINATES",
      "Latitude must be between -90 and 90 and longitude between -180 and 180."
    );
  }

  let parsedAccuracy: number | null = null;
  if (accuracy !== undefined && accuracy !== null) {
    if (
      typeof accuracy !== "number" ||
      !Number.isFinite(accuracy) ||
      accuracy < 0 ||
      accuracy > 100000
    ) {
      throw new ApiError(
        400,
        "INVALID_ACCURACY",
        "Accuracy must be a finite, non-negative number of metres."
      );
    }
    parsedAccuracy = accuracy;
  }

  return {
    latitude,
    longitude,
    accuracy: parsedAccuracy,
  };
}

export type StartRequest = {
  routeNumber: string;
  direction: Direction;
  startIndex: number;
  endIndex: number;
  initialLocation: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
  };
  consentVersion: string;
};

export function parseStartRequest(body: unknown): StartRequest {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "INVALID_REQUEST", "A JSON request body is required.");
  }

  const { routeNumber, direction, startIndex, endIndex, consent, initialLocation } =
    body;

  if (consent !== true) {
    throw new ApiError(
      400,
      "CONSENT_REQUIRED",
      "The driver must explicitly consent before sharing device GPS."
    );
  }

  if (typeof routeNumber !== "string") {
    throw new ApiError(400, "INVALID_ROUTE", "A route number is required.");
  }

  if (direction !== "outbound" && direction !== "return") {
    throw new ApiError(
      400,
      "INVALID_DIRECTION",
      "Direction must be either outbound or return."
    );
  }

  if (
    typeof startIndex !== "number" ||
    typeof endIndex !== "number" ||
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex)
  ) {
    throw new ApiError(
      400,
      "INVALID_INDEX",
      "Start and end must be integer stop indices."
    );
  }

  const journey = validateJourney(routeNumber, direction, startIndex, endIndex);
  if (!journey.ok) {
    throw new ApiError(400, journey.code, journey.message);
  }

  const location = parseLocationObject(initialLocation);

  return {
    routeNumber,
    direction,
    startIndex,
    endIndex,
    initialLocation: location,
    consentVersion: DEMO_CONSENT_VERSION,
  };
}

export type LocationRequest = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
};

export function parseLocationRequest(body: unknown): LocationRequest {
  return parseLocationObject(body);
}

export type AiRequest = {
  message: string;
  language: AiLanguage;
};

export function parseAiRequest(body: unknown): AiRequest {
  if (!isPlainObject(body)) {
    throw new ApiError(400, "INVALID_AI_REQUEST", "A JSON request body is required.");
  }

  const rawMessage = body.message;
  if (typeof rawMessage !== "string") {
    throw new ApiError(400, "INVALID_AI_REQUEST", "A question is required.");
  }

  const message = rawMessage.trim();
  if (!message || message.length > 1000) {
    throw new ApiError(
      400,
      "INVALID_AI_REQUEST",
      "The question must be between 1 and 1000 characters."
    );
  }

  // Control characters are deliberately rejected in AI questions.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message)) {
    throw new ApiError(
      400,
      "INVALID_AI_REQUEST",
      "The question contains unsupported control characters."
    );
  }

  const rawLanguage = body.language;
  let language: AiLanguage = "bn";
  if (rawLanguage !== undefined) {
    if (
      typeof rawLanguage !== "string" ||
      !(AI_LANGUAGES as readonly string[]).includes(rawLanguage)
    ) {
      throw new ApiError(
        400,
        "INVALID_AI_REQUEST",
        "Language must be bn, en, or ctg."
      );
    }
    language = rawLanguage as AiLanguage;
  }

  return { message, language };
}

export function parseRouteNumberQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "INVALID_ROUTE", "Route number must be a string.");
  }
  const routeNumber = value.trim();
  if (!(TEMPU_ROUTE_NUMBERS as readonly string[]).includes(routeNumber)) {
    throw new ApiError(400, "UNKNOWN_ROUTE", "This route is not in the verified set.");
  }
  return routeNumber;
}

export function parseBearerToken(header: string | undefined): string {
  if (!header) {
    throw new ApiError(
      401,
      "UNAUTHORIZED_SESSION",
      "A driver session token is required."
    );
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !/^[A-Za-z0-9_-]{43}$/.test(match[1])) {
    throw new ApiError(
      401,
      "UNAUTHORIZED_SESSION",
      "The driver session token is invalid."
    );
  }

  return match[1];
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionSecrets(): {
  sessionToken: string;
  tokenHash: string;
  publicId: string;
} {
  const sessionToken = randomBytes(32).toString("base64url");
  return {
    sessionToken,
    tokenHash: hashSessionToken(sessionToken),
    publicId: randomBytes(8).toString("base64url"),
  };
}
