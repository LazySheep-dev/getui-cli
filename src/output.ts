import { CliError, createErrorEnvelope } from "./errors.js";
import type {
  DiagnosticEvent,
  ErrorEnvelope,
  OutputFormat,
  SuccessEnvelope,
} from "./types.js";

const SENSITIVE_KEYS = new Set([
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

function replaceSensitiveValues(value: string, sensitiveValues: string[]): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) {
      redacted = redacted.split(sensitiveValue).join("[REDACTED]");
    }
  }
  return redacted;
}

export function redact(
  value: unknown,
  sensitiveValues: string[] = [],
): unknown {
  if (typeof value === "string") {
    return replaceSensitiveValues(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "_");
      result[key] = SENSITIVE_KEYS.has(normalizedKey)
        ? "[REDACTED]"
        : redact(child, sensitiveValues);
    }
    return result;
  }
  return value;
}

function printableValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function flattenObject(
  value: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      Object.assign(
        result,
        flattenObject(child as Record<string, unknown>, path),
      );
    } else {
      result[path] = printableValue(child);
    }
  }
  return result;
}

function rowsFromData(data: unknown): Array<Record<string, string>> {
  if (Array.isArray(data)) {
    return data.map((item) =>
      item !== null && typeof item === "object"
        ? flattenObject(item as Record<string, unknown>)
        : { value: printableValue(item) },
    );
  }
  if (data !== null && typeof data === "object") {
    const object = data as Record<string, unknown>;
    const collection = object.dimensions ?? object.series;
    if (Array.isArray(collection)) {
      return rowsFromData(collection);
    }
    return [flattenObject(object)];
  }
  return [{ value: printableValue(data) }];
}

function renderTable(data: unknown): string {
  const rows = rowsFromData(data);
  const headers = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row))),
  );
  if (headers.length === 0) {
    return "";
  }

  const widths = headers.map((header) =>
    Math.max(header.length, ...rows.map((row) => (row[header] ?? "").length)),
  );
  const renderRow = (row: Record<string, string>): string =>
    headers
      .map((header, index) => (row[header] ?? "").padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();

  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [renderRow(Object.fromEntries(headers.map((header) => [header, header]))), separator, ...rows.map(renderRow)].join("\n");
}

function renderText(envelope: SuccessEnvelope<unknown>): string {
  const lines = [
    `Operation: ${envelope.operation}`,
    `Fetched at: ${envelope.meta.fetchedAt}`,
    `Attempts: ${envelope.meta.attempts}`,
    renderTable(envelope.data),
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}

export function renderSuccess(
  envelope: SuccessEnvelope<unknown>,
  format: OutputFormat,
  sensitiveValues: string[] = [],
): string {
  const safeEnvelope = redact(envelope, sensitiveValues) as SuccessEnvelope<unknown>;
  if (safeEnvelope.mode === "raw" && format !== "json") {
    throw new CliError("Raw output requires JSON format", {
      type: "validation",
      code: "GETUI_CLI_RAW_FORMAT_CONFLICT",
      stage: "output",
    });
  }
  if (format === "json") {
    return JSON.stringify(safeEnvelope, null, 2);
  }
  if (format === "table") {
    return renderTable(safeEnvelope.data);
  }
  return renderText(safeEnvelope);
}

export function renderData(
  data: unknown,
  format: OutputFormat,
  sensitiveValues: string[] = [],
): string {
  const safeData = redact(data, sensitiveValues);
  if (format === "json") {
    return JSON.stringify(
      { schemaVersion: "1.0", ok: true, data: safeData },
      null,
      2,
    );
  }
  return renderTable(safeData);
}

export function renderError(
  error: CliError,
  operation?: string,
  sensitiveValues: string[] = [],
): string {
  const envelope = redact(
    createErrorEnvelope(error, operation),
    sensitiveValues,
  ) as ErrorEnvelope;
  return JSON.stringify(envelope, null, 2);
}

export function renderDiagnostics(
  diagnostics: DiagnosticEvent[],
  sensitiveValues: string[] = [],
): string {
  return diagnostics
    .map((event) => JSON.stringify(redact(event, sensitiveValues)))
    .join("\n");
}
