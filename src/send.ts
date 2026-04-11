import { ThreadType, TextStyle, type Style, type MessageContent, type Mention, type SendMessageQuote } from "zca-js";
import { getApi } from "./zalo-client.js";
import { resolveOutboundMentions } from "./mention-parser.js";
import * as fs from "fs";
import * as path from "path";

/**
 * Convert markdown to Zalo TextStyle.
 * Supports: **bold**, *italic*, __underline__, ~~strikethrough~~,
 * `code` (bold), ### headings (bold), - lists (bullet), 1. lists (numbered)
 */
export function markdownToZaloStyles(input: string): { text: string; styles: Style[] } {
  const styles: Style[] = [];
  let text = input;

  // --- Block-level: headings → bold ---
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _h, content) => content);
  // We'll apply bold to heading content after inline processing

  // --- Inline patterns (order matters: longer markers first) ---
  const inlinePatterns: Array<{ regex: RegExp; style: TextStyle }> = [
    { regex: /\*\*\*(.+?)\*\*\*/g, style: TextStyle.Bold },       // ***bold italic*** → bold
    { regex: /\*\*(.+?)\*\*/g, style: TextStyle.Bold },
    { regex: /~~(.+?)~~/g, style: TextStyle.StrikeThrough },
    { regex: /__(.+?)__/g, style: TextStyle.Underline },
    { regex: /`([^`]+)`/g, style: TextStyle.Bold },                // inline code → bold
    { regex: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, style: TextStyle.Italic },
  ];

  for (const { regex, style } of inlinePatterns) {
    let result = "";
    let lastIndex = 0;
    const pending: Style[] = [];

    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      result += text.slice(lastIndex, match.index);
      const start = result.length;
      const content = match[1];
      result += content;
      pending.push({ start, len: content.length, st: style as Exclude<TextStyle, TextStyle.Indent> });
      lastIndex = match.index + match[0].length;
    }
    if (pending.length > 0) {
      result += text.slice(lastIndex);
      text = result;
      styles.push(...pending);
    }
  }

  return { text, styles };
}

/** Binary search count of how many entries in `sorted` are strictly less than `value`. */
function countStripsBefore(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type ZaloPersonalSendOptions = {
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
  localPath?: string;  // Local file path to upload
  cleanupAfterUpload?: boolean;  // Delete local file after upload
  quote?: SendMessageQuote;  // Quote/reply to a specific message
};

export type ZaloPersonalSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

export async function sendMessageZaloPersonal(
  threadId: string,
  text: string,
  options: ZaloPersonalSendOptions = {},
): Promise<ZaloPersonalSendResult> {
  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  // Handle local file upload (explicit)
  if (options.localPath) {
    return uploadAndSendLocalImage(threadId, options.localPath, {
      ...options,
      caption: text || options.caption,
    });
  }

  // Auto-detect if text is a local file path
  if (text && isLocalFilePath(text.trim()) && fs.existsSync(text.trim())) {
    console.log("[zalo-personal] Auto-detected local file path:", text.trim());
    return uploadAndSendLocalImage(threadId, text.trim(), {
      ...options,
      caption: options.caption,
    });
  }

  if (options.mediaUrl) {
    return sendMediaZaloPersonal(threadId, options.mediaUrl, {
      ...options,
      caption: text || options.caption,
    });
  }

  try {
    const api = await getApi();
    const type = options.isGroup ? ThreadType.Group : ThreadType.User;
    const truncated = text.slice(0, 2000);
    const { text: postMarkdownText, styles } = markdownToZaloStyles(truncated);
    // Resolve @[Name]/@Name → Zalo Mention[] AFTER markdown styling. Mention
    // parsing strips `[`/`]`, which can shift any style span that started
    // after a stripped position; we walk styles once and shift each by the
    // count of strip indices below its start so style highlighting stays
    // aligned with the final outbound text.
    let outboundText = postMarkdownText;
    let mentions: Mention[] = [];
    let alignedStyles = styles;
    if (options.isGroup) {
      const resolved = await resolveOutboundMentions(threadId.trim(), postMarkdownText);
      outboundText = resolved.text;
      mentions = resolved.mentions;
      if (resolved.stripIndices.length > 0 && styles.length > 0) {
        alignedStyles = styles.map((s) => {
          const shift = countStripsBefore(resolved.stripIndices, s.start);
          return shift === 0 ? s : { ...s, start: s.start - shift };
        });
      }
    }
    const content: { msg: string; styles?: Style[]; mentions?: Mention[]; quote?: SendMessageQuote } = { msg: outboundText };
    if (alignedStyles.length > 0) {
      content.styles = alignedStyles;
    }
    if (mentions.length > 0) {
      content.mentions = mentions;
    }
    if (options.quote) {
      content.quote = options.quote;
    }
    const result = await api.sendMessage(
      content,
      threadId.trim(),
      type,
    );
    const msgId = result?.message?.msgId;
    return { ok: true, messageId: msgId != null ? String(msgId) : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendMediaZaloPersonal(
  threadId: string,
  mediaUrl: string,
  options: ZaloPersonalSendOptions = {},
): Promise<ZaloPersonalSendResult> {
  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }
  if (!mediaUrl?.trim()) {
    return { ok: false, error: "No media URL provided" };
  }

  try {
    const api = await getApi();
    const type = options.isGroup ? ThreadType.Group : ThreadType.User;

    // Use sendLink for URLs as zca-js doesn't support sending images by URL directly
    const result = await api.sendLink(
      {
        url: mediaUrl.trim(),
        title: options.caption || mediaUrl.trim(),
      },
      threadId.trim(),
      type,
    );
    const msgId = result?.message?.msgId;
    return { ok: true, messageId: msgId != null ? String(msgId) : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendLinkZaloPersonal(
  threadId: string,
  url: string,
  options: ZaloPersonalSendOptions = {},
): Promise<ZaloPersonalSendResult> {
  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }
  if (!url?.trim()) {
    return { ok: false, error: "No URL provided" };
  }

  try {
    const api = await getApi();
    const type = options.isGroup ? ThreadType.Group : ThreadType.User;
    const result = await api.sendLink(
      { url: url.trim() },
      threadId.trim(),
      type,
    );
    const msgId = result?.message?.msgId;
    return { ok: true, messageId: msgId != null ? String(msgId) : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Upload a local image file to Zalo and send it
 * @param threadId - Chat thread ID
 * @param localPath - Local file path to upload
 * @param options - Send options including caption and cleanup flag
 */
async function uploadAndSendLocalImage(
  threadId: string,
  localPath: string,
  options: ZaloPersonalSendOptions = {},
): Promise<ZaloPersonalSendResult> {
  console.log("[zalo-personal] uploadAndSendLocalImage called:", { threadId, localPath, options });

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }
  if (!localPath?.trim()) {
    return { ok: false, error: "No local path provided" };
  }

  // Check if file exists
  if (!fs.existsSync(localPath)) {
    console.error(`[zalo-personal] File not found: ${localPath}`);
    return { ok: false, error: `File not found: ${localPath}` };
  }

  try {
    const api = await getApi();
    const type = options.isGroup ? ThreadType.Group : ThreadType.User;

    console.log(`[zalo-personal] Uploading and sending: ${localPath} to thread ${threadId}`);

    // Send message with attachment - sendMessage will handle the upload internally
    const result = await api.sendMessage(
      {
        msg: options.caption || "",
        attachments: localPath,  // Pass file path directly
      },
      threadId.trim(),
      type,
    );

    console.log("[zalo-personal] Send result:", result);

    // Clean up local file after successful send (default: false to avoid race conditions)
    // OpenClaw's MEDIA: token processing may need the file, so only cleanup when explicitly requested
    if (options.cleanupAfterUpload === true) {
      try {
        fs.unlinkSync(localPath);
        console.log(`[zalo-personal] Cleaned up local file: ${localPath}`);
      } catch (cleanupErr) {
        console.warn(`[zalo-personal] Failed to cleanup ${localPath}:`, cleanupErr);
      }
    }

    const msgId = result?.message?.msgId;
    return { ok: true, messageId: msgId != null ? String(msgId) : undefined };
  } catch (err) {
    console.error("[zalo-personal] Upload error:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check if a string looks like a local file path
 */
export function isLocalFilePath(str: string): boolean {
  if (!str) return false;
  // Check if it's an absolute path or relative path pattern
  return (
    str.startsWith("/") ||
    str.startsWith("./") ||
    str.startsWith("../") ||
    str.includes("/.openclaw/workspace/")
  );
}
