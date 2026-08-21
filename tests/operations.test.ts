import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { operationRegistry } from "../src/operations.js";

function operation(name: string) {
  const value = operationRegistry.get(name);
  expect(value).not.toBeNull();
  return value!;
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(process.cwd(), "tests", "fixtures", name), "utf8"),
  );
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("operation registry", () => {
  it("exposes the statistics, tag/auth, and user operations", () => {
    expect(operationRegistry.list().map((item) => item.name)).toEqual([
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
    expect(operationRegistry.get("statistics.unknown")).toBeNull();
  });

  it("maps today defaults", () => {
    const definition = operation("statistics.today");
    const input = definition.inputSchema.parse({});
    expect(input).toEqual({ activityScope: "foreground" });
    expect(definition.buildRequest(input)).toEqual({ foregroundFlag: "1" });
  });

  it("maps period business values", () => {
    const definition = operation("statistics.period");
    const input = definition.inputSchema.parse({
      metric: "active",
      groupBy: "channel",
      groupValue: "organic",
      activityScope: "all",
    });
    expect(definition.buildRequest(input)).toEqual({
      analyzeType: 1,
      foregroundFlag: "0",
      aggregatorType: 2,
      aggregatorValue: "organic",
    });
  });

  it("cleans and maps dimension filters", () => {
    const definition = operation("statistics.activity");
    const input = definition.inputSchema.parse({
      channels: [" App Store ", "App Store", "organic"],
      appVersions: ["1.0", " 2.0 "],
      packageNames: ["com.example.app"],
      platforms: ["android", "ios"],
      groupBy: "platform",
    });
    expect(definition.buildRequest(input)).toEqual({
      channels: "App Store,organic",
      appVersions: "1.0,2.0",
      packageNames: "com.example.app",
      platforms: "android,ios",
      foregroundFlag: "1",
      aggregatorType: 1,
    });
  });

  it("maps all user trend metrics", () => {
    const definition = operation("statistics.userTrend");
    const metrics = [
      ["new", 0],
      ["active", 1],
      ["start", 2],
      ["total", 3],
      ["avgDuration", 4],
      ["avgFrequency", 5],
    ] as const;
    for (const [metric, expected] of metrics) {
      const input = definition.inputSchema.parse({
        startDate: dateOffset(-6),
        endDate: dateOffset(0),
        metric,
      });
      expect(definition.buildRequest(input)).toMatchObject({
        analyzeType: expected,
        foregroundFlag: "1",
      });
    }
  });

  it("maps retention inputs", () => {
    const definition = operation("statistics.retention");
    const input = definition.inputSchema.parse({
      startDate: dateOffset(-30),
      endDate: dateOffset(-1),
      metric: "new",
      groupBy: "version",
    });
    expect(definition.buildRequest(input)).toMatchObject({
      analyzeType: 0,
      aggregatorType: 3,
      foregroundFlag: "1",
    });
  });

  it("rejects invalid dates and unsupported input fields", () => {
    const definition = operation("statistics.userTrend");
    expect(() =>
      definition.inputSchema.parse({
        startDate: "2026-02-30",
        endDate: dateOffset(0),
        metric: "active",
      }),
    ).toThrow();
    expect(() =>
      definition.inputSchema.parse({
        startDate: dateOffset(-100),
        endDate: dateOffset(0),
        metric: "active",
      }),
    ).toThrow(/90 days/);
    expect(() =>
      definition.inputSchema.parse({
        startDate: dateOffset(-400),
        endDate: dateOffset(-399),
        metric: "active",
      }),
    ).toThrow(/recent year/);
    expect(() =>
      definition.inputSchema.parse({
        startDate: dateOffset(0),
        endDate: dateOffset(1),
        metric: "active",
      }),
    ).toThrow(/Future/);
    for (const field of ["url", "path", "method"]) {
      expect(() =>
        definition.inputSchema.parse({
          startDate: dateOffset(-1),
          endDate: dateOffset(0),
          metric: "active",
          [field]: "override",
        }),
      ).toThrow();
    }
    expect(() =>
      definition.inputSchema.parse({
        startDate: dateOffset(-1),
        endDate: dateOffset(0),
        metric: "unknown",
      }),
    ).toThrow();
  });

  it("requires groupBy when groupValue is present", () => {
    const definition = operation("statistics.period");
    expect(() =>
      definition.inputSchema.parse({ metric: "new", groupValue: "ios" }),
    ).toThrow(/groupValue requires groupBy/);
  });

  it("maps vector query and batch inputs without changing user ID order", () => {
    const query = operation("user.vector.query");
    const queryInput = query.inputSchema.parse({ userId: "  gtcid-1  " });
    expect(queryInput).toEqual({ userId: "gtcid-1" });
    expect(query.buildRequest(queryInput)).toEqual({ userId: "gtcid-1" });

    const batch = operation("user.vector.batch");
    const batchInput = batch.inputSchema.parse({
      userIdList: ["gtcid-2", " gtcid-1 ", "gtcid-2"],
    });
    expect(batchInput).toEqual({
      userIdList: ["gtcid-2", "gtcid-1", "gtcid-2"],
    });
    expect(batch.buildRequest(batchInput)).toEqual({
      userIdList: ["gtcid-2", "gtcid-1", "gtcid-2"],
    });
    expect(() =>
      batch.inputSchema.parse({ userIdList: Array.from({ length: 51 }, (_, i) => `id-${i}`) }),
    ).toThrow(/50 items/);
  });

  it("preserves vector response data, including the raw vert field", () => {
    const definition = operation("user.vector.query");
    const input = definition.inputSchema.parse({ userId: "gtcid-1" });
    const vert = "[0.10000000000000001, -0.2]";
    expect(
      definition.normalizeResponse(
        { code: 0, msg: "success", data: { userId: "gtcid-1", vert } },
        input,
      ),
    ).toEqual({ code: 0, msg: "success", data: { userId: "gtcid-1", vert } });

    const batch = operation("user.vector.batch");
    const batchInput = batch.inputSchema.parse({
      userIdList: ["gtcid-1", "gtcid-2"],
    });
    const batchData = {
      validVectors: [{ userId: "gtcid-1", vert }],
      invalidVectors: [{ userId: "gtcid-2", vert: null, reason: "not found" }],
    };
    expect(
      batch.normalizeResponse(
        { code: 0, msg: "success", data: batchData },
        batchInput,
      ),
    ).toEqual({ code: 0, msg: "success", data: batchData });
    expect(
      definition.normalizeResponse(
        { code: 0, msg: "success", data: { userId: "gtcid-1", vert: "" } },
        input,
      ),
    ).toEqual({ code: 0, msg: "success", data: { userId: "gtcid-1", vert: "" } });
    expect(
      definition.normalizeResponse(
        { code: 0, msg: "success", data: null },
        input,
      ),
    ).toEqual({ code: 0, msg: "success", data: null });
  });
});

describe("response normalization", () => {
  it("normalizes today", async () => {
    const definition = operation("statistics.today");
    const input = definition.inputSchema.parse({});
    const result = definition.normalizeResponse(
      await fixture("today-success.json"),
      input,
    ) as { dimensions: unknown[] };
    expect(result.dimensions).toHaveLength(2);
    expect(result.dimensions[0]).toMatchObject({
      dimension: "total",
      install: { count: 120, previousDayPercent: 11.11 },
      active: { count: 980 },
      start: { count: 2200, previousDayPercent: null },
    });
  });

  it("normalizes period", async () => {
    const definition = operation("statistics.period");
    const input = definition.inputSchema.parse({ metric: "active" });
    expect(definition.normalizeResponse(await fixture("period-success.json"), input))
      .toMatchObject({
        metric: "active",
        dimensions: [
          {
            dimension: "total",
            today: [
              { time: "00:00:00", value: 127 },
              { time: "01:00:00", value: 140 },
            ],
          },
        ],
      });
  });

  it("normalizes activity", async () => {
    const definition = operation("statistics.activity");
    const input = definition.inputSchema.parse({});
    const result = definition.normalizeResponse(
      await fixture("activity-success.json"),
      input,
    ) as { dimensions: unknown[] };
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions[0]).toMatchObject({
      dimension: "total",
      yesterdayActive: { total: 1000, comparison: 0.35 },
      dauMauRatio: { value: 0.2511, comparison: 0.03 },
    });
    expect(result.dimensions[2]).toMatchObject({
      dimension: "鸿蒙",
      yesterdayActive: { total: 37050, comparison: null },
      weeklyActive: { total: 99824, comparison: null },
      monthlyActive: { total: 162845, comparison: null },
      dauMauRatio: { value: 0.2275, comparison: null },
    });
    expect(result.dimensions[3]).toMatchObject({
      dimension: "unknown",
      dauMauRatio: { value: null, comparison: null },
    });
  });

  it("rejects invalid activity comparison values", async () => {
    const definition = operation("statistics.activity");
    const input = definition.inputSchema.parse({});
    const response = await fixture("activity-success.json") as {
      data: { list: Array<{ statisticsData: { ytd: { mom: unknown } } }> };
    };
    response.data.list[2].statisticsData.ytd.mom = "not-a-number";

    expect(() => definition.normalizeResponse(response, input)).toThrow(
      "Getui response field is invalid: ytd.mom",
    );
  });

  it("rejects placeholder values for required activity totals", async () => {
    const definition = operation("statistics.activity");
    const input = definition.inputSchema.parse({});
    const response = await fixture("activity-success.json") as {
      data: { list: Array<{ statisticsData: { ytd: { total: unknown } } }> };
    };
    response.data.list[2].statisticsData.ytd.total = "-";

    expect(() => definition.normalizeResponse(response, input)).toThrow(
      "Getui response field is invalid: ytd.total",
    );
  });

  it("normalizes trends", async () => {
    const definition = operation("statistics.userTrend");
    const input = definition.inputSchema.parse({
      startDate: dateOffset(-6),
      endDate: dateOffset(0),
      metric: "active",
    });
    const result = definition.normalizeResponse(
      await fixture("trend-success.json"),
      input,
    ) as { metric: string; series: unknown[] };
    expect(result.metric).toBe("active");
    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toEqual({
      dimension: "android",
      points: [
        { time: "2026-08-01", value: 127 },
        { time: "2026-08-02", value: 150 },
      ],
    });
  });

  it("normalizes retention object and array cohorts", async () => {
    const definition = operation("statistics.retention");
    const input = definition.inputSchema.parse({
      startDate: dateOffset(-30),
      endDate: dateOffset(-1),
      metric: "new",
    });
    const result = definition.normalizeResponse(
      await fixture("retention-success.json"),
      input,
    ) as { dimensions: Array<{ cohorts: unknown[] }> };
    expect(result.dimensions[0]?.cohorts).toHaveLength(2);
    expect(result.dimensions[1]?.cohorts).toHaveLength(1);
    expect(result.dimensions[0]?.cohorts[0]).toMatchObject({
      userCount: 83852,
      day1Percent: 31.95,
      day30Percent: null,
    });
  });

  it("normalizes current retention statisticsDataList responses", async () => {
    const definition = operation("statistics.retention");
    const input = definition.inputSchema.parse({
      startDate: dateOffset(-30),
      endDate: dateOffset(-1),
      metric: "active",
    });
    const result = definition.normalizeResponse(
      await fixture("retention-list-success.json"),
      input,
    ) as { dimensions: Array<{ cohorts: Array<{ userCount: number }> }> };
    expect(result.dimensions[0]?.cohorts).toHaveLength(2);
    expect(result.dimensions[0]?.cohorts[0]?.userCount).toBe(108344);
  });

  it("preserves retention dimensions with explicit null cohort data", async () => {
    const definition = operation("statistics.retention");
    const input = definition.inputSchema.parse({
      startDate: dateOffset(-30),
      endDate: dateOffset(-1),
      metric: "active",
      groupBy: "platform",
    });
    const result = definition.normalizeResponse(
      await fixture("retention-platform-null-success.json"),
      input,
    ) as {
      dimensions: Array<{
        dimension: string;
        cohorts: Array<Record<string, unknown>>;
      }>;
    };
    expect(result.dimensions.map((item) => item.dimension)).toEqual([
      "total",
      "Android",
      "iOS",
      "鸿蒙",
      "unknown",
    ]);
    expect(result.dimensions[0]?.cohorts[0]?.userCount).toBe(116285);
    expect(result.dimensions[1]?.cohorts[0]?.userCount).toBe(38478);
    expect(result.dimensions[4]?.cohorts[0]).toEqual({
      date: "2026-07-01",
      userCount: null,
      day1Percent: null,
      day2Percent: null,
      day3Percent: null,
      day4Percent: null,
      day5Percent: null,
      day6Percent: null,
      day7Percent: null,
      day30Percent: null,
    });
  });

  it.each([
    ["missing", undefined],
    ["empty string", ""],
    ["non-number string", "not-a-number"],
    ["boolean", true],
    ["object", {}],
    ["array", []],
  ])("rejects retention %s userCount values", async (_label, invalid) => {
    const definition = operation("statistics.retention");
    const input = definition.inputSchema.parse({
      startDate: dateOffset(-30),
      endDate: dateOffset(-1),
      metric: "active",
    });
    const response = await fixture("retention-platform-null-success.json") as {
      data: { list: Array<{ statisticsDataList: Array<Record<string, unknown>> }> };
    };
    if (invalid === undefined) {
      delete response.data.list[0]!.statisticsDataList[0]!.userCount;
    } else {
      response.data.list[0]!.statisticsDataList[0]!.userCount = invalid;
    }
    expect(() => definition.normalizeResponse(response, input)).toThrow(
      "Getui response field is invalid: userCount",
    );
  });

  it("reports invalid current retention cohort paths", async () => {
    const definition = operation("statistics.retention");
    const input = definition.inputSchema.parse({
      startDate: dateOffset(-30),
      endDate: dateOffset(-1),
      metric: "active",
    });
    const response = await fixture("retention-list-success.json") as {
      data: { list: Array<{ statisticsDataList: unknown[] }> };
    };
    response.data.list[0]!.statisticsDataList[0] = null;
    expect(() => definition.normalizeResponse(response, input)).toThrow(
      "Getui response field is invalid: statisticsDataList[0]",
    );
  });

  it("rejects invalid required numbers", async () => {
    const definition = operation("statistics.today");
    const input = definition.inputSchema.parse({});
    const raw = await fixture("today-success.json");
    const object = raw as {
      data: { list: Array<{ statisticsData: { install: { cnt: unknown } } }> };
    };
    object.data.list[0]!.statisticsData.install.cnt = null;
    expect(() => definition.normalizeResponse(object, input)).toThrow(
      /install.cnt/,
    );
  });
});

describe("tag and authentication operations", () => {
  function ids(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `gtcid-${index}`);
  }

  it("maps auth input without putting force in the request body", () => {
    const definition = operation("auth.token");
    const input = definition.inputSchema.parse({ force: true });
    expect(definition.kind).toBe("authentication");
    expect(definition.mutating).toBe(false);
    expect(input).toEqual({ force: true });
    expect(definition.buildRequest(input)).toEqual({});
  });

  it("maps tag query and preserves ID order", () => {
    const definition = operation("tag.user");
    const input = definition.inputSchema.parse({
      userIdList: [" first ", "second"],
    });
    expect(input).toEqual({ userIdList: ["first", "second"] });
    expect(definition.buildRequest(input)).toEqual({
      userIdList: ["first", "second"],
    });
  });

  it("enforces the 200-item boundary without deduplication", () => {
    const definition = operation("tag.user");
    const input = definition.inputSchema.parse({ userIdList: ids(200) });
    expect(input.userIdList).toHaveLength(200);
    expect(() => definition.inputSchema.parse({ userIdList: ids(201) })).toThrow(
      /200/,
    );
    expect(() =>
      operation("tag.external.import").inputSchema.parse({
        tagValCode: "value-1",
        idList: ids(201),
      }),
    ).toThrow(/200/);
  });

  it("rejects empty, unknown, and malformed tag inputs locally", () => {
    expect(() => operation("tag.user").inputSchema.parse({ userIdList: [] }))
      .toThrow();
    expect(() => operation("tag.user").inputSchema.parse({
      userIdList: ["  "],
    })).toThrow();
    expect(() => operation("tag.external.import").inputSchema.parse({
      tagValCode: "value-1",
      idList: ["id-1"],
      unexpected: true,
    })).toThrow();
    expect(() => operation("tag.external.create").inputSchema.parse({
      name: "Audience",
      tagValueList: [{ tagValCn: "Gold", idType: "unsupported" }],
    })).toThrow();
    expect(() => operation("tag.external.edit").inputSchema.parse({
      tagCode: "tag-1",
      name: "Audience",
      tagValueList: [],
    })).toThrow();
  });

  it("maps create, edit, import, and trigger bodies", () => {
    const create = operation("tag.external.create");
    const createInput = create.inputSchema.parse({
      dirId: "7",
      name: "VIP users",
      description: "manual",
      tagValueList: [{ tagValCn: "Gold", idType: "gtcid" }],
    });
    expect(create.buildRequest(createInput)).toEqual({
      dirId: 7,
      name: "VIP users",
      description: "manual",
      tagValueList: [{ tagValCn: "Gold", idType: "gtcid" }],
    });

    const edit = operation("tag.external.edit");
    const editInput = edit.inputSchema.parse({
      tagCode: "tag-1",
      name: "VIP users v2",
      tagValueList: [
        { tagValCn: "New", idType: "cid", reset: true },
        { tagValCn: "Existing", tagValCode: "value-1", reset: false },
      ],
    });
    expect(edit.buildRequest(editInput)).toMatchObject({
      tagCode: "tag-1",
      tagValueList: [
        { tagValCn: "New", idType: "cid", reset: true },
        { tagValCn: "Existing", tagValCode: "value-1", reset: false },
      ],
    });
    expect(() =>
      edit.inputSchema.parse({
        tagCode: "tag-1",
        name: "bad",
        tagValueList: [{ tagValCn: "New" }],
      }),
    ).toThrow(/reset/);

    const imported = operation("tag.external.import");
    const importInput = imported.inputSchema.parse({
      tagValCode: "value-1",
      idList: ["cid-1"],
    });
    expect(imported.buildRequest(importInput)).toEqual({
      tagValCode: "value-1",
      idList: ["cid-1"],
    });

    const trigger = operation("tag.external.trigger");
    const triggerInput = trigger.inputSchema.parse({
      tagCodeList: ["tag-1", "tag-2"],
    });
    expect(trigger.buildRequest(triggerInput)).toEqual({
      tagCodeList: ["tag-1", "tag-2"],
    });
  });

  it("normalizes tag responses while retaining code, msg, and data", () => {
    const query = operation("tag.user");
    const queryResult = query.normalizeResponse(
      {
        code: "0",
        msg: "成功",
        data: { validTags: [{ userId: "u-1" }], invalidTags: [] },
      },
      { userIdList: ["u-1"] },
    );
    expect(queryResult).toEqual({
      code: 0,
      msg: "成功",
      data: { validTags: [{ userId: "u-1" }], invalidTags: [] },
    });

    const tree = operation("tag.tree");
    expect(
      tree.normalizeResponse(
        { code: 0, msg: "成功", data: { customTagList: null } },
        {},
      ),
    ).toEqual({
      code: 0,
      msg: "成功",
      data: { customTagList: [], externalTagList: [], gtagList: [] },
    });

    const mutation = operation("tag.external.trigger");
    expect(
      mutation.normalizeResponse({ code: 0, msg: "成功" }, { tagCodeList: ["t"] }),
    ).toEqual({ code: 0, msg: "成功", data: null });

    for (const name of [
      "tag.external.create",
      "tag.external.edit",
      "tag.external.import",
    ] as const) {
      const definition = operation(name);
      const input = name === "tag.external.create"
        ? { name: "Audience", tagValueList: [{ tagValCn: "Gold" }] }
        : name === "tag.external.edit"
          ? {
              tagCode: "tag-1",
              name: "Audience",
              tagValueList: [{
                tagValCn: "Gold",
                tagValCode: "tag-1-1",
                reset: false,
              }],
            }
          : { tagValCode: "tag-1-1", idList: ["id-1"] };
      expect(definition.normalizeResponse({ code: 0, msg: "成功" }, input))
        .toEqual({ code: 0, msg: "成功", data: null });
    }
  });
});

describe("user API operations", () => {
  const properties = {
    $app_type: "app",
    $os: "android",
    custom: { keep: true },
  };

  const event = {
    gtcid: "gtcid-1",
    sessionId: "session-1",
    datetime: "1712646657000",
    eventId: "event-1",
    properties,
  };

  const user = {
    gtcid: "gtcid-1",
    datetime: "1712646657000",
    properties,
  };

  it("defines fixed paths and read/write metadata", () => {
    expect(operation("user.import.event")).toMatchObject({
      path: "/import/event",
      mutating: true,
      retryClass: "write",
    });
    expect(operation("user.import.user")).toMatchObject({
      path: "/import/user",
      mutating: true,
      retryClass: "write",
    });
    expect(operation("user.crowd.list")).toMatchObject({
      path: "/export/crowd/exportableCrowdList",
      mutating: false,
      retryClass: "read",
    });
    expect(operation("user.crowd.export.create")).toMatchObject({
      path: "/export/crowd/createCrowdExportTask",
      mutating: true,
      retryClass: "write",
    });
    expect(operation("user.crowd.export.status")).toMatchObject({
      path: "/export/crowd/exportCrowdTaskStatus",
      mutating: false,
      retryClass: "read",
    });
    expect(operation("user.crowd.export.file")).toMatchObject({
      path: "/export/crowd/exportCrowdSingleFile",
      mutating: false,
      retryClass: "read",
    });
  });

  it("validates and preserves event/user import payloads", () => {
    const eventDefinition = operation("user.import.event");
    const eventInput = eventDefinition.inputSchema.parse({ dataList: [event] });
    expect(eventDefinition.buildRequest(eventInput)).toEqual({
      dataList: [event],
    });
    expect(eventDefinition.queryForOutput?.(eventInput)).toEqual({
      importType: "event",
      recordCount: 1,
    });

    const userDefinition = operation("user.import.user");
    const userInput = userDefinition.inputSchema.parse({ dataList: [user] });
    expect(userDefinition.buildRequest(userInput)).toEqual({
      dataList: [user],
    });
    expect(userDefinition.queryForOutput?.(userInput)).toEqual({
      importType: "user",
      recordCount: 1,
    });

    for (const definition of [eventDefinition, userDefinition]) {
      expect(() => definition.inputSchema.parse({ dataList: [] })).toThrow();
      expect(() => definition.inputSchema.parse({
        dataList: Array.from({ length: 201 }, () => user),
      })).toThrow(/200/);
      expect(() => definition.inputSchema.parse({
        dataList: [{ ...user, datetime: "1712646657" }],
      })).toThrow(/millisecond/);
      expect(() => definition.inputSchema.parse({
        dataList: [{ ...user, properties: { $app_type: "native", $os: "android" } }],
      })).toThrow(/app_type/);
      expect(() => definition.inputSchema.parse({
        dataList: [{ ...user, properties: { $app_type: "app", $os: " " } }],
      })).toThrow(/os/);
      expect(() => definition.inputSchema.parse({
        dataList: [{ ...user, unexpected: true }],
      })).toThrow();
    }
    expect(() => eventDefinition.inputSchema.parse({
      dataList: [{ ...event, sessionId: " " }],
    })).toThrow();
    expect(() => userDefinition.inputSchema.parse({
      dataList: [{ ...user, eventId: "event-should-be-rejected" }],
    })).toThrow();
  });

  it("normalizes import responses without echoing records", () => {
    const eventDefinition = operation("user.import.event");
    const input = eventDefinition.inputSchema.parse({ dataList: [event] });
    expect(eventDefinition.normalizeResponse(
      { code: "0", msg: "成功", data: { accepted: 1 } },
      input,
    )).toEqual({
      code: "0",
      msg: "成功",
      data: { importType: "event", recordCount: 1 },
    });

    const userDefinition = operation("user.import.user");
    const userInput = userDefinition.inputSchema.parse({ dataList: [user] });
    expect(userDefinition.normalizeResponse({ code: 0, msg: "成功" }, userInput))
      .toEqual({
        code: 0,
        msg: "成功",
        data: { importType: "user", recordCount: 1 },
      });
  });

  it("maps and normalizes crowd list, task, status, and file calls", () => {
    const list = operation("user.crowd.list");
    expect(list.inputSchema.parse({})).toEqual({});
    expect(list.buildRequest({})).toEqual({});
    expect(list.normalizeResponse({
      code: "0",
      msg: "成功",
      data: { list: [{ crowdId: "crowd-1", crowdName: "Demo" }], total: 1 },
    }, {})).toEqual({
      code: "0",
      msg: "成功",
      data: { list: [{ crowdId: "crowd-1", crowdName: "Demo" }], total: 1 },
    });
    expect(list.normalizeResponse({ code: 0, msg: "成功", data: {} }, {}))
      .toEqual({ code: 0, msg: "成功", data: { list: [], total: 0 } });

    const create = operation("user.crowd.export.create");
    const createInput = create.inputSchema.parse({
      crowdId: "crowd-1",
      uidType: "GTCID",
    });
    expect(create.buildRequest(createInput)).toEqual(createInput);
    expect(create.normalizeResponse({
      code: 0,
      msg: "成功",
      data: { taskId: 1001 },
    }, createInput)).toEqual({ code: 0, msg: "成功", data: { taskId: 1001 } });
    expect(create.normalizeResponse({ code: 0, msg: "失败", data: {} }, createInput))
      .toEqual({ code: 0, msg: "失败", data: null });
    expect(() => create.inputSchema.parse({ crowdId: "crowd-1", uidType: "gtcid" }))
      .toThrow();

    const status = operation("user.crowd.export.status");
    const statusInput = status.inputSchema.parse({ crowdId: "crowd-1", taskId: 1001 });
    expect(status.buildRequest(statusInput)).toEqual(statusInput);
    expect(status.normalizeResponse({
      code: "0",
      msg: "成功",
      data: {
        appId: "app-1",
        crowdId: "crowd-1",
        taskId: 1001,
        uidType: "CID",
        status: 0,
      },
    }, statusInput)).toMatchObject({
      code: "0",
      data: { status: 0, fileIdList: [] },
    });
    expect(() => status.inputSchema.parse({ crowdId: "crowd-1", taskId: 0 }))
      .toThrow();
    expect(() => status.inputSchema.parse({ crowdId: "crowd-1", taskId: "1001" }))
      .toThrow();

    const file = operation("user.crowd.export.file");
    const fileInput = file.inputSchema.parse({
      crowdId: "crowd-1",
      taskId: 1001,
      fileId: "file-1",
    });
    expect(file.buildRequest(fileInput)).toEqual(fileInput);
    expect(file.normalizeResponse({
      code: 0,
      msg: "成功",
      data: { list: ["gtcid-1", "gtcid-2"], total: 2 },
    }, fileInput)).toEqual({
      code: 0,
      msg: "成功",
      data: { list: ["gtcid-1", "gtcid-2"], total: 2 },
    });
    expect(file.normalizeResponse({ code: 0, msg: "成功", data: {} }, fileInput))
      .toEqual({ code: 0, msg: "成功", data: { list: [], total: 0 } });
  });
});
