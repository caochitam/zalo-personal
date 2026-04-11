import type { OpenClawConfig, MarkdownTableMode, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
} from "openclaw/plugin-sdk/channel-reply-pipeline";
import { logTypingFailure, logAckFailure } from "openclaw/plugin-sdk/channel-feedback";
import { mergeAllowlist, summarizeMapping } from "openclaw/plugin-sdk/allow-from";
import { resolveMentionGatingWithBypass } from "openclaw/plugin-sdk/channel-inbound";
import { ThreadType, FriendEventType, Reactions, type API, type Message, type UserMessage, type GroupMessage, type FriendEvent } from "zca-js";
import type { ResolvedZaloPersonalAccount, ZaloPersonalFriend, ZaloPersonalGroup, ZaloPersonalMessage } from "./types.js";
import { getZaloPersonalRuntime } from "./runtime.js";
import { sendMessageZaloPersonal } from "./send.js";
import { getApi, getCurrentUid } from "./zalo-client.js";
import { downloadImagesFromUrls } from "./image-downloader.js";
import { addPendingRequest, removePendingRequest } from "./friend-request-store.js";
import { refreshCredentials } from "./credentials.js";

export type ZaloPersonalMonitorOptions = {
  account: ResolvedZaloPersonalAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type ZaloPersonalMonitorResult = {
  stop: () => void;
};

const ZALOJS_TEXT_LIMIT = 2000;

// --- Name cache: resolve user/group names via API with 1-hour TTL ---
const nameCache = new Map<string, { name: string; cachedAt: number }>();
const groupNameCache = new Map<string, { name: string; cachedAt: number }>();
const NAME_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// --- Group message buffer: stores non-mentioned messages for context ---
const groupMessageBuffer = new Map<string, Array<{
  senderName: string;
  content: string;
  timestamp: number;
  mediaUrls?: string[];
  localMediaPaths?: string[];
}>>();
const GROUP_BUFFER_MAX_MESSAGES = 50;
const GROUP_BUFFER_MAX_AGE_S = 4 * 60 * 60; // 4 hours

function bufferGroupMessage(groupId: string, entry: { senderName: string; content: string; timestamp: number; mediaUrls?: string[]; localMediaPaths?: string[] }): void {
  let buffer = groupMessageBuffer.get(groupId) ?? [];
  buffer.push(entry);
  const cutoff = Math.floor(Date.now() / 1000) - GROUP_BUFFER_MAX_AGE_S;
  buffer = buffer.filter(m => m.timestamp > cutoff).slice(-GROUP_BUFFER_MAX_MESSAGES);
  groupMessageBuffer.set(groupId, buffer);
}

function consumeGroupBuffer(groupId: string): { text: string; mediaPaths: string[] } {
  const buffer = groupMessageBuffer.get(groupId);
  if (!buffer || buffer.length === 0) return { text: "", mediaPaths: [] };
  const allMediaPaths: string[] = [];
  const lines = buffer.map(m => {
    let line = `[${m.senderName}]: ${m.content}`;
    if (m.localMediaPaths && m.localMediaPaths.length > 0) {
      m.localMediaPaths.forEach(p => allMediaPaths.push(p));
      line += ` [attached ${m.localMediaPaths.length} image(s)]`;
    } else if (m.mediaUrls && m.mediaUrls.length > 0) {
      line += ` [image: ${m.mediaUrls.join(", ")}]`;
    }
    return line;
  });
  groupMessageBuffer.delete(groupId);
  return { text: lines.join("\n"), mediaPaths: allMediaPaths };
}

async function resolveUserName(userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < NAME_CACHE_TTL) {
    return cached.name;
  }
  try {
    const api = await getApi();
    const userInfo = await api.getUserInfo(userId);
    const profile = (userInfo as any)?.changed_profiles?.[userId];
    const name = profile?.displayName || profile?.zaloName || userId;
    nameCache.set(userId, { name, cachedAt: Date.now() });
    return name;
  } catch {
    return userId;
  }
}

async function resolveGroupName(groupId: string): Promise<string> {
  const cached = groupNameCache.get(groupId);
  if (cached && Date.now() - cached.cachedAt < NAME_CACHE_TTL) {
    return cached.name;
  }
  try {
    const api = await getApi();
    const infoResp = await api.getGroupInfo([groupId]);
    const info = infoResp?.gridInfoMap?.[groupId];
    const name = (info as any)?.name || `group:${groupId}`;
    groupNameCache.set(groupId, { name, cachedAt: Date.now() });
    return name;
  } catch {
    return `group:${groupId}`;
  }
}

function normalizeZaloPersonalEntry(entry: string): string {
  return entry.replace(/^(zalo-personal|zp):/i, "").trim();
}

function buildNameIndex<T>(items: T[], nameFn: (item: T) => string | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = nameFn(item)?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}

type ZaloPersonalCoreRuntime = ReturnType<typeof getZaloPersonalRuntime>;

function logVerbose(core: ZaloPersonalCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[zalo-personal] ${message}`);
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(zalo-personal|zp):/i, "");
    return normalized === normalizedSenderId;
  });
}

/**
 * Check if a sender is globally denied (blocked)
 * @param senderId - User ID to check
 * @param denyFrom - Array of denied user IDs/names (already resolved to IDs)
 * @returns true if sender is blocked, false otherwise
 */
function isSenderDenied(senderId: string, denyFrom: string[]): boolean {
  if (denyFrom.length === 0) {
    return false;
  }
  const normalizedSenderId = senderId.toLowerCase();
  return denyFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(zalo-personal|zp):/i, "");
    return normalized === normalizedSenderId;
  });
}

/**
 * Check if a specific user is denied within a specific group
 * @param senderId - User ID to check
 * @param groupId - Group ID
 * @param groupName - Group name (optional)
 * @param groups - Group configuration object
 * @returns true if user is blocked in this group, false otherwise
 */
function isUserDeniedInGroup(params: {
  senderId: string;
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { denyUsers?: Array<string | number> }>;
}): boolean {
  const groups = params.groups ?? {};
  const candidates = [
    params.groupId,
    `group:${params.groupId}`,
    params.groupName ?? "",
    normalizeGroupSlug(params.groupName ?? ""),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const groupConfig = groups[candidate];
    if (!groupConfig || !groupConfig.denyUsers) {
      continue;
    }

    const denyUsers = groupConfig.denyUsers.map((v) => String(v));
    if (isSenderDenied(params.senderId, denyUsers)) {
      return true;
    }
  }

  // Check wildcard group config
  const wildcard = groups["*"];
  if (wildcard?.denyUsers) {
    const denyUsers = wildcard.denyUsers.map((v) => String(v));
    if (isSenderDenied(params.senderId, denyUsers)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a group has allowUsers configured and whether the sender is in it.
 * Returns: undefined if no allowUsers configured (no filtering), true if allowed, false if not.
 */
function checkGroupAllowUsers(params: {
  senderId: string;
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { allowUsers?: Array<string | number> }>;
}): boolean | undefined {
  const groups = params.groups ?? {};
  const candidates = [
    params.groupId,
    `group:${params.groupId}`,
    params.groupName ?? "",
    normalizeGroupSlug(params.groupName ?? ""),
  ].filter(Boolean);

  // Check specific group config first
  for (const candidate of candidates) {
    const groupConfig = groups[candidate];
    if (groupConfig?.allowUsers && groupConfig.allowUsers.length > 0) {
      const allowUsers = groupConfig.allowUsers.map((v) => String(v));
      return isSenderAllowed(params.senderId, allowUsers);
    }
  }

  // Check wildcard
  const wildcard = groups["*"];
  if (wildcard?.allowUsers && wildcard.allowUsers.length > 0) {
    const allowUsers = wildcard.allowUsers.map((v) => String(v));
    return isSenderAllowed(params.senderId, allowUsers);
  }

  // No allowUsers configured = no filtering
  return undefined;
}

function normalizeGroupSlug(raw?: string | null): string {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isGroupAllowed(params: {
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { allow?: boolean; enabled?: boolean }>;
}): boolean {
  const groups = params.groups ?? {};
  const keys = Object.keys(groups);
  if (keys.length === 0) {
    return false;
  }
  const candidates = [
    params.groupId,
    `group:${params.groupId}`,
    params.groupName ?? "",
    normalizeGroupSlug(params.groupName ?? ""),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const entry = groups[candidate];
    if (!entry) {
      continue;
    }
    return entry.allow !== false && entry.enabled !== false;
  }
  const wildcard = groups["*"];
  if (wildcard) {
    return wildcard.allow !== false && wildcard.enabled !== false;
  }
  return false;
}

function convertToZaloPersonalMessage(msg: Message): ZaloPersonalMessage | null {
  const data = msg.data;
  let content = "";
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  // Handle different content types
  if (typeof data.content === "string") {
    content = data.content;
  } else if (typeof data.content === "object" && data.content !== null) {
    // Handle attachment (image, video, file, etc.)
    const attachment = data.content as any;

    // Extract media URL from attachment
    if (attachment.href) {
      mediaUrls.push(attachment.href);

      // Determine media type based on attachment.type or default to image
      const attachmentType = attachment.type?.toLowerCase() || "";
      let mimeType = "application/octet-stream"; // default

      if (attachmentType.includes("photo") || attachmentType.includes("image")) {
        mimeType = "image/jpeg";
      } else if (attachmentType.includes("video")) {
        mimeType = "video/mp4";
      } else if (attachmentType.includes("audio")) {
        mimeType = "audio/mpeg";
      }

      mediaTypes.push(mimeType);
    }

    // Use title or description as content, or create a placeholder
    content = attachment.title || attachment.description || "[Media attachment]";
  }

  // Allow messages with media even if no text content
  if (!content.trim() && mediaUrls.length === 0) {
    return null;
  }

  // Extract quoted/replied message media (Zalo sends image separately from mention)
  const quote = (data as any).quote as { ownerId?: string; msg?: string; attach?: string; fromD?: string } | undefined;
  if (quote?.attach) {
    try {
      const attachData = JSON.parse(quote.attach);
      // attach can be object or array
      const attachList = Array.isArray(attachData) ? attachData : [attachData];
      for (const item of attachList) {
        const url = item.href || item.url || item.thumb;
        if (url && !mediaUrls.includes(url)) {
          mediaUrls.push(url);
          const t = (item.type || "").toLowerCase();
          if (t.includes("photo") || t.includes("image")) mediaTypes.push("image/jpeg");
          else if (t.includes("video")) mediaTypes.push("video/mp4");
          else mediaTypes.push("image/jpeg"); // default assume image
        }
      }
    } catch {
      // attach not parseable JSON, skip
    }
  }

  const isGroup = msg.type === ThreadType.Group;
  const threadId = msg.threadId;
  // For DMs, if uidFrom is not numeric (obfuscated ID), use threadId instead
  const rawSenderId = data.uidFrom;
  const senderId = !isGroup && !/^\d+$/.test(rawSenderId)
    ? threadId  // DM: use threadId as user ID when uidFrom is not numeric
    : rawSenderId;
  const senderName = data.dName ?? "";
  const timestamp = data.ts ? parseInt(data.ts, 10) : Math.floor(Date.now() / 1000);

  // Extract mentions from group messages
  const mentions = isGroup && (msg as GroupMessage).data.mentions
    ? (msg as GroupMessage).data.mentions
    : undefined;

  return {
    threadId,
    msgId: data.msgId,
    cliMsgId: data.cliMsgId,
    type: isGroup ? 1 : 0,
    content: content || "[Media]",
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    mentions: mentions ?? undefined,
    timestamp,
    metadata: {
      isGroup,
      groupId: isGroup ? threadId : undefined,
      senderName,
      fromId: senderId,
    },
  };
}

async function processMessage(
  message: ZaloPersonalMessage,
  account: ResolvedZaloPersonalAccount,
  config: OpenClawConfig,
  core: ZaloPersonalCoreRuntime,
  runtime: RuntimeEnv,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
): Promise<void> {
  const { threadId, content, timestamp, metadata } = message;
  if (!content?.trim()) {
    return;
  }

  const isGroup = metadata?.isGroup ?? false;
  const senderId = metadata?.fromId ?? threadId;
  const senderName = metadata?.senderName ?? "";
  const chatId = threadId;

  // NEW: Global denylist check (runs FIRST, before everything)
  const configDenyFrom = (account.config.denyFrom ?? []).map((v) => String(v));
  if (configDenyFrom.length > 0 && isSenderDenied(senderId, configDenyFrom)) {
    logVerbose(
      core,
      runtime,
      `Blocked denied sender ${senderId} (${senderName || "unknown"}) via denyFrom`,
    );
    return;
  }

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "open";
  const groups = account.config.groups ?? {};
  if (isGroup) {
    // Check if user is denied within this specific group
    if (isUserDeniedInGroup({ senderId, groupId: chatId, groups })) {
      logVerbose(
        core,
        runtime,
        `Blocked sender ${senderId} (${senderName || "unknown"}) denied in group ${chatId} via denyUsers`,
      );
      return;
    }

    // Check if group has allowUsers — only process messages from allowed users
    const userAllowed = checkGroupAllowUsers({ senderId, groupId: chatId, groups });
    if (userAllowed === false) {
      logVerbose(
        core,
        runtime,
        `Blocked sender ${senderId} (${senderName || "unknown"}) not in group ${chatId} allowUsers`,
      );
      return;
    }

    // Group policy checks
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `'zalo-personal': drop group ${chatId} (groupPolicy=disabled)`);
      return;
    }
    if (groupPolicy === "allowlist") {
      const allowed = isGroupAllowed({ groupId: chatId, groups });
      if (!allowed) {
        logVerbose(core, runtime, `'zalo-personal': drop group ${chatId} (not allowlisted)`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "open";
  const configAllowFrom = (account.config.allowFrom ?? ["*"]).map((v) => String(v));
  const rawBody = content.trim();
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("zalo-personal").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(core, runtime, `Blocked zalo-personal DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;

      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "zalo-personal",
            id: senderId,
            meta: { name: senderName || undefined },
          });

          if (created) {
            logVerbose(core, runtime, `zalo-personal pairing request sender=${senderId}`);
            try {
              await sendMessageZaloPersonal(
                chatId,
                core.channel.pairing.buildPairingReply({
                  channel: "zalo-personal",
                  idLine: `Your Zalo user id: ${senderId}`,
                  code,
                }),
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                core,
                runtime,
                `zalo-personal pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized zalo-personal sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(
      core,
      runtime,
      `'zalo-personal': drop control command from unauthorized sender ${senderId}`,
    );
    return;
  }

  // --- Mention gating for groups ---
  const selfUid = getCurrentUid();
  const wasMentioned = isGroup && selfUid
    ? (message.mentions ?? []).some(m => m.uid === selfUid)
    : false;

  // Resolve requireMention: per-group config → wildcard → default true
  const resolvedRequireMention = isGroup
    ? resolveGroupMentionSetting(account, chatId)
    : false;

  const hasControlCommand = core.channel.commands.isControlCommandMessage(rawBody, config);

  if (isGroup && resolvedRequireMention) {
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention: true,
      canDetectMention: true,
      wasMentioned,
      allowTextCommands: true,
      hasControlCommand,
      commandAuthorized: commandAuthorized === true,
    });

    if (mentionGate.shouldSkip) {
      // Buffer message for context (no AI tokens spent)
      const resolvedName = senderName || await resolveUserName(senderId);
      // Download media for buffered messages too, so they're available when bot is mentioned later
      let bufferedLocalPaths: string[] | undefined;
      if (message.mediaUrls && message.mediaUrls.length > 0) {
        const downloaded = await downloadImagesFromUrls(message.mediaUrls);
        bufferedLocalPaths = downloaded.filter((p): p is string => p !== undefined);
      }
      bufferGroupMessage(chatId, {
        senderName: resolvedName,
        content: rawBody,
        timestamp: timestamp ?? Math.floor(Date.now() / 1000),
        mediaUrls: message.mediaUrls,
        localMediaPaths: bufferedLocalPaths,
      });
      logVerbose(core, runtime, `Buffered non-mention message in group ${chatId} from ${senderId}`);
      return;
    }
  }

  const peer = isGroup
    ? { kind: "group" as const, id: chatId }
    : { kind: "direct" as const, id: senderId };

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "zalo-personal",
    accountId: account.accountId,
    peer: {
      kind: peer.kind,
      id: peer.id,
    },
  });

  // Resolve session label: use actual group/user names instead of raw IDs
  const resolvedSenderName = senderName || await resolveUserName(senderId);
  const fromLabel = isGroup
    ? await resolveGroupName(chatId)
    : resolvedSenderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Inject buffered group context when bot is mentioned
  const bufferedContext = isGroup ? consumeGroupBuffer(chatId) : { text: "", mediaPaths: [] };
  const bufferedMediaPaths = bufferedContext.mediaPaths ?? [];

  // Prepend sender context for group messages so the AI knows who sent what
  let bodyWithSender = isGroup
    ? `[userId: ${senderId}, name: ${resolvedSenderName}]: ${rawBody}`
    : rawBody;

  if (bufferedContext.text) {
    bodyWithSender = `[Recent group chat (context only, not addressed to you):\n${bufferedContext.text}\n]\n\n${bodyWithSender}`;
  }

  // --- Auto fetch user info for mentioned users (excluding self) ---
  if (isGroup && message.mentions && message.mentions.length > 0) {
    const mentionedUserIds = message.mentions
      .filter(m => m.type === 0 && m.uid && m.uid !== getCurrentUid()) // type 0 = user, skip bot self
      .map(m => m.uid);

    if (mentionedUserIds.length > 0) {
      try {
        const api = await getApi();
        const userInfos: string[] = [];
        for (const uid of mentionedUserIds) {
          try {
            const result = await api.getUserInfo(uid);
            const profiles = result?.changed_profiles ?? {};
            const info = Object.values(profiles)[0] as any;
            if (info) {
              const name = info.displayName ?? info.display_name ?? info.zaloName ?? uid;
              const gender = info.gender ? ` | gender: ${info.gender}` : "";
              const dob = info.dob ? ` | dob: ${info.dob}` : "";
              userInfos.push(`  - @${name} (userId: ${uid}${gender}${dob})`);
            } else {
              userInfos.push(`  - userId: ${uid} (profile not available)`);
            }
          } catch {
            userInfos.push(`  - userId: ${uid} (failed to fetch info)`);
          }
        }
        if (userInfos.length > 0) {
          bodyWithSender = `[Mentioned users info:\n${userInfos.join("\n")}\n]\n\n${bodyWithSender}`;
        }
      } catch {
        // getApi failed — skip mention enrichment
      }
    }
  }

  // Download media URLs to local files for native image support (BEFORE creating body)
  let localMediaPaths: string[] | undefined;
  if (message.mediaUrls && message.mediaUrls.length > 0) {
    console.log(`[zalo-personal] Downloading ${message.mediaUrls.length} images for native image support...`);
    const downloadedPaths = await downloadImagesFromUrls(message.mediaUrls);
    localMediaPaths = downloadedPaths.filter((p): p is string => p !== undefined);

    if (localMediaPaths.length > 0) {
      console.log(`[zalo-personal] Downloaded ${localMediaPaths.length} images:`, localMediaPaths);
    } else {
      console.warn(`[zalo-personal] Failed to download any images from:`, message.mediaUrls);
    }
  }

  // Merge buffered media paths from previous group messages (images sent before @mention)
  const allMediaPaths = [
    ...(localMediaPaths ?? []),
    ...bufferedMediaPaths,
  ];
  if (allMediaPaths.length > localMediaPaths?.length! && bufferedMediaPaths.length > 0) {
    console.log(`[zalo-personal] Injecting ${bufferedMediaPaths.length} buffered image(s) from group context`);
  }
  const effectiveLocalMediaPaths = allMediaPaths.length > 0 ? allMediaPaths : undefined;

  // Append media to body - use LOCAL paths if downloaded, otherwise URLs
  let bodyForEnvelope = bodyWithSender;
    const mediaPathsForBody = effectiveLocalMediaPaths && effectiveLocalMediaPaths.length > 0 ? effectiveLocalMediaPaths : message.mediaUrls;
  if (mediaPathsForBody && mediaPathsForBody.length > 0) {
    const mediaInfo = mediaPathsForBody.map((path, idx) =>
      `[Image ${idx + 1}: ${path}]`
    ).join('\n');
    bodyForEnvelope = `${bodyWithSender}\n\n${mediaInfo}`;
  }

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Zalo JS",
    from: fromLabel,
    timestamp: timestamp ? timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForEnvelope,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `'zalo-personal':group:${chatId}` : `'zalo-personal':${senderId}`,
    To: `'zalo-personal':${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    WasMentioned: wasMentioned || undefined,
    ConversationLabel: fromLabel,
    SenderName: resolvedSenderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "zalo-personal",
    Surface: "zalo-personal",
    MessageSid: message.msgId ?? `${timestamp}`,
    OriginatingChannel: "zalo-personal",
    OriginatingTo: `'zalo-personal':${chatId}`,
    // Media fields (OpenClaw standard schema)
    // MediaPaths = local file paths (downloaded + buffered), MediaUrls = remote URLs fallback
    MediaPaths: effectiveLocalMediaPaths && effectiveLocalMediaPaths.length > 0 ? effectiveLocalMediaPaths : undefined,
    MediaPath: effectiveLocalMediaPaths && effectiveLocalMediaPaths.length > 0 ? effectiveLocalMediaPaths[0] : undefined,
    MediaUrls: effectiveLocalMediaPaths && effectiveLocalMediaPaths.length > 0 ? undefined : message.mediaUrls,
    MediaUrl: effectiveLocalMediaPaths && effectiveLocalMediaPaths.length > 0 ? undefined : message.mediaUrls?.[0],
    MediaTypes: message.mediaTypes,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`'zalo-personal': failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "zalo-personal",
    accountId: account.accountId,
  });

  // --- Ack Reaction: react emoji on the inbound message ---
  const ackReaction = (config.messages?.ackReaction ?? "").trim();
  const ackScope = config.messages?.ackReactionScope ?? "group-mentions";
  const removeAckAfterReply = config.messages?.removeAckAfterReply ?? false;

  const shouldAck = Boolean(
    ackReaction &&
      core.channel.reactions.shouldAckReaction({
        scope: ackScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: false,
        canDetectMention: false,
        effectiveWasMentioned: true,
        shouldBypassMention: true,
      }),
  );

  let ackReactionPromise: Promise<boolean> | null = null;
  if (shouldAck && message.msgId && message.cliMsgId) {
    const ackMsgId = message.msgId;
    const ackCliMsgId = message.cliMsgId;
    ackReactionPromise = (async () => {
      try {
        const api = await getApi();
        const type = isGroup ? ThreadType.Group : ThreadType.User;
        const iconMap: Record<string, Reactions> = {
          heart: Reactions.HEART,
          love: Reactions.HEART,
          like: Reactions.LIKE,
          haha: Reactions.HAHA,
          wow: Reactions.WOW,
          sad: Reactions.CRY,
          cry: Reactions.CRY,
          angry: Reactions.ANGRY,
          "👍": Reactions.LIKE,
          "❤️": Reactions.HEART,
          "😆": Reactions.HAHA,
          "😮": Reactions.WOW,
          "😢": Reactions.CRY,
          "😠": Reactions.ANGRY,
          "👀": Reactions.SURPRISE,
        };
        const reactionIcon = iconMap[ackReaction.toLowerCase()] ?? (ackReaction as Reactions);
        await api.addReaction(reactionIcon, {
          data: { msgId: ackMsgId, cliMsgId: ackCliMsgId },
          threadId: chatId,
          type,
        });
        return true;
      } catch (err) {
        logAckFailure({
          log: (msg) => logVerbose(core, runtime, msg),
          channel: "zalo-personal",
          target: chatId,
          error: err,
        });
        return false;
      }
    })();
  }

  // --- Typing indicator: show "typing..." while processing ---
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      const api = await getApi();
      const type = isGroup ? ThreadType.Group : ThreadType.User;
      await api.sendTypingEvent(chatId, type);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (msg) => logVerbose(core, runtime, msg),
        channel: "zalo-personal",
        target: chatId,
        action: "start",
        error: err,
      });
    },
  });

  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload) => {
          await deliverZaloPersonalReply({
            payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string; isReasoning?: boolean },
            chatId,
            isGroup,
            runtime,
            core,
            config,
            accountId: account.accountId,
            statusSink,
            tableMode: core.channel.text.resolveMarkdownTableMode({
              cfg: config,
              channel: "zalo-personal",
              accountId: account.accountId,
            }),
          });
        },
        onError: (err, info) => {
          runtime.error(`[${account.accountId}] ZaloPersonal ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
        onIdle: typingCallbacks.onIdle,
        onCleanup: typingCallbacks.onCleanup,
      },
      replyOptions: {
        onModelSelected,
      },
    });
  } finally {
    // --- Remove ack reaction after reply (if configured) ---
    if (shouldAck && message.msgId && message.cliMsgId) {
      const removeMsgId = message.msgId;
      const removeCliMsgId = message.cliMsgId;
      core.channel.reactions.removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReaction || null,
        remove: async () => {
          const api = await getApi();
          const type = isGroup ? ThreadType.Group : ThreadType.User;
          await api.addReaction(Reactions.NONE, {
            data: { msgId: removeMsgId, cliMsgId: removeCliMsgId },
            threadId: chatId,
            type,
          });
        },
        onError: (err) => {
          logAckFailure({
            log: (msg) => logVerbose(core, runtime, msg),
            channel: "zalo-personal",
            target: chatId,
            error: err,
          });
        },
      });
    }
  }
}

function resolveGroupMentionSetting(account: ResolvedZaloPersonalAccount, groupId: string): boolean {
  const groups = account.config.groups ?? {};
  const candidates = [groupId, `group:${groupId}`, "*"];
  for (const key of candidates) {
    const entry = groups[key];
    if (entry && typeof entry.requireMention === "boolean") {
      return entry.requireMention;
    }
  }
  return true; // default: require mention in groups
}

const THINKING_TAG_RE = /^\s*<(?:think|thinking|thought|antthinking)\b[^>]*>/i;
const REASONING_PREFIX = "Reasoning:\n";

function isReasoningOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(REASONING_PREFIX)) return true;
  if (THINKING_TAG_RE.test(trimmed)) return true;
  return false;
}

function stripThinkingTags(text: string): string {
  return text.replace(/<(?:think|thinking|thought|antthinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thought|antthinking)>/gi, "").trim();
}

async function deliverZaloPersonalReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; isReasoning?: boolean };
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: ZaloPersonalCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, chatId, isGroup, runtime, core, config, accountId, statusSink } = params;

  // Skip reasoning-only blocks (thinking/internal reasoning should not be sent to Zalo)
  if (payload.isReasoning) {
    logVerbose(core, runtime, `Skipping reasoning block for ${chatId}`);
    return;
  }

  const tableMode = params.tableMode ?? "code";
  let text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  // Safety net: strip any thinking tags that slipped through
  if (text && isReasoningOnlyMessage(text)) {
    logVerbose(core, runtime, `Skipping reasoning-only message for ${chatId}`);
    return;
  }
  text = stripThinkingTags(text);

  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : undefined;
      first = false;
      try {
        logVerbose(core, runtime, `Sending media to ${chatId}`);
        await sendMessageZaloPersonal(chatId, caption ?? "", {
          mediaUrl,
          isGroup,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`ZaloPersonal media send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "zalo-personal", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      ZALOJS_TEXT_LIMIT,
      chunkMode,
    );
    logVerbose(core, runtime, `Sending ${chunks.length} text chunk(s) to ${chatId}`);
    for (const chunk of chunks) {
      try {
        await sendMessageZaloPersonal(chatId, chunk, { isGroup });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error(`ZaloPersonal message send failed: ${String(err)}`);
      }
    }
  }
}

export async function monitorZaloPersonalProvider(
  options: ZaloPersonalMonitorOptions,
): Promise<ZaloPersonalMonitorResult> {
  let { account, config } = options;
  const { abortSignal, statusSink, runtime } = options;

  const core = getZaloPersonalRuntime();
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let resolveRunning: (() => void) | null = null;

  // Resolve allowFrom name→id mappings using zca-js API
  try {
    const allowFromEntries = (account.config.allowFrom ?? [])
      .map((entry) => normalizeZaloPersonalEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");

    if (allowFromEntries.length > 0) {
      try {
        const api = await getApi();
        const friends = await api.getAllFriends();
        const friendList: ZaloPersonalFriend[] = Array.isArray(friends)
          ? friends.map((f: any) => ({
              userId: String(f.userId),
              displayName: f.displayName ?? f.zaloName ?? "",
              avatar: f.avatar,
            }))
          : [];
        const byName = buildNameIndex(friendList, (friend) => friend.displayName);
        const additions: string[] = [];
        const mapping: string[] = [];
        const unresolved: string[] = [];
        for (const entry of allowFromEntries) {
          if (/^\d+$/.test(entry)) {
            additions.push(entry);
            continue;
          }
          const matches = byName.get(entry.toLowerCase()) ?? [];
          const match = matches[0];
          const id = match?.userId ? String(match.userId) : undefined;
          if (id) {
            additions.push(id);
            mapping.push(`${entry}→${id}`);
          } else {
            unresolved.push(entry);
          }
        }
        const allowFrom = mergeAllowlist({ existing: account.config.allowFrom, additions });
        account = {
          ...account,
          config: {
            ...account.config,
            allowFrom,
          },
        };
        summarizeMapping("zalo-personal users", mapping, unresolved, runtime);
      } catch (err) {
        runtime.log?.(`zalo-personal user resolve failed; using config entries. ${String(err)}`);
      }
    }

    // NEW: Resolve denyFrom name→id mappings
    const denyFromEntries = (account.config.denyFrom ?? [])
      .map((entry) => normalizeZaloPersonalEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");

    if (denyFromEntries.length > 0) {
      try {
        const api = await getApi();
        const friends = await api.getAllFriends();
        const friendList: ZaloPersonalFriend[] = Array.isArray(friends)
          ? friends.map((f: any) => ({
              userId: String(f.userId),
              displayName: f.displayName ?? f.zaloName ?? "",
              avatar: f.avatar,
            }))
          : [];
        const byName = buildNameIndex(friendList, (friend) => friend.displayName);
        const additions: string[] = [];
        const mapping: string[] = [];
        const unresolved: string[] = [];

        for (const entry of denyFromEntries) {
          if (/^\d+$/.test(entry)) {
            additions.push(entry);
            continue;
          }
          const matches = byName.get(entry.toLowerCase()) ?? [];
          const match = matches[0];
          const id = match?.userId ? String(match.userId) : undefined;
          if (id) {
            additions.push(id);
            mapping.push(`${entry}→${id}`);
          } else {
            unresolved.push(entry);
          }
        }

        const denyFrom = mergeAllowlist({ existing: account.config.denyFrom, additions });
        account = {
          ...account,
          config: {
            ...account.config,
            denyFrom,
          },
        };
        summarizeMapping("zalo-personal blocked users", mapping, unresolved, runtime);
      } catch (err) {
        runtime.log?.(`zalo-personal denyFrom resolve failed. ${String(err)}`);
      }
    }

    // Resolve group name→id mappings
    const groupsConfig = account.config.groups ?? {};
    const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
    if (groupKeys.length > 0) {
      try {
        const api = await getApi();
        const groupsResp = await api.getAllGroups();
        const groupIds = Object.keys(groupsResp?.gridVerMap ?? {});
        let groupList: ZaloPersonalGroup[] = [];
        if (groupIds.length > 0) {
          try {
            const infoResp = await api.getGroupInfo(groupIds);
            const gridInfoMap = infoResp?.gridInfoMap ?? {};
            groupList = Object.entries(gridInfoMap).map(([id, info]: [string, any]) => ({
              groupId: id,
              name: info.name ?? "",
              memberCount: info.totalMember,
            }));
          } catch {
            groupList = groupIds.map((id) => ({ groupId: id, name: "", memberCount: 0 }));
          }
        }
        const byName = buildNameIndex(groupList, (group) => group.name);
        const mapping: string[] = [];
        const unresolved: string[] = [];
        const nextGroups = { ...groupsConfig };
        for (const entry of groupKeys) {
          const cleaned = normalizeZaloPersonalEntry(entry);
          if (/^\d+$/.test(cleaned)) {
            if (!nextGroups[cleaned]) {
              nextGroups[cleaned] = groupsConfig[entry];
            }
            mapping.push(`${entry}→${cleaned}`);
            continue;
          }
          const matches = byName.get(cleaned.toLowerCase()) ?? [];
          const match = matches[0];
          const id = match?.groupId ? String(match.groupId) : undefined;
          if (id) {
            if (!nextGroups[id]) {
              nextGroups[id] = groupsConfig[entry];
            }
            mapping.push(`${entry}→${id}`);
          } else {
            unresolved.push(entry);
          }
        }

        // NEW: Resolve denyUsers within each group
        for (const groupKey of Object.keys(nextGroups)) {
          const groupConfig = nextGroups[groupKey];
          if (!groupConfig.denyUsers || groupConfig.denyUsers.length === 0) {
            continue;
          }

          const denyUserEntries = groupConfig.denyUsers
            .map((entry) => normalizeZaloPersonalEntry(String(entry)))
            .filter((entry) => entry && entry !== "*");

          if (denyUserEntries.length === 0) {
            continue;
          }

          // Fetch friends for name resolution (reuse API call)
          const friends = await api.getAllFriends();
          const friendList: ZaloPersonalFriend[] = Array.isArray(friends)
            ? friends.map((f: any) => ({
                userId: String(f.userId),
                displayName: f.displayName ?? f.zaloName ?? "",
                avatar: f.avatar,
              }))
            : [];
          const friendByName = buildNameIndex(friendList, (friend) => friend.displayName);

          const userAdditions: string[] = [];
          const userMapping: string[] = [];
          const userUnresolved: string[] = [];

          for (const entry of denyUserEntries) {
            if (/^\d+$/.test(entry)) {
              userAdditions.push(entry);
              continue;
            }
            const matches = friendByName.get(entry.toLowerCase()) ?? [];
            const match = matches[0];
            const id = match?.userId ? String(match.userId) : undefined;
            if (id) {
              userAdditions.push(id);
              userMapping.push(`${entry}→${id}`);
            } else {
              userUnresolved.push(entry);
            }
          }

          const resolvedDenyUsers = mergeAllowlist({
            existing: groupConfig.denyUsers,
            additions: userAdditions,
          });
          nextGroups[groupKey] = {
            ...groupConfig,
            denyUsers: resolvedDenyUsers,
          };

          if (userMapping.length > 0 || userUnresolved.length > 0) {
            summarizeMapping(
              `zalo-personal group:${groupKey} blocked users`,
              userMapping,
              userUnresolved,
              runtime,
            );
          }
        }

        account = {
          ...account,
          config: {
            ...account.config,
            groups: nextGroups,
          },
        };
        summarizeMapping("zalo-personal groups", mapping, unresolved, runtime);
      } catch (err) {
        runtime.log?.(`zalo-personal group resolve failed; using config entries. ${String(err)}`);
      }
    }
  } catch (err) {
    runtime.log?.(`zalo-personal resolve failed; using config entries. ${String(err)}`);
  }

  const stop = () => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    resolveRunning?.();
  };

  let listenersRegistered = false;

  const startListener = async () => {
    if (stopped || abortSignal.aborted) {
      resolveRunning?.();
      return;
    }

    logVerbose(core, runtime, `[${account.accountId}] starting zca-js listener`);

    try {
      const api = await getApi();
      const selfUid = getCurrentUid();

      // Register event handlers only once to avoid duplicate processing
      if (listenersRegistered) {
        // Stop existing listener first to avoid "Already started" error
        try { api.listener.stop(); } catch (_) { /* ignore if not running */ }
        api.listener.start({ retryOnClose: true });
        return;
      }
      listenersRegistered = true;

      api.listener.on("message", (msg: Message) => {
        // Skip self messages
        if (msg.isSelf) {
          return;
        }
        // Skip messages from our own UID
        if (selfUid && msg.data.uidFrom === selfUid) {
          return;
        }

        const converted = convertToZaloPersonalMessage(msg);
        if (!converted) {
          return;
        }

        logVerbose(core, runtime, `[${account.accountId}] inbound message`);
        statusSink?.({ lastInboundAt: Date.now() });
        processMessage(converted, account, config, core, runtime, statusSink).catch((err) => {
          runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
        });
      });

      api.listener.on("friend_event", (event: FriendEvent) => {
        try {
          if (event.type === FriendEventType.REQUEST && !event.isSelf) {
            const data = event.data as { fromUid: string; message: string; src?: number };
            addPendingRequest(data.fromUid, data.message, data.src);
            runtime.log?.(`[${account.accountId}] incoming friend request from ${data.fromUid}: ${data.message}`);
          } else if (event.type === FriendEventType.UNDO_REQUEST) {
            const data = event.data as { fromUid: string };
            removePendingRequest(data.fromUid);
            runtime.log?.(`[${account.accountId}] friend request undone by ${data.fromUid}`);
          } else if (event.type === FriendEventType.ADD) {
            // Friend added - remove from pending
            const uid = event.data as string;
            removePendingRequest(uid);
          }
        } catch (err) {
          runtime.error(`[${account.accountId}] friend event error: ${String(err)}`);
        }
      });

      api.listener.on("error", (err: unknown) => {
        const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
        runtime.error(`[${account.accountId}] zca-js listener error: ${errMsg}`);
      });

      api.listener.on("closed", (code: number, reason: string) => {
        runtime.log?.(`[${account.accountId}] zca-js listener closed: code=${code} reason=${reason}`);
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        // Let retryOnClose handle reconnection automatically; only resolve if stopped
        if (stopped || abortSignal.aborted) {
          resolveRunning?.();
        }
      });

      api.listener.on("connected", () => {
        logVerbose(core, runtime, `[${account.accountId}] zca-js listener connected`);
      });

      // Use retryOnClose to let zca-js handle reconnection — do NOT also restart manually
      api.listener.start({ retryOnClose: true });

      // keepAlive heartbeat using server-recommended interval
      // Side-effect: HTTP requests trigger Set-Cookie refresh, which we persist to disk
      // This ensures gateway restarts can reuse valid session cookies
      const keepaliveDuration = api.getContext().settings?.keepalive?.keepalive_duration;
      if (keepaliveDuration && keepaliveDuration > 0) {
        const intervalMs = keepaliveDuration * 1000;
        runtime.log?.(`[${account.accountId}] keepAlive enabled: ${keepaliveDuration}s interval (${intervalMs}ms)`);

        keepAliveTimer = setInterval(async () => {
          if (stopped || abortSignal.aborted) return;
          try {
            await api.keepAlive();
            // Persist refreshed cookies to disk (request() auto-updates CookieJar in RAM)
            const jar = api.getCookie();
            const serialized = jar.serializeSync?.()?.cookies ?? jar.toJSON?.()?.cookies;
            if (serialized) {
              refreshCredentials(serialized);
            }
          } catch (err) {
            runtime.error(`[${account.accountId}] keepAlive failed: ${String(err)}`);
          }
        }, intervalMs);
      } else {
        runtime.log?.(`[${account.accountId}] keepAlive disabled (no server-provided duration)`);
      }
    } catch (err) {
      const errMsg = String(err);
      // If listener is already running, no need to retry — it's working fine
      if (errMsg.includes("Already started")) {
        runtime.log?.(`[${account.accountId}] listener already running, skipping retry`);
        return;
      }
      runtime.error(`[${account.accountId}] zca-js listener start failed: ${errMsg}`);
      if (!stopped && !abortSignal.aborted) {
        logVerbose(core, runtime, `[${account.accountId}] retrying listener in 10s...`);
        restartTimer = setTimeout(startListener, 10000);
      } else {
        resolveRunning?.();
      }
    }
  };

  const runningPromise = new Promise<void>((resolve) => {
    resolveRunning = resolve;
    abortSignal.addEventListener("abort", () => {
      stop();
      resolve();
    }, { once: true });
  });

  await startListener();
  await runningPromise;

  return { stop };
}
