import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthSign, GetuiClient } from "../src/client.js";
import { renderDiagnostics, renderError } from "../src/output.js";
import {
  MemorySecretStore,
  ProfileService,
} from "../src/profile.js";
import type { ResolvedCredentials } from "../src/types.js";

const NOW = 1_786_000_000_000;
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function credentials(appId = "fixture-app-id"): ResolvedCredentials {
  return {
    source: "environment",
    appId,
    appKey: `key-${appId}`,
    masterSecret: `secret-${appId}`,
  };
}

async function profileService(available = true): Promise<ProfileService> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-client-"));
  tempDirectories.push(baseDir);
  return new ProfileService({
    baseDir,
    secretStore: new MemorySecretStore(available),
    now: () => new Date(NOW),
    env: {},
  });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function authSuccess(token = "new-token"): Response {
  return jsonResponse({
    code: 0,
    msg: "success",
    data: { token, expireTime: NOW + 2 * 60 * 60 * 1000 },
  });
}

function businessSuccess(): Response {
  return jsonResponse({ code: 0, msg: "success", data: { list: [] } });
}

type QueuedFetchItem =
  | Response
  | Error
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>);

class FetchQueue {
  readonly calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  private readonly items: QueuedFetchItem[];

  constructor(items: QueuedFetchItem[]) {
    this.items = [...items];
  }

  readonly fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      this.calls.push(init === undefined ? { input } : { input, init });
      const item = this.items.shift();
      if (item === undefined) {
        throw new Error("Unexpected fetch call");
      }
      if (item instanceof Error) {
        throw item;
      }
      if (typeof item === "function") {
        return item(input, init);
      }
      return item;
    },
  );
}

function createClient(
  profile: ProfileService,
  queue: FetchQueue,
  sleep = vi.fn(async (_milliseconds: number) => undefined),
): GetuiClient {
  return new GetuiClient({
    profileService: profile,
    fetch: queue.fetch as typeof fetch,
    now: () => NOW,
    sleep,
    random: () => 0.5,
  });
}

describe("authentication", () => {
  it("creates the documented SHA-256 sign", () => {
    expect(createAuthSign("app-key", 1_786_000_000_000, "master-secret")).toBe(
      "dbc06ce42bf7cb266477b4030c236e70be2de5903c6ecb4ccfb492bf7e2c1e59",
    );
  });

  it("authenticates once and reuses a cached token", async () => {
    const profile = await profileService();
    const queue = new FetchQueue([
      authSuccess("cached-token"),
      businessSuccess(),
      businessSuccess(),
    ]);
    const client = createClient(profile, queue);

    await client.call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    await client.call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );

    expect(queue.calls.filter((call) => String(call.input).endsWith("/auth")))
      .toHaveLength(1);
    expect(queue.calls[1]?.init?.headers).toMatchObject({ token: "cached-token" });
    expect(queue.calls[2]?.init?.headers).toMatchObject({ token: "cached-token" });
  });

  it("refreshes a token inside the five-minute window", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "old-token", NOW + 4 * 60 * 1000);
    const queue = new FetchQueue([authSuccess("fresh-token"), businessSuccess()]);
    const result = await createClient(profile, queue).call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    expect(result.tokenRefreshed).toBe(true);
    expect(queue.calls[1]?.init?.headers).toMatchObject({ token: "fresh-token" });
  });

  it("falls back to a still-valid token after a transient proactive refresh failure", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "old-token", NOW + 4 * 60 * 1000);
    const queue = new FetchQueue([
      new Error("offline"),
      new Error("offline"),
      new Error("offline"),
      businessSuccess(),
    ]);
    const result = await createClient(profile, queue).call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: true },
    );
    expect(result.tokenRefreshed).toBe(false);
    expect(queue.calls[3]?.init?.headers).toMatchObject({ token: "old-token" });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("still-valid") }),
    );
  });

  it("does not send a statistics request when an expired token cannot refresh", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "expired-token", NOW - 1);
    const queue = new FetchQueue([
      new Error("offline"),
      new Error("offline"),
      new Error("offline"),
    ]);

    await expect(
      createClient(profile, queue).call(
        "/export/todayStatistics",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({
      type: "authentication",
      code: "GETUI_CLI_TOKEN_REFRESH_FAILED",
      retryable: true,
    });
    expect(queue.calls).toHaveLength(3);
    expect(queue.calls.every((call) => String(call.input).endsWith("/auth"))).toBe(true);
  });

  it("uses process memory when secure storage is unavailable", async () => {
    const profile = await profileService(false);
    const queue = new FetchQueue([
      authSuccess("memory-token"),
      businessSuccess(),
      businessSuccess(),
    ]);
    const client = createClient(profile, queue);
    await client.call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    const second = await client.call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    expect(second.tokenStatus).toBe("memory-only");
    expect(queue.calls.filter((call) => String(call.input).endsWith("/auth")))
      .toHaveLength(1);
  });

  it("allows only one concurrent refresh per application", async () => {
    const profile = await profileService();
    const queue = new FetchQueue([
      authSuccess("shared-token"),
      businessSuccess(),
      businessSuccess(),
    ]);
    const client = createClient(profile, queue);
    await Promise.all([
      client.call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      }),
      client.call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      }),
    ]);
    expect(queue.calls.filter((call) => String(call.input).endsWith("/auth")))
      .toHaveLength(1);
  });

  it("exposes an explicit auth operation without a token header", async () => {
    const profile = await profileService();
    const queue = new FetchQueue([authSuccess("explicit-token")]);
    const client = createClient(profile, queue);

    const result = await client.authenticate(credentials(), {
      timeoutMs: 1000,
      debug: false,
    });

    expect(result.tokenRefreshed).toBe(true);
    expect(result.tokenExpiresAt).toBe(NOW + 2 * 60 * 60 * 1000);
    expect(String(queue.calls[0]?.input)).toMatch(/\/fixture-app-id\/auth$/);
    expect(queue.calls[0]?.init?.method).toBe("POST");
    expect(queue.calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json;charset=utf-8",
    });
    expect(queue.calls[0]?.init?.headers).not.toHaveProperty("token");
    expect(Object.keys(JSON.parse(String(queue.calls[0]?.init?.body))).sort())
      .toEqual(["appkey", "sign", "timestamp"]);
    expect(JSON.stringify(result.raw)).toContain("explicit-token");
  });

  it("reuses an explicit auth cache and force bypasses it", async () => {
    const profile = await profileService();
    const queue = new FetchQueue([
      authSuccess("cached-auth-token"),
      authSuccess("forced-auth-token"),
    ]);
    const client = createClient(profile, queue);

    const first = await client.authenticate(credentials(), {
      timeoutMs: 1000,
      debug: false,
    });
    const cached = await client.authenticate(credentials(), {
      timeoutMs: 1000,
      debug: false,
    });
    const forced = await client.authenticate(credentials(), {
      timeoutMs: 1000,
      debug: false,
      force: true,
    });

    expect(first.tokenRefreshed).toBe(true);
    expect(cached.tokenRefreshed).toBe(false);
    expect(forced.tokenRefreshed).toBe(true);
    expect(queue.calls.filter((call) => String(call.input).endsWith("/auth")))
      .toHaveLength(2);
  });
});

describe("request retries and business errors", () => {
  it("calls a tag path with the documented token header and body", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "tag-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({
        code: 0,
        msg: "成功",
        data: { validTags: [], invalidTags: [] },
      }),
    ]);
    const client = createClient(profile, queue);

    await client.call(
      "/query_tag",
      { userIdList: ["gtcid-1", "gtcid-2"] },
      credentials(),
      { timeoutMs: 1000, debug: false },
    );

    expect(String(queue.calls[0]?.input)).toMatch(/\/fixture-app-id\/query_tag$/);
    expect(queue.calls[0]?.init?.headers).toMatchObject({
      token: "tag-token",
      "content-type": "application/json;charset=utf-8",
    });
    expect(JSON.parse(String(queue.calls[0]?.init?.body))).toEqual({
      userIdList: ["gtcid-1", "gtcid-2"],
    });
  });

  it("uses the exact fixed path and POST body for every tag endpoint", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "tag-token", NOW + 60 * 60 * 1000);
    const requests: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [
      { path: "/query_tag_tree", body: {} },
      {
        path: "/externalTag/add",
        body: {
          name: "Audience",
          tagValueList: [{ tagValCn: "Gold", idType: "gtcid" }],
        },
      },
      {
        path: "/externalTag/edit",
        body: {
          tagCode: "tag-1",
          name: "Audience 2",
          tagValueList: [{
            tagValCn: "Gold",
            tagValCode: "tag-1-1",
            reset: false,
          }],
        },
      },
      {
        path: "/externalTag/tagVal/data/import",
        body: { tagValCode: "tag-1-1", idList: ["gtcid-1"] },
      },
      {
        path: "/externalTag/trigger",
        body: { tagCodeList: ["tag-1"] },
      },
    ];
    const queue = new FetchQueue(
      requests.map(() => jsonResponse({ code: 0, msg: "success" })),
    );
    const client = createClient(profile, queue);

    for (const request of requests) {
      await client.call(
        request.path,
        request.body,
        credentials(),
        { timeoutMs: 1000, debug: false },
      );
    }

    expect(queue.calls).toHaveLength(requests.length);
    for (const [index, request] of requests.entries()) {
      const call = queue.calls[index]!;
      expect(String(call.input)).toBe(
        `https://ido.getui.com/openapi/fixture-app-id${request.path}`,
      );
      expect(call.init?.method).toBe("POST");
      expect(call.init?.headers).toMatchObject({ token: "tag-token" });
      expect(JSON.parse(String(call.init?.body))).toEqual(request.body);
    }
  });

  it("uses the fixed vector paths and preserves batch order", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "vector-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({
        code: 0,
        msg: "success",
        data: { userId: "gtcid-1", vert: "[0.1,-0.2]" },
      }),
      jsonResponse({
        code: 0,
        msg: "success",
        data: {
          userList: [
            { userId: "gtcid-2", vert: null },
            { userId: "gtcid-1", vert: "[0.1,-0.2]" },
          ],
        },
      }),
    ]);
    const client = createClient(profile, queue);

    await client.call(
      "/v2/query_vector",
      { userId: "gtcid-1" },
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    await client.call(
      "/v2/batch_query_vector",
      { userIdList: ["gtcid-2", "gtcid-1"] },
      credentials(),
      { timeoutMs: 1000, debug: false },
    );

    expect(String(queue.calls[0]?.input)).toBe(
      "https://ido.getui.com/openapi/fixture-app-id/v2/query_vector",
    );
    expect(String(queue.calls[1]?.input)).toBe(
      "https://ido.getui.com/openapi/fixture-app-id/v2/batch_query_vector",
    );
    expect(JSON.parse(String(queue.calls[1]?.init?.body))).toEqual({
      userIdList: ["gtcid-2", "gtcid-1"],
    });
  });

  it("rejects arbitrary business paths instead of allowing an export prefix", async () => {
    const profile = await profileService();
    const queue = new FetchQueue([]);
    const client = createClient(profile, queue);
    await expect(
      client.call(
        "/export/not-registered",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({ code: "GETUI_CLI_OPERATION_PATH_INVALID" });
    expect(queue.calls).toHaveLength(0);
  });

  it("refreshes and replays a tag request after HTTP 401 token rejection", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "old-tag-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ code: 10002, msg: "token invalid" }, 401),
      authSuccess("new-tag-token"),
      jsonResponse({ code: 0, msg: "成功", data: {} }),
    ]);
    const client = createClient(profile, queue);

    const result = await client.call(
      "/query_tag_tree",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );

    expect(result.tokenRefreshed).toBe(true);
    expect(queue.calls).toHaveLength(3);
    expect(queue.calls[2]?.init?.headers).toMatchObject({ token: "new-tag-token" });
  });

  it("does not refresh for an unrelated HTTP 401", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "tag-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ code: 11, msg: "IP restricted" }, 401),
    ]);
    const client = createClient(profile, queue);

    await expect(
      client.call(
        "/query_tag",
        { userIdList: ["gtcid-1"] },
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({ code: "GETUI_CLI_HTTP_UNAUTHORIZED" });
    expect(queue.calls).toHaveLength(1);
  });
  it("preserves structured JSON details for HTTP errors", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const remoteResponse = {
      code: 20001,
      msg: "超过允许时间跨度",
      data: null,
    };
    const queue = new FetchQueue([jsonResponse(remoteResponse, 400)]);

    await expect(
      createClient(profile, queue).call(
        "/export/remainChart",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_REMOTE_HTTP_ERROR",
      details: { status: 400, remoteResponse },
    });
  });

  it("preserves text and omits empty HTTP error responses", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);

    await expect(
      createClient(profile, new FetchQueue([
        new Response("bad gateway", { status: 400 }),
      ])).call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      }),
    ).rejects.toMatchObject({
      details: { status: 400, remoteResponse: "bad gateway" },
    });

    try {
      await createClient(profile, new FetchQueue([
        new Response(null, { status: 400 }),
      ])).call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      });
      throw new Error("Expected HTTP error");
    } catch (error) {
      expect(error).toMatchObject({ details: { status: 400 } });
      expect((error as { details: Record<string, unknown> }).details)
        .not.toHaveProperty("remoteResponse");
    }
  });

  it("truncates oversized invalid JSON details without exposing the full body", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const oversized = `${"a".repeat(64 * 1024 - 1)}中文`;

    await expect(
      createClient(profile, new FetchQueue([
        new Response(oversized, { status: 200 }),
      ])).call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      }),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_REMOTE_JSON_INVALID",
      details: {
        remoteResponse: expect.any(String),
        remoteResponseTruncated: true,
      },
    });

    try {
      await createClient(profile, new FetchQueue([
        new Response(oversized, { status: 200 }),
      ])).call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      });
      throw new Error("Expected invalid JSON error");
    } catch (error) {
      const details = (error as { details: Record<string, unknown> }).details;
      expect(Buffer.byteLength(String(details.remoteResponse), "utf8"))
        .toBeLessThanOrEqual(64 * 1024);
      expect(details.remoteResponse).not.toContain("�");
    }
  });

  it("retains a sanitized non-object response when business validation fails", async () => {
    const profile = await profileService();
    const values = credentials();
    await profile.setToken(values.appId, "valid-token", NOW + 60 * 60 * 1000);
    const response = JSON.stringify([
      { token: "remote-token", message: values.masterSecret },
    ]);

    await expect(
      createClient(profile, new FetchQueue([
        new Response(response, { status: 200 }),
      ])).call("/export/todayStatistics", {}, values, {
        timeoutMs: 1000,
        debug: false,
      }),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_RESPONSE_INVALID",
      details: {
        field: "response",
        remoteResponse: [
          { token: "[REDACTED]", message: "secret-[REDACTED]" },
        ],
      },
    });
  });

  it("keeps the HTTP error when reading its response fails", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const response = new Response("unreadable", { status: 400 });
    vi.spyOn(response, "text").mockRejectedValue(new Error("read failed"));

    await expect(
      createClient(profile, new FetchQueue([response])).call(
        "/export/todayStatistics",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_REMOTE_HTTP_ERROR",
      details: { status: 400 },
    });
  });

  it("preserves responses through 64 KiB and safely truncates larger UTF-8 text", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const exact = "a".repeat(64 * 1024);
    await expect(
      createClient(profile, new FetchQueue([
        new Response(exact, { status: 400 }),
      ])).call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      }),
    ).rejects.toMatchObject({
      details: { status: 400, remoteResponse: exact },
    });

    const oversized = `${"a".repeat(64 * 1024 - 1)}中文`;
    try {
      await createClient(profile, new FetchQueue([
        new Response(oversized, { status: 400 }),
      ])).call("/export/todayStatistics", {}, credentials(), {
        timeoutMs: 1000,
        debug: false,
      });
      throw new Error("Expected HTTP error");
    } catch (error) {
      const details = (error as { details: Record<string, unknown> }).details;
      expect(details.remoteResponseTruncated).toBe(true);
      expect(Buffer.byteLength(String(details.remoteResponse), "utf8"))
        .toBeLessThanOrEqual(64 * 1024);
      expect(details.remoteResponse).not.toContain("�");
    }
  });

  it("keeps only the final response after retryable HTTP failures", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ attempt: 1 }, 500),
      jsonResponse({ attempt: 2 }, 503),
      jsonResponse({ attempt: 3 }, 500),
    ]);

    await expect(
      createClient(profile, queue).call(
        "/export/todayStatistics",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_REMOTE_SERVER_ERROR",
      details: { status: 500, remoteResponse: { attempt: 3 } },
    });
    expect(queue.calls).toHaveLength(3);
  });

  it("retries transient server errors twice", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({}, 500),
      jsonResponse({}, 503),
      businessSuccess(),
    ]);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const result = await createClient(profile, queue, sleep).call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    expect(result.attempts).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("caps Retry-After at five seconds", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({}, 429, { "retry-after": "10" }),
      businessSuccess(),
    ]);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    await createClient(profile, queue, sleep).call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("refreshes and replays once after code 10001", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "rejected-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ code: 10001, msg: "expired" }),
      authSuccess("replacement-token"),
      businessSuccess(),
    ]);
    const result = await createClient(profile, queue).call(
      "/export/todayStatistics",
      {},
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    expect(result.tokenRefreshed).toBe(true);
    expect(queue.calls[2]?.init?.headers).toMatchObject({
      token: "replacement-token",
    });
  });

  it("refreshes and replays once after code 10002", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "rejected-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ code: 10002, msg: "token expired" }),
      authSuccess("replacement-token"),
      businessSuccess(),
    ]);
    const result = await createClient(profile, queue).call(
      "/externalTag/trigger",
      { tagCodeList: ["tag-1"] },
      credentials(),
      { timeoutMs: 1000, debug: false },
    );
    expect(result.tokenRefreshed).toBe(true);
    expect(queue.calls).toHaveLength(3);
    expect(queue.calls[2]?.init?.headers).toMatchObject({
      token: "replacement-token",
    });
  });

  it("stops when the replay also returns code 10001", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "rejected-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ code: 10001, msg: "expired" }),
      authSuccess("replacement-token"),
      jsonResponse({ code: 10001, msg: "expired again" }),
    ]);
    await expect(
      createClient(profile, queue).call(
        "/export/todayStatistics",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_TOKEN_REJECTED",
      type: "authentication",
    });
    expect(queue.calls).toHaveLength(3);
  });

  it("does not retry deterministic permission errors", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ code: 40001, msg: "VIP feature is not enabled" }),
    ]);
    await expect(
      createClient(profile, queue).call(
        "/export/todayStatistics",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({ type: "permission" });
    expect(queue.calls).toHaveLength(1);
  });

  it.each([
    ["invalid parameter", "remote"],
    ["VIP feature is not enabled", "permission"],
    ["IP whitelist rejected", "permission"],
  ])("does not retry deterministic '%s' errors", async (message, type) => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([jsonResponse({ code: 40001, msg: message })]);

    await expect(
      createClient(profile, queue).call(
        "/export/todayStatistics",
        {},
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({ type });
    expect(queue.calls).toHaveLength(1);
  });

  it("aborts timed-out requests and stops after the retry limit", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const hanging = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    const queue = new FetchQueue([hanging, hanging, hanging]);
    await expect(
      createClient(profile, queue).call(
        "/export/todayStatistics",
        {},
        credentials(),
        { timeoutMs: 5, debug: false },
      ),
    ).rejects.toMatchObject({ code: "GETUI_CLI_REQUEST_TIMEOUT" });
    expect(queue.calls).toHaveLength(3);
  });

  it("keeps application tokens isolated", async () => {
    const profile = await profileService();
    await profile.setToken("app-a", "token-a", NOW + 60 * 60 * 1000);
    await profile.setToken("app-b", "token-b", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([businessSuccess(), businessSuccess()]);
    const client = createClient(profile, queue);
    await Promise.all([
      client.call("/export/todayStatistics", {}, credentials("app-a"), {
        timeoutMs: 1000,
        debug: false,
      }),
      client.call("/export/todayStatistics", {}, credentials("app-b"), {
        timeoutMs: 1000,
        debug: false,
      }),
    ]);
    const tokens = queue.calls.map(
      (call) => (call.init?.headers as Record<string, string>).token,
    );
    expect(tokens.sort()).toEqual(["token-a", "token-b"]);
  });

  it("does not expose credentials, signatures, or tokens in errors and diagnostics", async () => {
    const profile = await profileService();
    const values = credentials();
    const sign = createAuthSign(values.appKey, NOW, values.masterSecret);
    const authMessage = [
      values.appId,
      values.appKey,
      values.masterSecret,
      sign,
    ].join(" ");
    const authQueue = new FetchQueue([
      jsonResponse({ code: 40002, msg: authMessage }),
    ]);

    let renderedAuthError = "";
    try {
      await createClient(profile, authQueue).call(
        "/export/todayStatistics",
        {},
        values,
        { timeoutMs: 1000, debug: true },
      );
    } catch (error) {
      renderedAuthError = renderError(error as import("../src/errors.js").CliError);
    }
    for (const sensitive of [values.appId, values.appKey, values.masterSecret, sign]) {
      expect(renderedAuthError).not.toContain(sensitive);
    }

    await profile.setToken(values.appId, "output-token", NOW + 60 * 60 * 1000);
    const businessQueue = new FetchQueue([
      jsonResponse({
        code: 40002,
        msg: `${values.appId} ${values.appKey} ${values.masterSecret} output-token`,
      }),
    ]);
    let renderedBusinessError = "";
    try {
      await createClient(profile, businessQueue).call(
        "/export/todayStatistics",
        {},
        values,
        { timeoutMs: 1000, debug: true },
      );
    } catch (error) {
      renderedBusinessError = renderError(error as import("../src/errors.js").CliError);
    }
    for (const sensitive of [
      values.appId,
      values.appKey,
      values.masterSecret,
      "output-token",
    ]) {
      expect(renderedBusinessError).not.toContain(sensitive);
    }

    const successQueue = new FetchQueue([businessSuccess()]);
    const result = await createClient(profile, successQueue).call(
      "/export/todayStatistics",
      {},
      values,
      { timeoutMs: 1000, debug: true },
    );
    const diagnostics = renderDiagnostics(result.diagnostics);
    for (const sensitive of [
      values.appId,
      values.appKey,
      values.masterSecret,
      "output-token",
    ]) {
      expect(diagnostics).not.toContain(sensitive);
    }
  });

  it("allows the user import path and preserves the write request body", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "write-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([jsonResponse({ code: 0, msg: "success" })]);
    await createClient(profile, queue).call(
      "/import/event",
      { dataList: [{ gtcid: "synthetic-user", eventId: "launch" }] },
      credentials(),
      { timeoutMs: 1000, debug: false, retryClass: "write" },
    );
    expect(String(queue.calls[0]?.input)).toBe(
      "https://ido.getui.com/openapi/fixture-app-id/import/event",
    );
    expect(queue.calls).toHaveLength(1);
    expect(JSON.parse(String(queue.calls[0]?.init?.body))).toEqual({
      dataList: [{ gtcid: "synthetic-user", eventId: "launch" }],
    });
  });

  it("defaults the three user write paths to a single attempt", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "write-token", NOW + 60 * 60 * 1000);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const queue = new FetchQueue([jsonResponse({ code: 50001 }, 500)]);

    await expect(
      createClient(profile, queue, sleep).call(
        "/export/crowd/createCrowdExportTask",
        { crowdId: "crowd-1", uidType: "CID" },
        credentials(),
        { timeoutMs: 1000, debug: false },
      ),
    ).rejects.toMatchObject({ code: "GETUI_CLI_REMOTE_SERVER_ERROR" });
    expect(queue.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a write endpoint after a transient HTTP failure", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "write-token", NOW + 60 * 60 * 1000);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const queue = new FetchQueue([jsonResponse({ code: 50001 }, 503)]);

    await expect(
      createClient(profile, queue, sleep).call(
        "/import/user",
        { dataList: [] },
        credentials(),
        { timeoutMs: 1000, debug: false, retryClass: "write" },
      ),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_REMOTE_SERVER_ERROR",
      details: { outcomeUnknown: true },
    });
    expect(queue.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps authentication retries independent from a write request", async () => {
    const profile = await profileService();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const queue = new FetchQueue([
      jsonResponse({ code: 50001 }, 503),
      authSuccess("auth-after-retry"),
      businessSuccess(),
    ]);

    await createClient(profile, queue, sleep).call(
      "/import/user",
      { dataList: [] },
      credentials(),
      { timeoutMs: 1000, debug: false, retryClass: "write" },
    );
    expect(queue.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(queue.calls[2]?.init?.headers).toMatchObject({
      token: "auth-after-retry",
    });
  });

  it("refreshes once for an HTTP 401 that explicitly says the token expired", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "old-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ message: "token expired" }, 401),
      authSuccess("replacement-token"),
      businessSuccess(),
    ]);

    const result = await createClient(profile, queue).call(
      "/export/crowd/createCrowdExportTask",
      { crowdId: "crowd-1", uidType: "GTCID" },
      credentials(),
      { timeoutMs: 1000, debug: false, retryClass: "write" },
    );
    expect(result.tokenRefreshed).toBe(true);
    expect(queue.calls).toHaveLength(3);
  });

  it("stops after a refreshed token receives a second HTTP token rejection", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "old-token", NOW + 60 * 60 * 1000);
    const queue = new FetchQueue([
      jsonResponse({ message: "token expired" }, 401),
      authSuccess("replacement-token"),
      jsonResponse({ message: "token invalid" }, 401),
    ]);

    await expect(
      createClient(profile, queue).call(
        "/import/event",
        { dataList: [] },
        credentials(),
        { timeoutMs: 1000, debug: false, retryClass: "write" },
      ),
    ).rejects.toMatchObject({
      code: "GETUI_CLI_TOKEN_REJECTED",
      type: "authentication",
    });
    expect(queue.calls).toHaveLength(3);
  });

  it("parses a successful response larger than the error detail limit", async () => {
    const profile = await profileService();
    await profile.setToken("fixture-app-id", "valid-token", NOW + 60 * 60 * 1000);
    const ids = Array.from({ length: 8000 }, (_, index) => `synthetic-${index}`);
    const queue = new FetchQueue([
      jsonResponse({ code: 0, msg: "success", data: { list: ids, total: ids.length } }),
    ]);

    const result = await createClient(profile, queue).call(
      "/export/crowd/exportCrowdSingleFile",
      { crowdId: "crowd-1", taskId: 1001, fileId: "file-1" },
      credentials(),
      { timeoutMs: 1000, debug: false, retryClass: "read" },
    );

    expect((result.raw as { data: { list: string[] } }).data.list).toHaveLength(8000);
    expect((result.raw as { data: { list: string[] } }).data.list.at(-1)).toBe(
      "synthetic-7999",
    );
  });
});
