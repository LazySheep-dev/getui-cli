import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import readline from "node:readline/promises";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { CliError, asCliError } from "./errors.js";
import type { OperationExecutor } from "./executor.js";
import { operationRegistry } from "./operations.js";
import { renderData, renderError, renderSuccess } from "./output.js";
import type { ProfileService } from "./profile.js";
import type {
  ExecutionOptions,
  OperationDefinition,
  OutputFormat,
} from "./types.js";

export const CLI_VERSION = "0.1.0";

interface RegistryLike {
  list(): Array<OperationDefinition<unknown, unknown>>;
  get(name: string): OperationDefinition<unknown, unknown> | null;
}

type CliProfileService = Pick<
    ProfileService,
    | "add"
    | "list"
    | "get"
    | "use"
    | "remove"
    | "getStatus"
    | "isSecretStoreAvailable"
  >;

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdinIsTTY: boolean;
}

export interface CliDependencies {
  profileService: CliProfileService;
  executor: Pick<OperationExecutor, "execute">;
  registry?: RegistryLike | undefined;
  io?: CliIo | undefined;
  version?: string | undefined;
  readSecret?: ((prompt: string) => Promise<string | undefined>) | undefined;
  confirm?: ((prompt: string) => Promise<boolean>) | undefined;
  readInputFile?: ((filePath: string) => Promise<string>) | undefined;
  readStdin?: (() => Promise<string>) | undefined;
}

interface GlobalOptions {
  profile?: string | undefined;
  format: string;
  raw: boolean;
  debug: boolean;
  timeout: number;
  yes?: boolean | undefined;
}

interface CommonStatsOptions {
  activityScope?: string | undefined;
  groupBy?: string | undefined;
  channels?: string | undefined;
  appVersions?: string | undefined;
  packageNames?: string | undefined;
  platforms?: string | undefined;
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies,
): Promise<number> {
  const io = dependencies.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTTY: process.stdin.isTTY === true,
  };
  const registry = dependencies.registry ?? operationRegistry;
  const readSecret =
    dependencies.readSecret ?? ((prompt) => readHiddenLine(io, prompt));
  const confirm =
    dependencies.confirm ?? ((prompt) => readConfirmation(io, prompt));
  const readInputFile =
    dependencies.readInputFile ?? ((filePath) => readFile(filePath, "utf8"));
  const readStdin = dependencies.readStdin ?? (() => readAll(io.stdin));
  let currentOperation: string | undefined;

  const program = new Command()
    .name("getui-cli")
    .description("Getui IDO statistics command-line interface")
    .version(dependencies.version ?? CLI_VERSION)
    .option("--profile <alias>", "use a configured application profile")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["json", "table", "text"])
        .default("json"),
    )
    .option("--raw", "return the redacted original API response", false)
    .option("--debug", "write request diagnostics to stderr", false)
    .option(
      "--timeout <seconds>",
      "request timeout in seconds (maximum 30)",
      parseTimeout,
      30,
    )
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => io.stdout.write(value),
      writeErr: (value) => io.stderr.write(value),
      outputError: () => undefined,
    });

  program.action(() => program.outputHelp());

  const outputLocal = (command: Command, data: unknown): void => {
    const global = command.optsWithGlobals<GlobalOptions>();
    io.stdout.write(`${renderData(data, parseFormat(global.format))}\n`);
  };

  const execute = async (
    command: Command,
    operationName: string,
    input: unknown,
  ): Promise<void> => {
    currentOperation = operationName;
    const global = command.optsWithGlobals<GlobalOptions>();
    const format = parseFormat(global.format);
    if (global.raw && format !== "json") {
      throw new CliError("Raw output requires JSON format", {
        type: "validation",
        code: "GETUI_CLI_RAW_FORMAT_CONFLICT",
        stage: "input",
      });
    }
    const executionOptions: ExecutionOptions = {
      timeoutMs: global.timeout * 1000,
      debug: global.debug,
      raw: global.raw,
      confirmMutations: global.yes === true,
    };
    if (global.profile !== undefined) {
      executionOptions.profileAlias = global.profile;
    }
    const envelope = await dependencies.executor.execute(
      operationName,
      input,
      executionOptions,
    );
    io.stdout.write(`${renderSuccess(envelope, format)}\n`);
  };

  const app = program.command("app").description("manage application profiles");
  app
    .command("add <alias>")
    .requiredOption("--app-id <appId>", "Getui application ID")
    .requiredOption("--app-key <appKey>", "Getui application key")
    .description("add an application profile")
    .action(async (alias: string, options: { appId: string; appKey: string }, command: Command) => {
      const secureStorage = await dependencies.profileService.isSecretStoreAvailable();
      const masterSecret =
        io.stdinIsTTY && secureStorage
          ? await readSecret("Master secret (leave empty to use environment credentials): ")
          : undefined;
      const profile = await dependencies.profileService.add({
        alias,
        appId: options.appId,
        appKey: options.appKey,
        masterSecret,
      });
      outputLocal(command, {
        profile,
        secretStored: masterSecret !== undefined,
        credentialHint: secureStorage
          ? undefined
          : "Secure storage unavailable; use complete environment credentials",
      });
    });
  app
    .command("list")
    .description("list application profiles")
    .action(async (_options: unknown, command: Command) => {
      outputLocal(command, await dependencies.profileService.list());
    });
  app
    .command("show [alias]")
    .description("show one application profile")
    .action(async (alias: string | undefined, _options: unknown, command: Command) => {
      outputLocal(command, await dependencies.profileService.get(alias));
    });
  app
    .command("use <alias>")
    .description("set the default application profile")
    .action(async (alias: string, _options: unknown, command: Command) => {
      await dependencies.profileService.use(alias);
      outputLocal(command, { defaultProfile: alias });
    });
  app
    .command("remove <alias>")
    .option("--yes", "confirm removal without prompting", false)
    .description("remove an application profile")
    .action(async (alias: string, options: { yes: boolean }, command: Command) => {
      if (!options.yes) {
        if (!io.stdinIsTTY) {
          throw new CliError("Non-interactive removal requires --yes", {
            type: "usage",
            code: "GETUI_CLI_CONFIRMATION_REQUIRED",
            stage: "input",
          });
        }
        if (!(await confirm(`Remove application profile ${alias}? [y/N] `))) {
          outputLocal(command, { removed: false, alias });
          return;
        }
      }
      await dependencies.profileService.remove(alias);
      outputLocal(command, { removed: true, alias });
    });

  program
    .command("status")
    .description("show the selected application and token status")
    .action(async (_options: unknown, command: Command) => {
      const global = command.optsWithGlobals<GlobalOptions>();
      try {
        outputLocal(
          command,
          await dependencies.profileService.getStatus(global.profile),
        );
      } catch (error) {
        if (
          error instanceof CliError &&
          error.code === "GETUI_CLI_PROFILE_NOT_SELECTED"
        ) {
          outputLocal(command, {
            profile: null,
            credentialSource: null,
            secretStored: false,
            tokenStatus: "missing",
          });
          return;
        }
        throw error;
      }
    });

  const operations = program
    .command("operations")
    .description("discover supported operations");
  operations
    .command("list")
    .description("list supported operations")
    .action((_options: unknown, command: Command) => {
      outputLocal(
        command,
        registry.list().map(({ name, summary }) => ({ name, summary })),
      );
    });
  operations
    .command("show <name>")
    .description("show an operation's business input")
    .action((name: string, _options: unknown, command: Command) => {
      const operation = registry.get(name);
      if (operation === null) {
        throw unknownOperation(name);
      }
      outputLocal(command, {
        name: operation.name,
        summary: operation.summary,
        input: operation.inputDescription,
      });
    });

  program
    .command("api")
    .description("call a registered operation")
    .command("call <operation>")
    .option("--input <json>", "inline JSON object")
    .option("--input-file <path>", "read a JSON object from a file")
    .option("--yes", "confirm a mutating operation", false)
    .description("call one registered statistics, tag, or authentication operation")
    .action(
      async (
        operationName: string,
        options: { input?: string; inputFile?: string },
        command: Command,
      ) => {
        currentOperation = operationName;
        const input = await resolveApiInput(
          options,
          io.stdinIsTTY,
          readInputFile,
          readStdin,
        );
        await execute(command, operationName, input);
      },
    );

  const auth = program.command("auth").description("manage authentication");
  auth
    .command("token")
    .option("--force", "force a fresh token request", false)
    .description("get or refresh the current application's token")
    .action(async (options: { force: boolean }, command: Command) => {
      await execute(command, "auth.token", { force: options.force === true });
    });

  const tag = program
    .command("tag")
    .description("query or manage Getui tags; write commands require --yes");
  addJsonInputOptions(
    tag
      .command("query")
      .description("query user tags by gtcid list"),
  ).action(async (options: JsonInputOptions, command: Command) => {
    const input = await resolveApiInput(
      options,
      io.stdinIsTTY,
      readInputFile,
      readStdin,
    );
    await execute(command, "tag.user", input);
  });
  addJsonInputOptions(
    tag
      .command("tree")
      .description("query the complete tag tree"),
  ).action(async (options: JsonInputOptions, command: Command) => {
    const input = await resolveApiInput(
      options,
      io.stdinIsTTY,
      readInputFile,
      readStdin,
    );
    await execute(command, "tag.tree", input);
  });

  for (const [commandName, operationName, description] of [
    ["create", "tag.external.create", "create an external tag"],
    ["edit", "tag.external.edit", "edit an external tag"],
    ["import", "tag.external.import", "import IDs into a tag value"],
    ["trigger", "tag.external.trigger", "trigger external tag calculation"],
  ] as const) {
    addJsonInputOptions(
      tag
        .command(commandName)
        .option("--yes", "confirm this mutating operation", false)
        .description(description),
    ).action(async (options: JsonInputOptions, command: Command) => {
      const input = await resolveApiInput(
        options,
        io.stdinIsTTY,
        readInputFile,
        readStdin,
      );
      await execute(command, operationName, input);
    });
  }

  const user = program
    .command("user")
    .description("import user data and manage exportable user crowds");
  const userImport = user
    .command("import")
    .description("import historical event or user data; requires --yes");
  addJsonInputOptions(
    userImport
      .command("event")
      .option("--yes", "confirm this mutating operation", false)
      .description("import historical event records"),
  ).action(async (options: JsonInputOptions, command: Command) => {
    const input = await resolveApiInput(
      options,
      io.stdinIsTTY,
      readInputFile,
      readStdin,
    );
    await execute(command, "user.import.event", input);
  });
  addJsonInputOptions(
    userImport
      .command("user")
      .option("--yes", "confirm this mutating operation", false)
      .description("import historical user records"),
  ).action(async (options: JsonInputOptions, command: Command) => {
    const input = await resolveApiInput(
      options,
      io.stdinIsTTY,
      readInputFile,
      readStdin,
    );
    await execute(command, "user.import.user", input);
  });

  const crowd = user
    .command("crowd")
    .description("list crowds and inspect export files");
  crowd
    .command("list")
    .description("list exportable user crowds")
    .action(async (_options: unknown, command: Command) => {
      await execute(command, "user.crowd.list", {});
    });

  const crowdExport = crowd
    .command("export")
    .description("create and inspect user crowd export tasks");
  crowdExport
    .command("create")
    .requiredOption("--crowd-id <crowdId>", "user crowd ID")
    .requiredOption("--uid-type <uidType>", "CID or GTCID")
    .option("--yes", "confirm this mutating operation", false)
    .description("create a crowd export task")
    .action(
      async (
        options: { crowdId: string; uidType: string },
        command: Command,
      ) => {
        await execute(command, "user.crowd.export.create", {
          crowdId: options.crowdId,
          uidType: options.uidType,
        });
      },
    );
  crowdExport
    .command("status")
    .requiredOption("--crowd-id <crowdId>", "user crowd ID")
    .requiredOption(
      "--task-id <taskId>",
      "positive integer export task ID",
      parseTaskId,
    )
    .description("get a crowd export task status")
    .action(
      async (options: { crowdId: string; taskId: number }, command: Command) => {
        await execute(command, "user.crowd.export.status", {
          crowdId: options.crowdId,
          taskId: options.taskId,
        });
      },
    );
  crowdExport
    .command("file")
    .requiredOption("--crowd-id <crowdId>", "user crowd ID")
    .requiredOption(
      "--task-id <taskId>",
      "positive integer export task ID",
      parseTaskId,
    )
    .requiredOption("--file-id <fileId>", "export file ID")
    .description("get IDs from one crowd export file")
    .action(
      async (
        options: { crowdId: string; taskId: number; fileId: string },
        command: Command,
      ) => {
        await execute(command, "user.crowd.export.file", {
          crowdId: options.crowdId,
          taskId: options.taskId,
          fileId: options.fileId,
        });
      },
    );

  const vector = user
    .command("vector")
    .description("query user vector information (read-only)");
  vector
    .command("query")
    .requiredOption("--gtcid <gtcid>", "one GTCID")
    .description("query vector information for one GTCID (read-only)")
    .action(async (options: { gtcid: string }, command: Command) => {
      await execute(command, "user.vector.query", {
        userId: options.gtcid,
      });
    });
  addJsonInputOptions(
    vector
      .command("batch")
      .description("query vector information for up to 50 GTCIDs (read-only)"),
  ).action(async (options: JsonInputOptions, command: Command) => {
    const input = await resolveApiInput(
      options,
      io.stdinIsTTY,
      readInputFile,
      readStdin,
    );
    await execute(command, "user.vector.batch", input);
  });

  const stats = program.command("stats").description("query statistics");
  stats
    .command("today")
    .option("--activity-scope <scope>", "foreground or all")
    .description("query today's installs, active users, and starts")
    .action(async (options: CommonStatsOptions, command: Command) => {
      await execute(command, "statistics.today", compact({
        activityScope: options.activityScope,
      }));
    });
  stats
    .command("period")
    .requiredOption("--metric <metric>", "new, active, or start")
    .option("--group-by <dimension>", "platform, channel, version, or package")
    .option("--group-value <value>", "value for the selected group")
    .option("--activity-scope <scope>", "foreground or all")
    .description("query hourly statistics")
    .action(async (options: CommonStatsOptions & { metric: string; groupValue?: string }, command: Command) => {
      await execute(command, "statistics.period", compact({
        metric: options.metric,
        groupBy: options.groupBy,
        groupValue: options.groupValue,
        activityScope: options.activityScope,
      }));
    });
  addDimensionOptions(
    stats
      .command("activity")
      .description("query yesterday, weekly, monthly, and DAU/MAU activity"),
  ).action(async (options: CommonStatsOptions, command: Command) => {
    await execute(command, "statistics.activity", dimensionInput(options));
  });
  addDimensionOptions(
    stats
      .command("trend")
      .requiredOption("--start-date <date>", "start date in YYYY-MM-DD")
      .requiredOption("--end-date <date>", "end date in YYYY-MM-DD")
      .requiredOption("--metric <metric>", "trend metric")
      .description("query a date-range user trend"),
  ).action(
    async (
      options: CommonStatsOptions & {
        startDate: string;
        endDate: string;
        metric: string;
      },
      command: Command,
    ) => {
      await execute(command, "statistics.userTrend", compact({
        ...dimensionInput(options),
        startDate: options.startDate,
        endDate: options.endDate,
        metric: options.metric,
      }));
    },
  );
  addDimensionOptions(
    stats
      .command("retention")
      .requiredOption("--start-date <date>", "start date in YYYY-MM-DD")
      .requiredOption("--end-date <date>", "end date in YYYY-MM-DD")
      .requiredOption("--metric <metric>", "new, active, or start")
      .description("query retention cohorts"),
  ).action(
    async (
      options: CommonStatsOptions & {
        startDate: string;
        endDate: string;
        metric: string;
      },
      command: Command,
    ) => {
      await execute(command, "statistics.retention", compact({
        ...dimensionInput(options),
        startDate: options.startDate,
        endDate: options.endDate,
        metric: options.metric,
      }));
    },
  );

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" ||
        error.code === "commander.version")
    ) {
      return 0;
    }
    const cliError =
      error instanceof CommanderError
        ? new CliError(error.message, {
            type: "usage",
            code: "GETUI_CLI_USAGE",
            stage: "input",
          })
        : asCliError(error);
    io.stderr.write(`${renderError(cliError, currentOperation)}\n`);
    return cliError.exitCode;
  }
}

function parseTimeout(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
    throw new InvalidArgumentError("timeout must be greater than 0 and at most 30 seconds");
  }
  return seconds;
}

function parseTaskId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("task-id must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("task-id must be a positive safe integer");
  }
  return parsed;
}

function parseFormat(value: string): OutputFormat {
  if (value === "json" || value === "table" || value === "text") {
    return value;
  }
  throw new CliError(`Unsupported output format: ${value}`, {
    type: "usage",
    code: "GETUI_CLI_FORMAT_INVALID",
    stage: "input",
  });
}

function addDimensionOptions(command: Command): Command {
  return command
    .option("--channels <items>", "comma-separated channels")
    .option("--app-versions <items>", "comma-separated app versions")
    .option("--package-names <items>", "comma-separated package names")
    .option("--platforms <items>", "comma-separated platforms")
    .option("--group-by <dimension>", "platform, channel, version, or package")
    .option("--activity-scope <scope>", "foreground or all");
}

function dimensionInput(options: CommonStatsOptions): Record<string, unknown> {
  return compact({
    channels: commaList(options.channels),
    appVersions: commaList(options.appVersions),
    packageNames: commaList(options.packageNames),
    platforms: commaList(options.platforms),
    groupBy: options.groupBy,
    activityScope: options.activityScope,
  });
}

function commaList(value?: string): string[] | undefined {
  return value === undefined ? undefined : value.split(",");
}

function compact(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
}

interface JsonInputOptions {
  input?: string;
  inputFile?: string;
  yes?: boolean;
}

function addJsonInputOptions(command: Command): Command {
  return command
    .option("--input <json>", "inline JSON object")
    .option("--input-file <path>", "read a JSON object from a file");
}

async function resolveApiInput(
  options: { input?: string; inputFile?: string },
  stdinIsTTY: boolean,
  readInputFile: (filePath: string) => Promise<string>,
  readStdin: () => Promise<string>,
): Promise<Record<string, unknown>> {
  if (options.input !== undefined && options.inputFile !== undefined) {
    throw new CliError("Use only one of --input, --input-file, or stdin", {
      type: "validation",
      code: "GETUI_CLI_INPUT_CONFLICT",
      stage: "input",
      details: { sources: ["--input", "--input-file"] },
    });
  }
  let source: { name: string; value: string } | undefined;
  if (options.input !== undefined) {
    source = { name: "--input", value: options.input };
  } else if (options.inputFile !== undefined) {
    source = {
      name: "--input-file",
      value: await readInputFile(options.inputFile),
    };
  } else if (!stdinIsTTY) {
    const stdin = await readStdin();
    if (stdin.trim().length > 0) {
      source = { name: "stdin", value: stdin };
    }
  }
  if (source === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.value);
  } catch (error) {
    throw new CliError("API input must be valid JSON", {
      type: "validation",
      code: "GETUI_CLI_INPUT_JSON_INVALID",
      stage: "input",
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("API input must be a JSON object", {
      type: "validation",
      code: "GETUI_CLI_INPUT_OBJECT_REQUIRED",
      stage: "input",
    });
  }
  return parsed as Record<string, unknown>;
}

function unknownOperation(name: string): CliError {
  return new CliError(`Unknown operation: ${name}`, {
    type: "usage",
    code: "GETUI_CLI_OPERATION_UNKNOWN",
    stage: "input",
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let value = "";
  for await (const chunk of stream) {
    value += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return value;
}

async function readHiddenLine(
  io: CliIo,
  prompt: string,
): Promise<string | undefined> {
  io.stderr.write(prompt);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const interface_ = readline.createInterface({
    input: io.stdin,
    output: muted,
    terminal: true,
  });
  try {
    const value = await interface_.question("");
    io.stderr.write("\n");
    return value.length === 0 ? undefined : value;
  } finally {
    interface_.close();
  }
}

async function readConfirmation(io: CliIo, prompt: string): Promise<boolean> {
  const interface_ = readline.createInterface({
    input: io.stdin,
    output: io.stderr,
    terminal: true,
  });
  try {
    return /^y(?:es)?$/i.test((await interface_.question(prompt)).trim());
  } finally {
    interface_.close();
  }
}
