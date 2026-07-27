import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { providerModels } from "@paperclipai/db";
import type { CreateProviderModel, LlmProvider, ProviderModel, UpdateProviderModel } from "@paperclipai/shared";
import { LLM_PROVIDERS } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { fetchAnthropicModels } from "../adapters/anthropic-models.js";
import { secretService } from "./secrets.js";

// Known-good models built into the product, kept current by hand until a provider's
// discovery endpoint surfaces them (e.g. new Anthropic snapshots land here first).
export const BUILT_IN_MODELS: Record<LlmProvider, Array<{ modelKey: string; displayName: string; contextWindow: number | null }>> = {
  anthropic: [
    { modelKey: "claude-opus-5", displayName: "Claude Opus 5", contextWindow: 1_000_000 },
    { modelKey: "claude-opus-4-6", displayName: "Claude Opus 4.6", contextWindow: 200_000 },
    { modelKey: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 200_000 },
    { modelKey: "claude-haiku-4-6", displayName: "Claude Haiku 4.6", contextWindow: 200_000 },
    { modelKey: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", contextWindow: 200_000 },
    { modelKey: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", contextWindow: 200_000 },
  ],
  openai: [
    { modelKey: "gpt-4o", displayName: "GPT-4o", contextWindow: 128_000 },
    { modelKey: "gpt-4o-mini", displayName: "GPT-4o mini", contextWindow: 128_000 },
    { modelKey: "gpt-4.1", displayName: "GPT-4.1", contextWindow: 1_000_000 },
    { modelKey: "gpt-4.1-mini", displayName: "GPT-4.1 mini", contextWindow: 1_000_000 },
  ],
  google: [
    { modelKey: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", contextWindow: 1_000_000 },
    { modelKey: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextWindow: 1_000_000 },
  ],
  other: [],
};

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  other: "Other",
};

// Company secret name convention checked to decide whether a provider is "configured".
const PROVIDER_SECRET_NAMES: Record<LlmProvider, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  other: null,
};

const PROVIDER_ENV_VARS: Record<LlmProvider, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  other: null,
};

function toProviderModel(row: typeof providerModels.$inferSelect): ProviderModel {
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider as LlmProvider,
    modelKey: row.modelKey,
    displayName: row.displayName,
    source: row.source as ProviderModel["source"],
    contextWindow: row.contextWindow,
    isActive: row.isActive,
    createdByUserId: row.createdByUserId,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function modelCatalogService(db: Db) {
  const secrets = secretService(db);

  async function resolveProviderApiKey(companyId: string, provider: LlmProvider): Promise<string | null> {
    const secretName = PROVIDER_SECRET_NAMES[provider];
    if (secretName) {
      const secret = await secrets.getByName(companyId, secretName);
      if (secret) {
        try {
          return await secrets.resolveSecretValue(companyId, secret.id, "latest");
        } catch (err) {
          logger.warn({ err, companyId, provider }, "failed to resolve provider secret for model discovery");
        }
      }
    }
    const envVar = PROVIDER_ENV_VARS[provider];
    const fallback = envVar ? process.env[envVar]?.trim() : undefined;
    return fallback && fallback.length > 0 ? fallback : null;
  }

  async function listStored(companyId: string, provider?: LlmProvider): Promise<ProviderModel[]> {
    const rows = await db
      .select()
      .from(providerModels)
      .where(
        provider
          ? and(eq(providerModels.companyId, companyId), eq(providerModels.provider, provider))
          : eq(providerModels.companyId, companyId),
      )
      .orderBy(asc(providerModels.provider), asc(providerModels.displayName));
    return rows.map(toProviderModel);
  }

  async function listCatalog(companyId: string) {
    const stored = await listStored(companyId);
    const byProviderModelKey = new Map(stored.map((row) => [`${row.provider}:${row.modelKey}`, row]));

    const builtIn: ProviderModel[] = [];
    const now = new Date();
    for (const provider of LLM_PROVIDERS) {
      for (const model of BUILT_IN_MODELS[provider]) {
        const key = `${provider}:${model.modelKey}`;
        if (byProviderModelKey.has(key)) continue; // discovered/manual row supersedes the built-in entry
        builtIn.push({
          id: `built-in:${key}`,
          companyId,
          provider,
          modelKey: model.modelKey,
          displayName: model.displayName,
          source: "manual",
          contextWindow: model.contextWindow,
          isActive: true,
          createdByUserId: null,
          lastSeenAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return [...builtIn, ...stored];
  }

  async function providerStatuses(companyId: string) {
    const stored = await listStored(companyId);
    return Promise.all(
      LLM_PROVIDERS.map(async (provider) => {
        const apiKey = await resolveProviderApiKey(companyId, provider);
        const rowsForProvider = stored.filter((row) => row.provider === provider);
        const lastRefreshed = rowsForProvider
          .filter((row) => row.source === "discovered" && row.lastSeenAt)
          .reduce<Date | null>((latest, row) => {
            if (!row.lastSeenAt) return latest;
            return !latest || row.lastSeenAt > latest ? row.lastSeenAt : latest;
          }, null);
        return {
          provider,
          label: PROVIDER_LABELS[provider],
          configured: apiKey !== null,
          secretName: PROVIDER_SECRET_NAMES[provider],
          builtInModelCount: BUILT_IN_MODELS[provider].length,
          discoveredModelCount: rowsForProvider.filter((row) => row.source === "discovered").length,
          manualModelCount: rowsForProvider.filter((row) => row.source === "manual").length,
          lastRefreshedAt: lastRefreshed,
        };
      }),
    );
  }

  async function refreshProvider(companyId: string, provider: LlmProvider): Promise<{ refreshed: boolean; count: number }> {
    if (provider !== "anthropic") {
      // Only Anthropic has a wired discovery fetcher today; other providers rely on
      // their adapter's own live model list (see server/src/adapters/codex-models.ts)
      // or manually-added catalog rows until a fetcher is added here.
      return { refreshed: false, count: 0 };
    }

    const apiKey = await resolveProviderApiKey(companyId, provider);
    if (!apiKey) return { refreshed: false, count: 0 };

    const discovered = await fetchAnthropicModels(apiKey);
    if (discovered.length === 0) return { refreshed: false, count: 0 };

    const now = new Date();
    for (const model of discovered) {
      await db
        .insert(providerModels)
        .values({
          companyId,
          provider,
          modelKey: model.modelKey,
          displayName: model.displayName,
          source: "discovered",
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [providerModels.companyId, providerModels.provider, providerModels.modelKey],
          set: { displayName: model.displayName, lastSeenAt: now, updatedAt: now },
          // Never downgrade a manually-added/edited row to "discovered" bookkeeping fields.
          setWhere: eq(providerModels.source, "discovered"),
        });
    }

    return { refreshed: true, count: discovered.length };
  }

  async function refreshAllCompanies(companyIds: string[]) {
    let refreshedCompanies = 0;
    for (const companyId of companyIds) {
      for (const provider of LLM_PROVIDERS) {
        try {
          const result = await refreshProvider(companyId, provider);
          if (result.refreshed) refreshedCompanies += 1;
        } catch (err) {
          logger.error({ err, companyId, provider }, "model catalog refresh failed");
        }
      }
    }
    return { refreshedCompanies };
  }

  async function createManual(companyId: string, userId: string | null, input: CreateProviderModel): Promise<ProviderModel> {
    const existing = await db
      .select()
      .from(providerModels)
      .where(
        and(
          eq(providerModels.companyId, companyId),
          eq(providerModels.provider, input.provider),
          eq(providerModels.modelKey, input.modelKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) throw conflict("A model with this key already exists for this provider");

    const [row] = await db
      .insert(providerModels)
      .values({
        companyId,
        provider: input.provider,
        modelKey: input.modelKey,
        displayName: input.displayName,
        source: "manual",
        contextWindow: input.contextWindow ?? null,
        createdByUserId: userId,
      })
      .returning();
    return toProviderModel(row);
  }

  async function update(companyId: string, id: string, patch: UpdateProviderModel): Promise<ProviderModel> {
    if (id.startsWith("built-in:")) throw unprocessable("Built-in models cannot be edited");
    const existing = await db
      .select()
      .from(providerModels)
      .where(and(eq(providerModels.id, id), eq(providerModels.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Model not found");

    const [row] = await db
      .update(providerModels)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(providerModels.id, id))
      .returning();
    return toProviderModel(row);
  }

  async function remove(companyId: string, id: string): Promise<void> {
    if (id.startsWith("built-in:")) throw unprocessable("Built-in models cannot be deleted");
    const existing = await db
      .select()
      .from(providerModels)
      .where(and(eq(providerModels.id, id), eq(providerModels.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Model not found");
    await db.delete(providerModels).where(eq(providerModels.id, id));
  }

  return {
    listCatalog,
    providerStatuses,
    refreshProvider,
    refreshAllCompanies,
    createManual,
    update,
    remove,
  };
}
