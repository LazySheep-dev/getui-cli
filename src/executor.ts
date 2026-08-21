import { ZodError } from "zod";
import type { GetuiClient } from "./client.js";
import { CliError } from "./errors.js";
import { operationRegistry } from "./operations.js";
import { redact } from "./output.js";
import type { ProfileService } from "./profile.js";
import type {
  DiagnosticEvent,
  ExecutionOptions,
  OperationDefinition,
  SuccessEnvelope,
} from "./types.js";

interface OperationRegistryLike {
  get(name: string): OperationDefinition<unknown, unknown> | null;
}

export interface OperationExecutorOptions {
  profileService: Pick<ProfileService, "resolveCredentials">;
  client: Pick<GetuiClient, "call"> &
    Partial<Pick<GetuiClient, "authenticate">>;
  registry?: OperationRegistryLike | undefined;
  now?: (() => number) | undefined;
  onDiagnostics?: ((events: DiagnosticEvent[]) => void) | undefined;
}

export class OperationExecutor {
  private readonly profileService: Pick<ProfileService, "resolveCredentials">;
  private readonly client: Pick<GetuiClient, "call"> &
    Partial<Pick<GetuiClient, "authenticate">>;
  private readonly registry: OperationRegistryLike;
  private readonly now: () => number;
  private readonly onDiagnostics?: ((events: DiagnosticEvent[]) => void) | undefined;

  constructor(options: OperationExecutorOptions) {
    this.profileService = options.profileService;
    this.client = options.client;
    this.registry = options.registry ?? operationRegistry;
    this.now = options.now ?? Date.now;
    this.onDiagnostics = options.onDiagnostics;
  }

  async execute(
    operationName: string,
    input: unknown,
    options: ExecutionOptions,
  ): Promise<SuccessEnvelope<unknown>> {
    const startedAt = this.now();
    const operation = this.registry.get(operationName);
    if (operation === null) {
      throw new CliError(`Unknown operation: ${operationName}`, {
        type: "usage",
        code: "GETUI_CLI_OPERATION_UNKNOWN",
        stage: "input",
      });
    }

    const query = parseInput(operation, input);
    if (operation.mutating && options.confirmMutations !== true) {
      throw new CliError(
        "This operation changes Getui data; pass --yes to confirm",
        {
          type: "usage",
          code: "GETUI_CLI_CONFIRMATION_REQUIRED",
          stage: "input",
        },
      );
    }
    const credentials = await this.profileService.resolveCredentials(
      options.profileAlias,
    );
    const request = operation.buildRequest(query);
    let result;
    if (operation.kind === "authentication") {
      if (this.client.authenticate === undefined) {
        throw new CliError("Authentication execution is unavailable", {
          type: "internal",
          code: "GETUI_CLI_AUTH_EXECUTOR_UNAVAILABLE",
          stage: "authentication",
        });
      }
      const authInput = query as { force?: boolean };
      result = await this.client.authenticate(credentials, {
        timeoutMs: options.timeoutMs,
        debug: options.debug,
        force: authInput.force === true,
      });
    } else {
      // Retry policy is operation metadata, never caller-controlled input.
      const requestOptions = {
        timeoutMs: options.timeoutMs,
        debug: options.debug,
        ...(operation.retryClass === undefined
          ? {}
          : { retryClass: operation.retryClass }),
      };
      result = await this.client.call(
        operation.path,
        request,
        credentials,
        requestOptions,
      );
    }

    if (options.debug) {
      this.onDiagnostics?.(result.diagnostics);
    }

    const completedAt = this.now();
    const sensitiveValues = [
      credentials.masterSecret,
      credentials.appId,
      credentials.appKey,
    ];
    const data = options.raw
      ? result.raw
      : operation.normalizeResponse(result.raw, query, {
          tokenStatus: result.tokenStatus,
          tokenRefreshed: result.tokenRefreshed,
          tokenExpiresAt: result.tokenExpiresAt,
        });

    const outputQuery = operation.queryForOutput === undefined
      ? query as Record<string, unknown>
      : operation.queryForOutput(query);
    const envelope: SuccessEnvelope<unknown> = {
      schemaVersion: "1.0",
      ok: true,
      mode: options.raw ? "raw" : "normalized",
      operation: operation.name,
      query: outputQuery,
      data,
      meta: {
        credentialSource: credentials.source,
        fetchedAt: new Date(completedAt).toISOString(),
        durationMs: Math.max(0, completedAt - startedAt),
        attempts: result.attempts,
      },
    };
    if (credentials.profileAlias !== undefined) {
      envelope.meta.profileAlias = credentials.profileAlias;
    }
    return redact(envelope, sensitiveValues) as SuccessEnvelope<unknown>;
  }
}

function parseInput(
  operation: OperationDefinition<unknown, unknown>,
  input: unknown,
): unknown {
  try {
    return operation.inputSchema.parse(input);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if (error instanceof ZodError) {
      throw new CliError("Operation input is invalid", {
        type: "validation",
        code: "GETUI_CLI_INPUT_INVALID",
        stage: "input",
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        cause: error,
      });
    }
    throw error;
  }
}
