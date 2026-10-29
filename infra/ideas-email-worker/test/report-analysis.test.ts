import { describe, expect, it } from "vitest";

import { analyzeTextReport } from "../src/report-analysis";

describe("OPERA report analysis", () => {
  it("marks a current dated report as fresh without retaining row values", () => {
    const analysis = analyzeTextReport(
      "ressummary_69931742.txt",
      [
        "D_DATE\tROOM\tGUEST_NAME\tCF_OCC_PERC",
        "28-JUL-26\t1401\tExample Guest\t87.5",
        "29-JUL-26\t1402\tAnother Guest\t75.4",
      ].join("\n"),
      "2026-07-28T07:00:00.000Z",
    );

    expect(analysis.reportType).toBe("ressummary");
    expect(analysis.status).toBe("fresh");
    expect(analysis.coverageStart).toBe("2026-07-28");
    expect(analysis.coverageEnd).toBe("2026-07-29");
    expect(analysis.summaryJson).not.toContain("Example Guest");
    expect(analysis.summaryJson).not.toContain("1401");
  });

  it("marks a report whose coverage ended months ago as stale", () => {
    const analysis = analyzeTextReport(
      "business_on_the_books_69932051.txt",
      [
        "CONSIDERED_DATE\tROOMS",
        "01-NOV-25\t12",
        "30-NOV-25\t18",
      ].join("\n"),
      "2026-07-28T07:00:00.000Z",
    );

    expect(analysis.status).toBe("stale");
    expect(JSON.parse(analysis.warningsJson)).toContain(
      "coverage_ends_more_than_30_days_before_receipt",
    );
  });

  it("marks zero-result profile productivity as empty", () => {
    const analysis = analyzeTextReport(
      "profileproductivitystat_69932156.txt",
      [
        "SORT_COLUMN\tGUEST_NAME\tPROFILE_ID",
        "PROFILE_NAME\tRELATIONSHIP_TYPE\tPROFILE_NAME_ID",
        "CF_LOGO\tCS_COUNT_LOOPS",
        "\t0",
      ].join("\n"),
      "2026-07-28T07:00:00.000Z",
    );

    expect(analysis.status).toBe("empty");
    expect(analysis.rowCount).toBe(0);
  });
});
