import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OperationExecutor } from "../src/executor.js";
import { operationRegistry } from "../src/operations.js";
import type {
  ApiCallResult,
  DiagnosticEvent,
  ResolvedCredentials,
} from "../src/types.js";

const CREDENTIALS: ResolvedCredentials = {
  source: "command-profile",
  profileAlias: "production",
  appId: "fixture-app-id",
  appKey: "fixture-app-key",
  masterSecret: "fixture-master-secret",
};

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(process.cwd(), "tests", "fixtures", name), "utf8"),
  );
}

function apiResult(raw: unknown): ApiCallResult {
  return {
    raw,
    attempts: 2,
    tokenStatus: "valid",
    tokenRefreshed: true,
    diagnostics: [{ stage: "authentication", message: "Token refreshed" }],
  };
}

describe("OperationExecutor", () => {
  it("runs schema, credential, request, and normalization in order", async () => {
    const order: string[] = [];
    const raw = await fixture("today-success.json");
    const profileService = {
      resolveCredentials: vi.fn(async (alias?: string) => {
        order.push(`credentials:${alias}`);
        return CREDENTIALS;
      }),
    };
    const client = {
      call: vi.fn(async (requestPath, body) => {
        order.push("client");
        expect(requestPath).toBe("/export/todayStatistics");
        expect(body).toEqual({ foregroundFlag: "1" });
        return apiResult(raw);
      }),
    };
    const executor = new OperationExecutor({ profileService, client });

    const result = await executor.execute("statistics.today", {}, {
      profileAlias: "production",
      timeoutMs: 5000,
      debug: false,
      raw: false,
    });

    expect(order).toEqual(["credentials:production", "client"]);
    expect(result.query).toEqual({ activityScope: "foreground" });
    expect(
      (result.data as { dimensions: unknown[] }).dimensions[0],
    ).toMatchObject({ dimension: "total", install: { count: 120 } });
    expect(client.call).toHaveBeenCalledWith(
      "/export/todayStatistics",
      { foregroundFlag: "1" },
      CREDENTIALS,
      { timeoutMs: 5000, debug: false },
    );
  });

  it("passes retry policy from operation metadata and ignores caller overrides", async () => {
    const baseOperation = operationRegistry.get("statistics.today");
    if (baseOperation === null) {
      throw new Error("Missing statistics.today operation");
    }
    const operation = { ...baseOperation, retryClass: "write" as const };
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = {
      call: vi.fn(async () => apiResult(await fixture("today-success.json"))),
    };
    const executor = new OperationExecutor({
      profileService,
      client,
      registry: { get: vi.fn(() => operation) },
    });

    await executor.execute("statistics.today", {}, {
      timeoutMs: 5000,
      debug: false,
      raw: false,
      retryClass: "read",
    });

    expect(client.call).toHaveBeenCalledWith(
      "/export/todayStatistics",
      { foregroundFlag: "1" },
      CREDENTIALS,
      { timeoutMs: 5000, debug: false, retryClass: "write" },
    );
  });

  it("uses queryForOutput for both normalized and raw success envelopes", async () => {
    const baseOperation = operationRegistry.get("statistics.today");
    if (baseOperation === null) {
      throw new Error("Missing statistics.today operation");
    }
    const operation = {
      ...baseOperation,
      queryForOutput: () => ({ importType: "event", recordCount: 1 }),
    };
    const raw = await fixture("today-success.json");
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = {
      call: vi.fn(async () => apiResult(raw)),
    };
    const executor = new OperationExecutor({
      profileService,
      client,
      registry: { get: vi.fn(() => operation) },
    });

    const normalized = await executor.execute("statistics.today", {}, {
      timeoutMs: 5000,
      debug: false,
      raw: false,
    });
    const rawEnvelope = await executor.execute("statistics.today", {}, {
      timeoutMs: 5000,
      debug: false,
      raw: true,
    });

    expect(normalized.query).toEqual({ importType: "event", recordCount: 1 });
    expect(rawEnvelope.query).toEqual({ importType: "event", recordCount: 1 });
    expect(rawEnvelope.data).toEqual(raw);
  });

  it("returns stable metadata and emits diagnostics only in debug mode", async () => {
    const diagnostics: DiagnosticEvent[][] = [];
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = {
      call: vi.fn(async () => apiResult(await fixture("today-success.json"))),
    };
    const times = [1000, 1042];
    const executor = new OperationExecutor({
      profileService,
      client,
      now: () => times.shift() ?? 1042,
      onDiagnostics: (events) => diagnostics.push(events),
    });

    const result = await executor.execute("statistics.today", {}, {
      timeoutMs: 30000,
      debug: true,
      raw: false,
    });

    expect(result).toMatchObject({
      schemaVersion: "1.0",
      ok: true,
      mode: "normalized",
      operation: "statistics.today",
      meta: {
        profileAlias: "production",
        credentialSource: "command-profile",
        fetchedAt: "1970-01-01T00:00:01.042Z",
        durationMs: 42,
        attempts: 2,
      },
    });
    expect(diagnostics).toEqual([apiResult(null).diagnostics]);
  });

  it("returns a redacted raw response without running the normalizer", async () => {
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = {
      call: vi.fn(async () =>
        apiResult({
          code: 0,
          data: {
            token: "raw-token",
            appId: CREDENTIALS.appId,
            message: `for ${CREDENTIALS.appKey} with ${CREDENTIALS.masterSecret}`,
          },
        }),
      ),
    };
    const executor = new OperationExecutor({ profileService, client });

    const result = await executor.execute("statistics.today", {}, {
      timeoutMs: 30000,
      debug: false,
      raw: true,
    });

    expect(result.mode).toBe("raw");
    expect(result.data).toEqual({
      code: 0,
      data: {
        token: "[REDACTED]",
        appId: "[REDACTED]",
        message: "for [REDACTED] with [REDACTED]",
      },
    });
  });

  it("redacts credential values from normalized response text", async () => {
    const raw = await fixture("today-success.json") as {
      data: { list: Array<{ dimension: string }> };
    };
    raw.data.list[0]!.dimension = CREDENTIALS.appId;
    const executor = new OperationExecutor({
      profileService: { resolveCredentials: vi.fn(async () => CREDENTIALS) },
      client: { call: vi.fn(async () => apiResult(raw)) },
    });

    const result = await executor.execute("statistics.today", {}, {
      timeoutMs: 30000,
      debug: false,
      raw: false,
    });

    expect(JSON.stringify(result)).not.toContain(CREDENTIALS.appId);
    expect(JSON.stringify(result)).not.toContain(CREDENTIALS.appKey);
    expect(JSON.stringify(result)).not.toContain(CREDENTIALS.masterSecret);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("rejects unknown operations and invalid input before credentials", async () => {
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = { call: vi.fn() };
    const executor = new OperationExecutor({ profileService, client });

    await expect(
      executor.execute("statistics.unknown", {}, {
        timeoutMs: 30000,
        debug: false,
        raw: false,
      }),
    ).rejects.toMatchObject({
      type: "usage",
      code: "GETUI_CLI_OPERATION_UNKNOWN",
    });
    await expect(
      executor.execute("statistics.period", {}, {
        timeoutMs: 30000,
        debug: false,
        raw: false,
      }),
    ).rejects.toMatchObject({
      type: "validation",
      code: "GETUI_CLI_INPUT_INVALID",
    });
    expect(profileService.resolveCredentials).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });

  it("rejects an over-limit vector batch before credentials or network", async () => {
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = { call: vi.fn() };
    const executor = new OperationExecutor({ profileService, client });

    await expect(
      executor.execute("user.vector.batch", {
        userIdList: Array.from({ length: 51 }, (_, index) => `gtcid-${index}`),
      }, {
        timeoutMs: 30000,
        debug: false,
        raw: false,
      }),
    ).rejects.toMatchObject({
      type: "validation",
      code: "GETUI_CLI_INPUT_INVALID",
    });
    expect(profileService.resolveCredentials).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });

  it.each([
    ["statistics.today", {}, "today-success.json", "/export/todayStatistics"],
    [
      "statistics.period",
      { metric: "active" },
      "period-success.json",
      "/export/periodChart",
    ],
    [
      "statistics.activity",
      {},
      "activity-success.json",
      "/export/activityStatistics",
    ],
    [
      "statistics.userTrend",
      { startDate: "2026-08-01", endDate: "2026-08-07", metric: "active" },
      "trend-success.json",
      "/export/userTrendChart",
    ],
    [
      "statistics.retention",
      { startDate: "2026-07-01", endDate: "2026-07-31", metric: "new" },
      "retention-success.json",
      "/export/remainChart",
    ],
  ])("runs %s through credentials, client, and normalization", async (
    operationName,
    input,
    fixtureName,
    expectedPath,
  ) => {
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = {
      call: vi.fn(async () => apiResult(await fixture(fixtureName))),
    };
    const executor = new OperationExecutor({ profileService, client });

    const result = await executor.execute(operationName, input, {
      timeoutMs: 30000,
      debug: false,
      raw: false,
    });

    expect(result.operation).toBe(operationName);
    expect(result.mode).toBe("normalized");
    expect(profileService.resolveCredentials).toHaveBeenCalledTimes(1);
    expect(client.call).toHaveBeenCalledWith(
      expectedPath,
      expect.any(Object),
      CREDENTIALS,
      expect.any(Object),
    );
  });

  it("routes auth.token to authenticate without calling protected call", async () => {
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = {
      call: vi.fn(),
      authenticate: vi.fn(async () =>
        apiResult({
          code: 0,
          msg: "成功",
          data: { token: "auth-secret", expireTime: 1_786_010_800_000 },
        }),
      ),
    };
    const executor = new OperationExecutor({ profileService, client });

    const result = await executor.execute(
      "auth.token",
      { force: true },
      { timeoutMs: 30000, debug: false, raw: false },
    );

    expect(client.call).not.toHaveBeenCalled();
    expect(client.authenticate).toHaveBeenCalledWith(
      CREDENTIALS,
      { timeoutMs: 30000, debug: false, force: true },
    );
    expect(result.data).toEqual({
      code: 0,
      msg: "成功",
      data: {
        tokenStatus: "valid",
        expiresAt: 1_786_010_800_000,
        refreshed: true,
      },
    });
  });

  it("blocks mutating operations before credentials or client access", async () => {
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = { call: vi.fn() };
    const executor = new OperationExecutor({ profileService, client });

    await expect(
      executor.execute(
        "tag.external.trigger",
        { tagCodeList: ["tag-1"] },
        { timeoutMs: 30000, debug: false, raw: false },
      ),
    ).rejects.toMatchObject({
      type: "usage",
      code: "GETUI_CLI_CONFIRMATION_REQUIRED",
    });
    expect(profileService.resolveCredentials).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });

  it("executes a confirmed tag mutation", async () => {
    const profileService = {
      resolveCredentials: vi.fn(async () => CREDENTIALS),
    };
    const client = {
      call: vi.fn(async () =>
        apiResult({ code: 0, msg: "成功" }),
      ),
    };
    const executor = new OperationExecutor({ profileService, client });

    const result = await executor.execute(
      "tag.external.trigger",
      { tagCodeList: ["tag-1"] },
      {
        timeoutMs: 30000,
        debug: false,
        raw: false,
        confirmMutations: true,
      },
    );

    expect(client.call).toHaveBeenCalledWith(
      "/externalTag/trigger",
      { tagCodeList: ["tag-1"] },
      CREDENTIALS,
      { timeoutMs: 30000, debug: false },
    );
    expect(result.data).toEqual({ code: 0, msg: "成功", data: null });
  });
});
