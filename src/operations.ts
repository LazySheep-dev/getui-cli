import { z } from "zod";
import { CliError } from "./errors.js";
import type {
  ActivityInput,
  ActivityResult,
  ActivityScope,
  AuthTokenInput,
  AuthTokenResult,
  CrowdExportCreateData,
  CrowdExportCreateInput,
  CrowdExportFileData,
  CrowdExportFileInput,
  CrowdExportStatusData,
  CrowdExportStatusInput,
  CrowdListData,
  CrowdListInput,
  DimensionFilters,
  EventImportInput,
  ImportResult,
  GroupBy,
  MetricPoint,
  OperationDefinition,
  OperationName,
  OperationResultContext,
  PeriodInput,
  PeriodMetric,
  PeriodResult,
  RetentionInput,
  RetentionResult,
  TagApiResult,
  TagExternalCreateInput,
  TagExternalEditInput,
  TagExternalImportInput,
  TagExternalTriggerInput,
  TagTreeInput,
  TagTreeResult,
  TagUserInput,
  TagUserResult,
  TagValueCreateInput,
  TagValueEditInput,
  TodayInput,
  TodayMetric,
  TodayResult,
  UserImportInput,
  UserApiResult,
  UserTrendInput,
  UserTrendMetric,
  UserTrendResult,
  UserVectorBatchInput,
  UserVectorBatchResult,
  UserVectorQueryInput,
  UserVectorQueryResult,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const activityScopeSchema = z
  .enum(["foreground", "all"])
  .default("foreground");
const groupBySchema = z
  .enum(["platform", "channel", "version", "package"])
  .optional();
const periodMetricSchema = z.enum(["new", "active", "start"]);
const userTrendMetricSchema = z.enum([
  "new",
  "active",
  "start",
  "total",
  "avgDuration",
  "avgFrequency",
]);

const cleanedStringArraySchema = z
  .array(z.string())
  .transform((values) => {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        throw new CliError("Filter values cannot be empty", {
          type: "validation",
          code: "GETUI_CLI_FILTER_VALUE_EMPTY",
          stage: "input",
        });
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        cleaned.push(trimmed);
      }
    }
    return cleaned;
  })
  .optional();

const dimensionFilterFields = {
  channels: cleanedStringArraySchema,
  appVersions: cleanedStringArraySchema,
  packageNames: cleanedStringArraySchema,
  platforms: cleanedStringArraySchema,
};

const todaySchema: z.ZodType<TodayInput> = z
  .object({ activityScope: activityScopeSchema })
  .strict();

const periodSchema: z.ZodType<PeriodInput> = z
  .object({
    metric: periodMetricSchema,
    groupBy: groupBySchema,
    groupValue: z.string().trim().min(1).optional(),
    activityScope: activityScopeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.groupValue !== undefined && value.groupBy === undefined) {
      context.addIssue({
        code: "custom",
        message: "groupValue requires groupBy",
        path: ["groupValue"],
      });
    }
  });

const activitySchema: z.ZodType<ActivityInput> = z
  .object({
    ...dimensionFilterFields,
    groupBy: groupBySchema,
    activityScope: activityScopeSchema,
  })
  .strict();

const userTrendSchema: z.ZodType<UserTrendInput> = z
  .object({
    ...dimensionFilterFields,
    startDate: dateStringSchema(),
    endDate: dateStringSchema(),
    metric: userTrendMetricSchema,
    groupBy: groupBySchema,
    activityScope: activityScopeSchema,
  })
  .strict()
  .superRefine(validateDateRange);

const retentionSchema: z.ZodType<RetentionInput> = z
  .object({
    ...dimensionFilterFields,
    startDate: dateStringSchema(),
    endDate: dateStringSchema(),
    metric: periodMetricSchema,
    groupBy: groupBySchema,
    activityScope: activityScopeSchema,
  })
  .strict()
  .superRefine(validateDateRange);

const tagIdTypeSchema = z.enum([
  "mobile_md5",
  "imei_md5",
  "oaid_md5",
  "idfa_md5",
  "cid",
  "gtcid",
]);

const tagStringSchema = z.string().trim().min(1, {
  message: "Value cannot be empty",
});

const tagIdListSchema = z
  .array(tagStringSchema)
  .min(1, { message: "List cannot be empty" })
  .max(200, { message: "List cannot contain more than 200 items" });

const tagCodeListSchema = z
  .array(tagStringSchema)
  .min(1, { message: "tagCodeList cannot be empty" });

const dirIdSchema = z
  .union([
    z.number().refine((value) => Number.isSafeInteger(value) && value >= 0, {
      message: "dirId must be a non-negative integer",
    }),
    z
      .string()
      .trim()
      .regex(/^\d+$/, {
        message: "dirId must be a non-negative integer",
      })
      .transform((value) => Number(value))
      .refine((value) => Number.isSafeInteger(value), {
        message: "dirId must be a safe integer",
      }),
  ])
  .optional();

const tagValueCreateSchema: z.ZodType<TagValueCreateInput> = z
  .object({
    tagValCn: tagStringSchema,
    idType: tagIdTypeSchema.optional(),
  })
  .strict();

const tagValueEditSchema: z.ZodType<TagValueEditInput> = z
  .object({
    tagValCn: tagStringSchema,
    idType: tagIdTypeSchema.optional(),
    tagValCode: tagStringSchema.optional(),
    reset: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tagValCode === undefined && value.reset !== true) {
      context.addIssue({
        code: "custom",
        message: "New tag values require reset: true",
        path: ["reset"],
      });
    }
  });

const authTokenSchema: z.ZodType<AuthTokenInput> = z
  .object({
    force: z.boolean().default(false),
  })
  .strict();

const tagUserSchema: z.ZodType<TagUserInput> = z
  .object({
    userIdList: tagIdListSchema,
  })
  .strict();

const tagTreeSchema: z.ZodType<TagTreeInput> = z.object({}).strict();

const tagExternalCreateSchema: z.ZodType<TagExternalCreateInput> = z
  .object({
    dirId: dirIdSchema,
    name: tagStringSchema,
    description: tagStringSchema.optional(),
    tagValueList: z
      .array(tagValueCreateSchema)
      .min(1, { message: "tagValueList cannot be empty" }),
  })
  .strict();

const tagExternalEditSchema: z.ZodType<TagExternalEditInput> = z
  .object({
    dirId: dirIdSchema,
    tagCode: tagStringSchema,
    name: tagStringSchema,
    description: tagStringSchema.optional(),
    tagValueList: z
      .array(tagValueEditSchema)
      .min(1, { message: "tagValueList cannot be empty" }),
  })
  .strict();

const tagExternalImportSchema: z.ZodType<TagExternalImportInput> = z
  .object({
    tagValCode: tagStringSchema,
    idList: tagIdListSchema,
  })
  .strict();

const tagExternalTriggerSchema: z.ZodType<TagExternalTriggerInput> = z
  .object({
    tagCodeList: tagCodeListSchema,
  })
  .strict();

const userStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Value cannot be empty",
});

// Getui documents datetime as a decimal millisecond timestamp. Requiring the
// current 13-digit representation avoids silently treating seconds as ms.
const datetimeSchema = z.string().regex(/^\d{13}$/, {
  message: "datetime must be a 13-digit millisecond timestamp string",
});

const importPropertiesSchema: z.ZodType<Record<string, unknown>> = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const appType = value["$app_type"];
    if (appType !== "app" && appType !== "mp" && appType !== "h5") {
      context.addIssue({
        code: "custom",
        message: "properties.$app_type must be app, mp, or h5",
        path: ["$app_type"],
      });
    }
    const os = value["$os"];
    if (typeof os !== "string" || os.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "properties.$os must be a non-empty string",
        path: ["$os"],
      });
    }
  });

const eventImportItemSchema = z
  .object({
    gtcid: userStringSchema,
    sessionId: userStringSchema.optional(),
    datetime: datetimeSchema,
    eventId: userStringSchema,
    properties: importPropertiesSchema,
  })
  .strict();

const userImportItemSchema = z
  .object({
    gtcid: userStringSchema,
    datetime: datetimeSchema,
    properties: importPropertiesSchema,
  })
  .strict();

const importListSchema = z
  .array(eventImportItemSchema)
  .min(1, { message: "dataList cannot be empty" })
  .max(200, { message: "dataList cannot contain more than 200 items" });

const userImportListSchema = z
  .array(userImportItemSchema)
  .min(1, { message: "dataList cannot be empty" })
  .max(200, { message: "dataList cannot contain more than 200 items" });

const eventImportSchema: z.ZodType<EventImportInput> = z
  .object({ dataList: importListSchema })
  .strict();

const userImportSchema: z.ZodType<UserImportInput> = z
  .object({ dataList: userImportListSchema })
  .strict();

const crowdIdSchema = userStringSchema;
const uidTypeSchema = z.enum(["CID", "GTCID"]);
const taskIdSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "taskId must be a positive safe integer" },
);

const crowdListSchema: z.ZodType<CrowdListInput> = z.object({}).strict();
const crowdExportCreateSchema: z.ZodType<CrowdExportCreateInput> = z
  .object({
    crowdId: crowdIdSchema,
    uidType: uidTypeSchema,
  })
  .strict();
const crowdExportStatusSchema: z.ZodType<CrowdExportStatusInput> = z
  .object({
    crowdId: crowdIdSchema,
    taskId: taskIdSchema,
  })
  .strict();
const crowdExportFileSchema: z.ZodType<CrowdExportFileInput> = z
  .object({
    crowdId: crowdIdSchema,
    taskId: taskIdSchema,
    fileId: userStringSchema,
  })
  .strict();

const vectorUserIdSchema = z.string().trim().min(1, {
  message: "userId cannot be empty",
});

const vectorUserIdListSchema = z
  .array(vectorUserIdSchema)
  .min(1, { message: "userIdList cannot be empty" })
  .max(50, { message: "userIdList cannot contain more than 50 items" });

const userVectorQuerySchema: z.ZodType<UserVectorQueryInput> = z
  .object({ userId: vectorUserIdSchema })
  .strict();

const userVectorBatchSchema: z.ZodType<UserVectorBatchInput> = z
  .object({ userIdList: vectorUserIdListSchema })
  .strict();

const ACTIVITY_SCOPE_MAP: Record<ActivityScope, string> = {
  all: "0",
  foreground: "1",
};

const GROUP_BY_MAP: Record<GroupBy, number> = {
  platform: 1,
  channel: 2,
  version: 3,
  package: 4,
};

const PERIOD_METRIC_MAP: Record<PeriodMetric, number> = {
  new: 0,
  active: 1,
  start: 2,
};

const USER_TREND_METRIC_MAP: Record<UserTrendMetric, number> = {
  new: 0,
  active: 1,
  start: 2,
  total: 3,
  avgDuration: 4,
  avgFrequency: 5,
};

const todayOperation: OperationDefinition<TodayInput, TodayResult> = {
  name: "statistics.today",
  kind: "protected",
  mutating: false,
  summary: "Today's installs, active users, and starts",
  path: "/export/todayStatistics",
  inputSchema: todaySchema,
  inputDescription: {
    activityScope: ["foreground", "all"],
  },
  buildRequest: (input) => ({
    foregroundFlag: ACTIVITY_SCOPE_MAP[input.activityScope],
  }),
  normalizeResponse(raw) {
    return {
      dimensions: responseList(raw).map((item) => {
        const statistics = requiredObject(item.statisticsData, "statisticsData");
        return {
          dimension: requiredString(item.dimension, "dimension"),
          install: normalizeTodayMetric(statistics.install, "install"),
          active: normalizeTodayMetric(statistics.active, "active"),
          start: normalizeTodayMetric(statistics.start, "start"),
        };
      }),
    };
  },
};

const periodOperation: OperationDefinition<PeriodInput, PeriodResult> = {
  name: "statistics.period",
  kind: "protected",
  mutating: false,
  summary: "Hourly new, active, or start statistics",
  path: "/export/periodChart",
  inputSchema: periodSchema,
  inputDescription: {
    metric: ["new", "active", "start"],
    groupBy: ["platform", "channel", "version", "package"],
    groupValue: "string",
    activityScope: ["foreground", "all"],
  },
  buildRequest(input) {
    const body: Record<string, unknown> = {
      analyzeType: PERIOD_METRIC_MAP[input.metric],
      foregroundFlag: ACTIVITY_SCOPE_MAP[input.activityScope],
    };
    addGroupBy(body, input.groupBy);
    if (input.groupValue !== undefined) {
      body.aggregatorValue = input.groupValue;
    }
    return body;
  },
  normalizeResponse(raw, input) {
    return {
      metric: input.metric,
      dimensions: responseList(raw).map((item) => {
        const statistics = requiredObject(item.statisticsData, "statisticsData");
        const result: PeriodResult["dimensions"][number] = {
          dimension: requiredString(item.dimension, "dimension"),
          today: normalizePoints(statistics.todayData, "todayData"),
          yesterday: normalizePoints(
            statistics.yesterdayData,
            "yesterdayData",
          ),
          sevenDaysAgo: normalizePoints(
            statistics.sevenDayData,
            "sevenDayData",
          ),
        };
        if (typeof statistics.itemName === "string") {
          result.itemName = statistics.itemName;
        }
        return result;
      }),
    };
  },
};

const activityOperation: OperationDefinition<ActivityInput, ActivityResult> = {
  name: "statistics.activity",
  kind: "protected",
  mutating: false,
  summary: "Yesterday, weekly, monthly, and DAU/MAU activity",
  path: "/export/activityStatistics",
  inputSchema: activitySchema,
  inputDescription: {
    channels: "string[]",
    appVersions: "string[]",
    packageNames: "string[]",
    platforms: "string[]",
    groupBy: ["platform", "channel", "version", "package"],
    activityScope: ["foreground", "all"],
  },
  buildRequest(input) {
    const body = buildDimensionBody(input);
    body.foregroundFlag = ACTIVITY_SCOPE_MAP[input.activityScope];
    addGroupBy(body, input.groupBy);
    return body;
  },
  normalizeResponse(raw) {
    return {
      dimensions: responseList(raw).map((item) => {
        const statistics = requiredObject(item.statisticsData, "statisticsData");
        return {
          dimension: requiredString(item.dimension, "dimension"),
          yesterdayActive: normalizeActivityMetric(statistics.ytd, "ytd"),
          weeklyActive: normalizeActivityMetric(statistics.week, "week"),
          monthlyActive: normalizeActivityMetric(statistics.month, "month"),
          dauMauRatio: normalizeRatioMetric(statistics.mau, "mau"),
        };
      }),
    };
  },
};

const userTrendOperation: OperationDefinition<
  UserTrendInput,
  UserTrendResult
> = {
  name: "statistics.userTrend",
  kind: "protected",
  mutating: false,
  summary: "Date-range user metric trends",
  path: "/export/userTrendChart",
  inputSchema: userTrendSchema,
  inputDescription: {
    startDate: "YYYY-MM-DD",
    endDate: "YYYY-MM-DD",
    metric: [
      "new",
      "active",
      "start",
      "total",
      "avgDuration",
      "avgFrequency",
    ],
    channels: "string[]",
    appVersions: "string[]",
    packageNames: "string[]",
    platforms: "string[]",
    groupBy: ["platform", "channel", "version", "package"],
    activityScope: ["foreground", "all"],
  },
  buildRequest(input) {
    const body = buildDimensionBody(input);
    Object.assign(body, {
      startDate: input.startDate,
      endDate: input.endDate,
      analyzeType: USER_TREND_METRIC_MAP[input.metric],
      foregroundFlag: ACTIVITY_SCOPE_MAP[input.activityScope],
    });
    addGroupBy(body, input.groupBy);
    return body;
  },
  normalizeResponse(raw, input) {
    return {
      metric: input.metric,
      series: responseList(raw).map((item) => ({
        dimension: requiredString(item.dimension, "dimension"),
        points: normalizePoints(
          item.statisticsDataList,
          "statisticsDataList",
        ),
      })),
    };
  },
};

const retentionOperation: OperationDefinition<RetentionInput, RetentionResult> = {
  name: "statistics.retention",
  kind: "protected",
  mutating: false,
  summary: "New, active, or start retention cohorts",
  path: "/export/remainChart",
  inputSchema: retentionSchema,
  inputDescription: {
    startDate: "YYYY-MM-DD",
    endDate: "YYYY-MM-DD",
    metric: ["new", "active", "start"],
    channels: "string[]",
    appVersions: "string[]",
    packageNames: "string[]",
    platforms: "string[]",
    groupBy: ["platform", "channel", "version", "package"],
    activityScope: ["foreground", "all"],
  },
  buildRequest(input) {
    const body = buildDimensionBody(input);
    Object.assign(body, {
      startDate: input.startDate,
      endDate: input.endDate,
      analyzeType: PERIOD_METRIC_MAP[input.metric],
      foregroundFlag: ACTIVITY_SCOPE_MAP[input.activityScope],
    });
    addGroupBy(body, input.groupBy);
    return body;
  },
  normalizeResponse(raw, input) {
    return {
      metric: input.metric,
      dimensions: responseList(raw).map((item) => {
        const cohortField = item.statisticsDataList !== undefined
          ? "statisticsDataList"
          : "statisticsData";
        const rawCohortValue = item[cohortField];
        const rawCohorts = Array.isArray(rawCohortValue)
          ? rawCohortValue
          : [rawCohortValue];
        return {
          dimension: requiredString(item.dimension, "dimension"),
          cohorts: rawCohorts.map((cohort, index) => {
            const value = requiredObject(
              cohort,
              `${cohortField}[${index}]`,
            );
            return {
              date: requiredString(value.date, "date"),
              userCount: nullableNumber(value.userCount, "userCount"),
              day1Percent: optionalNumber(
                value.yesterdayPercent,
                "yesterdayPercent",
              ),
              day2Percent: optionalNumber(
                value.twoDayPercent,
                "twoDayPercent",
              ),
              day3Percent: optionalNumber(
                value.threeDayPercent,
                "threeDayPercent",
              ),
              day4Percent: optionalNumber(
                value.fourDayPercent,
                "fourDayPercent",
              ),
              day5Percent: optionalNumber(
                value.fiveDayPercent,
                "fiveDayPercent",
              ),
              day6Percent: optionalNumber(
                value.sixDayPercent,
                "sixDayPercent",
              ),
              day7Percent: optionalNumber(
                value.sevenDayPercent,
                "sevenDayPercent",
              ),
              day30Percent: optionalNumber(
                value.thirtyDayPercent,
                "thirtyDayPercent",
              ),
            };
          }),
        };
      }),
    };
  },
};

const authTokenOperation: OperationDefinition<AuthTokenInput, AuthTokenResult> = {
  name: "auth.token",
  kind: "authentication",
  mutating: false,
  summary: "Get or refresh the application authentication token",
  path: "/auth",
  inputSchema: authTokenSchema,
  inputDescription: {
    force: "boolean; bypass a valid cached token when true",
  },
  // The authentication request body is built by GetuiClient from credentials,
  // timestamp, and signature. The operation input only controls cache policy.
  buildRequest: () => ({}),
  normalizeResponse(raw, _input, context) {
    return normalizeAuthResponse(raw, context);
  },
};

const tagUserOperation: OperationDefinition<TagUserInput, TagUserResult> = {
  name: "tag.user",
  kind: "protected",
  mutating: false,
  summary: "Query tags for a list of users",
  path: "/query_tag",
  inputSchema: tagUserSchema,
  inputDescription: {
    userIdList: "string[]; 1-200 user gtcids",
  },
  buildRequest: (input) => ({
    userIdList: [...input.userIdList],
  }),
  normalizeResponse(raw) {
    return normalizeTagUserResponse(raw);
  },
};

const tagTreeOperation: OperationDefinition<TagTreeInput, TagTreeResult> = {
  name: "tag.tree",
  kind: "protected",
  mutating: false,
  summary: "Query the complete application tag tree",
  path: "/query_tag_tree",
  inputSchema: tagTreeSchema,
  inputDescription: {},
  buildRequest: () => ({}),
  normalizeResponse(raw) {
    return normalizeTagTreeResponse(raw);
  },
};

const tagExternalCreateOperation: OperationDefinition<
  TagExternalCreateInput,
  TagApiResult
> = {
  name: "tag.external.create",
  kind: "protected",
  mutating: true,
  summary: "Create an external tag and its values",
  path: "/externalTag/add",
  inputSchema: tagExternalCreateSchema,
  inputDescription: {
    dirId: "non-negative integer; optional parent directory code",
    name: "string; tag name",
    description: "string; optional tag description",
    tagValueList: "array of { tagValCn, idType? }",
  },
  buildRequest(input) {
    const body: Record<string, unknown> = {
      name: input.name,
      tagValueList: input.tagValueList.map((value) => ({ ...value })),
    };
    addOptionalField(body, "dirId", input.dirId);
    addOptionalField(body, "description", input.description);
    return body;
  },
  normalizeResponse(raw) {
    return normalizeTagApiResponse(raw);
  },
};

const tagExternalEditOperation: OperationDefinition<
  TagExternalEditInput,
  TagApiResult
> = {
  name: "tag.external.edit",
  kind: "protected",
  mutating: true,
  summary: "Edit an external tag and its values",
  path: "/externalTag/edit",
  inputSchema: tagExternalEditSchema,
  inputDescription: {
    dirId: "non-negative integer; optional parent directory code",
    tagCode: "string; existing tag code",
    name: "string; tag name",
    description: "string; optional tag description",
    tagValueList:
      "array of { tagValCn, idType?, tagValCode?, reset }; new values require reset=true",
  },
  buildRequest(input) {
    const body: Record<string, unknown> = {
      tagCode: input.tagCode,
      name: input.name,
      tagValueList: input.tagValueList.map((value) => ({ ...value })),
    };
    addOptionalField(body, "dirId", input.dirId);
    addOptionalField(body, "description", input.description);
    return body;
  },
  normalizeResponse(raw) {
    return normalizeTagApiResponse(raw);
  },
};

const tagExternalImportOperation: OperationDefinition<
  TagExternalImportInput,
  TagApiResult
> = {
  name: "tag.external.import",
  kind: "protected",
  mutating: true,
  summary: "Import user IDs into an external tag value",
  path: "/externalTag/tagVal/data/import",
  inputSchema: tagExternalImportSchema,
  inputDescription: {
    tagValCode: "string; existing tag value code",
    idList: "string[]; 1-200 user IDs",
  },
  buildRequest: (input) => ({
    tagValCode: input.tagValCode,
    idList: [...input.idList],
  }),
  normalizeResponse(raw) {
    return normalizeTagApiResponse(raw);
  },
};

const tagExternalTriggerOperation: OperationDefinition<
  TagExternalTriggerInput,
  TagApiResult
> = {
  name: "tag.external.trigger",
  kind: "protected",
  mutating: true,
  summary: "Trigger external tag calculation",
  path: "/externalTag/trigger",
  inputSchema: tagExternalTriggerSchema,
  inputDescription: {
    tagCodeList: "string[]; one or more external tag codes",
  },
  buildRequest: (input) => ({
    tagCodeList: [...input.tagCodeList],
  }),
  normalizeResponse(raw) {
    return normalizeTagApiResponse(raw);
  },
};

const userImportEventOperation: OperationDefinition<
  EventImportInput,
  ImportResult
> = {
  name: "user.import.event",
  kind: "protected",
  mutating: true,
  retryClass: "write",
  summary: "Import historical event data",
  path: "/import/event",
  inputSchema: eventImportSchema,
  inputDescription: {
    dataList: "array of 1-200 event records",
  },
  buildRequest(input) {
    return {
      dataList: input.dataList.map((item) => ({
        ...item,
        properties: { ...item.properties },
      })),
    };
  },
  queryForOutput(input) {
    return { importType: "event", recordCount: input.dataList.length };
  },
  normalizeResponse(raw, input) {
    return normalizeImportResponse(raw, "event", input.dataList.length);
  },
};

const userImportUserOperation: OperationDefinition<
  UserImportInput,
  ImportResult
> = {
  name: "user.import.user",
  kind: "protected",
  mutating: true,
  retryClass: "write",
  summary: "Import historical user data",
  path: "/import/user",
  inputSchema: userImportSchema,
  inputDescription: {
    dataList: "array of 1-200 user records",
  },
  buildRequest(input) {
    return {
      dataList: input.dataList.map((item) => ({
        ...item,
        properties: { ...item.properties },
      })),
    };
  },
  queryForOutput(input) {
    return { importType: "user", recordCount: input.dataList.length };
  },
  normalizeResponse(raw, input) {
    return normalizeImportResponse(raw, "user", input.dataList.length);
  },
};

const userCrowdListOperation: OperationDefinition<
  CrowdListInput,
  UserApiResult<CrowdListData>
> = {
  name: "user.crowd.list",
  kind: "protected",
  mutating: false,
  retryClass: "read",
  summary: "List exportable user crowds",
  path: "/export/crowd/exportableCrowdList",
  inputSchema: crowdListSchema,
  inputDescription: {},
  buildRequest: () => ({}),
  normalizeResponse(raw) {
    return normalizeCrowdListResponse(raw);
  },
};

const userCrowdExportCreateOperation: OperationDefinition<
  CrowdExportCreateInput,
  UserApiResult<CrowdExportCreateData>
> = {
  name: "user.crowd.export.create",
  kind: "protected",
  mutating: true,
  retryClass: "write",
  summary: "Create a user crowd export task",
  path: "/export/crowd/createCrowdExportTask",
  inputSchema: crowdExportCreateSchema,
  inputDescription: {
    crowdId: "non-empty crowd ID",
    uidType: ["CID", "GTCID"],
  },
  buildRequest: (input) => ({
    crowdId: input.crowdId,
    uidType: input.uidType,
  }),
  normalizeResponse(raw) {
    return normalizeCrowdExportCreateResponse(raw);
  },
};

const userCrowdExportStatusOperation: OperationDefinition<
  CrowdExportStatusInput,
  UserApiResult<CrowdExportStatusData>
> = {
  name: "user.crowd.export.status",
  kind: "protected",
  mutating: false,
  retryClass: "read",
  summary: "Get a user crowd export task status",
  path: "/export/crowd/exportCrowdTaskStatus",
  inputSchema: crowdExportStatusSchema,
  inputDescription: {
    crowdId: "non-empty crowd ID",
    taskId: "positive safe integer task ID",
  },
  buildRequest: (input) => ({
    crowdId: input.crowdId,
    taskId: input.taskId,
  }),
  normalizeResponse(raw) {
    return normalizeCrowdExportStatusResponse(raw);
  },
};

const userCrowdExportFileOperation: OperationDefinition<
  CrowdExportFileInput,
  UserApiResult<CrowdExportFileData>
> = {
  name: "user.crowd.export.file",
  kind: "protected",
  mutating: false,
  retryClass: "read",
  summary: "Get IDs from one user crowd export file",
  path: "/export/crowd/exportCrowdSingleFile",
  inputSchema: crowdExportFileSchema,
  inputDescription: {
    crowdId: "non-empty crowd ID",
    taskId: "positive safe integer task ID",
    fileId: "non-empty file ID",
  },
  buildRequest: (input) => ({
    crowdId: input.crowdId,
    taskId: input.taskId,
    fileId: input.fileId,
  }),
  normalizeResponse(raw) {
    return normalizeCrowdExportFileResponse(raw);
  },
};

const userVectorQueryOperation: OperationDefinition<
  UserVectorQueryInput,
  UserVectorQueryResult
> = {
  name: "user.vector.query",
  kind: "protected",
  mutating: false,
  retryClass: "read",
  summary: "Query vector information for one GTCID",
  path: "/v2/query_vector",
  inputSchema: userVectorQuerySchema,
  inputDescription: {
    userId: "string; one GTCID",
  },
  buildRequest: (input) => ({
    userId: input.userId,
  }),
  normalizeResponse(raw) {
    return normalizeUserApiResponse(raw);
  },
};

const userVectorBatchOperation: OperationDefinition<
  UserVectorBatchInput,
  UserVectorBatchResult
> = {
  name: "user.vector.batch",
  kind: "protected",
  mutating: false,
  retryClass: "read",
  summary: "Query vector information for up to 50 GTCIDs",
  path: "/v2/batch_query_vector",
  inputSchema: userVectorBatchSchema,
  inputDescription: {
    userIdList: "string[]; 1-50 GTCIDs",
  },
  buildRequest: (input) => ({
    userIdList: [...input.userIdList],
  }),
  normalizeResponse(raw) {
    return normalizeUserApiResponse(raw);
  },
};

const OPERATIONS: Array<OperationDefinition<unknown, unknown>> = [
  todayOperation as OperationDefinition<unknown, unknown>,
  periodOperation as OperationDefinition<unknown, unknown>,
  activityOperation as OperationDefinition<unknown, unknown>,
  userTrendOperation as OperationDefinition<unknown, unknown>,
  retentionOperation as OperationDefinition<unknown, unknown>,
  authTokenOperation as OperationDefinition<unknown, unknown>,
  tagUserOperation as OperationDefinition<unknown, unknown>,
  tagTreeOperation as OperationDefinition<unknown, unknown>,
  tagExternalCreateOperation as OperationDefinition<unknown, unknown>,
  tagExternalEditOperation as OperationDefinition<unknown, unknown>,
  tagExternalImportOperation as OperationDefinition<unknown, unknown>,
  tagExternalTriggerOperation as OperationDefinition<unknown, unknown>,
  userImportEventOperation as OperationDefinition<unknown, unknown>,
  userImportUserOperation as OperationDefinition<unknown, unknown>,
  userCrowdListOperation as OperationDefinition<unknown, unknown>,
  userCrowdExportCreateOperation as OperationDefinition<unknown, unknown>,
  userCrowdExportStatusOperation as OperationDefinition<unknown, unknown>,
  userCrowdExportFileOperation as OperationDefinition<unknown, unknown>,
  userVectorQueryOperation as OperationDefinition<unknown, unknown>,
  userVectorBatchOperation as OperationDefinition<unknown, unknown>,
];

const OPERATION_MAP = new Map(
  OPERATIONS.map((operation) => [operation.name, operation]),
);

export const operationRegistry = {
  list(): Array<OperationDefinition<unknown, unknown>> {
    return [...OPERATIONS];
  },

  get(name: string): OperationDefinition<unknown, unknown> | null {
    return OPERATION_MAP.get(name as OperationName) ?? null;
  },
};

function dateStringSchema(): z.ZodType<string> {
  return z.string().refine((value) => parseDate(value) !== null, {
    message: "Date must be a real calendar date in YYYY-MM-DD format",
  });
}

function validateDateRange(
  value: { startDate: string; endDate: string },
  context: z.RefinementCtx,
): void {
  const start = parseDate(value.startDate);
  const end = parseDate(value.endDate);
  if (start === null || end === null) {
    return;
  }
  if (start > end) {
    context.addIssue({
      code: "custom",
      message: "startDate must not be later than endDate",
      path: ["startDate"],
    });
    return;
  }

  const today = localCalendarUtc(new Date());
  if (end > today) {
    context.addIssue({
      code: "custom",
      message: "Future dates are not supported",
      path: ["endDate"],
    });
  }
  if ((end - start) / DAY_MS > 90) {
    context.addIssue({
      code: "custom",
      message: "Date range cannot exceed 90 days",
      path: ["endDate"],
    });
  }

  const oneYearAgo = new Date(today);
  oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
  if (start < oneYearAgo.getTime()) {
    context.addIssue({
      code: "custom",
      message: "Date range must be within the most recent year",
      path: ["startDate"],
    });
  }
}

function parseDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? timestamp
    : null;
}

function localCalendarUtc(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildDimensionBody(input: DimensionFilters): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  addJoined(body, "channels", input.channels);
  addJoined(body, "appVersions", input.appVersions);
  addJoined(body, "packageNames", input.packageNames);
  addJoined(body, "platforms", input.platforms);
  return body;
}

function addJoined(
  body: Record<string, unknown>,
  key: string,
  values?: string[],
): void {
  if (values !== undefined) {
    body[key] = values.join(",");
  }
}

function addGroupBy(body: Record<string, unknown>, groupBy?: GroupBy): void {
  if (groupBy !== undefined) {
    body.aggregatorType = GROUP_BY_MAP[groupBy];
  }
}

function addOptionalField(
  body: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    body[key] = value;
  }
}

function normalizeImportResponse(
  raw: unknown,
  importType: "event" | "user",
  recordCount: number,
): ImportResult {
  const response = normalizeUserApiResponse(raw);
  return {
    code: response.code,
    msg: response.msg,
    data: { importType, recordCount },
  };
}

function normalizeCrowdListResponse(
  raw: unknown,
): UserApiResult<CrowdListData> {
  const response = normalizeUserApiResponse(raw);
  if (response.data === null) {
    return { code: response.code, msg: response.msg, data: null };
  }
  const data = requiredObject(response.data, "data");
  const listValue = data.list;
  const list = listValue === undefined || listValue === null
    ? []
    : (() => {
        if (!Array.isArray(listValue)) {
          throw invalidRemoteField("data.list");
        }
        return listValue.map((item, index) =>
          requiredObject(item, `data.list[${index}]`),
        );
      })();
  return {
    code: response.code,
    msg: response.msg,
    data: {
      list,
      total: data.total === undefined || data.total === null
        ? 0
        : requiredNumber(data.total, "data.total"),
    },
  };
}

function normalizeCrowdExportCreateResponse(
  raw: unknown,
): UserApiResult<CrowdExportCreateData> {
  const response = normalizeUserApiResponse(raw);
  if (response.data === null) {
    return { code: response.code, msg: response.msg, data: null };
  }
  const data = requiredObject(response.data, "data");
  if (data.taskId === undefined || data.taskId === null) {
    return { code: response.code, msg: response.msg, data: null };
  }
  return {
    code: response.code,
    msg: response.msg,
    data: {
      taskId: requiredPositiveSafeInteger(data.taskId, "data.taskId"),
    },
  };
}

function normalizeCrowdExportStatusResponse(
  raw: unknown,
): UserApiResult<CrowdExportStatusData> {
  const response = normalizeUserApiResponse(raw);
  if (response.data === null) {
    return { code: response.code, msg: response.msg, data: null };
  }
  const data = requiredObject(response.data, "data");
  const fileIdList = data.fileIdList;
  if (fileIdList !== undefined && fileIdList !== null && !Array.isArray(fileIdList)) {
    throw invalidRemoteField("data.fileIdList");
  }
  const normalized: Record<string, unknown> = { ...data };
  if (typeof data.appId !== "undefined" && data.appId !== null) {
    normalized.appId = requiredString(data.appId, "data.appId");
  }
  normalized.crowdId = requiredString(data.crowdId, "data.crowdId");
  normalized.taskId = requiredPositiveSafeInteger(data.taskId, "data.taskId");
  normalized.uidType = requiredUidType(data.uidType, "data.uidType");
  normalized.status = requiredStatus(data.status, "data.status");
  normalized.fileIdList = (fileIdList ?? []).map((value, index) =>
    requiredString(value, `data.fileIdList[${index}]`),
  );
  return {
    code: response.code,
    msg: response.msg,
    data: normalized as unknown as CrowdExportStatusData,
  };
}

function normalizeCrowdExportFileResponse(
  raw: unknown,
): UserApiResult<CrowdExportFileData> {
  const response = normalizeUserApiResponse(raw);
  if (response.data === null) {
    return { code: response.code, msg: response.msg, data: null };
  }
  const data = requiredObject(response.data, "data");
  const listValue = data.list;
  const list = listValue === undefined || listValue === null
    ? []
    : (() => {
        if (!Array.isArray(listValue)) {
          throw invalidRemoteField("data.list");
        }
        return listValue.map((value, index) =>
          requiredString(value, `data.list[${index}]`),
        );
      })();
  return {
    code: response.code,
    msg: response.msg,
    data: {
      list,
      total: data.total === undefined || data.total === null
        ? 0
        : requiredNumber(data.total, "data.total"),
    },
  };
}

function normalizeUserApiResponse(raw: unknown): UserApiResult<unknown> {
  const root = requiredObject(raw, "response");
  return {
    code: requiredUserCode(root.code, "code"),
    msg: requiredString(root.msg, "msg"),
    data: root.data === undefined || root.data === null ? null : root.data,
  };
}

function normalizeAuthResponse(
  raw: unknown,
  context?: OperationResultContext,
): AuthTokenResult {
  const response = normalizeTagApiResponse(raw);
  let expiresAt = context?.tokenExpiresAt;
  if (expiresAt === undefined && response.data !== null) {
    const authData = requiredObject(response.data, "data");
    expiresAt = requiredNumber(authData.expireTime, "data.expireTime");
  }
  if (expiresAt === undefined) {
    throw invalidRemoteField("data.expireTime");
  }
  return {
    code: response.code,
    msg: response.msg,
    data: {
      tokenStatus: context?.tokenStatus ?? "valid",
      expiresAt,
      refreshed: context?.tokenRefreshed ?? true,
    },
  };
}

function normalizeTagApiResponse(raw: unknown): TagApiResult {
  const root = requiredObject(raw, "response");
  return {
    code: requiredNumber(root.code, "code"),
    msg: requiredString(root.msg, "msg"),
    data: root.data === undefined ? null : root.data,
  };
}

function normalizeTagUserResponse(raw: unknown): TagUserResult {
  const response = normalizeTagApiResponse(raw);
  if (response.data === null) {
    return {
      code: response.code,
      msg: response.msg,
      data: null,
    };
  }
  const data = requiredObject(response.data, "data");
  return {
    code: response.code,
    msg: response.msg,
    data: {
      ...data,
      validTags: optionalList(data.validTags, "data.validTags"),
      invalidTags: optionalList(data.invalidTags, "data.invalidTags"),
    },
  };
}

function normalizeTagTreeResponse(raw: unknown): TagTreeResult {
  const response = normalizeTagApiResponse(raw);
  if (response.data === null) {
    return {
      code: response.code,
      msg: response.msg,
      data: null,
    };
  }
  const data = requiredObject(response.data, "data");
  return {
    code: response.code,
    msg: response.msg,
    data: {
      ...data,
      customTagList: optionalList(data.customTagList, "data.customTagList"),
      externalTagList: optionalList(
        data.externalTagList,
        "data.externalTagList",
      ),
      gtagList: optionalList(data.gtagList, "data.gtagList"),
    },
  };
}

function optionalList(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidRemoteField(field);
  }
  return value;
}

function responseList(raw: unknown): Array<Record<string, unknown>> {
  const root = requiredObject(raw, "response");
  const data = requiredObject(root.data, "data");
  if (!Array.isArray(data.list)) {
    throw invalidRemoteField("data.list");
  }
  return data.list.map((item, index) =>
    requiredObject(item, `data.list[${index}]`),
  );
}

function normalizeTodayMetric(value: unknown, field: string): TodayMetric {
  const metric = requiredObject(value, field);
  return {
    count: requiredNumber(metric.cnt, `${field}.cnt`),
    previousDayPercent: optionalNumber(
      metric.ytdPercent,
      `${field}.ytdPercent`,
    ),
    sevenDayPercent: optionalNumber(
      metric.sevenPercent,
      `${field}.sevenPercent`,
    ),
  };
}

function normalizeActivityMetric(
  value: unknown,
  field: string,
): { total: number; comparison: number | null } {
  const metric = requiredObject(value, field);
  return {
    total: requiredNumber(metric.total, `${field}.total`),
    comparison: optionalNumber(metric.mom, `${field}.mom`),
  };
}

function normalizeRatioMetric(
  value: unknown,
  field: string,
): { value: number | null; comparison: number | null } {
  const metric = requiredObject(value, field);
  return {
    value: optionalNumber(metric.total, `${field}.total`),
    comparison: optionalNumber(metric.mom, `${field}.mom`),
  };
}

function normalizePoints(value: unknown, field: string): MetricPoint[] {
  if (!Array.isArray(value)) {
    throw invalidRemoteField(field);
  }
  return value.map((point, index) => {
    const item = requiredObject(point, `${field}[${index}]`);
    const timeValue = item.time ?? item.date;
    return {
      time: requiredString(timeValue, `${field}[${index}].time`),
      value: requiredNumber(item.value, `${field}[${index}].value`),
    };
  });
}

function requiredObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRemoteField(field);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRemoteField(field);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw invalidRemoteField(field);
  }
  if (typeof value === "string" && value.trim().length === 0) {
    throw invalidRemoteField(field);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw invalidRemoteField(field);
  }
  return parsed;
}

function requiredUserCode(value: unknown, field: string): number | string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidRemoteField(field);
    }
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw invalidRemoteField(field);
}

function requiredPositiveSafeInteger(value: unknown, field: string): number {
  const parsed = requiredNumber(value, field);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalidRemoteField(field);
  }
  return parsed;
}

function requiredUidType(value: unknown, field: string): "CID" | "GTCID" {
  if (value === "CID" || value === "GTCID") {
    return value;
  }
  throw invalidRemoteField(field);
}

function requiredStatus(value: unknown, field: string): 0 | 1 | 2 {
  const parsed = requiredNumber(value, field);
  if (!Number.isInteger(parsed) || (parsed !== 0 && parsed !== 1 && parsed !== 2)) {
    throw invalidRemoteField(field);
  }
  return parsed;
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : requiredNumber(value, field);
}

function optionalNumber(value: unknown, field: string): number | null {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "-"
  ) {
    return null;
  }
  return requiredNumber(value, field);
}

function invalidRemoteField(field: string): CliError {
  return new CliError(`Getui response field is invalid: ${field}`, {
    type: "remote",
    code: "GETUI_CLI_RESPONSE_INVALID",
    stage: "response",
    details: { field },
  });
}
