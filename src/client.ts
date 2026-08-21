import { createHash } from "node:crypto";
import { CliError } from "./errors.js";
import type { ProfileService } from "./profile.js";
import type {
  ApiCallResult,
  DiagnosticEvent,
  ErrorStage,
  RequestOptions,
  RetryClass,
  ResolvedCredentials,
  TokenRecord,
} from "./types.js";

const BASE_URL = "https://ido.getui.com/openapi";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REMOTE_RESPONSE_BYTES = 64 * 1024;

const PROTECTED_PATHS = new Set([
  "/export/todayStatistics",
  "/export/periodChart",
  "/export/activityStatistics",
  "/export/userTrendChart",
  "/export/remainChart",
  "/query_tag",
  "/query_tag_tree",
  "/externalTag/add",
  "/externalTag/edit",
  "/externalTag/tagVal/data/import",
  "/externalTag/trigger",
  "/import/event",
  "/import/user",
  "/export/crowd/exportableCrowdList",
  "/export/crowd/createCrowdExportTask",
  "/export/crowd/exportCrowdTaskStatus",
  "/export/crowd/exportCrowdSingleFile",
  "/v2/query_vector",
  "/v2/batch_query_vector",
]);

const WRITE_PATHS = new Set([
  "/import/event",
  "/import/user",
  "/export/crowd/createCrowdExportTask",
]);

// Authentication refreshes have their own retry budget.  They must not inherit
// the single-attempt budget used by non-idempotent write operations.
type AttemptClass = RetryClass | "auth";

type FetchLike = typeof fetch;

export interface GetuiClientOptions {
  profileService: ProfileService;
  fetch?: FetchLike | undefined;
  now?: (() => number) | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
}

interface RequestResult {
  body: unknown;
  attempts: number;
}

interface TokenResult {
  record: TokenRecord;
  attempts: number;
  refreshed: boolean;
  raw?: unknown;
}

interface RemoteResponseDetails {
  remoteResponse?: unknown;
  remoteResponseTruncated?: true;
}

interface ReadResponseBodyResult {
  text: string;
  safeText: string;
  details: RemoteResponseDetails;
}

export class GetuiClient {
  private readonly profileService: ProfileService;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: GetuiClientOptions) {
    this.profileService = options.profileService;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  async call(
    path: string,
    body: Record<string, unknown>,
    credentials: ResolvedCredentials,
    options: RequestOptions,
  ): Promise<ApiCallResult> {
    if (!PROTECTED_PATHS.has(path)) {
      throw new CliError("Operation path is not allowed", {
        type: "usage",
        code: "GETUI_CLI_OPERATION_PATH_INVALID",
        stage: "input",
      });
    }

    const diagnostics: DiagnosticEvent[] = [];
    const tokenResult = await this.getValidToken(credentials, options, diagnostics);
    let attempts = tokenResult.attempts;
    let refreshed = tokenResult.refreshed;
    let activeToken = tokenResult.record;
    const sensitiveValues = [
      credentials.appId,
      credentials.appKey,
      credentials.masterSecret,
    ];
    let replayed = false;

    let request: RequestResult;
    try {
      request = await this.callProtected(
        path,
        body,
        credentials.appId,
        activeToken.token,
        options,
        diagnostics,
        [...sensitiveValues, activeToken.token],
      );
    } catch (error) {
      if (!isTokenInvalidHttpError(error)) {
        throw error;
      }
      replayed = true;
      diagnostics.push({
        stage: "authentication",
        message: "HTTP token rejection; forcing one refresh",
      });
      const forced = await this.refreshToken(
        credentials,
        options,
        diagnostics,
        activeToken.token,
      );
      attempts += forced.attempts;
      refreshed = true;
      activeToken = forced.record;
      try {
        request = await this.callProtected(
          path,
          body,
          credentials.appId,
          activeToken.token,
          options,
          diagnostics,
          [...sensitiveValues, activeToken.token],
        );
      } catch (replayError) {
        if (isTokenInvalidHttpError(replayError)) {
          throw tokenRejectedHttpError(replayError, [
            ...sensitiveValues,
            activeToken.token,
          ]);
        }
        throw replayError;
      }
    }
    attempts += request.attempts;

    if (isTokenInvalidBusiness(request.body)) {
      if (replayed) {
        throw tokenRejectedError(request.body, sensitiveValues);
      }
      replayed = true;
      diagnostics.push({
        stage: "authentication",
        message: "Token rejected; forcing one refresh",
      });
      const forced = await this.refreshToken(
        credentials,
        options,
        diagnostics,
        activeToken.token,
      );
      attempts += forced.attempts;
      refreshed = true;
      activeToken = forced.record;
      try {
        // The refreshed token gets one business replay. A second HTTP token
        // rejection is terminal and must not start another refresh cycle.
        request = await this.callProtected(
          path,
          body,
          credentials.appId,
          activeToken.token,
          options,
          diagnostics,
          [...sensitiveValues, activeToken.token],
        );
      } catch (replayError) {
        if (isTokenInvalidHttpError(replayError)) {
          throw tokenRejectedHttpError(replayError, [
            ...sensitiveValues,
            activeToken.token,
          ]);
        }
        throw replayError;
      }
      attempts += request.attempts;
      if (isTokenInvalidBusiness(request.body)) {
        throw tokenRejectedError(request.body, [
          ...sensitiveValues,
          activeToken.token,
        ]);
      }
    }

    assertBusinessSuccess(request.body, "response", [
      ...sensitiveValues,
      activeToken.token,
    ]);
    return {
      raw: request.body,
      attempts,
      tokenStatus: activeToken.status,
      tokenRefreshed: refreshed,
      tokenExpiresAt: activeToken.expiresAt,
      diagnostics,
    };
  }

  async authenticate(
    credentials: ResolvedCredentials,
    options: RequestOptions & { force?: boolean },
  ): Promise<ApiCallResult> {
    const diagnostics: DiagnosticEvent[] = [];
    const tokenResult = options.force
      ? await this.refreshToken(credentials, options, diagnostics, undefined, true)
      : await this.getValidToken(credentials, options, diagnostics);
    const raw =
      tokenResult.raw ??
      ({
        code: 0,
        msg: "Using cached token",
        data: {
          token: tokenResult.record.token,
          expireTime: tokenResult.record.expiresAt,
        },
      } satisfies Record<string, unknown>);
    return {
      raw,
      attempts: tokenResult.attempts,
      tokenStatus: tokenResult.record.status,
      tokenRefreshed: tokenResult.refreshed,
      tokenExpiresAt: tokenResult.record.expiresAt,
      diagnostics,
    };
  }

  private async getValidToken(
    credentials: ResolvedCredentials,
    options: RequestOptions,
    diagnostics: DiagnosticEvent[],
  ): Promise<TokenResult> {
    const existing = await this.profileService.getToken(credentials.appId);
    const now = this.now();
    if (existing !== null && existing.expiresAt - now > REFRESH_WINDOW_MS) {
      diagnostics.push({
        stage: "authentication",
        message: "Using cached token",
      });
      return { record: existing, attempts: 0, refreshed: false };
    }

    if (existing !== null && existing.expiresAt > now) {
      try {
        return await this.refreshToken(
          credentials,
          options,
          diagnostics,
        );
      } catch (error) {
        if (isRetryableError(error)) {
          diagnostics.push({
            stage: "authentication",
            message: "Proactive refresh failed; using still-valid token",
          });
          return { record: existing, attempts: 0, refreshed: false };
        }
        throw error;
      }
    }

    try {
      return await this.refreshToken(credentials, options, diagnostics);
    } catch (error) {
      if (existing !== null && existing.expiresAt <= now) {
        throw new CliError("Expired token could not be refreshed", {
          type: "authentication",
          code: "GETUI_CLI_TOKEN_REFRESH_FAILED",
          stage: "authentication",
          retryable: isRetryableError(error),
          cause: error,
        });
      }
      throw error;
    }
  }

  private async refreshToken(
    credentials: ResolvedCredentials,
    options: RequestOptions,
    diagnostics: DiagnosticEvent[],
    invalidToken?: string,
    force = false,
  ): Promise<TokenResult> {
    return this.profileService.withApplicationLock(
      credentials.appId,
      async () => {
        const cached = await this.profileService.getToken(credentials.appId);
        const now = this.now();
        if (
          cached !== null &&
          cached.expiresAt > now &&
          (!force && invalidToken === undefined
            ? cached.expiresAt - now > REFRESH_WINDOW_MS
            : !force && cached.token !== invalidToken)
        ) {
          return { record: cached, attempts: 0, refreshed: false };
        }

        if (invalidToken !== undefined) {
          await this.profileService.deleteToken(credentials.appId);
        }
        const auth = await this.createToken(credentials, options, diagnostics);
        const record = await this.profileService.setToken(
          credentials.appId,
          auth.token,
          auth.expiresAt,
        );
        diagnostics.push({
          stage: "authentication",
          message: "Token refreshed",
        });
        return {
          record,
          attempts: auth.attempts,
          refreshed: true,
          raw: auth.raw,
        };
      },
    );
  }

  private async createToken(
    credentials: ResolvedCredentials,
    options: RequestOptions,
    diagnostics: DiagnosticEvent[],
  ): Promise<{ token: string; expiresAt: number; attempts: number; raw: unknown }> {
    const timestamp = this.now();
    const sign = createAuthSign(
      credentials.appKey,
      timestamp,
      credentials.masterSecret,
    );
    const result = await this.requestJson(
      `${BASE_URL}/${encodeURIComponent(credentials.appId)}/auth`,
      { appkey: credentials.appKey, sign, timestamp },
      options,
      diagnostics,
      {},
      [credentials.appId, credentials.appKey, credentials.masterSecret, sign],
      "auth",
    );
    assertBusinessSuccess(result.body, "authentication", [
      credentials.appId,
      credentials.appKey,
      credentials.masterSecret,
      sign,
    ]);

    const authSensitiveValues = [
      credentials.appId,
      credentials.appKey,
      credentials.masterSecret,
      sign,
    ];
    const root = asObject(
      result.body,
      "authentication response",
      authSensitiveValues,
      "authentication",
    );
    const data = asObject(
      root.data,
      "authentication data",
      authSensitiveValues,
      "authentication",
    );
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw invalidAuthResponse("data.token", result.body, authSensitiveValues);
    }
    const expiresAt = parseFiniteNumber(data.expireTime);
    if (expiresAt === null || expiresAt <= this.now()) {
      throw invalidAuthResponse(
        "data.expireTime",
        result.body,
        authSensitiveValues,
      );
    }
    return {
      token: data.token,
      expiresAt,
      attempts: result.attempts,
      raw: result.body,
    };
  }

  private async callProtected(
    path: string,
    body: Record<string, unknown>,
    appId: string,
    token: string,
    options: RequestOptions,
    diagnostics: DiagnosticEvent[],
    sensitiveValues: string[],
  ): Promise<RequestResult> {
    const retryClass = options.retryClass ??
      (WRITE_PATHS.has(path) ? "write" : "read");
    return this.requestJson(
      `${BASE_URL}/${encodeURIComponent(appId)}${path}`,
      body,
      options,
      diagnostics,
      { token },
      sensitiveValues,
      retryClass,
    );
  }

  private async requestJson(
    url: string,
    body: Record<string, unknown>,
    options: RequestOptions,
    diagnostics: DiagnosticEvent[],
    headers: Record<string, string> = {},
    sensitiveValues: string[] = [],
    attemptClass: AttemptClass = "read",
  ): Promise<RequestResult> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs, 1), MAX_TIMEOUT_MS);
    const maxAttempts = attemptClass === "write" ? 1 : 3;
    const markUnknownOutcome = attemptClass === "write";
    let lastError: CliError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = this.now();
      try {
        const response = await this.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json;charset=utf-8",
            ...headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const durationMs = Math.max(0, this.now() - startedAt);
        diagnostics.push({
          stage: "request",
          message: `HTTP ${response.status}`,
          attempt,
          durationMs,
        });

        const responseBody = await readResponseBody(response, !response.ok);

        if (response.status === 429 || response.status >= 500) {
          const error = httpStatusError(
            response.status,
            responseBody.details,
            sensitiveValues,
            markUnknownOutcome,
          );
          if (attempt < maxAttempts) {
            await this.waitBeforeRetry(attempt, response.headers.get("retry-after"));
            lastError = error;
            continue;
          }
          throw error;
        }
        if (!response.ok) {
          throw httpStatusError(
            response.status,
            responseBody.details,
            sensitiveValues,
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(responseBody.text);
        } catch (error) {
          throw new CliError("Getui returned invalid JSON", {
            type: "remote",
            code: "GETUI_CLI_REMOTE_JSON_INVALID",
            stage: "response",
            details: {
              ...responseBody.details,
              remoteResponse: sanitizeRemoteValue(
                responseBody.safeText,
                sensitiveValues,
              ),
            },
            cause: error,
          });
        }
        return { body: parsed, attempts: attempt };
      } catch (error) {
        const cliError = requestError(
          error,
          controller.signal.aborted,
          markUnknownOutcome,
        );
        if (cliError.retryable && attempt < maxAttempts) {
          lastError = cliError;
          await this.waitBeforeRetry(attempt, null);
          continue;
        }
        throw cliError;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw (
      lastError ??
      new CliError("Request failed", {
        type: "network",
        code: "GETUI_CLI_NETWORK_ERROR",
        stage: "request",
        retryable: true,
      })
    );
  }

  private async waitBeforeRetry(
    attempt: number,
    retryAfter: string | null,
  ): Promise<void> {
    const retryAfterMs = parseRetryAfter(retryAfter, this.now());
    const baseDelay = attempt === 1 ? 250 : 1000;
    const jitter = 0.8 + this.random() * 0.4;
    await this.sleep(
      retryAfterMs === null
        ? Math.round(baseDelay * jitter)
        : Math.min(retryAfterMs, 5000),
    );
  }
}

export function createAuthSign(
  appKey: string,
  timestamp: number,
  masterSecret: string,
): string {
  return createHash("sha256")
    .update(`${appKey}${timestamp}${masterSecret}`)
    .digest("hex");
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function requestError(
  error: unknown,
  aborted: boolean,
  markUnknownOutcome = false,
): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (aborted) {
    return new CliError("Getui request timed out", {
      type: "network",
      code: "GETUI_CLI_REQUEST_TIMEOUT",
      stage: "request",
      retryable: true,
      details: markUnknownOutcome ? { outcomeUnknown: true } : undefined,
      cause: error,
    });
  }
  return new CliError("Getui network request failed", {
    type: "network",
    code: "GETUI_CLI_NETWORK_ERROR",
    stage: "request",
    retryable: true,
    details: markUnknownOutcome ? { outcomeUnknown: true } : undefined,
    cause: error,
  });
}

function httpStatusError(
  status: number,
  response: RemoteResponseDetails = {},
  sensitiveValues: string[] = [],
  markUnknownOutcome = false,
): CliError {
  const details = sanitizeRemoteDetails(
    {
      status,
      ...response,
      ...(markUnknownOutcome && (status === 429 || status >= 500)
        ? { outcomeUnknown: true }
        : {}),
    },
    sensitiveValues,
  );
  if (status === 401) {
    return new CliError("Getui authentication failed", {
      type: "authentication",
      code: "GETUI_CLI_HTTP_UNAUTHORIZED",
      stage: "authentication",
      details,
    });
  }
  if (status === 403) {
    return new CliError("Getui permission denied", {
      type: "permission",
      code: "GETUI_CLI_HTTP_FORBIDDEN",
      stage: "request",
      details,
    });
  }
  if (status === 429) {
    return new CliError("Getui rate limit exceeded", {
      type: "network",
      code: "GETUI_CLI_RATE_LIMITED",
      stage: "request",
      retryable: true,
      details,
    });
  }
  if (status >= 500) {
    return new CliError(`Getui server returned HTTP ${status}`, {
      type: "remote",
      code: "GETUI_CLI_REMOTE_SERVER_ERROR",
      stage: "response",
      retryable: true,
      details,
    });
  }
  return new CliError(`Getui request failed with HTTP ${status}`, {
    type: "remote",
    code: "GETUI_CLI_REMOTE_HTTP_ERROR",
    stage: "response",
    details,
  });
}

async function readResponseBody(
  response: Response,
  limitDetails: boolean,
): Promise<ReadResponseBodyResult> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { text: "", safeText: "", details: {} };
  }

  const bytes = Buffer.from(text, "utf8");
  if (limitDetails && bytes.length > MAX_REMOTE_RESPONSE_BYTES) {
    const truncated = safeUtf8Prefix(bytes, MAX_REMOTE_RESPONSE_BYTES);
    return {
      text,
      safeText: truncated,
      details: {
        remoteResponse: truncated,
        remoteResponseTruncated: true,
      },
    };
  }
  if (text.length === 0) {
    return { text, safeText: text, details: {} };
  }
  try {
    return {
      text,
      safeText: text,
      details: { remoteResponse: JSON.parse(text) },
    };
  } catch {
    const safeText = bytes.length > MAX_REMOTE_RESPONSE_BYTES
      ? safeUtf8Prefix(bytes, MAX_REMOTE_RESPONSE_BYTES)
      : text;
    return { text, safeText, details: { remoteResponse: safeText, ...(bytes.length > MAX_REMOTE_RESPONSE_BYTES ? { remoteResponseTruncated: true } : {}) } };
  }
}

function safeUtf8Prefix(bytes: Buffer, maximumBytes: number): string {
  let end = Math.min(bytes.length, maximumBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function assertBusinessSuccess(
  body: unknown,
  stage: "authentication" | "response" = "response",
  sensitiveValues: string[] = [],
): void {
  const code = businessCode(body);
  if (code === 0) {
    return;
  }
  const root = asObject(body, "response", sensitiveValues, stage);
  const message = sanitizeRemoteMessage(
    typeof root.msg === "string" ? root.msg : "Getui request failed",
    sensitiveValues,
  );
  if (code === 10001) {
    throw new CliError(message, {
      type: "authentication",
      code: "GETUI_CLI_TOKEN_INVALID",
      stage: "authentication",
      details: {
        remoteCode: code,
        remoteResponse: sanitizeRemoteValue(body, sensitiveValues),
      },
    });
  }
  if (code === 10002) {
    throw new CliError(message, {
      type: "authentication",
      code: "GETUI_CLI_TOKEN_INVALID",
      stage: "authentication",
      details: {
        remoteCode: code,
        remoteResponse: sanitizeRemoteValue(body, sensitiveValues),
      },
    });
  }
  if (/vip|白名单|whitelist|permission|权限/i.test(message)) {
    throw new CliError(message, {
      type: "permission",
      code: "GETUI_CLI_PERMISSION_DENIED",
      stage,
      details: {
        remoteCode: code,
        remoteResponse: sanitizeRemoteValue(body, sensitiveValues),
      },
    });
  }
  throw new CliError(message, {
    type: "remote",
    code: "GETUI_CLI_REMOTE_BUSINESS_ERROR",
    stage,
    details: {
      remoteCode: code,
      remoteResponse: sanitizeRemoteValue(body, sensitiveValues),
    },
  });
}

function sanitizeRemoteMessage(
  message: string,
  sensitiveValues: string[],
): string {
  let safe = message;
  for (const value of sensitiveValues) {
    if (value.length > 0) {
      safe = safe.split(value).join("[REDACTED]");
    }
  }
  return safe;
}

const SENSITIVE_RESPONSE_KEYS = new Set([
  "mastersecret",
  "master_secret",
  "sign",
  "signature",
  "token",
  "access_token",
  "accesstoken",
  "authorization",
  "appid",
  "appkey",
]);

function sanitizeRemoteValue(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === "string") {
    return sanitizeRemoteMessage(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRemoteValue(item, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "_");
      result[key] = SENSITIVE_RESPONSE_KEYS.has(normalizedKey)
        ? "[REDACTED]"
        : sanitizeRemoteValue(child, sensitiveValues);
    }
    return result;
  }
  return value;
}

function sanitizeRemoteDetails(
  details: Record<string, unknown>,
  sensitiveValues: string[],
): Record<string, unknown> {
  return sanitizeRemoteValue(details, sensitiveValues) as Record<string, unknown>;
}

function isTokenInvalidBusiness(body: unknown): boolean {
  const code = businessCode(body);
  return code === 10001 || code === 10002;
}

function isTokenInvalidHttpError(error: unknown): boolean {
  if (!(error instanceof CliError) || error.code !== "GETUI_CLI_HTTP_UNAUTHORIZED") {
    return false;
  }
  const details = error.details;
  if (details === undefined) {
    return false;
  }
  const remote = details.remoteResponse;
  return isTokenInvalidMarker(remote);
}

/**
 * A 401 response is recoverable only when the remote body identifies a token
 * failure.  This keeps unrelated authorization failures (for example an IP
 * restriction) from causing a needless token refresh.
 */
function isTokenInvalidMarker(value: unknown): boolean {
  if (isTokenInvalidBusiness(value)) {
    return true;
  }
  if (typeof value === "string") {
    return tokenInvalidText(value);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const object = value as Record<string, unknown>;
  const candidates = [object.msg, object.message, object.error, object.reason];
  return candidates.some((candidate) =>
    typeof candidate === "string" && tokenInvalidText(candidate),
  );
}

function tokenInvalidText(value: string): boolean {
  return /(?:(?:token|令牌|凭证).*?(?:invalid|expire|expired|unauthori[sz]ed|失效|过期|无效)|(?:invalid|expire|expired|unauthori[sz]ed|失效|过期|无效).*?(?:token|令牌|凭证))/i.test(
    value,
  );
}

function tokenRejectedHttpError(
  error: unknown,
  sensitiveValues: string[],
): CliError {
  const original = error instanceof CliError ? error : undefined;
  const details = original?.details === undefined
    ? undefined
    : sanitizeRemoteDetails(original.details, sensitiveValues);
  return new CliError(
    sanitizeRemoteMessage(
      original?.message ?? "Getui rejected the refreshed token",
      sensitiveValues,
    ),
    {
      type: "authentication",
      code: "GETUI_CLI_TOKEN_REJECTED",
      stage: "authentication",
      details,
      cause: error,
    },
  );
}

function tokenRejectedError(
  body: unknown,
  sensitiveValues: string[],
): CliError {
  const root = body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const message = sanitizeRemoteMessage(
    typeof root.msg === "string" ? root.msg : "Getui rejected the refreshed token",
    sensitiveValues,
  );
  return new CliError(message, {
    type: "authentication",
    code: "GETUI_CLI_TOKEN_REJECTED",
    stage: "authentication",
    details: {
      remoteCode: businessCode(body),
      remoteResponse: sanitizeRemoteValue(body, sensitiveValues),
    },
  });
}

function businessCode(body: unknown): number | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  return parseFiniteNumber((body as Record<string, unknown>).code);
}

function asObject(
  value: unknown,
  field: string,
  sensitiveValues: string[] = [],
  stage: ErrorStage = "response",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`Getui ${field} is invalid`, {
      type: "remote",
      code: "GETUI_CLI_RESPONSE_INVALID",
      stage,
      details: {
        field,
        remoteResponse: sanitizeRemoteValue(value, sensitiveValues),
      },
    });
  }
  return value as Record<string, unknown>;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function invalidAuthResponse(
  field: string,
  body?: unknown,
  sensitiveValues: string[] = [],
): CliError {
  return new CliError(`Getui authentication field is invalid: ${field}`, {
    type: "remote",
    code: "GETUI_CLI_AUTH_RESPONSE_INVALID",
    stage: "authentication",
    details: {
      field,
      ...(body === undefined
        ? {}
        : { remoteResponse: sanitizeRemoteValue(body, sensitiveValues) }),
    },
  });
}

function isRetryableError(error: unknown): boolean {
  return error instanceof CliError && error.retryable;
}
