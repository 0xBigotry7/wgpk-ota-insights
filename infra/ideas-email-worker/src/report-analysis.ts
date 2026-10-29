const REPORT_ID_PATTERN = /_(\d+)(?:\.[^.]+)?$/;
const DATE_VALUE_PATTERNS = [
  /^(\d{2})\/(\d{2})\/(\d{2})$/,
  /^(\d{2})-([A-Z]{3})-(\d{2})$/,
];
const MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

export type ReportAnalysis = {
  reportType: string;
  status: "fresh" | "stale" | "empty" | "review";
  rowCount: number;
  coverageStart: string | null;
  coverageEnd: string | null;
  summaryJson: string;
  warningsJson: string;
};

function reportType(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  return withoutExtension.replace(REPORT_ID_PATTERN, "").toLowerCase();
}

function parseDate(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  const slash = normalized.match(DATE_VALUE_PATTERNS[0]);
  if (slash) return `20${slash[3]}-${slash[2]}-${slash[1]}`;

  const dash = normalized.match(DATE_VALUE_PATTERNS[1]);
  if (!dash) return null;
  const month = MONTHS[dash[2]];
  return month ? `20${dash[3]}-${month}-${dash[1]}` : null;
}

function daysBetween(left: string, right: string): number {
  return (
    Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)
  ) / 86_400_000;
}

function looksLikeSchemaRow(values: string[]): boolean {
  const populated = values.filter(Boolean);
  if (populated.length === 0) return true;
  const uppercaseIdentifiers = populated.filter((value) =>
    /^[A-Z][A-Z0-9_]{2,}$/.test(value)
  );
  return uppercaseIdentifiers.length >= Math.max(2, populated.length * 0.6);
}

export function analyzeTextReport(
  filename: string,
  text: string,
  receivedAt: string,
): ReportAnalysis {
  const lines = text
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const headers = (lines[0] || "").split("\t");
  const values = lines.slice(1).map((line) => line.split("\t"));
  const dateColumnIndexes = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => /(^|_)DATE($|_)|BUSINESS_DATE|STAY_DATE/.test(header));
  const dates = new Set<string>();
  let schemaSectionRows = 0;

  for (const row of values) {
    if (looksLikeSchemaRow(row)) schemaSectionRows += 1;
    for (const { index } of dateColumnIndexes) {
      const parsed = parseDate(row[index] || "");
      if (parsed) dates.add(parsed);
    }
  }

  const sortedDates = [...dates].sort();
  const coverageStart = sortedDates[0] || null;
  const coverageEnd = sortedDates.at(-1) || null;
  const asOf = receivedAt.slice(0, 10);
  const type = reportType(filename);
  const warnings: string[] = [];
  const profileProductivityEmpty = type === "profileproductivitystat"
    && /\bCS_COUNT_LOOPS\b/.test(text)
    && /\n\s*0\s*$/m.test(text);
  const effectiveRows = profileProductivityEmpty
    ? 0
    : Math.max(values.length - schemaSectionRows, 0);

  let status: ReportAnalysis["status"] = "fresh";
  if (effectiveRows === 0 || profileProductivityEmpty) {
    status = "empty";
    warnings.push("no_effective_data_rows");
  } else if (coverageEnd && daysBetween(coverageEnd, asOf) > 30) {
    status = "stale";
    warnings.push("coverage_ends_more_than_30_days_before_receipt");
  } else if (!coverageEnd) {
    status = "review";
    warnings.push("no_parseable_date_metadata");
  }
  if (schemaSectionRows > 0) warnings.push("multiple_schema_sections_detected");

  return {
    reportType: type,
    status,
    rowCount: effectiveRows,
    coverageStart,
    coverageEnd,
    summaryJson: JSON.stringify({
      schemaVersion: 1,
      delimiter: "tab",
      headerCount: headers.length,
      dateFields: dateColumnIndexes.map(({ header }) => header),
      parseableDateCount: dates.size,
      schemaSectionRows,
      piiStored: false,
    }),
    warningsJson: JSON.stringify(warnings),
  };
}
