import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk/channel-plugin-common";
import {
  addWildcardAllowFrom,
  promptAccountId,
  promptChannelAccessConfig,
} from "openclaw/plugin-sdk/setup";
import * as fs from "fs";
import {
  listZaloPersonalAccountIds,
  resolveDefaultZaloPersonalAccountId,
  resolveZaloPersonalAccountSync,
  checkZaloPersonalAuthenticated,
} from "./accounts.js";
import { hasStoredCredentials, loginWithQR } from "./zalo-client.js";
import { LoginQRCallbackEventType } from "zca-js";
import { displayQRFromPNG } from "./qr-display.js";

const channel = "zalo-personal" as const;

function setZaloPersonalDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.['zalo-personal']?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      'zalo-personal': {
        ...cfg.channels?.['zalo-personal'],
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

async function noteZaloPersonalHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Zalo Personal Account login via QR code.",
      "",
      "Prerequisites:",
      "1) zca-js library (bundled with plugin)",
      "2) You'll scan a QR code with your Zalo app",
      "",
      "No CLI binary needed - uses zca-js library directly.",
    ].join("\n"),
    "Zalo JS Setup",
  );
}

async function promptZaloPersonalAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZaloPersonalAccountSync({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const parseInput = (raw: string) =>
    raw
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  const resolveUserId = async (input: string): Promise<string | null> => {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      return trimmed;
    }
    try {
      const { getApi } = await import("./zalo-client.js");
      const api = await getApi();
      const friends = await api.getAllFriends();
      const friendList = Array.isArray(friends) ? friends : [];
      const match = friendList.find(
        (f: any) => (f.displayName ?? "").toLowerCase() === trimmed.toLowerCase(),
      );
      return match ? String(match.userId) : null;
    } catch {
      return null;
    }
  };

  while (true) {
    const entry = await prompter.text({
      message: "ZaloPersonal allowFrom (username or user id)",
      placeholder: "Alice, 123456789",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInput(String(entry));
    const results = await Promise.all(parts.map((part) => resolveUserId(part)));
    const unresolved = parts.filter((_, idx) => !results[idx]);
    if (unresolved.length > 0) {
      await prompter.note(
        `Could not resolve: ${unresolved.join(", ")}. Use numeric user ids or ensure you are logged in.`,
        "Zalo JS allowlist",
      );
      continue;
    }
    const merged = [
      ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
      ...(results.filter(Boolean) as string[]),
    ];
    const unique = [...new Set(merged)];
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          'zalo-personal': {
            ...cfg.channels?.['zalo-personal'],
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      } as OpenClawConfig;
    }

    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        'zalo-personal': {
          ...cfg.channels?.['zalo-personal'],
          enabled: true,
          accounts: {
            ...cfg.channels?.['zalo-personal']?.accounts,
            [accountId]: {
              ...cfg.channels?.['zalo-personal']?.accounts?.[accountId],
              enabled: cfg.channels?.['zalo-personal']?.accounts?.[accountId]?.enabled ?? true,
              dmPolicy: "allowlist",
              allowFrom: unique,
            },
          },
        },
      },
    } as OpenClawConfig;
  }
}

function setZaloPersonalGroupPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        'zalo-personal': {
          ...cfg.channels?.['zalo-personal'],
          enabled: true,
          groupPolicy,
        },
      },
    } as OpenClawConfig;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      'zalo-personal': {
        ...cfg.channels?.['zalo-personal'],
        enabled: true,
        accounts: {
          ...cfg.channels?.['zalo-personal']?.accounts,
          [accountId]: {
            ...cfg.channels?.['zalo-personal']?.accounts?.[accountId],
            enabled: cfg.channels?.['zalo-personal']?.accounts?.[accountId]?.enabled ?? true,
            groupPolicy,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setZaloPersonalGroupAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  groupKeys: string[],
): OpenClawConfig {
  const groups = Object.fromEntries(groupKeys.map((key) => [key, { allow: true }]));
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        'zalo-personal': {
          ...cfg.channels?.['zalo-personal'],
          enabled: true,
          groups,
        },
      },
    } as OpenClawConfig;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      'zalo-personal': {
        ...cfg.channels?.['zalo-personal'],
        enabled: true,
        accounts: {
          ...cfg.channels?.['zalo-personal']?.accounts,
          [accountId]: {
            ...cfg.channels?.['zalo-personal']?.accounts?.[accountId],
            enabled: cfg.channels?.['zalo-personal']?.accounts?.[accountId]?.enabled ?? true,
            groups,
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function resolveZaloPersonalGroups(params: {
  cfg: OpenClawConfig;
  accountId: string;
  entries: string[];
}): Promise<Array<{ input: string; resolved: boolean; id?: string }>> {
  try {
    const { getApi } = await import("./zalo-client.js");
    const api = await getApi();
    const groupsResp = await api.getAllGroups();
    const groupIds = Object.keys(groupsResp?.gridVerMap ?? {});
    let groups: Array<{ groupId: string; name: string }> = [];
    if (groupIds.length > 0) {
      try {
        const infoResp = await api.getGroupInfo(groupIds);
        const gridInfoMap = infoResp?.gridInfoMap ?? {};
        groups = Object.entries(gridInfoMap).map(([id, info]: [string, any]) => ({
          groupId: id,
          name: info.name ?? "",
        }));
      } catch {
        groups = [];
      }
    }
    const byName = new Map<string, typeof groups>();
    for (const group of groups) {
      const name = group.name?.trim().toLowerCase();
      if (!name) {
        continue;
      }
      const list = byName.get(name) ?? [];
      list.push(group);
      byName.set(name, list);
    }

    return params.entries.map((input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return { input, resolved: false };
      }
      if (/^\d+$/.test(trimmed)) {
        return { input, resolved: true, id: trimmed };
      }
      const matches = byName.get(trimmed.toLowerCase()) ?? [];
      const match = matches[0];
      return match?.groupId
        ? { input, resolved: true, id: String(match.groupId) }
        : { input, resolved: false };
    });
  } catch {
    throw new Error("Not authenticated - cannot resolve groups");
  }
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zalo JS",
  channel,
  policyKey: "channels['zalo-personal'].dmPolicy",
  allowFromKey: "channels['zalo-personal'].allowFrom",
  getCurrent: (cfg) => (cfg.channels?.['zalo-personal']?.dmPolicy ?? "open") as "open",
  setPolicy: (cfg, policy) => setZaloPersonalDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultZaloPersonalAccountId(cfg);
    return promptZaloPersonalAllowFrom({
      cfg: cfg,
      prompter,
      accountId: id,
    });
  },
};

export const zaloPersonalOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = hasStoredCredentials();
    return {
      channel,
      configured,
      statusLines: [`Zalo JS: ${configured ? "logged in" : "needs QR login"}`],
      selectionHint: configured ? "recommended · logged in" : "recommended · QR login",
      quickstartScore: configured ? 1 : 15,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const zaloPersonalOverride = accountOverrides['zalo-personal']?.trim();
    const defaultAccountId = resolveDefaultZaloPersonalAccountId(cfg);
    let accountId = zaloPersonalOverride ? normalizeAccountId(zaloPersonalOverride) : defaultAccountId;

    if (shouldPromptAccountIds && !zaloPersonalOverride) {
      accountId = await promptAccountId({
        cfg: cfg,
        prompter,
        label: "Zalo JS",
        currentId: accountId,
        listAccountIds: listZaloPersonalAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const alreadyAuthenticated = hasStoredCredentials();

    if (!alreadyAuthenticated) {
      await noteZaloPersonalHelp(prompter);

      const wantsLogin = await prompter.confirm({
        message: "Login via QR code now?",
        initialValue: true,
      });

      if (wantsLogin) {
        await prompter.note(
          "A QR code will be displayed below.\nScan it with your Zalo app to login.",
          "QR Login",
        );

        let qrFilePath: string | null = null;
        try {
          await loginWithQR(async (event) => {
            if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
              // Display QR via HTTP server + qrcode-terminal
              try {
                qrFilePath = await displayQRFromPNG(event.data.image);
              } catch (err) {
                console.log(`Could not display QR: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          });

          await prompter.note("Login successful!", "Success");

          // Delete QR image file if it exists
          if (qrFilePath) {
            try {
              fs.unlinkSync(qrFilePath);
              await prompter.note(`QR image deleted: ${qrFilePath}`, "Cleanup");
            } catch (err) {
              console.log(`Could not delete QR image: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Ask if user wants to restart gateway
          const wantsRestart = await prompter.confirm({
            message: "Restart gateway now? (Required for certificate to be recognized)",
            initialValue: true,
          });

          if (wantsRestart) {
            await prompter.note(
              "To apply the new certificate, run: openclaw gateway restart",
              "Gateway",
            );
          }
        } catch (err) {
          await prompter.note(
            `Login failed: ${err instanceof Error ? err.message : "Unknown error"}`,
            "Error",
          );
          // Clean up QR file even on failure
          if (qrFilePath) {
            try {
              fs.unlinkSync(qrFilePath);
            } catch {}
          }
        }
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Zalo JS already logged in. Keep session?",
        initialValue: true,
      });
      if (!keepSession) {
        const { logout } = await import("./zalo-client.js");
        await logout();
        await prompter.note(
          "A QR code will be displayed below.\nScan it with your Zalo app to login.",
          "QR Login",
        );

        let qrFilePath: string | null = null;
        try {
          await loginWithQR(async (event) => {
            if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
              // Display QR via HTTP server + qrcode-terminal
              try {
                qrFilePath = await displayQRFromPNG(event.data.image);
              } catch (err) {
                console.log(`Could not display QR: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          });

          await prompter.note("Login successful!", "Success");

          // Delete QR image file if it exists
          if (qrFilePath) {
            try {
              fs.unlinkSync(qrFilePath);
              await prompter.note(`QR image deleted: ${qrFilePath}`, "Cleanup");
            } catch (err) {
              console.log(`Could not delete QR image: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Ask if user wants to restart gateway
          const wantsRestart = await prompter.confirm({
            message: "Restart gateway now? (Required for certificate to be recognized)",
            initialValue: true,
          });

          if (wantsRestart) {
            await prompter.note(
              "To apply the new certificate, run: openclaw gateway restart",
              "Gateway",
            );
          }
        } catch {
          // ignore login errors during re-login, but clean up QR file
          if (qrFilePath) {
            try {
              fs.unlinkSync(qrFilePath);
            } catch {}
          }
        }
      }
    }

    // Enable the channel
    if (accountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          'zalo-personal': {
            ...next.channels?.['zalo-personal'],
            enabled: true,
          },
        },
      } as OpenClawConfig;
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          'zalo-personal': {
            ...next.channels?.['zalo-personal'],
            enabled: true,
            accounts: {
              ...next.channels?.['zalo-personal']?.accounts,
              [accountId]: {
                ...next.channels?.['zalo-personal']?.accounts?.[accountId],
                enabled: true,
              },
            },
          },
        },
      } as OpenClawConfig;
    }

    if (forceAllowFrom) {
      next = await promptZaloPersonalAllowFrom({
        cfg: next,
        prompter,
        accountId,
      });
    }

    const account = resolveZaloPersonalAccountSync({ cfg: next, accountId });
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Zalo groups",
      currentPolicy: account.config.groupPolicy ?? "open",
      currentEntries: Object.keys(account.config.groups ?? {}),
      placeholder: "Family, Work, 123456789",
      updatePrompt: Boolean(account.config.groups),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setZaloPersonalGroupPolicy(next, accountId, accessConfig.policy);
      } else {
        let keys = accessConfig.entries;
        if (accessConfig.entries.length > 0) {
          try {
            const resolved = await resolveZaloPersonalGroups({
              cfg: next,
              accountId,
              entries: accessConfig.entries,
            });
            const resolvedIds = resolved
              .filter((entry) => entry.resolved && entry.id)
              .map((entry) => entry.id as string);
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            keys = [...resolvedIds, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
            if (resolvedIds.length > 0 || unresolved.length > 0) {
              await prompter.note(
                [
                  resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(", ")}` : undefined,
                  unresolved.length > 0
                    ? `Unresolved (kept as typed): ${unresolved.join(", ")}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
                "Zalo groups",
              );
            }
          } catch (err) {
            await prompter.note(
              `Group lookup failed; keeping entries as typed. ${String(err)}`,
              "Zalo groups",
            );
          }
        }
        next = setZaloPersonalGroupPolicy(next, accountId, "allowlist");
        next = setZaloPersonalGroupAllowlist(next, accountId, keys);
      }
    }

    return { cfg: next, accountId };
  },
};
