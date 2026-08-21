import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { CliError } from "./errors.js";
import type {
  AddProfileInput,
  AppProfile,
  ConfigDocument,
  CredentialSource,
  ProfileStatus,
  ResolvedCredentials,
  TokenMetadata,
  TokenMetadataDocument,
  TokenRecord,
  TokenStatus,
} from "./types.js";

const PROFILE_SERVICE = "getui-cli.profile";
const TOKEN_SERVICE = "getui-cli.token";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;

const profileSchema = z
  .object({
    alias: z.string().min(1),
    appId: z.string().min(1),
    appKey: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultProfile: z.string().min(1).optional(),
    profiles: z.record(z.string(), profileSchema),
  })
  .strict();

const tokenMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.record(
      z.string(),
      z
        .object({
          applicationKey: z.string().min(1),
          expiresAt: z.number().int().nonnegative(),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export interface AppPaths {
  baseDir: string;
  configPath: string;
  tokenMetadataPath: string;
  locksDir: string;
}

export interface SecretStore {
  isAvailable(): Promise<boolean>;
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  constructor(private readonly available = true) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async get(service: string, account: string): Promise<string | null> {
    if (!this.available) {
      return null;
    }
    return this.values.get(`${service}:${account}`) ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    if (!this.available) {
      throw secureStoreUnavailable();
    }
    this.values.set(`${service}:${account}`, value);
  }

  async delete(service: string, account: string): Promise<void> {
    if (this.available) {
      this.values.delete(`${service}:${account}`);
    }
  }
}

export class KeyringSecretStore implements SecretStore {
  private modulePromise?: Promise<typeof import("@napi-rs/keyring") | null>;
  private disabled = false;

  private load(): Promise<typeof import("@napi-rs/keyring") | null> {
    if (this.disabled) {
      return Promise.resolve(null);
    }
    this.modulePromise ??= import("@napi-rs/keyring").catch(() => null);
    return this.modulePromise;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  async get(service: string, account: string): Promise<string | null> {
    const module = await this.load();
    if (module === null) {
      return null;
    }
    try {
      return (await new module.AsyncEntry(service, account).getPassword()) ?? null;
    } catch (error) {
      if (isMissingCredential(error)) {
        return null;
      }
      this.disabled = true;
      throw secureStoreUnavailable(error);
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const module = await this.load();
    if (module === null) {
      throw secureStoreUnavailable();
    }
    try {
      await new module.AsyncEntry(service, account).setPassword(value);
    } catch (error) {
      this.disabled = true;
      throw secureStoreUnavailable(error);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    const module = await this.load();
    if (module === null) {
      return;
    }
    try {
      await new module.AsyncEntry(service, account).deleteCredential();
    } catch (error) {
      if (!isMissingCredential(error)) {
        this.disabled = true;
        throw secureStoreUnavailable(error);
      }
    }
  }
}

export interface ProfileServiceOptions {
  baseDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  secretStore?: SecretStore | undefined;
  now?: (() => Date) | undefined;
}

export function resolveAppPaths(
  baseDir?: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): AppPaths {
  let resolvedBaseDir = baseDir;
  if (resolvedBaseDir === undefined) {
    if (platform === "darwin") {
      resolvedBaseDir = path.join(
        homeDir,
        "Library",
        "Application Support",
        "getui-cli",
      );
    } else if (platform === "win32") {
      resolvedBaseDir = path.join(
        env.APPDATA ?? path.join(homeDir, "AppData", "Roaming"),
        "getui-cli",
      );
    } else {
      resolvedBaseDir = path.join(
        env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config"),
        "getui-cli",
      );
    }
  }

  return {
    baseDir: resolvedBaseDir,
    configPath: path.join(resolvedBaseDir, "config.json"),
    tokenMetadataPath: path.join(resolvedBaseDir, "token-metadata.json"),
    locksDir: path.join(resolvedBaseDir, "locks"),
  };
}

export class ProfileService {
  readonly paths: AppPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly secretStore: SecretStore;
  private readonly now: () => Date;
  private readonly memoryTokens = new Map<string, TokenRecord>();

  constructor(options: ProfileServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.paths = resolveAppPaths(options.baseDir, process.platform, this.env);
    this.secretStore = options.secretStore ?? new KeyringSecretStore();
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await mkdir(this.paths.baseDir, { recursive: true, mode: 0o700 });
    await mkdir(this.paths.locksDir, { recursive: true, mode: 0o700 });
  }

  async isSecretStoreAvailable(): Promise<boolean> {
    return this.secretStore.isAvailable();
  }

  async list(): Promise<AppProfile[]> {
    const config = await this.readConfig();
    return Object.values(config.profiles).sort((left, right) =>
      left.alias.localeCompare(right.alias),
    );
  }

  async get(alias?: string): Promise<AppProfile> {
    const config = await this.readConfig();
    const selectedAlias = alias ?? config.defaultProfile;
    if (selectedAlias === undefined) {
      throw new CliError("No default application is configured", {
        type: "configuration",
        code: "GETUI_CLI_PROFILE_NOT_SELECTED",
        stage: "configuration",
      });
    }
    const profile = config.profiles[selectedAlias];
    if (profile === undefined) {
      throw profileNotFound(selectedAlias);
    }
    return profile;
  }

  async getDefaultAlias(): Promise<string | undefined> {
    return (await this.readConfig()).defaultProfile;
  }

  async add(input: AddProfileInput): Promise<AppProfile> {
    validateAlias(input.alias);
    if (input.masterSecret !== undefined) {
      if (!(await this.secretStore.isAvailable())) {
        throw secureStoreUnavailable();
      }
    }

    return this.withConfigLock(async () => {
      const config = await this.readConfig();
      if (config.profiles[input.alias] !== undefined) {
        throw new CliError(`Application alias already exists: ${input.alias}`, {
          type: "configuration",
          code: "GETUI_CLI_PROFILE_ALIAS_EXISTS",
          stage: "configuration",
        });
      }
      if (
        Object.values(config.profiles).some(
          (profile) => profile.appId === input.appId,
        )
      ) {
        throw new CliError("Application ID is already configured", {
          type: "configuration",
          code: "GETUI_CLI_PROFILE_APP_ID_EXISTS",
          stage: "configuration",
        });
      }

      let secretStored = false;
      try {
        if (input.masterSecret !== undefined) {
          await this.secretStore.set(
            PROFILE_SERVICE,
            profileAccount(input.alias),
            input.masterSecret,
          );
          secretStored = true;
        }
        const timestamp = this.now().toISOString();
        const profile: AppProfile = {
          alias: input.alias,
          appId: input.appId,
          appKey: input.appKey,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        config.profiles[input.alias] = profile;
        config.defaultProfile ??= input.alias;
        await this.writeConfig(config);
        return profile;
      } catch (error) {
        if (secretStored) {
          await this.secretStore
            .delete(PROFILE_SERVICE, profileAccount(input.alias))
            .catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async use(alias: string): Promise<void> {
    await this.withConfigLock(async () => {
      const config = await this.readConfig();
      if (config.profiles[alias] === undefined) {
        throw profileNotFound(alias);
      }
      config.defaultProfile = alias;
      await this.writeConfig(config);
    });
  }

  async remove(alias: string): Promise<void> {
    await this.withApplicationLockByAlias(alias, async () => {
      const profile = await this.get(alias);
      const applicationKey = hashAppId(profile.appId);
      try {
        await this.deleteToken(profile.appId);
        await this.secretStore.delete(
          PROFILE_SERVICE,
          profileAccount(profile.alias),
        );
        await this.withConfigLock(async () => {
          const config = await this.readConfig();
          delete config.profiles[alias];
          if (config.defaultProfile === alias) {
            delete config.defaultProfile;
          }
          await this.writeConfig(config);
        });
      } catch (error) {
        throw new CliError("Application cleanup did not complete", {
          type: "configuration",
          code: "GETUI_CLI_PROFILE_REMOVE_PARTIAL",
          stage: "configuration",
          details: { alias, applicationKey },
          cause: error,
        });
      }
    });
  }

  async resolveCredentials(profileAlias?: string): Promise<ResolvedCredentials> {
    const environment = readEnvironmentCredentials(this.env);
    if (environment.kind === "partial") {
      throw new CliError("Environment credentials must be provided together", {
        type: "credentials",
        code: "GETUI_CLI_ENV_CREDENTIALS_INCOMPLETE",
        stage: "credentials",
        details: { missing: environment.missing },
      });
    }
    if (environment.kind === "complete") {
      return {
        source: "environment",
        appId: environment.appId,
        appKey: environment.appKey,
        masterSecret: environment.masterSecret,
      };
    }

    let source: CredentialSource;
    let alias: string | undefined;
    if (this.env.GETUI_PROFILE !== undefined) {
      source = "environment-profile";
      alias = this.env.GETUI_PROFILE;
    } else if (profileAlias !== undefined) {
      source = "command-profile";
      alias = profileAlias;
    } else {
      source = "default-profile";
    }

    const profile = await this.get(alias);
    const masterSecret = await this.secretStore.get(
      PROFILE_SERVICE,
      profileAccount(profile.alias),
    );
    if (masterSecret === null) {
      throw new CliError(
        "Application secret is unavailable; provide complete environment credentials",
        {
          type: "credentials",
          code: "GETUI_CLI_PROFILE_SECRET_UNAVAILABLE",
          stage: "credentials",
          details: { profileAlias: profile.alias },
        },
      );
    }

    return {
      source,
      profileAlias: profile.alias,
      appId: profile.appId,
      appKey: profile.appKey,
      masterSecret,
    };
  }

  async getStatus(profileAlias?: string): Promise<ProfileStatus> {
    const environment = readEnvironmentCredentials(this.env);
    if (environment.kind === "partial") {
      throw new CliError("Environment credentials must be provided together", {
        type: "credentials",
        code: "GETUI_CLI_ENV_CREDENTIALS_INCOMPLETE",
        stage: "credentials",
        details: { missing: environment.missing },
      });
    }
    if (environment.kind === "complete") {
      return {
        credentialSource: "environment",
        secretStored: false,
        tokenStatus: await this.getTokenStatus(environment.appId),
      };
    }

    const selectedAlias = this.env.GETUI_PROFILE ?? profileAlias;
    const profile = await this.get(selectedAlias);
    const secretStored =
      (await this.secretStore.get(
        PROFILE_SERVICE,
        profileAccount(profile.alias),
      )) !== null;
    const credentialSource: CredentialSource =
      this.env.GETUI_PROFILE !== undefined
        ? "environment-profile"
        : profileAlias !== undefined
          ? "command-profile"
          : "default-profile";
    return {
      profile,
      credentialSource,
      secretStored,
      tokenStatus: await this.getTokenStatus(profile.appId),
    };
  }

  async getToken(appId: string): Promise<TokenRecord | null> {
    const applicationKey = hashAppId(appId);
    const memoryToken = this.memoryTokens.get(applicationKey);
    if (memoryToken !== undefined) {
      return { ...memoryToken, status: "memory-only" };
    }
    if (!(await this.secretStore.isAvailable())) {
      return null;
    }
    let token: string | null;
    try {
      token = await this.secretStore.get(
        TOKEN_SERVICE,
        tokenAccount(applicationKey),
      );
    } catch (error) {
      if (isSecureStoreUnavailable(error)) {
        return null;
      }
      throw error;
    }
    const metadata = await this.getTokenMetadata(applicationKey);
    if (token === null || metadata === null) {
      return null;
    }
    return {
      applicationKey,
      token,
      expiresAt: metadata.expiresAt,
      status: classifyTokenStatus(metadata.expiresAt, this.now().getTime()),
      persistence: "secure-store",
    };
  }

  async setToken(appId: string, token: string, expiresAt: number): Promise<TokenRecord> {
    const applicationKey = hashAppId(appId);
    if (await this.secretStore.isAvailable()) {
      try {
        await this.secretStore.set(TOKEN_SERVICE, tokenAccount(applicationKey), token);
        await this.setTokenMetadata({
          applicationKey,
          expiresAt,
          updatedAt: this.now().toISOString(),
        });
        return {
          applicationKey,
          token,
          expiresAt,
          status: classifyTokenStatus(expiresAt, this.now().getTime()),
          persistence: "secure-store",
        };
      } catch (error) {
        if (!isSecureStoreUnavailable(error)) {
          throw error;
        }
      }
    }

    const record: TokenRecord = {
      applicationKey,
      token,
      expiresAt,
      status: "memory-only",
      persistence: "memory",
    };
    this.memoryTokens.set(applicationKey, record);
    return record;
  }

  async deleteToken(appId: string): Promise<void> {
    const applicationKey = hashAppId(appId);
    this.memoryTokens.delete(applicationKey);
    await this.secretStore.delete(TOKEN_SERVICE, tokenAccount(applicationKey));
    await this.updateTokenMetadata((document) => {
      delete document.records[applicationKey];
    });
  }

  async getTokenStatus(appId: string): Promise<TokenStatus> {
    const token = await this.getToken(appId);
    return token?.status ?? "missing";
  }

  async withApplicationLock<T>(
    appId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withLock(`token-${hashAppId(appId)}`, action);
  }

  private async withApplicationLockByAlias<T>(
    alias: string,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withLock(`profile-${alias}`, action);
  }

  private async readConfig(): Promise<ConfigDocument> {
    await this.initialize();
    const raw = await readOptionalFile(this.paths.configPath);
    if (raw === null) {
      return { schemaVersion: 1, profiles: {} };
    }
    try {
      return configSchema.parse(JSON.parse(raw)) as ConfigDocument;
    } catch (error) {
      throw new CliError("Application configuration is invalid", {
        type: "configuration",
        code: "GETUI_CLI_CONFIG_INVALID",
        stage: "configuration",
        cause: error,
      });
    }
  }

  private async writeConfig(config: ConfigDocument): Promise<void> {
    configSchema.parse(config);
    await writeFileAtomic(
      this.paths.configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async getTokenMetadata(
    applicationKey: string,
  ): Promise<TokenMetadata | null> {
    const document = await this.readTokenMetadata();
    return document.records[applicationKey] ?? null;
  }

  private async setTokenMetadata(metadata: TokenMetadata): Promise<void> {
    await this.updateTokenMetadata((document) => {
      document.records[metadata.applicationKey] = metadata;
    });
  }

  private async readTokenMetadata(): Promise<TokenMetadataDocument> {
    await this.initialize();
    const raw = await readOptionalFile(this.paths.tokenMetadataPath);
    if (raw === null) {
      return { schemaVersion: 1, records: {} };
    }
    try {
      return tokenMetadataSchema.parse(JSON.parse(raw)) as TokenMetadataDocument;
    } catch (error) {
      throw new CliError("Token metadata is invalid", {
        type: "configuration",
        code: "GETUI_CLI_TOKEN_METADATA_INVALID",
        stage: "configuration",
        cause: error,
      });
    }
  }

  private async updateTokenMetadata(
    mutation: (document: TokenMetadataDocument) => void,
  ): Promise<void> {
    await this.withLock("token-metadata", async () => {
      const document = await this.readTokenMetadata();
      mutation(document);
      tokenMetadataSchema.parse(document);
      await writeFileAtomic(
        this.paths.tokenMetadataPath,
        `${JSON.stringify(document, null, 2)}\n`,
        { mode: 0o600 },
      );
    });
  }

  private async withConfigLock<T>(action: () => Promise<T>): Promise<T> {
    return this.withLock("config", action);
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lockTarget = path.join(this.paths.locksDir, key);
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }
}

export function hashAppId(appId: string): string {
  return createHash("sha256").update(appId).digest("hex");
}

function classifyTokenStatus(expiresAt: number, now: number): TokenStatus {
  if (expiresAt <= now) {
    return "expired";
  }
  if (expiresAt - now <= REFRESH_WINDOW_MS) {
    return "refresh-soon";
  }
  return "valid";
}

function validateAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new CliError(
      "Application alias may contain only letters, numbers, hyphens, and underscores",
      {
        type: "validation",
        code: "GETUI_CLI_PROFILE_ALIAS_INVALID",
        stage: "input",
      },
    );
  }
}

function profileNotFound(alias: string): CliError {
  return new CliError(`Application profile not found: ${alias}`, {
    type: "configuration",
    code: "GETUI_CLI_PROFILE_NOT_FOUND",
    stage: "configuration",
  });
}

function secureStoreUnavailable(cause?: unknown): CliError {
  return new CliError(
    "Secure credential storage is unavailable; use complete environment credentials",
    {
      type: "credentials",
      code: "GETUI_CLI_SECURE_STORE_UNAVAILABLE",
      stage: "credentials",
      cause,
    },
  );
}

function isSecureStoreUnavailable(error: unknown): boolean {
  return (
    error instanceof CliError &&
    error.code === "GETUI_CLI_SECURE_STORE_UNAVAILABLE"
  );
}

function isMissingCredential(error: unknown): boolean {
  return error instanceof Error && /NoEntry|not found|no entry/i.test(error.message);
}

function profileAccount(alias: string): string {
  return `profile:${alias}`;
}

function tokenAccount(applicationKey: string): string {
  return `token:${applicationKey}`;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

type EnvironmentCredentials =
  | { kind: "none" }
  | { kind: "partial"; missing: string[] }
  | {
      kind: "complete";
      appId: string;
      appKey: string;
      masterSecret: string;
    };

function readEnvironmentCredentials(
  env: NodeJS.ProcessEnv,
): EnvironmentCredentials {
  const values = {
    appId: env.GETUI_APP_ID,
    appKey: env.GETUI_APP_KEY,
    masterSecret: env.GETUI_MASTER_SECRET,
  };
  const environmentValues = Object.values(values);
  if (environmentValues.every((value) => value === undefined)) {
    return { kind: "none" };
  }
  if (
    environmentValues.some(
      (value) => value === undefined || value.length === 0,
    )
  ) {
    return {
      kind: "partial",
      missing: Object.entries(values)
        .filter(([, value]) => value === undefined || value.length === 0)
        .map(([key]) => key),
    };
  }
  return {
    kind: "complete",
    appId: values.appId as string,
    appKey: values.appKey as string,
    masterSecret: values.masterSecret as string,
  };
}
