import type { z } from "zod";

export type OperationName =
  | "statistics.today"
  | "statistics.period"
  | "statistics.activity"
  | "statistics.userTrend"
  | "statistics.retention"
  | "auth.token"
  | "tag.user"
  | "tag.tree"
  | "tag.external.create"
  | "tag.external.edit"
  | "tag.external.import"
  | "tag.external.trigger"
  | "user.import.event"
  | "user.import.user"
  | "user.crowd.list"
  | "user.crowd.export.create"
  | "user.crowd.export.status"
  | "user.crowd.export.file"
  | "user.vector.query"
  | "user.vector.batch";

export type OperationKind = "protected" | "authentication";
export type RetryClass = "read" | "write";

export type ActivityScope = "foreground" | "all";
export type GroupBy = "platform" | "channel" | "version" | "package";
export type PeriodMetric = "new" | "active" | "start";
export type UserTrendMetric =
  | PeriodMetric
  | "total"
  | "avgDuration"
  | "avgFrequency";

export interface ConfigDocument {
  schemaVersion: 1;
  defaultProfile?: string | undefined;
  profiles: Record<string, AppProfile>;
}

export interface AppProfile {
  alias: string;
  appId: string;
  appKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddProfileInput {
  alias: string;
  appId: string;
  appKey: string;
  masterSecret?: string | undefined;
}

export type CredentialSource =
  | "environment"
  | "environment-profile"
  | "command-profile"
  | "default-profile";

export interface ResolvedCredentials {
  source: CredentialSource;
  profileAlias?: string | undefined;
  appId: string;
  appKey: string;
  masterSecret: string;
}

export interface TokenMetadataDocument {
  schemaVersion: 1;
  records: Record<string, TokenMetadata>;
}

export interface TokenMetadata {
  applicationKey: string;
  expiresAt: number;
  updatedAt: string;
}

export type TokenStatus =
  | "missing"
  | "valid"
  | "refresh-soon"
  | "expired"
  | "memory-only";

export interface TokenRecord {
  applicationKey: string;
  token: string;
  expiresAt: number;
  status: TokenStatus;
  persistence: "secure-store" | "memory";
}

export interface DimensionFilters {
  channels?: string[] | undefined;
  appVersions?: string[] | undefined;
  packageNames?: string[] | undefined;
  platforms?: string[] | undefined;
}

export interface TodayInput {
  activityScope: ActivityScope;
}

export interface PeriodInput {
  metric: PeriodMetric;
  groupBy?: GroupBy | undefined;
  groupValue?: string | undefined;
  activityScope: ActivityScope;
}

export interface ActivityInput extends DimensionFilters {
  groupBy?: GroupBy | undefined;
  activityScope: ActivityScope;
}

export interface UserTrendInput extends DimensionFilters {
  startDate: string;
  endDate: string;
  metric: UserTrendMetric;
  groupBy?: GroupBy | undefined;
  activityScope: ActivityScope;
}

export interface RetentionInput extends DimensionFilters {
  startDate: string;
  endDate: string;
  metric: PeriodMetric;
  groupBy?: GroupBy | undefined;
  activityScope: ActivityScope;
}

export type TagIdType =
  | "mobile_md5"
  | "imei_md5"
  | "oaid_md5"
  | "idfa_md5"
  | "cid"
  | "gtcid";

export interface AuthTokenInput {
  force: boolean;
}

export interface TagUserInput {
  userIdList: string[];
}

export type TagTreeInput = Record<string, never>;

export interface TagValueCreateInput {
  tagValCn: string;
  idType?: TagIdType | undefined;
}

export interface TagExternalCreateInput {
  dirId?: number | undefined;
  name: string;
  description?: string | undefined;
  tagValueList: TagValueCreateInput[];
}

export interface TagValueEditInput extends TagValueCreateInput {
  tagValCode?: string | undefined;
  reset: boolean;
}

export interface TagExternalEditInput {
  dirId?: number | undefined;
  tagCode: string;
  name: string;
  description?: string | undefined;
  tagValueList: TagValueEditInput[];
}

export interface TagExternalImportInput {
  tagValCode: string;
  idList: string[];
}

export interface TagExternalTriggerInput {
  tagCodeList: string[];
}

export interface EventImportInput {
  dataList: EventData[];
}

export interface EventData {
  gtcid: string;
  sessionId?: string | undefined;
  datetime: string;
  eventId: string;
  properties: Record<string, unknown>;
}

export interface UserImportInput {
  dataList: UserData[];
}

export interface UserData {
  gtcid: string;
  datetime: string;
  properties: Record<string, unknown>;
}

export type CrowdListInput = Record<string, never>;

export interface CrowdExportCreateInput {
  crowdId: string;
  uidType: "CID" | "GTCID";
}

export interface CrowdExportStatusInput {
  crowdId: string;
  taskId: number;
}

export interface CrowdExportFileInput {
  crowdId: string;
  taskId: number;
  fileId: string;
}

export interface UserVectorQueryInput {
  userId: string;
}

export interface UserVectorBatchInput {
  userIdList: string[];
}

export interface MetricPoint {
  time: string;
  value: number;
}

export interface TodayMetric {
  count: number;
  previousDayPercent: number | null;
  sevenDayPercent: number | null;
}

export interface TodayResult {
  dimensions: Array<{
    dimension: string;
    install: TodayMetric;
    active: TodayMetric;
    start: TodayMetric;
  }>;
}

export interface PeriodResult {
  metric: PeriodMetric;
  dimensions: Array<{
    dimension: string;
    itemName?: string | undefined;
    today: MetricPoint[];
    yesterday: MetricPoint[];
    sevenDaysAgo: MetricPoint[];
  }>;
}

export interface ActivityResult {
  dimensions: Array<{
    dimension: string;
    yesterdayActive: { total: number; comparison: number | null };
    weeklyActive: { total: number; comparison: number | null };
    monthlyActive: { total: number; comparison: number | null };
    dauMauRatio: { value: number | null; comparison: number | null };
  }>;
}

export interface UserTrendResult {
  metric: UserTrendMetric;
  series: Array<{ dimension: string; points: MetricPoint[] }>;
}

export interface RetentionResult {
  metric: PeriodMetric;
  dimensions: Array<{
    dimension: string;
    cohorts: Array<{
      date: string;
      userCount: number | null;
      day1Percent: number | null;
      day2Percent: number | null;
      day3Percent: number | null;
      day4Percent: number | null;
      day5Percent: number | null;
      day6Percent: number | null;
      day7Percent: number | null;
      day30Percent: number | null;
    }>;
  }>;
}

export interface TagApiResult<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

export type AuthTokenResult = TagApiResult<{
  tokenStatus: TokenStatus;
  expiresAt: number;
  refreshed: boolean;
}>;

export type TagUserResult = TagApiResult<{
  validTags: unknown[];
  invalidTags: unknown[];
}>;

export type TagTreeResult = TagApiResult<{
  customTagList: unknown[];
  externalTagList: unknown[];
  gtagList: unknown[];
}>;

export type UserApiCode = number | string;

export interface UserApiResult<T = unknown> {
  code: UserApiCode;
  msg: string;
  data: T | null;
}

export interface ImportSummary {
  importType: "event" | "user";
  recordCount: number;
}

export type ImportResult = UserApiResult<ImportSummary>;

export interface CrowdListData {
  list: Array<Record<string, unknown>>;
  total: number;
}

export interface CrowdExportCreateData {
  taskId: number;
}

export interface CrowdExportStatusData {
  appId?: string | undefined;
  crowdId: string;
  taskId: number;
  uidType: "CID" | "GTCID";
  status: 0 | 1 | 2;
  fileIdList: string[];
}

export interface CrowdExportFileData {
  list: string[];
  total: number;
}

export type UserImportEventResult = ImportResult;
export type UserImportUserResult = ImportResult;
export type UserCrowdListResult = UserApiResult<CrowdListData>;
export type UserCrowdExportCreateResult = UserApiResult<CrowdExportCreateData>;
export type UserCrowdExportStatusResult = UserApiResult<CrowdExportStatusData>;
export type UserCrowdExportFileResult = UserApiResult<CrowdExportFileData>;
export type UserVectorQueryResult = UserApiResult;
export type UserVectorBatchResult = UserApiResult;

// Short aliases are kept for operation implementations and external callers
// that refer to the response by endpoint rather than by its CLI namespace.
export type CrowdExportCreateResult = UserCrowdExportCreateResult;
export type CrowdExportStatusResult = UserCrowdExportStatusResult;
export type CrowdExportFileResult = UserCrowdExportFileResult;

export type OperationOutput =
  | TodayResult
  | PeriodResult
  | ActivityResult
  | UserTrendResult
  | RetentionResult
  | AuthTokenResult
  | TagUserResult
  | TagTreeResult
  | TagApiResult
  | UserImportEventResult
  | UserImportUserResult
  | UserCrowdListResult
  | UserCrowdExportCreateResult
  | UserCrowdExportStatusResult
  | UserCrowdExportFileResult
  | UserVectorQueryResult
  | UserVectorBatchResult;

export interface OperationResultContext {
  tokenStatus: TokenStatus;
  tokenRefreshed: boolean;
  tokenExpiresAt?: number | undefined;
}

export interface OperationDefinition<Input, Output> {
  name: OperationName;
  kind: OperationKind;
  mutating: boolean;
  retryClass?: RetryClass | undefined;
  summary: string;
  path: string;
  inputSchema: z.ZodType<Input>;
  inputDescription: Record<string, unknown>;
  buildRequest(input: Input): Record<string, unknown>;
  queryForOutput?: ((input: Input) => Record<string, unknown>) | undefined;
  normalizeResponse(
    raw: unknown,
    input: Input,
    context?: OperationResultContext,
  ): Output;
}

export interface RequestOptions {
  timeoutMs: number;
  debug: boolean;
  retryClass?: RetryClass | undefined;
}

export interface ApiCallResult {
  raw: unknown;
  attempts: number;
  tokenStatus: TokenStatus;
  tokenRefreshed: boolean;
  tokenExpiresAt?: number | undefined;
  diagnostics: DiagnosticEvent[];
}

export interface ExecutionOptions extends RequestOptions {
  profileAlias?: string | undefined;
  raw: boolean;
  confirmMutations?: boolean | undefined;
}

export interface DiagnosticEvent {
  stage: string;
  message: string;
  attempt?: number | undefined;
  durationMs?: number | undefined;
}

export interface SuccessEnvelope<T> {
  schemaVersion: "1.0";
  ok: true;
  mode: "normalized" | "raw";
  operation: OperationName;
  query: Record<string, unknown>;
  data: T;
  meta: {
    profileAlias?: string | undefined;
    credentialSource: CredentialSource;
    fetchedAt: string;
    durationMs: number;
    attempts: number;
  };
}

export type ErrorType =
  | "usage"
  | "validation"
  | "configuration"
  | "credentials"
  | "authentication"
  | "permission"
  | "network"
  | "remote"
  | "internal";

export type ErrorStage =
  | "input"
  | "configuration"
  | "credentials"
  | "authentication"
  | "request"
  | "response"
  | "output"
  | "internal";

export interface ErrorEnvelope {
  schemaVersion: "1.0";
  ok: false;
  error: {
    type: ErrorType;
    code: string;
    message: string;
    stage: ErrorStage;
    retryable: boolean;
    details?: Record<string, unknown> | undefined;
  };
  meta: {
    operation?: string | undefined;
    occurredAt: string;
  };
}

export type OutputFormat = "json" | "table" | "text";

export interface ProfileStatus {
  profile?: AppProfile | undefined;
  credentialSource?: CredentialSource | undefined;
  secretStored: boolean;
  tokenStatus: TokenStatus;
}
