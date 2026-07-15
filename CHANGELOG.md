# Changelog

All notable changes to the zalo-personal OpenClaw extension will be documented in this file.

## [2.4.2] - 2026-07-15

### Added
- **Tool contract declaration**: the plugin now advertises `contracts: { tools: ["zalo-personal"] }` in both `index.ts` and `openclaw.plugin.json`, so newer OpenClaw builds can discover the `zalo-personal` tool from the manifest during contract resolution.

### Fixed
- **`openclaw.plugin.json` formatting**: restored clean 2-space JSON (removed a UTF-8 BOM and `'`-escaped apostrophes introduced by a Windows/PowerShell round-trip) so the manifest stays diff-friendly and BOM-free.

## [2.4.1] - 2026-05-31

### Fixed
- **OpenClaw 2026.4.29+ channel discovery**: added `channelConfigs` metadata to `openclaw.plugin.json`. Newer OpenClaw builds the channel registry for CLI surfaces (`channels list`, `channels login`) from the manifest *before* the runtime loads; without `channelConfigs` the channel was invisible to the CLI and `openclaw channels login --channel zalo-personal` failed with `Unsupported channel: zalo-personal`. Runtime/gateway registration was unaffected.

## [2.4.0] - 2026-05-13

### Added
- **Self-reply support**: Bot can react to its own messages in opt-in groups, enabling a 1-person "command group" used as a terminal.
  - `zalo-client.ts`: pass `selfListen: true` when constructing `Zalo` so zca-js delivers own-message events.
  - `config-schema.ts`: new optional `allowSelf` field on per-group config.
  - `monitor.ts`: `resolveGroupAllowSelf()` + listener gate that drops self messages unless the originating group sets `allowSelf: true`.
- **Outbound loop guard**: prevent echo loops when self-reply is enabled.
  - New `outbound-tracker.ts` module: tracks bot-sent msgIds with a 5-minute TTL and 1000-entry cap.
  - `send.ts`: every send path calls `markOutboundMsgId(msgId)` after a successful send.
  - `monitor.ts`: inbound listener short-circuits when the incoming msgId was recently outbound.
- **Per-thread history store**: append-only log of every inbound message so the agent can recall older context with its Read tool, regardless of `dmPolicy` or mention requirements.
  - New `history-store.ts` module: JSONL log at `~/.openclaw/workspace/threads/<threadId>/messages.jsonl`, 5MB rolling cap (archives to `messages.prev.jsonl`).
  - Maintains `~/.openclaw/workspace/peers/zalo-personal.json` index of seen users and groups.
  - `monitor.ts`: `appendThreadHistory()` + `rememberPeer()` called on every inbound event, in a try/catch so logging failure never blocks the reply pipeline.

## [1.5.0] - 2026-03-10

### Added
- **Group Mention Gating**: Bot only replies when @mentioned in groups (default)
  - Per-group `requireMention` config: `true` (default) or `false`
  - Wildcard `"*"` support for global default
  - Non-mentioned messages buffered for context (max 50 msgs, 4h TTL)
  - When @mentioned, buffered context injected so AI understands conversation
  - Control commands bypass mention requirement for authorized admins
  - New `group-mention` tool action for admin to configure via chat
- **Thinking/Reasoning Filter**: Strip AI thinking blocks from Zalo replies
  - Check `isReasoning` flag, detect `<think>` tags, strip embedded thinking
- **Rich Text Auto-Convert**: Markdown → Zalo styles in replies
  - New `send-styled` tool action for explicit rich text formatting

### Changed
- `resolveRequireMention` reads from per-group config instead of hardcoding `true`
- Default `dmPolicy` changed to `"open"` with `allowFrom: ["*"]`

## [1.3.1] - 2026-02-14

### Fixed
- **Native Image Detection**: Fixed image detection in current prompt vs history
  - Images now properly recognized as "in prompt" instead of "in history"
  - LLM vision/analysis now uses the correct uploaded image
  - Resolved issue where bot analyzed old images instead of new ones

## [1.3.0] - 2026-02-14

### Added
- **Native Image Input Support**: Download images from Zalo messages for use as input to AI skills
  - New `image-downloader.ts` module for downloading images from URLs
  - Automatic download of images sent by users to local files
  - Images saved to `~/.openclaw/workspace/media/` with timestamped filenames
  - Full integration with nano-banana and other image-processing skills
  - Support for multiple images (multi-image composition up to 14 images)
  - Proper error handling and fallback to URLs if download fails

### Technical Details
- Downloaded images replace URL references in message context
- Local file paths passed to OpenClaw's native image system
- Works seamlessly with image editing, analysis, and composition tasks

## [1.2.4] - 2026-02-14

### Fixed
- **Race Condition**: Fixed auto-cleanup deleting files before OpenClaw processing
  - Changed `cleanupAfterUpload` default from `true` to `false`
  - Prevents file deletion before MEDIA: token processing completes
  - OpenClaw now manages file lifecycle correctly
  - Fixes issue where nano-banana couldn't find generated images

## [1.2.3] - 2026-02-14

### Added
- **Image Metadata Support**: Added `imageMetadataGetter` for zca-js v2.0+ compatibility
  - Uses `sharp` library to read image dimensions (width, height, size)
  - Required for zca-js uploadAttachment to work correctly
  - Fixes "Missing imageMetadataGetter" error when uploading images

## [1.2.2] - 2026-02-14

### Fixed
- **Session Routing**: Fixed DM messages incorrectly routed to per-channel sessions
  - Bug: Both DM and group messages were set as `kind: "group"`
  - Fix: DM messages now correctly use `kind: "direct"`
  - DM messages now appear in main:main session like Telegram
  - Messages now visible in OpenClaw webui
  - Proper integration with `session.dmScope = "main"` configuration

## [1.2.1] - 2026-02-14

### Added
- **Local File Upload**: Upload local images generated by AI skills to Zalo
  - New `uploadAndSendLocalImage()` function for direct file uploads
  - Auto-detection of local file paths in message sending
  - Integration with zca-js `sendMessage` attachments parameter
  - Support for AI-generated images from skills like nano-banana
  - Automatic cleanup option for local files after upload (optional)

### Features
- Seamless workflow: AI generates image → upload to Zalo → send to user
- Works with all image formats supported by zca-js
- Local path detection: automatically uploads if path starts with `/` and file exists

## [1.2.0] - 2026-02-13

### Added
- Initial media support groundwork
- Prepared infrastructure for image handling

---

## [1.1.2] - Previous Stable

### Features
- QR Code login via zca-js
- Pairing mode for access control
- Group and direct message support
- Automatic QR cleanup
- Gateway restart prompt
- Blocklist/Denylist support

