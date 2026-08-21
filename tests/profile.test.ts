import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemorySecretStore,
  ProfileService,
  resolveAppPaths,
} from "../src/profile.js";

const NOW = new Date("2026-08-07T08:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "getui-profile-"));
  tempDirectories.push(directory);
  return directory;
}

function createService(
  baseDir: string,
  secretStore = new MemorySecretStore(),
  env: NodeJS.ProcessEnv = {},
): ProfileService {
  return new ProfileService({
    baseDir,
    secretStore,
    env,
    now: () => NOW,
  });
}

describe("ProfileService configuration", () => {
  it("adds, lists, selects, and removes applications without exposing secrets", async () => {
    const baseDir = await temporaryDirectory();
    const service = createService(baseDir);
    const first = await service.add({
      alias: "app-a",
      appId: "id-a",
      appKey: "key-a",
      masterSecret: "secret-a",
    });
    await service.add({
      alias: "app-b",
      appId: "id-b",
      appKey: "key-b",
      masterSecret: "secret-b",
    });

    expect(first).not.toHaveProperty("masterSecret");
    expect((await service.list()).map((profile) => profile.alias)).toEqual([
      "app-a",
      "app-b",
    ]);
    expect((await service.get()).alias).toBe("app-a");
    await service.use("app-b");
    expect((await service.get()).alias).toBe("app-b");

    await service.setToken("id-b", "token-b", NOW.getTime() + 3_600_000);
    await service.remove("app-b");
    expect((await service.list()).map((profile) => profile.alias)).toEqual([
      "app-a",
    ]);
    expect(await service.getDefaultAlias()).toBeUndefined();
    expect(await service.getToken("id-b")).toBeNull();

    await service.add({ alias: "app-b", appId: "id-b", appKey: "key-b" });
    await expect(service.resolveCredentials("app-b")).rejects.toMatchObject({
      code: "GETUI_CLI_PROFILE_SECRET_UNAVAILABLE",
    });

    const config = await readFile(service.paths.configPath, "utf8");
    const metadata = await readFile(service.paths.tokenMetadataPath, "utf8");
    expect(`${config}\n${metadata}`).not.toContain("secret-a");
    expect(`${config}\n${metadata}`).not.toContain("secret-b");
    expect(`${config}\n${metadata}`).not.toContain("token-b");
  });

  it("rejects duplicate aliases, duplicate app IDs, and invalid aliases", async () => {
    const baseDir = await temporaryDirectory();
    const service = createService(baseDir);
    await service.add({ alias: "primary", appId: "id-a", appKey: "key-a" });

    await expect(
      service.add({ alias: "primary", appId: "id-b", appKey: "key-b" }),
    ).rejects.toMatchObject({ code: "GETUI_CLI_PROFILE_ALIAS_EXISTS" });
    await expect(
      service.add({ alias: "secondary", appId: "id-a", appKey: "key-b" }),
    ).rejects.toMatchObject({ code: "GETUI_CLI_PROFILE_APP_ID_EXISTS" });
    await expect(
      service.add({ alias: "not valid", appId: "id-c", appKey: "key-c" }),
    ).rejects.toMatchObject({ code: "GETUI_CLI_PROFILE_ALIAS_INVALID" });
  });

  it("rejects configuration documents containing plaintext secret fields", async () => {
    const baseDir = await temporaryDirectory();
    const service = createService(baseDir);
    await service.initialize();
    await writeFile(
      service.paths.configPath,
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          unsafe: {
            alias: "unsafe",
            appId: "id",
            appKey: "key",
            masterSecret: "plaintext-secret",
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        },
      }),
    );

    await expect(service.list()).rejects.toMatchObject({
      code: "GETUI_CLI_CONFIG_INVALID",
      type: "configuration",
    });
  });

  it("serializes concurrent updates into one valid configuration document", async () => {
    const baseDir = await temporaryDirectory();
    const services = Array.from({ length: 8 }, () => createService(baseDir));

    await Promise.all(
      services.map((service, index) =>
        service.add({
          alias: `app-${index}`,
          appId: `id-${index}`,
          appKey: `key-${index}`,
        }),
      ),
    );

    const raw = await readFile(services[0]!.paths.configPath, "utf8");
    const document = JSON.parse(raw) as {
      profiles: Record<string, unknown>;
    };
    expect(Object.keys(document.profiles)).toHaveLength(8);
    expect(await services[0]!.list()).toHaveLength(8);
    await Promise.all(
      services.map((service, index) => service.use(`app-${index}`)),
    );
    const afterUse = JSON.parse(
      await readFile(services[0]!.paths.configPath, "utf8"),
    ) as { defaultProfile: string; profiles: Record<string, unknown> };
    expect(Object.keys(afterUse.profiles)).toHaveLength(8);
    expect(afterUse.defaultProfile).toMatch(/^app-[0-7]$/);
    if (process.platform !== "win32") {
      expect((await stat(services[0]!.paths.configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(baseDir)).mode & 0o777).toBe(0o700);
    }
  });

  it("reports missing, valid, refresh-soon, expired, and memory-only token states", async () => {
    const baseDir = await temporaryDirectory();
    const service = createService(baseDir);
    await service.add({ alias: "status", appId: "status-id", appKey: "status-key" });
    expect((await service.getStatus("status")).tokenStatus).toBe("missing");

    await service.setToken("status-id", "valid", NOW.getTime() + 3_600_000);
    expect((await service.getStatus("status")).tokenStatus).toBe("valid");
    const metadata = await readFile(service.paths.tokenMetadataPath, "utf8");
    expect(metadata).not.toContain("status-id");
    expect(metadata).not.toContain('"valid"');
    await service.setToken("status-id", "soon", NOW.getTime() + 4 * 60_000);
    expect((await service.getStatus("status")).tokenStatus).toBe("refresh-soon");
    await service.setToken("status-id", "expired", NOW.getTime() - 1);
    expect((await service.getStatus("status")).tokenStatus).toBe("expired");

    const memoryBaseDir = await temporaryDirectory();
    const memory = createService(memoryBaseDir, new MemorySecretStore(false));
    await memory.add({ alias: "memory", appId: "memory-id", appKey: "memory-key" });
    await memory.setToken("memory-id", "memory-token", NOW.getTime() + 3_600_000);
    expect((await memory.getStatus("memory")).tokenStatus).toBe("memory-only");
  });
});

describe("credential resolution", () => {
  it("uses complete environment credentials before all local selections", async () => {
    const baseDir = await temporaryDirectory();
    const store = new MemorySecretStore();
    const setup = createService(baseDir, store);
    await setup.add({
      alias: "local",
      appId: "local-id",
      appKey: "local-key",
      masterSecret: "local-secret",
    });
    const service = createService(baseDir, store, {
      GETUI_APP_ID: "env-id",
      GETUI_APP_KEY: "env-key",
      GETUI_MASTER_SECRET: "env-secret",
      GETUI_PROFILE: "local",
    });

    expect(await service.resolveCredentials("local")).toEqual({
      source: "environment",
      appId: "env-id",
      appKey: "env-key",
      masterSecret: "env-secret",
    });
  });

  it("resolves environment profile, command profile, and default profile in order", async () => {
    const baseDir = await temporaryDirectory();
    const store = new MemorySecretStore();
    const setup = createService(baseDir, store);
    for (const alias of ["default", "command", "environment"]) {
      await setup.add({
        alias,
        appId: `${alias}-id`,
        appKey: `${alias}-key`,
        masterSecret: `${alias}-secret`,
      });
    }

    const environmentProfile = createService(baseDir, store, {
      GETUI_PROFILE: "environment",
    });
    expect(await environmentProfile.resolveCredentials("command")).toMatchObject({
      source: "environment-profile",
      profileAlias: "environment",
      appId: "environment-id",
    });
    expect(await setup.resolveCredentials("command")).toMatchObject({
      source: "command-profile",
      profileAlias: "command",
      appId: "command-id",
    });
    expect(await setup.resolveCredentials()).toMatchObject({
      source: "default-profile",
      profileAlias: "default",
      appId: "default-id",
    });
  });

  it("rejects partial environment credentials without mixing local fields", async () => {
    const baseDir = await temporaryDirectory();
    const store = new MemorySecretStore();
    const setup = createService(baseDir, store);
    await setup.add({
      alias: "local",
      appId: "local-id",
      appKey: "local-key",
      masterSecret: "local-secret",
    });
    const partialEnvironments: NodeJS.ProcessEnv[] = [
      { GETUI_APP_ID: "env-id" },
      { GETUI_APP_KEY: "env-key" },
      { GETUI_MASTER_SECRET: "env-secret" },
      { GETUI_APP_ID: "env-id", GETUI_APP_KEY: "env-key" },
      { GETUI_APP_ID: "env-id", GETUI_MASTER_SECRET: "env-secret" },
      { GETUI_APP_KEY: "env-key", GETUI_MASTER_SECRET: "env-secret" },
    ];

    for (const env of partialEnvironments) {
      const service = createService(baseDir, store, env);
      await expect(service.resolveCredentials("local")).rejects.toMatchObject({
        code: "GETUI_CLI_ENV_CREDENTIALS_INCOMPLETE",
      });
    }
  });

  it("never persists a master secret when secure storage is unavailable", async () => {
    const baseDir = await temporaryDirectory();
    const service = createService(baseDir, new MemorySecretStore(false));

    await expect(
      service.add({
        alias: "unsafe",
        appId: "unsafe-id",
        appKey: "unsafe-key",
        masterSecret: "must-not-be-written",
      }),
    ).rejects.toMatchObject({ code: "GETUI_CLI_SECURE_STORE_UNAVAILABLE" });
    await service.add({
      alias: "metadata-only",
      appId: "metadata-id",
      appKey: "metadata-key",
    });

    const config = await readFile(service.paths.configPath, "utf8");
    expect(config).not.toContain("must-not-be-written");
    await expect(service.resolveCredentials("metadata-only")).rejects.toMatchObject({
      code: "GETUI_CLI_PROFILE_SECRET_UNAVAILABLE",
    });
  });
});

describe("platform paths", () => {
  it("uses the documented per-platform configuration directories", () => {
    expect(resolveAppPaths(undefined, "darwin", {}, "/home/user").baseDir).toBe(
      "/home/user/Library/Application Support/getui-cli",
    );
    expect(
      resolveAppPaths(undefined, "linux", { XDG_CONFIG_HOME: "/config" }, "/home/user")
        .baseDir,
    ).toBe("/config/getui-cli");
    expect(
      resolveAppPaths(undefined, "win32", { APPDATA: "C:\\Data" }, "C:\\Users\\User")
        .baseDir,
    ).toBe(path.join("C:\\Data", "getui-cli"));
  });
});
