export class AiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryAfterSeconds?: number; retryable?: boolean } = {}
  ) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.retryable = options.retryable ?? false;
  }
}
