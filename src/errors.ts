import type {
  ErrorEnvelope,
  ErrorStage,
  ErrorType,
} from "./types.js";

const EXIT_CODES: Record<ErrorType, number> = {
  usage: 2,
  validation: 2,
  configuration: 3,
  credentials: 3,
  authentication: 4,
  permission: 5,
  network: 6,
  remote: 7,
  internal: 8,
};

export interface CliErrorOptions {
  type: ErrorType;
  code: string;
  stage: ErrorStage;
  retryable?: boolean | undefined;
  details?: Record<string, unknown> | undefined;
  cause?: unknown;
}

export class CliError extends Error {
  readonly type: ErrorType;
  readonly code: string;
  readonly stage: ErrorStage;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown> | undefined;

  constructor(message: string, options: CliErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "CliError";
    this.type = options.type;
    this.code = options.code;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.type];
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  return new CliError("Unexpected CLI failure", {
    type: "internal",
    code: "GETUI_CLI_INTERNAL_ERROR",
    stage: "internal",
    cause: error,
  });
}

export function createErrorEnvelope(
  error: CliError,
  operation?: string,
): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    schemaVersion: "1.0",
    ok: false,
    error: {
      type: error.type,
      code: error.code,
      message: error.message,
      stage: error.stage,
      retryable: error.retryable,
    },
    meta: {
      occurredAt: new Date().toISOString(),
    },
  };

  if (error.details !== undefined) {
    envelope.error.details = error.details;
  }
  if (operation !== undefined) {
    envelope.meta.operation = operation;
  }

  return envelope;
}
