import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/channel-plugin-common";
import type { ResolvedZaloPersonalAccount, ZaloPersonalAccountConfig, ZaloPersonalConfig } from "./types.js";
import { hasStoredCredentials } from "./zalo-client.js";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.['zalo-personal'] as ZaloPersonalConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZaloPersonalAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZaloPersonalAccountId(cfg: OpenClawConfig): string {
  const zaloPersonalConfig = cfg.channels?.['zalo-personal'] as ZaloPersonalConfig | undefined;
  if (zaloPersonalConfig?.defaultAccount?.trim()) {
    return zaloPersonalConfig.defaultAccount.trim();
  }
  const ids = listZaloPersonalAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZaloPersonalAccountConfig | undefined {
  const accounts = (cfg.channels?.['zalo-personal'] as ZaloPersonalConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZaloPersonalAccountConfig | undefined;
}

function mergeZaloPersonalAccountConfig(cfg: OpenClawConfig, accountId: string): ZaloPersonalAccountConfig {
  const raw = (cfg.channels?.['zalo-personal'] ?? {}) as ZaloPersonalConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export async function checkZaloPersonalAuthenticated(): Promise<boolean> {
  return hasStoredCredentials();
}

export async function resolveZaloPersonalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ResolvedZaloPersonalAccount> {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.['zalo-personal'] as ZaloPersonalConfig | undefined)?.enabled !== false;
  const merged = mergeZaloPersonalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const authenticated = await checkZaloPersonalAuthenticated();

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    authenticated,
    config: merged,
  };
}

export function resolveZaloPersonalAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZaloPersonalAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.['zalo-personal'] as ZaloPersonalConfig | undefined)?.enabled !== false;
  const merged = mergeZaloPersonalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    authenticated: false,
    config: merged,
  };
}

export async function listEnabledZaloPersonalAccounts(
  cfg: OpenClawConfig,
): Promise<ResolvedZaloPersonalAccount[]> {
  const ids = listZaloPersonalAccountIds(cfg);
  const accounts = await Promise.all(
    ids.map((accountId) => resolveZaloPersonalAccount({ cfg, accountId })),
  );
  return accounts.filter((account) => account.enabled);
}

export async function getZaloPersonalUserInfo(): Promise<{ userId?: string; displayName?: string } | null> {
  try {
    const { getApi } = await import("./zalo-client.js");
    const api = await getApi();
    const raw = await api.fetchAccountInfo();
    const info = (raw as any)?.profile ?? raw;
    return info ? { userId: info.userId, displayName: info.displayName } : null;
  } catch {
    return null;
  }
}

export type { ResolvedZaloPersonalAccount } from "./types.js";
