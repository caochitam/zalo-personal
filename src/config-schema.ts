import { MarkdownConfigSchema, ToolPolicySchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);
const denyFromEntry = z.union([z.string(), z.number()]);

const groupConfigSchema = z.object({
  allow: z.boolean().optional(),
  enabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  denyUsers: z.array(denyFromEntry).optional(),
  tools: ToolPolicySchema,
});

const zaloPersonalAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  denyFrom: z.array(denyFromEntry).optional(),
  groupPolicy: z.enum(["disabled", "allowlist", "open"]).optional(),
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZaloPersonalConfigSchema = zaloPersonalAccountSchema.extend({
  accounts: z.object({}).catchall(zaloPersonalAccountSchema).optional(),
  defaultAccount: z.string().optional(),
});
