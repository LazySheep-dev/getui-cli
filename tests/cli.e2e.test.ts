import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";
import { GetuiClient } from "../src/client.js";
import { CliError } from "../src/errors.js";
import { OperationExecutor } from "../src/executor.js";
import { renderDiagnostics } from "../src/output.js";
import { MemorySecretStore, ProfileService } from "../src/profile.js";
import type {
  ExecutionOptions,
  OperationName,
  SuccessEnvelope,
} from "../src/types.js";

class CaptureStream extends Writable {
  value = "";

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

function successEnvelope(
  operation: OperationName,
  query: Record<string, unknown>,
  options: ExecutionOptions,
): SuccessEnvelope<unknown> {
  return {
    schemaVersion: "1.0",
    ok: true,
    mode: options.raw ? "raw" : "normalized",
    operation,
    query,
    data: [{ operation, query }],
    meta: {
      credentialSource: "environment",
      fetchedAt: "2026-08-07T08:00:00.000Z",
      durationMs: 12,
      attempts: 1,
    },
  };
}

function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const readStdin = overrides.readStdin ?? vi.fn(async () => "");
  const executor = {
    execute: vi.fn(
      async (
        operationName: string,
        input: unknown,
        options: ExecutionOptions,
      ) => successEnvelope(
        operationName as OperationName,
        input as Record<string, unknown>,
        options,
      ),
    ),
  };
  const profileService = {
    add: vi.fn(async (input) => ({
      alias: input.alias,
      appId: input.appId,
      appKey: input.appKey,
      createdAt: "2026-08-07T08:00:00.000Z",
      updatedAt: "2026-08-07T08:00:00.000Z",
    })),
    list: vi.fn(async () => []),
    get: vi.fn(async (alias?: string) => ({
      alias: alias ?? "default",
      appId: "app-id",
      appKey: "app-key",
      createdAt: "2026-08-07T08:00:00.000Z",
      updatedAt: "2026-08-07T08:00:00.000Z",
    })),
    use: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({
      secretStored: true,
      tokenStatus: "valid" as const,
    })),
    isSecretStoreAvailable: vi.fn(async () => true),
  };
  const dependencies: CliDependencies = {
    profileService,
    executor,
    io: {
      stdin: Readable.from([]),
      stdout,
      stderr,
      stdinIsTTY: true,
    },
    version: "9.8.7",
    readStdin,
    ...overrides,
  };

  return {
    stdout,
    stderr,
    executor,
    profileService,
    readStdin,
    async run(args: string[]): Promise<number> {
      return runCli(args, dependencies);
    },
  };
}

describe("CLI discovery", () => {
  it("prints version and help with successful exit codes", async () => {
    const version = harness();
    expect(await version.run(["--version"])).toBe(0);
    expect(version.stdout.value).toBe("9.8.7\n");
    expect(version.stderr.value).toBe("");

    const help = harness();
    expect(await help.run(["--help"])).toBe(0);
    expect(help.stdout.value).toContain("stats");
    expect(help.stdout.value).toContain("api");
    expect(help.stdout.value).toContain("auth");
    expect(help.stdout.value).toContain("tag");
    expect(help.stderr.value).toBe("");
  });

  it("lists all supported operations and shows business inputs", async () => {
    const listing = harness();
    expect(await listing.run(["operations", "list"])).toBe(0);
    const parsed = JSON.parse(listing.stdout.value) as {
      data: Array<{ name: string }>;
    };
    expect(parsed.data.map((item) => item.name)).toEqual([
      "statistics.today",
      "statistics.period",
      "statistics.activity",
      "statistics.userTrend",
      "statistics.retention",
      "auth.token",
      "tag.user",
      "tag.tree",
      "tag.external.create",
      "tag.external.edit",
      "tag.external.import",
      "tag.external.trigger",
      "user.import.event",
      "user.import.user",
      "user.crowd.list",
      "user.crowd.export.create",
      "user.crowd.export.status",
      "user.crowd.export.file",
      "user.vector.query",
      "user.vector.batch",
    ]);

    for (const name of parsed.data.map((item) => item.name)) {
      const show = harness();
      expect(await show.run(["operations", "show", name])).toBe(0);
      expect(show.stdout.value).toContain('"input"');
      expect(show.stdout.value).not.toContain("/export/");
    }
  });
});

describe("application commands", () => {
  it("adds, lists, shows, selects, removes, and reports no default profile", async () => {
    const baseDir = `/tmp/getui-cli-e2e-${process.pid}-${Date.now()}`;
    const profileService = new ProfileService({
      baseDir,
      env: {},
      secretStore: new MemorySecretStore(),
    });
    const invoke = async (args: string[]) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(args, {
        profileService,
        executor: { execute: vi.fn() },
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: false,
        },
      });
      return { exitCode, stdout: stdout.value, stderr: stderr.value };
    };

    expect((await invoke(["app", "add", "one", "--app-id", "id-1", "--app-key", "key-1"])).exitCode).toBe(0);
    expect((await invoke(["app", "add", "two", "--app-id", "id-2", "--app-key", "key-2"])).exitCode).toBe(0);
    expect((await invoke(["app", "list"])).stdout).toContain('"alias": "one"');
    expect((await invoke(["app", "show", "two"])).stdout).toContain('"alias": "two"');
    expect((await invoke(["app", "use", "two"])).exitCode).toBe(0);
    expect((await invoke(["status"])).stdout).toContain('"alias": "two"');
    expect((await invoke(["app", "remove", "two", "--yes"])).exitCode).toBe(0);
    const status = await invoke(["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('"profile": null');
    expect(status.stderr).toBe("");

    await import("node:fs/promises").then(({ rm }) =>
      rm(baseDir, { recursive: true, force: true }),
    );
  });
});

describe("api call input", () => {
  it("accepts inline JSON, a file, and stdin as separate sources", async () => {
    const inline = harness();
    expect(
      await inline.run([
        "api",
        "call",
        "statistics.period",
        "--input",
        '{"metric":"active"}',
      ]),
    ).toBe(0);
    expect(inline.executor.execute).toHaveBeenCalledWith(
      "statistics.period",
      { metric: "active" },
      expect.objectContaining({ raw: false, timeoutMs: 30000 }),
    );

    const inputFile = harness({
      readInputFile: vi.fn(async () => '{"activityScope":"all"}'),
    });
    expect(
      await inputFile.run([
        "api",
        "call",
        "statistics.today",
        "--input-file",
        "query.json",
      ]),
    ).toBe(0);
    expect(inputFile.executor.execute).toHaveBeenCalledWith(
      "statistics.today",
      { activityScope: "all" },
      expect.any(Object),
    );

    const stdin = harness({
      io: {
        stdin: Readable.from([]),
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdinIsTTY: false,
      },
      readStdin: vi.fn(async () => '{"metric":"new"}'),
    });
    expect(await stdin.run(["api", "call", "statistics.period"])).toBe(0);
    expect(stdin.executor.execute).toHaveBeenCalledWith(
      "statistics.period",
      { metric: "new" },
      expect.any(Object),
    );
  });

  it("rejects input source conflicts and non-object JSON", async () => {
    const conflict = harness({
      io: {
        stdin: Readable.from([]),
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdinIsTTY: false,
      },
      readStdin: vi.fn(async () => "{}"),
    });
    expect(
      await conflict.run([
        "api",
        "call",
        "statistics.today",
        "--input",
        "{}",
      ]),
    ).toBe(0);
    expect(conflict.executor.execute).toHaveBeenCalledWith(
      "statistics.today",
      {},
      expect.any(Object),
    );
    expect(conflict.readStdin).not.toHaveBeenCalled();

    const array = harness();
    expect(
      await array.run([
        "api",
        "call",
        "statistics.today",
        "--input",
        "[]",
      ]),
    ).toBe(2);
    expect(array.stderr.value).toContain("GETUI_CLI_INPUT_OBJECT_REQUIRED");

    const inputAndFile = harness({
      readInputFile: vi.fn(async () => "{}"),
    });
    expect(
      await inputAndFile.run([
        "api",
        "call",
        "statistics.today",
        "--input",
        "{}",
        "--input-file",
        "query.json",
      ]),
    ).toBe(2);
    expect(inputAndFile.executor.execute).not.toHaveBeenCalled();

    const fileAndStdin = harness({
      io: {
        stdin: Readable.from([]),
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdinIsTTY: false,
      },
      readInputFile: vi.fn(async () => "{}"),
      readStdin: vi.fn(async () => "{}"),
    });
    expect(
      await fileAndStdin.run([
        "api",
        "call",
        "statistics.today",
        "--input-file",
        "query.json",
      ]),
    ).toBe(0);
    expect(fileAndStdin.executor.execute).toHaveBeenCalledWith(
      "statistics.today",
      {},
      expect.any(Object),
    );
    expect(fileAndStdin.readStdin).not.toHaveBeenCalled();
  });
});

describe("user vector commands", () => {
  it("maps the human single-query command to user.vector.query", async () => {
    const cli = harness();
    expect(await cli.run(["user", "vector", "query", "--gtcid", "gtcid-1"])).toBe(0);
    expect(cli.executor.execute).toHaveBeenCalledWith(
      "user.vector.query",
      { userId: "gtcid-1" },
      expect.objectContaining({ confirmMutations: false }),
    );
  });

  it("maps the human batch command to user.vector.batch", async () => {
    const cli = harness();
    expect(
      await cli.run([
        "user",
        "vector",
        "batch",
        "--input",
        '{"userIdList":["gtcid-1","gtcid-2"]}',
      ]),
    ).toBe(0);
    expect(cli.executor.execute).toHaveBeenCalledWith(
      "user.vector.batch",
      { userIdList: ["gtcid-1", "gtcid-2"] },
      expect.objectContaining({ confirmMutations: false }),
    );
  });

  it("exposes vector-specific help and the 50-item boundary", async () => {
    const help = harness();
    expect(await help.run(["user", "vector", "--help"])).toBe(0);
    expect(help.stdout.value).toContain("query");
    expect(help.stdout.value).toContain("batch");
    expect(help.stdout.value).toContain("read-only");
    const batchHelp = harness();
    expect(await batchHelp.run(["user", "vector", "batch", "--help"])).toBe(0);
    expect(batchHelp.stdout.value).toContain("--input");
    expect(batchHelp.stdout.value).toContain("up to 50");
    expect(batchHelp.stdout.value).toContain("read-only");
  });
});

describe("stats commands", () => {
  it("maps all five human commands to their operation inputs", async () => {
    const cases: Array<{
      args: string[];
      operation: OperationName;
      input: Record<string, unknown>;
    }> = [
      {
        args: ["stats", "today", "--activity-scope", "all"],
        operation: "statistics.today",
        input: { activityScope: "all" },
      },
      {
        args: [
          "stats",
          "period",
          "--metric",
          "active",
          "--group-by",
          "channel",
          "--group-value",
          "organic",
        ],
        operation: "statistics.period",
        input: { metric: "active", groupBy: "channel", groupValue: "organic" },
      },
      {
        args: [
          "stats",
          "activity",
          "--channels",
          "store,organic",
          "--group-by",
          "platform",
        ],
        operation: "statistics.activity",
        input: { channels: ["store", "organic"], groupBy: "platform" },
      },
      {
        args: [
          "stats",
          "trend",
          "--start-date",
          "2026-08-01",
          "--end-date",
          "2026-08-07",
          "--metric",
          "active",
          "--platforms",
          "android,ios",
        ],
        operation: "statistics.userTrend",
        input: {
          startDate: "2026-08-01",
          endDate: "2026-08-07",
          metric: "active",
          platforms: ["android", "ios"],
        },
      },
      {
        args: [
          "stats",
          "retention",
          "--start-date",
          "2026-07-01",
          "--end-date",
          "2026-07-31",
          "--metric",
          "new",
          "--app-versions",
          "1.0,2.0",
        ],
        operation: "statistics.retention",
        input: {
          startDate: "2026-07-01",
          endDate: "2026-07-31",
          metric: "new",
          appVersions: ["1.0", "2.0"],
        },
      },
    ];

    for (const item of cases) {
      const cli = harness();
      expect(await cli.run(item.args)).toBe(0);
      expect(cli.executor.execute).toHaveBeenCalledWith(
        item.operation,
        item.input,
        expect.any(Object),
      );
    }
  });
});

describe("auth and tag commands", () => {
  it("maps human auth and tag commands and forwards confirmation", async () => {
    const cases: Array<{
      args: string[];
      operation: OperationName;
      input: Record<string, unknown>;
      confirmed: boolean;
    }> = [
      {
        args: ["auth", "token", "--force"],
        operation: "auth.token",
        input: { force: true },
        confirmed: false,
      },
      {
        args: [
          "tag",
          "query",
          "--input",
          JSON.stringify({ userIdList: ["gtcid-1", "gtcid-2"] }),
        ],
        operation: "tag.user",
        input: { userIdList: ["gtcid-1", "gtcid-2"] },
        confirmed: false,
      },
      {
        args: ["tag", "tree"],
        operation: "tag.tree",
        input: {},
        confirmed: false,
      },
      {
        args: [
          "tag",
          "create",
          "--input",
          JSON.stringify({
            name: "Audience",
            tagValueList: [{ tagValCn: "Gold", idType: "gtcid" }],
          }),
          "--yes",
        ],
        operation: "tag.external.create",
        input: {
          name: "Audience",
          tagValueList: [{ tagValCn: "Gold", idType: "gtcid" }],
        },
        confirmed: true,
      },
      {
        args: [
          "tag",
          "edit",
          "--input",
          JSON.stringify({
            tagCode: "tag-1",
            name: "Audience 2",
            tagValueList: [{
              tagValCn: "Gold",
              tagValCode: "tag-1-1",
              reset: false,
            }],
          }),
          "--yes",
        ],
        operation: "tag.external.edit",
        input: {
          tagCode: "tag-1",
          name: "Audience 2",
          tagValueList: [{
            tagValCn: "Gold",
            tagValCode: "tag-1-1",
            reset: false,
          }],
        },
        confirmed: true,
      },
      {
        args: [
          "tag",
          "import",
          "--input",
          JSON.stringify({ tagValCode: "tag-1-1", idList: ["id-1"] }),
          "--yes",
        ],
        operation: "tag.external.import",
        input: { tagValCode: "tag-1-1", idList: ["id-1"] },
        confirmed: true,
      },
      {
        args: [
          "tag",
          "trigger",
          "--input",
          JSON.stringify({ tagCodeList: ["tag-1"] }),
          "--yes",
        ],
        operation: "tag.external.trigger",
        input: { tagCodeList: ["tag-1"] },
        confirmed: true,
      },
      {
        args: [
          "api",
          "call",
          "tag.external.trigger",
          "--input",
          JSON.stringify({ tagCodeList: ["tag-2"] }),
          "--yes",
        ],
        operation: "tag.external.trigger",
        input: { tagCodeList: ["tag-2"] },
        confirmed: true,
      },
    ];

    for (const item of cases) {
      const cli = harness();
      expect(await cli.run(item.args)).toBe(0);
      expect(cli.executor.execute).toHaveBeenCalledWith(
        item.operation,
        item.input,
        expect.objectContaining({ confirmMutations: item.confirmed }),
      );
    }
  });

  it("shows tag commands and confirmation options in help", async () => {
    const tagHelp = harness();
    expect(await tagHelp.run(["tag", "--help"])).toBe(0);
    for (const command of ["query", "tree", "create", "edit", "import", "trigger"]) {
      expect(tagHelp.stdout.value).toContain(command);
    }
    expect(tagHelp.stdout.value).toContain("--yes");

    const authHelp = harness();
    expect(await authHelp.run(["auth", "token", "--help"])).toBe(0);
    expect(authHelp.stdout.value).toContain("--force");
  });

  it("blocks a mutating human command before credentials or network access", async () => {
    const cli = harness();
    const resolveCredentials = vi.fn();
    const client = { call: vi.fn() };
    const executor = new OperationExecutor({
      profileService: {
        resolveCredentials,
      },
      client,
    });
    const profileService = {
      ...cli.profileService,
      resolveCredentials,
    };
    const blocked = await runCli([
      "tag",
      "import",
      "--input",
      JSON.stringify({ tagValCode: "tag-1", idList: ["id-1"] }),
    ], {
      profileService,
      executor,
      io: {
        stdin: Readable.from([]),
        stdout: cli.stdout,
        stderr: cli.stderr,
        stdinIsTTY: true,
      },
    });

    expect(blocked).toBe(2);
    expect(cli.stderr.value).toContain("GETUI_CLI_CONFIRMATION_REQUIRED");
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });

  it("runs cold-start authentication before a tag query and returns a safe envelope", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-tag-e2e-"));
    const now = Date.now();
    const credentials = {
      GETUI_APP_ID: "tag-e2e-app-id",
      GETUI_APP_KEY: "tag-e2e-app-key",
      GETUI_MASTER_SECRET: "tag-e2e-master-secret",
    };
    const profileService = new ProfileService({
      baseDir,
      env: credentials,
      secretStore: new MemorySecretStore(false),
    });
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ input, init });
        if (String(input).endsWith("/auth")) {
          return new Response(JSON.stringify({
            code: 0,
            msg: "success",
            data: {
              token: "tag-e2e-token",
              expireTime: now + 2 * 60 * 60 * 1000,
            },
          }));
        }
        expect(String(input)).toBe(
          "https://ido.getui.com/openapi/tag-e2e-app-id/query_tag",
        );
        expect(init?.headers).toMatchObject({ token: "tag-e2e-token" });
        expect(JSON.parse(String(init?.body))).toEqual({
          userIdList: ["gtcid-1"],
        });
        return new Response(JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            validTags: [{ userId: "gtcid-1", tags: { external: ["tag-1"] } }],
            invalidTags: [],
          },
        }));
      },
    );
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const executor = new OperationExecutor({ profileService, client });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    try {
      const exitCode = await runCli([
        "tag",
        "query",
        "--input",
        JSON.stringify({ userIdList: ["gtcid-1"] }),
      ], {
        profileService,
        executor,
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: true,
        },
      });
      const output = JSON.parse(stdout.value) as {
        ok: boolean;
        operation: string;
        data: { data: { validTags: unknown[] } };
      };

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(2);
      expect(String(calls[0]?.input)).toMatch(/\/tag-e2e-app-id\/auth$/);
      expect(output).toMatchObject({
        ok: true,
        operation: "tag.user",
        data: { data: { validTags: [{ userId: "gtcid-1" }] } },
      });
      expect(stdout.value).not.toContain("tag-e2e-token");
      expect(stderr.value).toBe("");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("user commands", () => {
  const eventInput = {
    dataList: [{
      gtcid: "synthetic-gtcid",
      datetime: "1712646657000",
      eventId: "launch",
      properties: { $app_type: "app", $os: "android", custom: true },
    }],
  };

  it("maps both import commands and the crowd export flow", async () => {
    const cases: Array<{
      args: string[];
      operation: OperationName;
      input: Record<string, unknown>;
      confirmed?: boolean;
    }> = [
      {
        args: ["user", "import", "event", "--input", JSON.stringify(eventInput), "--yes"],
        operation: "user.import.event",
        input: eventInput,
        confirmed: true,
      },
      {
        args: ["user", "import", "user", "--input", JSON.stringify({
          dataList: [{
            gtcid: "synthetic-gtcid",
            datetime: "1712646657000",
            properties: { $app_type: "h5", $os: "web" },
          }],
        }), "--yes"],
        operation: "user.import.user",
        input: {
          dataList: [{
            gtcid: "synthetic-gtcid",
            datetime: "1712646657000",
            properties: { $app_type: "h5", $os: "web" },
          }],
        },
        confirmed: true,
      },
      {
        args: ["user", "crowd", "list"],
        operation: "user.crowd.list",
        input: {},
      },
      {
        args: [
          "user", "crowd", "export", "create",
          "--crowd-id", "crowd-1", "--uid-type", "GTCID", "--yes",
        ],
        operation: "user.crowd.export.create",
        input: { crowdId: "crowd-1", uidType: "GTCID" },
        confirmed: true,
      },
      {
        args: [
          "user", "crowd", "export", "status",
          "--crowd-id", "crowd-1", "--task-id", "1001",
        ],
        operation: "user.crowd.export.status",
        input: { crowdId: "crowd-1", taskId: 1001 },
      },
      {
        args: [
          "user", "crowd", "export", "file",
          "--crowd-id", "crowd-1", "--task-id", "1001", "--file-id", "file-1",
        ],
        operation: "user.crowd.export.file",
        input: { crowdId: "crowd-1", taskId: 1001, fileId: "file-1" },
      },
    ];

    for (const item of cases) {
      const cli = harness();
      expect(await cli.run(item.args)).toBe(0);
      expect(cli.executor.execute).toHaveBeenCalledWith(
        item.operation,
        item.input,
        expect.objectContaining({
          confirmMutations: item.confirmed === true,
        }),
      );
    }
  });

  it("accepts import JSON from non-TTY stdin", async () => {
    const cli = harness({
      io: {
        stdin: Readable.from([]),
        stdout: new CaptureStream(),
        stderr: new CaptureStream(),
        stdinIsTTY: false,
      },
      readStdin: vi.fn(async () => JSON.stringify(eventInput)),
    });
    expect(await cli.run(["user", "import", "event", "--yes"])).toBe(0);
    expect(cli.executor.execute).toHaveBeenCalledWith(
      "user.import.event",
      eventInput,
      expect.objectContaining({ confirmMutations: true }),
    );
  });

  it("keeps api call and human crowd commands equivalent", async () => {
    const human = harness();
    expect(await human.run([
      "user", "crowd", "export", "status",
      "--crowd-id", "crowd-1", "--task-id", "1001",
    ])).toBe(0);
    const api = harness();
    expect(await api.run([
      "api", "call", "user.crowd.export.status",
      "--input", JSON.stringify({ crowdId: "crowd-1", taskId: 1001 }),
    ])).toBe(0);
    expect(human.executor.execute.mock.calls[0]?.slice(0, 2)).toEqual(
      api.executor.execute.mock.calls[0]?.slice(0, 2),
    );
  });

  it("exposes user commands and confirmation in help", async () => {
    const cli = harness();
    expect(await cli.run(["user", "--help"])).toBe(0);
    expect(cli.stdout.value).toContain("import");
    expect(cli.stdout.value).toContain("crowd");
    const importHelp = harness();
    expect(await importHelp.run(["user", "import", "event", "--help"])).toBe(0);
    expect(importHelp.stdout.value).toContain("--input");
    expect(importHelp.stdout.value).toContain("--input-file");
    expect(importHelp.stdout.value).toContain("--yes");
  });
});

describe("mocked user API flow", () => {
  it("runs vector query and batch through CLI, auth, client, and fixed endpoints", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-vector-e2e-"));
    const now = Date.now();
    const profileService = new ProfileService({
      baseDir,
      env: {
        GETUI_APP_ID: "synthetic-vector-app-id",
        GETUI_APP_KEY: "synthetic-vector-app-key",
        GETUI_MASTER_SECRET: "synthetic-vector-master-secret",
      },
      secretStore: new MemorySecretStore(false),
    });
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ input, init });
        const url = String(input);
        if (url.endsWith("/auth")) {
          return new Response(JSON.stringify({
            code: 0,
            msg: "success",
            data: { token: "synthetic-vector-token", expireTime: now + 60 * 60 * 1000 },
          }));
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url.endsWith("/v2/query_vector")) {
          expect(body).toEqual({ userId: "synthetic-gtcid-1" });
          return new Response(JSON.stringify({
            code: 0,
            msg: "success",
            data: { userId: "synthetic-gtcid-1", vert: "[0.1,-0.2]" },
          }));
        }
        expect(url).toMatch(/\/v2\/batch_query_vector$/);
        expect(body).toEqual({
          userIdList: ["synthetic-gtcid-1", "synthetic-gtcid-2"],
        });
        return new Response(JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            validVectors: [{ userId: "synthetic-gtcid-1", vert: "[0.1,-0.2]" }],
            invalidVectors: [{ userId: "synthetic-gtcid-2", reason: "not found" }],
          },
        }));
      },
    );
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const executor = new OperationExecutor({ profileService, client });

    const invoke = async (args: string[]) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(args, {
        profileService,
        executor,
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: true,
        },
      });
      return { exitCode, stdout: stdout.value, stderr: stderr.value };
    };

    try {
      const single = await invoke([
        "user", "vector", "query", "--gtcid", "synthetic-gtcid-1",
      ]);
      expect(single.exitCode).toBe(0);
      expect(JSON.parse(single.stdout)).toMatchObject({
        ok: true,
        operation: "user.vector.query",
        query: { userId: "synthetic-gtcid-1" },
        data: {
          code: 0,
          msg: "success",
          data: { userId: "synthetic-gtcid-1", vert: "[0.1,-0.2]" },
        },
      });

      const batch = await invoke([
        "api", "call", "user.vector.batch", "--input",
        JSON.stringify({
          userIdList: ["synthetic-gtcid-1", "synthetic-gtcid-2"],
        }),
      ]);
      expect(batch.exitCode).toBe(0);
      expect(JSON.parse(batch.stdout)).toMatchObject({
        ok: true,
        operation: "user.vector.batch",
        data: {
          data: {
            validVectors: [{ userId: "synthetic-gtcid-1" }],
            invalidVectors: [{ userId: "synthetic-gtcid-2" }],
          },
        },
      });
      expect(calls).toHaveLength(3);
      expect(String(calls[1]?.input)).toMatch(/\/v2\/query_vector$/);
      expect(String(calls[2]?.input)).toMatch(/\/v2\/batch_query_vector$/);
      expect(single.stdout).not.toContain("synthetic-vector-token");
      expect(batch.stdout).not.toContain("synthetic-vector-master-secret");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("preserves a vector VIP failure without reporting success", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-vector-vip-"));
    const now = Date.now();
    const profileService = new ProfileService({
      baseDir,
      env: {
        GETUI_APP_ID: "synthetic-vip-app-id",
        GETUI_APP_KEY: "synthetic-vip-app-key",
        GETUI_MASTER_SECRET: "synthetic-vip-master-secret",
      },
      secretStore: new MemorySecretStore(false),
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith("/auth")) {
        return new Response(JSON.stringify({
          code: 0,
          msg: "success",
          data: { token: "synthetic-vip-token", expireTime: now + 60 * 60 * 1000 },
        }));
      }
      return new Response(JSON.stringify({
        code: 40001,
        msg: "VIP feature is not enabled",
        data: null,
      }));
    });
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    try {
      const exitCode = await runCli([
        "user", "vector", "query", "--gtcid", "synthetic-gtcid-1",
      ], {
        profileService,
        executor: new OperationExecutor({ profileService, client }),
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: true,
        },
      });
      expect(exitCode).toBe(5);
      expect(stdout.value).toBe("");
      expect(JSON.parse(stderr.value)).toMatchObject({
        ok: false,
        error: {
          type: "permission",
          code: "GETUI_CLI_PERMISSION_DENIED",
          retryable: false,
          details: {
            remoteCode: 40001,
            remoteResponse: { msg: "VIP feature is not enabled" },
          },
        },
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("runs import and the explicit crowd list/create/status/file sequence", async () => {
    const eventInput = {
      dataList: [{
        gtcid: "synthetic-gtcid",
        datetime: "1712646657000",
        eventId: "launch",
        properties: { $app_type: "app", $os: "android", custom: true },
      }],
    };
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-user-e2e-"));
    const now = Date.now();
    const profileService = new ProfileService({
      baseDir,
      env: {
        GETUI_APP_ID: "synthetic-app-id",
        GETUI_APP_KEY: "synthetic-app-key",
        GETUI_MASTER_SECRET: "synthetic-master-secret",
      },
      secretStore: new MemorySecretStore(false),
    });
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ input, init });
        const url = String(input);
        if (url.endsWith("/auth")) {
          return new Response(JSON.stringify({
            code: 0,
            msg: "success",
            data: { token: "synthetic-token", expireTime: now + 60 * 60 * 1000 },
          }));
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url.endsWith("/import/event")) {
          expect(body).toEqual(eventInput);
          return new Response(JSON.stringify({ code: "0", msg: "success" }));
        }
        if (url.endsWith("/export/crowd/exportableCrowdList")) {
          expect(body).toEqual({});
          return new Response(JSON.stringify({
            code: "0",
            msg: "success",
            data: {
              list: [{
                crowdId: "synthetic-crowd",
                crowdName: "Synthetic crowd",
                crowdCount: 2,
                lastCompleteTime: "2026-08-01 00:00:00",
              }],
              total: 1,
            },
          }));
        }
        if (url.endsWith("/export/crowd/createCrowdExportTask")) {
          expect(body).toEqual({ crowdId: "synthetic-crowd", uidType: "GTCID" });
          return new Response(JSON.stringify({
            code: 0,
            msg: "success",
            data: { taskId: 1001 },
          }));
        }
        if (url.endsWith("/export/crowd/exportCrowdTaskStatus")) {
          expect(body).toEqual({ crowdId: "synthetic-crowd", taskId: 1001 });
          return new Response(JSON.stringify({
            code: "0",
            msg: "success",
            data: {
              appId: "synthetic-app-id",
              crowdId: "synthetic-crowd",
              taskId: 1001,
              uidType: "GTCID",
              status: 1,
              fileIdList: ["synthetic-file"],
            },
          }));
        }
        expect(url).toMatch(/\/export\/crowd\/exportCrowdSingleFile$/);
        expect(body).toEqual({
          crowdId: "synthetic-crowd",
          taskId: 1001,
          fileId: "synthetic-file",
        });
        return new Response(JSON.stringify({
          code: 0,
          msg: "success",
          data: { list: ["synthetic-id-1", "synthetic-id-2"], total: 2 },
        }));
      },
    );
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => now,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const executor = new OperationExecutor({ profileService, client });

    const invoke = async (args: string[]) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(args, {
        profileService,
        executor,
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: true,
        },
      });
      return { exitCode, stdout: stdout.value, stderr: stderr.value };
    };

    try {
      const imported = await invoke([
        "user", "import", "event", "--input", JSON.stringify(eventInput), "--yes",
      ]);
      expect(imported.exitCode).toBe(0);
      expect(JSON.parse(imported.stdout)).toMatchObject({
        operation: "user.import.event",
        query: { importType: "event", recordCount: 1 },
        data: { code: "0", msg: "success", data: {
          importType: "event", recordCount: 1,
        } },
      });

      expect((await invoke(["user", "crowd", "list"])).exitCode).toBe(0);
      expect((await invoke([
        "user", "crowd", "export", "create",
        "--crowd-id", "synthetic-crowd", "--uid-type", "GTCID", "--yes",
      ])).exitCode).toBe(0);
      expect((await invoke([
        "user", "crowd", "export", "status",
        "--crowd-id", "synthetic-crowd", "--task-id", "1001",
      ])).exitCode).toBe(0);
      const file = await invoke([
        "user", "crowd", "export", "file",
        "--crowd-id", "synthetic-crowd", "--task-id", "1001", "--file-id", "synthetic-file",
      ]);
      expect(file.exitCode).toBe(0);
      expect(JSON.parse(file.stdout)).toMatchObject({
        data: { data: { list: ["synthetic-id-1", "synthetic-id-2"], total: 2 } },
      });
      expect(calls).toHaveLength(6);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("output and errors", () => {
  it("uses JSON by default and supports table, text, and raw JSON", async () => {
    const json = harness();
    expect(await json.run(["stats", "today"])).toBe(0);
    expect(JSON.parse(json.stdout.value)).toMatchObject({
      schemaVersion: "1.0",
      ok: true,
      mode: "normalized",
    });

    const table = harness();
    expect(
      await table.run(["--format", "table", "stats", "today"]),
    ).toBe(0);
    expect(table.stdout.value).toContain("operation");
    expect(table.stdout.value).not.toContain('"schemaVersion"');

    const text = harness();
    expect(
      await text.run(["--format", "text", "stats", "today"]),
    ).toBe(0);
    expect(text.stdout.value).toContain("Operation: statistics.today");

    const raw = harness();
    expect(await raw.run(["--raw", "stats", "today"])).toBe(0);
    expect(JSON.parse(raw.stdout.value).mode).toBe("raw");
  });

  it("rejects raw table output before execution", async () => {
    for (const format of ["table", "text"]) {
      const cli = harness();
      expect(
        await cli.run(["--raw", "--format", format, "stats", "today"]),
      ).toBe(2);
      expect(cli.executor.execute).not.toHaveBeenCalled();
      expect(cli.stdout.value).toBe("");
      expect(cli.stderr.value).toContain("GETUI_CLI_RAW_FORMAT_CONFLICT");
    }
  });

  it("keeps success on stdout and errors on stderr with stable exit codes", async () => {
    const success = harness();
    expect(await success.run(["stats", "today"])).toBe(0);
    expect(success.stdout.value).not.toBe("");
    expect(success.stderr.value).toBe("");

    const failure = harness({
      executor: {
        execute: vi.fn(async () => {
          throw new CliError("Permission denied", {
            type: "permission",
            code: "GETUI_CLI_PERMISSION_DENIED",
            stage: "response",
          });
        }),
      },
    });
    expect(await failure.run(["stats", "today"])).toBe(5);
    expect(failure.stdout.value).toBe("");
    expect(JSON.parse(failure.stderr.value)).toMatchObject({
      ok: false,
      error: { type: "permission", code: "GETUI_CLI_PERMISSION_DENIED" },
      meta: { operation: "statistics.today" },
    });
  });

  it("keeps remote HTTP JSON details and redacts sensitive response fields", async () => {
    const cli = harness({
      executor: {
        execute: vi.fn(async () => {
          throw new CliError("Getui request failed with HTTP 400", {
            type: "remote",
            code: "GETUI_CLI_REMOTE_HTTP_ERROR",
            stage: "response",
            details: {
              status: 400,
              remoteResponse: {
                code: 20001,
                msg: "超过允许时间跨度",
                data: null,
                token: "secret-token",
                appId: "secret-app-id",
                nested: { authorization: "secret-authorization" },
              },
            },
          });
        }),
      },
    });

    expect(await cli.run(["api", "call", "statistics.retention"])).toBe(7);
    const output = JSON.parse(cli.stderr.value) as {
      error: { details: Record<string, unknown> };
    };
    expect(output.error.details).toMatchObject({
      status: 400,
      remoteResponse: {
        code: 20001,
        msg: "超过允许时间跨度",
        data: null,
        token: "[REDACTED]",
        appId: "[REDACTED]",
        nested: { authorization: "[REDACTED]" },
      },
    });
  });

  it("redacts application identifiers and keys from local command output", async () => {
    const cli = harness();
    expect(await cli.run(["app", "show", "production"])).toBe(0);
    expect(cli.stdout.value).not.toContain("app-id");
    expect(cli.stdout.value).not.toContain("app-key");
    expect(cli.stdout.value).toContain("[REDACTED]");
  });

  it.each([
    ["usage", 2],
    ["validation", 2],
    ["configuration", 3],
    ["credentials", 3],
    ["authentication", 4],
    ["permission", 5],
    ["network", 6],
    ["remote", 7],
  ] as const)("maps %s errors to exit code %i", async (type, exitCode) => {
    const cli = harness({
      executor: {
        execute: vi.fn(async () => {
          throw new CliError("failure", {
            type,
            code: `GETUI_CLI_${type.toUpperCase()}`,
            stage: type === "configuration" || type === "credentials"
              ? type
              : type === "authentication"
                ? "authentication"
                : type === "usage" || type === "validation"
                  ? "input"
                  : type === "remote"
                    ? "response"
                    : "request",
          });
        }),
      },
    });
    expect(await cli.run(["stats", "today"])).toBe(exitCode);
  });

  it("maps unknown failures to the internal exit code", async () => {
    const cli = harness({
      executor: {
        execute: vi.fn(async () => {
          throw new Error("unexpected");
        }),
      },
    });
    expect(await cli.run(["stats", "today"])).toBe(8);
    expect(cli.stderr.value).toContain("GETUI_CLI_INTERNAL_ERROR");
  });
});

describe("shared execution chain", () => {
  it("preserves null retention cohorts in platform-grouped CLI output", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-retention-e2e-"));
    const credentials = {
      GETUI_APP_ID: "retention-app-id",
      GETUI_APP_KEY: "retention-app-key",
      GETUI_MASTER_SECRET: "retention-master-secret",
    };
    const profileService = new ProfileService({
      baseDir,
      env: credentials,
      secretStore: new MemorySecretStore(false),
    });
    const retentionResponse = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "tests",
          "fixtures",
          "retention-platform-null-success.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("/auth")) {
          return new Response(JSON.stringify({
            code: 0,
            data: { token: "retention-token", expireTime: 1_786_010_800_000 },
          }));
        }
        expect(String(input)).toBe(
          "https://ido.getui.com/openapi/retention-app-id/export/remainChart",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          startDate: "2026-07-01",
          endDate: "2026-07-30",
          analyzeType: 1,
          foregroundFlag: "1",
          aggregatorType: 1,
        });
        return new Response(JSON.stringify(retentionResponse));
      },
    );
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => 1_786_000_000_000,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const executor = new OperationExecutor({ profileService, client });
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    try {
      const exitCode = await runCli([
        "stats",
        "retention",
        "--start-date",
        "2026-07-01",
        "--end-date",
        "2026-07-30",
        "--group-by",
        "platform",
        "--metric",
        "active",
      ], {
        profileService,
        executor,
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: true,
        },
      });
      const output = JSON.parse(stdout.value) as {
        ok: boolean;
        operation: string;
        query: Record<string, unknown>;
        data: {
          dimensions: Array<{
            dimension: string;
            cohorts: Array<{ userCount: number | null; day1Percent: number | null }>;
          }>;
        };
      };

      expect(exitCode).toBe(0);
      expect(output).toMatchObject({
        ok: true,
        operation: "statistics.retention",
        query: { metric: "active", groupBy: "platform" },
      });
      expect(output.data.dimensions.map((item) => item.dimension)).toEqual([
        "total",
        "Android",
        "iOS",
        "鸿蒙",
        "unknown",
      ]);
      expect(output.data.dimensions[4]?.cohorts[0]).toMatchObject({
        userCount: null,
        day1Percent: null,
      });
      expect(stderr.value).toBe("");
      const rendered = `${stdout.value}${stderr.value}`;
      for (const sensitive of [
        ...Object.values(credentials),
        "retention-token",
      ]) {
        expect(rendered).not.toContain(sensitive);
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("produces the same trend request and data for stdin API and stats inputs", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-env-e2e-"));
    const credentials = {
      GETUI_APP_ID: "env-app-id",
      GETUI_APP_KEY: "env-app-key",
      GETUI_MASTER_SECRET: "env-master-secret",
    };
    const profileService = new ProfileService({
      baseDir,
      env: credentials,
      secretStore: new MemorySecretStore(false),
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).endsWith("/auth")) {
          return new Response(JSON.stringify({
            code: 0,
            data: { token: "environment-token", expireTime: 1_786_010_800_000 },
          }));
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            list: [
              {
                dimension: "total",
                statisticsDataList: [{ time: "2026-08-01", value: "10" }],
              },
            ],
          },
        }));
      },
    );
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => 1_786_000_000_000,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const executor = new OperationExecutor({ profileService, client });
    const invoke = async (args: string[], stdin = "") => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(args, {
        profileService,
        executor,
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: stdin.length === 0,
        },
        readStdin: vi.fn(async () => stdin),
      });
      return { exitCode, output: JSON.parse(stdout.value), stderr: stderr.value };
    };
    const input = {
      startDate: "2026-08-01",
      endDate: "2026-08-07",
      metric: "active",
      platforms: ["android", "ios"],
    };
    try {
      const api = await invoke(
        ["api", "call", "statistics.userTrend"],
        JSON.stringify(input),
      );
      const stats = await invoke([
        "stats",
        "trend",
        "--start-date",
        "2026-08-01",
        "--end-date",
        "2026-08-07",
        "--metric",
        "active",
        "--platforms",
        "android,ios",
      ]);

      expect(api.exitCode).toBe(0);
      expect(stats.exitCode).toBe(0);
      expect(api.output.data).toEqual(stats.output.data);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/auth$/);
      const statisticCalls = fetchMock.mock.calls.slice(1);
      expect(statisticCalls.map((call) => String(call[0]))).toEqual([
        "https://ido.getui.com/openapi/env-app-id/export/userTrendChart",
        "https://ido.getui.com/openapi/env-app-id/export/userTrendChart",
      ]);
      expect(`${api.stderr}${stats.stderr}`).toBe("");
      await expect(readFile(profileService.paths.configPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(profileService.paths.tokenMetadataPath, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("keeps tokens isolated while switching between two profiles", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-multi-e2e-"));
    const store = new MemorySecretStore();
    const profileService = new ProfileService({
      baseDir,
      env: {},
      secretStore: store,
      now: () => new Date("2026-08-07T08:00:00.000Z"),
    });
    await profileService.add({
      alias: "one",
      appId: "multi-app-one",
      appKey: "multi-key-one",
      masterSecret: "multi-secret-one",
    });
    await profileService.add({
      alias: "two",
      appId: "multi-app-two",
      appKey: "multi-key-two",
      masterSecret: "multi-secret-two",
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/auth")) {
          const token = url.includes("multi-app-one") ? "token-one" : "token-two";
          return new Response(JSON.stringify({
            code: 0,
            data: { token, expireTime: 1_786_010_800_000 },
          }));
        }
        const expectedToken = url.includes("multi-app-one") ? "token-one" : "token-two";
        expect((init?.headers as Record<string, string>).token).toBe(expectedToken);
        return new Response(JSON.stringify({
          code: 0,
          data: {
            list: [
              {
                dimension: "total",
                statisticsData: {
                  install: { cnt: 1, ytdPercent: null, sevenPercent: null },
                  active: { cnt: 2, ytdPercent: null, sevenPercent: null },
                  start: { cnt: 3, ytdPercent: null, sevenPercent: null },
                },
              },
            ],
          },
        }));
      },
    );
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => 1_786_000_000_000,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const executor = new OperationExecutor({ profileService, client });
    const invoke = async (args: string[]) => {
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runCli(args, {
        profileService,
        executor,
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: true,
        },
      });
      return { exitCode, stdout: stdout.value, stderr: stderr.value };
    };

    try {
      expect((await invoke(["app", "use", "one"])).exitCode).toBe(0);
      const one = await invoke(["stats", "today"]);
      expect((await invoke(["app", "use", "two"])).exitCode).toBe(0);
      const two = await invoke(["stats", "today"]);

      expect(one.exitCode).toBe(0);
      expect(two.exitCode).toBe(0);
      const statisticsUrls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.endsWith("/export/todayStatistics"));
      expect(statisticsUrls).toEqual([
        "https://ido.getui.com/openapi/multi-app-one/export/todayStatistics",
        "https://ido.getui.com/openapi/multi-app-two/export/todayStatistics",
      ]);
      const output = `${one.stdout}${one.stderr}${two.stdout}${two.stderr}`;
      for (const sensitive of [
        "multi-app-one",
        "multi-app-two",
        "multi-key-one",
        "multi-key-two",
        "multi-secret-one",
        "multi-secret-two",
        "token-one",
        "token-two",
      ]) {
        expect(output).not.toContain(sensitive);
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("recovers once from code 10001 and emits redacted debug diagnostics", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "getui-cli-replay-e2e-"));
    const profileService = new ProfileService({
      baseDir,
      env: {
        GETUI_APP_ID: "replay-app-id",
        GETUI_APP_KEY: "replay-app-key",
        GETUI_MASTER_SECRET: "replay-master-secret",
      },
      secretStore: new MemorySecretStore(false),
    });
    let authCount = 0;
    let statisticsCount = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).endsWith("/auth")) {
          authCount += 1;
          return new Response(JSON.stringify({
            code: 0,
            data: {
              token: `replay-token-${authCount}`,
              expireTime: 1_786_010_800_000,
            },
          }));
        }
        statisticsCount += 1;
        if (statisticsCount === 1) {
          return new Response(JSON.stringify({ code: 10001, msg: "expired" }));
        }
        return new Response(JSON.stringify({
          code: 0,
          data: {
            list: [
              {
                dimension: "total",
                statisticsData: {
                  install: { cnt: 1, ytdPercent: null, sevenPercent: null },
                  active: { cnt: 2, ytdPercent: null, sevenPercent: null },
                  start: { cnt: 3, ytdPercent: null, sevenPercent: null },
                },
              },
            ],
          },
        }));
      },
    );
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const client = new GetuiClient({
      profileService,
      fetch: fetchMock as typeof fetch,
      now: () => 1_786_000_000_000,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const executor = new OperationExecutor({
      profileService,
      client,
      onDiagnostics(events) {
        stderr.write(`${renderDiagnostics(events)}\n`);
      },
    });

    try {
      const exitCode = await runCli(["--debug", "stats", "today"], {
        profileService,
        executor,
        io: {
          stdin: Readable.from([]),
          stdout,
          stderr,
          stdinIsTTY: true,
        },
      });
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.value)).toMatchObject({ ok: true });
      expect(authCount).toBe(2);
      expect(statisticsCount).toBe(2);
      expect(stderr.value).toContain("forcing one refresh");
      expect(stderr.value).toContain("Token refreshed");
      for (const sensitive of [
        "replay-app-id",
        "replay-app-key",
        "replay-master-secret",
        "replay-token-1",
        "replay-token-2",
      ]) {
        expect(`${stdout.value}${stderr.value}`).not.toContain(sensitive);
      }
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
