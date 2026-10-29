import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";

type FakeMessage = ForwardableEmailMessage & { rejected?: string };
type BoundStatement = {
  sql: string;
  args: unknown[];
};

function mimeMessage(
  attachments: Array<{
    filename: string;
    mimeType: string;
    content: string;
  }> = [{
    filename: "reservation_pace.txt",
    mimeType: "text/plain",
    content: "Stay Date\\tRooms\\tRevenue\\n28/07/2026\\t117\\t250000",
  }],
): string {
  const boundary = "wgpk-opera-analytics-test";
  const parts = [
    "From: NoReply@Wyndham.com",
    "To: opera-analytics@wyndhamgardenkamala.com",
    "Subject: OPERA scheduled report",
    "Message-ID: <opera-report-1@wyndham.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Scheduled report attached.",
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `${"Content-Type"}: ${attachment.mimeType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(attachment.content).toString("base64"),
    );
  }
  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

function fakeMessage(
  rawText: string,
  overrides: Partial<Pick<FakeMessage, "from" | "to">> = {},
): FakeMessage {
  const bytes = new TextEncoder().encode(rawText);
  const message = {
    from: overrides.from || "NoReply@Wyndham.com",
    to: overrides.to || "opera-analytics@wyndhamgardenkamala.com",
    headers: new Headers({
      "message-id": "<opera-report-1@wyndham.com>",
      subject: "OPERA scheduled report",
    }),
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    setReject(reason: string) {
      message.rejected = reason;
    },
  } as FakeMessage;
  return message;
}

function fakeEnv() {
  const objects = new Map<string, Uint8Array | string>();
  const statements: BoundStatement[] = [];
  const reports = {
    put: vi.fn(async (
      key: string,
      value: Uint8Array | string,
    ) => {
      objects.set(key, value);
      return {} as R2Object;
    }),
  } as unknown as R2Bucket;
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const statement = { sql, args };
          statements.push(statement);
          return statement;
        },
      };
    },
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
  return {
    env: {
      ALLOWED_SENDER_DOMAIN: "wyndham.com",
      INGEST_ADDRESS: "opera-analytics@wyndhamgardenkamala.com",
      REPORTS: reports,
      DB: db,
    } as unknown as Env,
    objects,
    statements,
    reports,
    db,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IDeaS report email Worker", () => {
  it("archives supported attachments and metadata without forwarding", async () => {
    const test = fakeEnv();
    const message = fakeMessage(mimeMessage());

    await worker.email!(message, test.env);

    expect(message.rejected).toBeUndefined();
    expect(test.reports.put).toHaveBeenCalledTimes(2);
    expect([...test.objects.keys()]).toEqual(expect.arrayContaining([
      expect.stringMatching(/reservation_pace\.txt$/),
      expect.stringMatching(/manifest\.json$/),
    ]));
    expect(test.statements).toHaveLength(3);
    expect(test.statements[0].sql).toContain("report_emails");
    expect(test.statements[1].sql).toContain("report_files");
    expect(test.statements[2].sql).toContain("report_analyses");
  });

  it("stores multiple OPERA report attachments from one message", async () => {
    const test = fakeEnv();
    const message = fakeMessage(mimeMessage([
      {
        filename: "history_forecast.xml",
        mimeType: "application/xml",
        content: "<?xml version=\"1.0\"?><REPORT/>",
      },
      {
        filename: "manager_flash.pdf",
        mimeType: "application/pdf",
        content: "%PDF-test",
      },
    ]));

    await worker.email!(message, test.env);

    expect(message.rejected).toBeUndefined();
    expect(test.reports.put).toHaveBeenCalledTimes(3);
    expect(test.statements).toHaveLength(3);
  });

  it("rejects mail sent to another address", async () => {
    const test = fakeEnv();
    const message = fakeMessage(mimeMessage(), {
      to: "opera-inhouse@wyndhamgardenkamala.com",
    });

    await worker.email!(message, test.env);

    expect(message.rejected).toBe("Unknown report recipient");
    expect(test.reports.put).not.toHaveBeenCalled();
  });

  it("rejects a sender outside the configured domain", async () => {
    const test = fakeEnv();
    const message = fakeMessage(mimeMessage(), {
      from: "attacker@example.net",
    });

    await worker.email!(message, test.env);

    expect(message.rejected).toBe("Untrusted report sender");
    expect(test.reports.put).not.toHaveBeenCalled();
  });

  it("rejects messages without a supported report attachment", async () => {
    const test = fakeEnv();
    const message = fakeMessage(mimeMessage([{
      filename: "tracking.gif",
      mimeType: "image/gif",
      content: "not a report",
    }]));

    await worker.email!(message, test.env);

    expect(message.rejected).toBe("No supported IDeaS report attachment");
    expect(test.reports.put).not.toHaveBeenCalled();
  });

  it("archives an IDeaS Excel export", async () => {
    const test = fakeEnv();
    const message = fakeMessage(mimeMessage([{
      filename: "G3_DataExtraction_2026-10-29.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: "PK-test",
    }]));

    await worker.email!(message, test.env);

    expect(message.rejected).toBeUndefined();
    expect([...test.objects.keys()]).toEqual(expect.arrayContaining([expect.stringMatching(/DataExtraction_2026-10-29\.xlsx$/)]));
  });
});
