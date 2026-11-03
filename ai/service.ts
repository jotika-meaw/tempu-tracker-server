import { AiError } from "./errors.js";
import {
  buildInstructions,
  buildRouteContext,
  formatLiveSummary,
  type LiveSummary,
} from "./prompt.js";
import type { AiLanguage } from "../validation.js";

export type MetaCreateParams = {
  model: string;
  instructions: string;
  input: string;
  store: false;
  max_output_tokens: number;
};

export type MetaClient = {
  create(params: MetaCreateParams): Promise<{ output_text?: string }>;
};

export type MetaAIServiceOptions = {
  client: MetaClient | null;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  timeoutMs: number;
  allowedRouteNumbers: readonly string[];
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type AskInput = {
  message: string;
  language: AiLanguage;
  liveSummary: LiveSummary;
};

export type AskResult = {
  answer: string;
  model: string;
};

const ROUTE_CONTEXT = buildRouteContext();

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function normalizeDigits(value: string): string {
  const bengali = "০১২৩৪৫৬৭৮৯";
  return [...value]
    .map((character) => {
      const index = bengali.indexOf(character);
      return index >= 0 ? String(index) : character;
    })
    .join("");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AiError(504, "AI_TIMEOUT", "The AI provider did not respond in time.", {
          retryable: true,
        })
      );
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

function retryAfterFromError(error: unknown): number | undefined {
  const candidate = error as {
    retryAfter?: unknown;
    headers?: Record<string, unknown>;
  };
  const raw =
    candidate.retryAfter ??
    candidate.headers?.["retry-after"] ??
    candidate.headers?.["Retry-After"];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(10, Math.ceil(parsed)) : undefined;
}

function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;

  const candidate = error as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const retryAfterSeconds = retryAfterFromError(error);

  if (
    name.includes("Timeout") ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new AiError(504, "AI_TIMEOUT", "The AI provider did not respond in time.", {
      retryable: true,
      retryAfterSeconds,
    });
  }

  if (status === 401 || status === 403) {
    return new AiError(
      502,
      "AI_AUTH_FAILED",
      "The AI provider rejected the server credential."
    );
  }

  if (status === 429) {
    return new AiError(429, "AI_RATE_LIMITED", "The AI provider rate limit was reached.", {
      retryable: true,
      retryAfterSeconds,
    });
  }

  if (status === 504) {
    return new AiError(504, "AI_TIMEOUT", "The AI provider timed out.", {
      retryable: true,
      retryAfterSeconds,
    });
  }

  if (status !== undefined && status >= 500) {
    return new AiError(503, "AI_UNAVAILABLE", "The AI provider is temporarily unavailable.", {
      retryable: true,
      retryAfterSeconds,
    });
  }

  if (status === 400 || status === 404 || status === 422) {
    return new AiError(
      502,
      "AI_REQUEST_REJECTED",
      "The AI provider rejected the request configuration."
    );
  }

  if (
    name.includes("Connection") ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED"
  ) {
    return new AiError(503, "AI_UNAVAILABLE", "The AI provider could not be reached.", {
      retryable: true,
      retryAfterSeconds,
    });
  }

  return new AiError(503, "AI_UNAVAILABLE", "The AI provider could not be reached.", {
    retryable: true,
    retryAfterSeconds,
  });
}

function unknownRouteMention(
  answer: string,
  allowedRouteNumbers: ReadonlySet<string>
): string | null {
  const normalized = normalizeDigits(answer);
  const pattern = /(?:রুট|route)\s*#?\s*([0-9]{1,2})/gi;

  for (const match of normalized.matchAll(pattern)) {
    const routeNumber = match[1].padStart(2, "0");
    if (allowedRouteNumbers.has(routeNumber)) continue;

    const index = match.index ?? 0;
    const context = normalized.slice(Math.max(0, index - 45), index + 80);
    const explicitlyUnavailable =
      /(নেই|নাই|absent|not available|not in|does not exist|যাচাইকৃত\s*তালিকায়\s*নেই)/i.test(
        context
      );

    if (!explicitlyUnavailable) return routeNumber;
  }

  return null;
}

export class MetaAIService {
  private readonly client: MetaClient | null;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly allowedRouteNumbers: ReadonlySet<string>;
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: MetaAIServiceOptions) {
    this.client = options.client;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.maxOutputTokens = options.maxOutputTokens;
    this.timeoutMs = options.timeoutMs;
    this.allowedRouteNumbers = new Set(options.allowedRouteNumbers);
    this.maxRetries = Math.max(0, Math.min(2, options.maxRetries ?? 2));
    this.sleep = options.sleep ?? defaultSleep;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  health(): { configured: boolean; model: string; baseUrl: string } {
    return {
      configured: this.configured,
      model: this.model,
      baseUrl: this.baseUrl,
    };
  }

  async ask(input: AskInput): Promise<AskResult> {
    if (!this.client) {
      throw new AiError(
        503,
        "AI_NOT_CONFIGURED",
        "The Meta AI service is not configured on this server."
      );
    }

    const instructions = buildInstructions(
      ROUTE_CONTEXT,
      formatLiveSummary(input.liveSummary),
      input.language
    );

    let lastError: AiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await withTimeout(
          this.client.create({
            model: this.model,
            instructions,
            input: input.message,
            store: false,
            max_output_tokens: this.maxOutputTokens,
          }),
          this.timeoutMs
        );

        return {
          answer: this.validateAnswer(response.output_text),
          model: this.model,
        };
      } catch (error) {
        const aiError = toAiError(error);
        lastError = aiError;

        if (!aiError.retryable || attempt === this.maxRetries) {
          throw aiError;
        }

        const waitMs =
          aiError.retryAfterSeconds !== undefined
            ? aiError.retryAfterSeconds * 1000
            : 400 * 2 ** attempt;
        await this.sleep(waitMs);
      }
    }

    throw lastError ?? new AiError(503, "AI_UNAVAILABLE", "The AI provider failed.");
  }

  private validateAnswer(raw: string | undefined): string {
    const answer = (raw ?? "").trim();

    if (!answer || answer.length > 6000) {
      throw new AiError(
        502,
        "AI_INVALID_RESPONSE",
        "The AI provider returned an unusable answer."
      );
    }

    const unknownRoute = unknownRouteMention(answer, this.allowedRouteNumbers);
    if (unknownRoute) {
      throw new AiError(
        502,
        "AI_INVALID_RESPONSE",
        "The AI answer mentioned a route outside the verified dataset."
      );
    }

    return answer;
  }
}
