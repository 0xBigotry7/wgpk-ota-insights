import PostalMime from "postal-mime";
import {
  analyzeTextReport,
  type ReportAnalysis,
} from "./report-analysis";

const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  ".csv",
  ".dat",
  ".pdf",
  ".tsv",
  ".txt",
  ".xlsx",          // IDeaS G3 exports Excel only (this copy differs from the OPERA worker only here)
  ".xml",
]);
const SUPPORTED_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/xml",
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "text/xml",
]);

type ParsedAttachment = Awaited<
  ReturnType<typeof PostalMime.parse>
>["attachments"][number];

type StoredFile = {
  id: string;
  filename: string;
  mimeType: string;
  bytes: number;
  objectKey: string;
  checksumSha256: string;
  analysis: ReportAnalysis | null;
};

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function senderDomain(sender: string): string {
  const normalized = normalizeAddress(sender);
  return normalized.includes("@") ? normalized.split("@").pop() || "" : "";
}

function isAllowedSender(sender: string, allowedDomain: string): boolean {
  return senderDomain(sender) === normalizeAddress(allowedDomain);
}

function attachmentBytes(attachment: ParsedAttachment): Uint8Array {
  if (typeof attachment.content === "string") {
    return new TextEncoder().encode(attachment.content);
  }
  return new Uint8Array(attachment.content);
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function isSupportedAttachment(attachment: ParsedAttachment): boolean {
  const filename = (attachment.filename || "").trim();
  const mimeType = (attachment.mimeType || "").toLowerCase();
  return Boolean(filename)
    && (
      SUPPORTED_EXTENSIONS.has(extension(filename))
      || SUPPORTED_MIME_TYPES.has(mimeType)
    );
}

function safeFilename(filename: string, index: number): string {
  const normalized = filename
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return normalized || `attachment-${index + 1}.dat`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function reject(message: ForwardableEmailMessage, reason: string): void {
  message.setReject(reason);
  console.warn(JSON.stringify({
    event: "opera_analytics_email_rejected",
    reason,
  }));
}

export default {
  async email(
    message: ForwardableEmailMessage,
    env: Env,
  ): Promise<void> {
    if (normalizeAddress(message.to) !== normalizeAddress(env.INGEST_ADDRESS)) {
      reject(message, "Unknown report recipient");
      return;
    }
    if (!isAllowedSender(message.from, env.ALLOWED_SENDER_DOMAIN)) {
      reject(message, "Untrusted report sender");
      return;
    }
    if (message.rawSize > MAX_MESSAGE_BYTES) {
      reject(message, "Report email is too large");
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const attachments = parsed.attachments.filter(isSupportedAttachment);
    if (attachments.length === 0) {
      reject(message, "No supported IDeaS report attachment");
      return;
    }

    const receivedAt = new Date().toISOString();
    const emailId = await sha256Hex(new Uint8Array(raw));
    const datePath = receivedAt.slice(0, 10).replaceAll("-", "/");
    const prefix = `reports/${datePath}/${emailId}`;
    const files: StoredFile[] = [];

    for (const [index, attachment] of attachments.entries()) {
      const bytes = attachmentBytes(attachment);
      const filename = (attachment.filename || `attachment-${index + 1}.dat`)
        .slice(0, 500);
      const mimeType = (attachment.mimeType || "application/octet-stream")
        .toLowerCase();
      const checksumSha256 = await sha256Hex(bytes);
      const objectKey = `${prefix}/${index + 1}-${safeFilename(filename, index)}`;
      const id = `${emailId}:${index + 1}`;
      const analysis = mimeType.startsWith("text/")
        || [".csv", ".dat", ".tsv", ".txt"].includes(extension(filename))
        ? analyzeTextReport(
          filename,
          new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes),
          receivedAt,
        )
        : null;

      await env.REPORTS.put(objectKey, bytes, {
        httpMetadata: {
          contentType: mimeType,
          contentDisposition: `attachment; filename="${safeFilename(filename, index)}"`,
        },
        customMetadata: {
          emailId,
          checksumSha256,
        },
      });
      files.push({
        id,
        filename,
        mimeType,
        bytes: bytes.byteLength,
        objectKey,
        checksumSha256,
        analysis,
      });
    }

    const manifestKey = `${prefix}/manifest.json`;
    const subject = (parsed.subject || message.headers.get("subject") || "")
      .slice(0, 500);
    const messageId = (
      message.headers.get("message-id")
      || parsed.messageId
      || ""
    ).slice(0, 500);
    const manifest = {
      schemaVersion: 1,
      emailId,
      receivedAt,
      recipient: normalizeAddress(message.to),
      senderDomain: senderDomain(message.from),
      subject,
      messageId: messageId || null,
      rawSize: message.rawSize,
      attachments: files.map((file) => ({
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: file.bytes,
        objectKey: file.objectKey,
        checksumSha256: file.checksumSha256,
      })),
    };
    await env.REPORTS.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { emailId },
    });

    const statements = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO report_emails (
          id, received_at, sender_domain, recipient, subject, message_id,
          raw_size, attachment_count, manifest_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        emailId,
        receivedAt,
        senderDomain(message.from),
        normalizeAddress(message.to),
        subject,
        messageId || null,
        message.rawSize,
        files.length,
        manifestKey,
      ),
      ...files.map((file) => env.DB.prepare(
        `INSERT OR IGNORE INTO report_files (
          id, email_id, filename, mime_type, bytes, object_key,
          checksum_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        file.id,
        emailId,
        file.filename,
        file.mimeType,
        file.bytes,
        file.objectKey,
        file.checksumSha256,
      )),
      ...files
        .filter((file) => file.analysis)
        .map((file) => env.DB.prepare(
          `INSERT OR REPLACE INTO report_analyses (
            file_id, report_type, analyzed_at, status, row_count,
            coverage_start, coverage_end, summary_json, warnings_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          file.id,
          file.analysis!.reportType,
          receivedAt,
          file.analysis!.status,
          file.analysis!.rowCount,
          file.analysis!.coverageStart,
          file.analysis!.coverageEnd,
          file.analysis!.summaryJson,
          file.analysis!.warningsJson,
        )),
    ];
    await env.DB.batch(statements);

    console.log(JSON.stringify({
      event: "opera_analytics_email_archived",
      email_id: emailId,
      attachment_count: files.length,
      attachment_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    }));
  },
} satisfies ExportedHandler<Env>;
