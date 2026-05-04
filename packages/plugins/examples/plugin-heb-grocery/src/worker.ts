import {
  createTokenSession,
  updateTokenSession,
  createSessionFromCookies,
  getWeeklyAdProducts,
  getAccountDetails,
  getOrders,
  getOrder,
  getCart,
  getProductDetails,
  searchProducts,
  persistedQuery,
  addToCart,
  getShoppingLists,
  getShoppingList,
  formatWeeklyAd,
  formatOrderHistory,
  formatCart,
  formatAccountDetails,
  formatProductDetails,
  formatShoppingLists,
  formatShoppingList,
  setStore,
  type HEBSession,
  type RawHistoryOrder,
  type ShoppingList,
  type WeeklyAdProduct,
} from "heb-sdk-unofficial";
import { refreshTokens } from "heb-auth-unofficial";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

type HEBConfig = {
  storeNumber?: string;
  shoppingContext?: "CURBSIDE_PICKUP" | "CURBSIDE_DELIVERY" | "EXPLORE_MY_STORE";
  hebAccessToken?: string;
  hebRefreshToken?: string;
  hebIdToken?: string;
  /** Full raw cookie header string: "sat=X; reese84=Y; incap_ses=Z" */
  hebCookies?: string;
};

type CachedDeals = {
  fetchedAt: string;
  weeklyAdText: string;
  productCount: number;
  products?: WeeklyAdProduct[];
};

type OrderRecord = {
  orderId: string;
  orderDate: string;
  total?: string;
  itemCount?: number;
  /** Abbreviated list of item names for fast pattern matching */
  itemNames: string[];
};

type OrderCache = {
  lastSyncedAt: string;
  orders: OrderRecord[];
  totalPulled: number;
};

type ItemFrequency = {
  name: string;
  count: number;
  lastOrdered: string;
  avgDaysBetweenOrders?: number;
};

type OrderProfile = {
  builtAt: string;
  totalOrders: number;
  dateRange: { from: string; to: string };
  topItems: ItemFrequency[];
  estimatedCadenceDays: number | null;
  staples: string[];      // ordered 3+ times
  occasionals: string[];  // ordered 2 times
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

type CachedTokens = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  savedAt: string;
};

const AUTH_STATE_KEY = { scopeKind: "instance" as const, stateKey: "auth-tokens" };

async function getConfig(ctx: PluginContext): Promise<HEBConfig> {
  const raw = await ctx.config.get();
  return (raw ?? {}) as HEBConfig;
}

async function resolveTokens(cfg: HEBConfig, ctx: PluginContext): Promise<{
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}> {
  const cached = await ctx.state.get(AUTH_STATE_KEY) as CachedTokens | null;
  return {
    accessToken: (cached?.accessToken ?? cfg.hebAccessToken?.trim()) || "",
    refreshToken: cached?.refreshToken ?? cfg.hebRefreshToken?.trim(),
    idToken: cached?.idToken ?? cfg.hebIdToken?.trim(),
  };
}

function buildBearerSession(cfg: HEBConfig, ctx: PluginContext, tokens: {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}): HEBSession {
  if (!tokens.accessToken) {
    throw new Error(
      "HEB bearer token not configured. Set 'hebAccessToken' in the HEB Grocery plugin settings."
    );
  }
  const session = createTokenSession({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    expiresIn: 1800,
  });

  if (tokens.refreshToken) {
    const currentRefreshToken = tokens.refreshToken;
    session.refresh = async () => {
      ctx.logger.info("HEB access token expired, refreshing via refresh token");
      const newTokens = await refreshTokens({ refreshToken: currentRefreshToken });
      updateTokenSession(session, {
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token ?? currentRefreshToken,
        idToken: newTokens.id_token,
        expiresIn: newTokens.expires_in ?? 1800,
      });
      await ctx.state.set(AUTH_STATE_KEY, {
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token ?? currentRefreshToken,
        idToken: newTokens.id_token,
        savedAt: new Date().toISOString(),
      } satisfies CachedTokens);
      ctx.logger.info("HEB tokens refreshed and persisted");
    };
  }

  return session;
}

async function getAuthedBearerSession(ctx: PluginContext): Promise<{ cfg: HEBConfig; session: HEBSession }> {
  const cfg = await getConfig(ctx);
  const tokens = await resolveTokens(cfg, ctx);
  const session = buildBearerSession(cfg, ctx, tokens);
  return { cfg, session };
}

function buildCookieSession(cfg: HEBConfig): HEBSession {
  if (!cfg.hebCookies) {
    throw new Error(
      "HEB cookies not configured. Set 'hebCookies' in the HEB Grocery plugin settings."
    );
  }
  return createSessionFromCookies(cfg.hebCookies);
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Pull all order pages up to maxPages and return flat RawHistoryOrder array. */
async function pullAllOrders(
  session: HEBSession,
  maxPages = 20,
  pageSize = 20
): Promise<RawHistoryOrder[]> {
  const all: RawHistoryOrder[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const resp = await getOrders(session, { page, size: pageSize });
    const batch = resp.pageProps?.orders ?? [];
    all.push(...batch);
    if (!resp.pagination?.hasMore) break;
  }
  return all;
}

/** Build a compact OrderRecord from a RawHistoryOrder. */
function toOrderRecord(raw: RawHistoryOrder): OrderRecord {
  const date =
    (raw as any).orderTimeslot?.date ||
    (raw as any).placedDate ||
    (raw as any).orderDate ||
    new Date().toISOString();
  const items: string[] = ((raw as any).orderItems ?? []).map(
    (i: any) => i.name ?? i.itemName ?? i.productName ?? ""
  ).filter(Boolean);
  return {
    orderId: (raw as any).orderId ?? (raw as any).id ?? "unknown",
    orderDate: date,
    total: (raw as any).orderTotal?.formatted ?? (raw as any).total?.formatted,
    itemCount: items.length || (raw as any).itemCount,
    itemNames: items,
  };
}

/** Analyse cached orders into a profile. */
function buildProfile(orders: OrderRecord[]): OrderProfile {
  if (orders.length === 0) {
    return {
      builtAt: new Date().toISOString(),
      totalOrders: 0,
      dateRange: { from: "", to: "" },
      topItems: [],
      estimatedCadenceDays: null,
      staples: [],
      occasionals: [],
    };
  }

  // Count item frequencies
  const freq = new Map<string, { count: number; dates: string[] }>();
  for (const order of orders) {
    for (const name of order.itemNames) {
      const key = name.toLowerCase().trim();
      if (!key) continue;
      const entry = freq.get(key) ?? { count: 0, dates: [] };
      entry.count++;
      entry.dates.push(order.orderDate);
      freq.set(key, entry);
    }
  }

  // Build display name map: lowercase key → original casing
  const nameMap = new Map<string, string>();
  for (const order of orders) {
    for (const name of order.itemNames) {
      if (!nameMap.has(name.toLowerCase().trim())) {
        nameMap.set(name.toLowerCase().trim(), name);
      }
    }
  }
  const fixedTopItems: ItemFrequency[] = Array.from(freq.entries())
    .map(([key, v]) => {
      const sortedDates = v.dates.sort();
      let avgDays: number | undefined;
      if (v.dates.length >= 2) {
        const spans: number[] = [];
        for (let i = 1; i < sortedDates.length; i++) {
          const ms = Date.parse(sortedDates[i]) - Date.parse(sortedDates[i - 1]);
          if (ms > 0) spans.push(ms / 86400000);
        }
        if (spans.length) avgDays = Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
      }
      return {
        name: nameMap.get(key) ?? key,
        count: v.count,
        lastOrdered: sortedDates[sortedDates.length - 1],
        avgDaysBetweenOrders: avgDays,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  // Estimate cadence (average days between consecutive orders)
  const sortedOrders = [...orders].sort((a, b) =>
    Date.parse(a.orderDate) - Date.parse(b.orderDate)
  );
  let cadence: number | null = null;
  if (sortedOrders.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < sortedOrders.length; i++) {
      const ms = Date.parse(sortedOrders[i].orderDate) - Date.parse(sortedOrders[i - 1].orderDate);
      if (ms > 0) gaps.push(ms / 86400000);
    }
    if (gaps.length) cadence = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }

  const dateRange = {
    from: sortedOrders[0].orderDate,
    to: sortedOrders[sortedOrders.length - 1].orderDate,
  };

  return {
    builtAt: new Date().toISOString(),
    totalOrders: orders.length,
    dateRange,
    topItems: fixedTopItems,
    estimatedCadenceDays: cadence,
    staples: fixedTopItems.filter((i) => i.count >= 3).map((i) => i.name),
    occasionals: fixedTopItems.filter((i) => i.count === 2).map((i) => i.name),
  };
}

/** Format a profile as readable markdown. */
function formatProfile(profile: OrderProfile): string {
  if (profile.totalOrders === 0) return "No order history found yet. Run `heb_sync_orders` first.";

  const lines: string[] = [
    `## Your HEB Profile`,
    `**Orders analysed:** ${profile.totalOrders}`,
    `**Period:** ${profile.dateRange.from.slice(0, 10)} → ${profile.dateRange.to.slice(0, 10)}`,
    profile.estimatedCadenceDays
      ? `**Shopping frequency:** approximately every ${profile.estimatedCadenceDays} days`
      : "",
    "",
    `### Staples (ordered 3+ times)`,
    profile.staples.length ? profile.staples.map((s) => `- ${s}`).join("\n") : "None yet.",
    "",
    `### Occasionally ordered (2 times)`,
    profile.occasionals.length ? profile.occasionals.slice(0, 20).map((s) => `- ${s}`).join("\n") : "None yet.",
    "",
    `### Top 20 items by frequency`,
    profile.topItems.slice(0, 20).map((i) => {
      const cadence = i.avgDaysBetweenOrders ? ` (every ~${i.avgDaysBetweenOrders}d)` : "";
      return `- **${i.name}** — ${i.count}×${cadence}, last: ${i.lastOrdered.slice(0, 10)}`;
    }).join("\n"),
  ];

  return lines.filter((l) => l !== "").join("\n");
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("HEB Grocery plugin starting up");

    // ── Job: daily deals refresh ─────────────────────────────────────────────
    ctx.jobs.register("daily-deals-refresh", async (_jobCtx) => {
      ctx.logger.info("Running daily HEB deals refresh");
      try {
        const { cfg, session } = await getAuthedBearerSession(ctx);
        if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
        const ad = await getWeeklyAdProducts(session, { limit: 100 });
        const text = formatWeeklyAd(ad);
        const cached: CachedDeals = {
          fetchedAt: new Date().toISOString(),
          weeklyAdText: text,
          productCount: ad.products.length,
          products: ad.products,
        };
        await ctx.state.set({ scopeKind: "instance", stateKey: "weekly-ad" }, cached);
        ctx.logger.info(`Cached ${ad.products.length} weekly ad products`);
      } catch (err) {
        ctx.logger.error("Failed to refresh HEB deals", { error: summarizeError(err) });
        throw err;
      }
    });

    // ── Job: sync order history ───────────────────────────────────────────────
    ctx.jobs.register("sync-order-history", async (_jobCtx) => {
      ctx.logger.info("Syncing HEB order history");
      try {
        const { cfg, session } = await getAuthedBearerSession(ctx);
        const existing = (await ctx.state.get({
          scopeKind: "instance",
          stateKey: "order-cache",
        })) as OrderCache | null;

        const rawOrders = await pullAllOrders(session, 20, 20);
        const records = rawOrders.map(toOrderRecord);

        // Merge with existing — deduplicate by orderId
        const merged = new Map<string, OrderRecord>();
        for (const r of (existing?.orders ?? [])) merged.set(r.orderId, r);
        for (const r of records) merged.set(r.orderId, r);
        const allOrders = Array.from(merged.values());

        const cache: OrderCache = {
          lastSyncedAt: new Date().toISOString(),
          orders: allOrders,
          totalPulled: allOrders.length,
        };
        await ctx.state.set({ scopeKind: "instance", stateKey: "order-cache" }, cache);

        // Rebuild profile
        const profile = buildProfile(allOrders);
        await ctx.state.set({ scopeKind: "instance", stateKey: "order-profile" }, profile);

        ctx.logger.info(`Order cache updated: ${allOrders.length} orders, ${profile.staples.length} staples identified`);
      } catch (err) {
        ctx.logger.error("Failed to sync order history", { error: summarizeError(err) });
        throw err;
      }
    });

    // ── Tool: search products ─────────────────────────────────────────────────
    ctx.tools.register(
      "heb_search_products",
      {
        displayName: "HEB: Search Products",
        description: "Search for products at H-E-B. Returns matching products with names, prices, and availability.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search term, e.g. 'coffee' or 'organic milk'" },
            limit: { type: "number", description: "Max results (default 10, max 50)", default: 10 },
          },
          required: ["query"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { query, limit = 10 } = params as { query: string; limit?: number };
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const results = await searchProducts(session, query, { limit: Math.min(limit, 50) });
          if (results.products.length === 0) return { content: `No products found for "${query}".`, data: { query, totalCount: 0, products: [] } };
          const lines = results.products.map((p, i) => {
            const price = p.price ? p.price.formatted : "price unavailable";
            const brand = p.brand ? ` (${p.brand})` : "";
            return `${i + 1}. **${p.name}**${brand} — ${price} | ID: \`${p.productId}\``;
          });
          return { content: `**HEB Product Search: "${query}"** (${results.totalCount} total)\n\n${lines.join("\n")}`, data: { query, totalCount: results.totalCount, hasNextPage: results.hasNextPage, products: results.products } };
        } catch (err) {
          return { error: `Error searching HEB products: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: weekly ad ───────────────────────────────────────────────────────
    ctx.tools.register(
      "heb_get_weekly_ad",
      {
        displayName: "HEB: Get Weekly Ad",
        description: "Returns the current weekly ad deals and sale items.",
        parametersSchema: {
          type: "object",
          properties: {
            category: { type: "string", description: "Optional category filter ID." },
            limit: { type: "number", description: "Max products to return (default 20)", default: 20 },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { category, limit = 20 } = (params ?? {}) as { category?: string; limit?: number };
        try {
          if (!category) {
            const cached = await ctx.state.get({ scopeKind: "instance", stateKey: "weekly-ad" }) as CachedDeals | null;
            if (cached) {
              const ageHours = Math.round((Date.now() - new Date(cached.fetchedAt).getTime()) / 3600000);
              return { content: `**HEB Weekly Ad** (cached ${ageHours}h ago, ${cached.productCount} items)\n\n${cached.weeklyAdText}`, data: { cached: true, fetchedAt: cached.fetchedAt, ageHours, totalCount: cached.productCount, products: cached.products ?? [] } };
            }
          }
          const { cfg, session } = await getAuthedBearerSession(ctx);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const ad = await getWeeklyAdProducts(session, { limit: Math.min(limit, 100), ...(category ? { category } : {}) });
          return { content: formatWeeklyAd(ad), data: { cached: false, totalCount: ad.totalCount, validFrom: ad.validFrom, validTo: ad.validTo, storeCode: ad.storeCode, categories: ad.categories, products: ad.products } };
        } catch (err) {
          return { error: `Error fetching HEB weekly ad: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: coupon report ────────────────────────────────────────────────────
    ctx.tools.register(
      "heb_get_coupon_report",
      {
        displayName: "HEB: Get Coupon Report",
        description: "Returns available HEB digital coupons. NOTE: Auto-clipping is not yet supported by the SDK — this reports available coupons for manual or future automated clipping.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional search term to filter coupons." },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { query } = (params ?? {}) as { query?: string };
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          const variables: Record<string, unknown> = { first: 50, sortBy: "RELEVANCE" };
          if (query) variables["searchTerm"] = query;
          let result: unknown;
          try {
            result = await persistedQuery(session, "searchCouponsV2", variables);
          } catch {
            result = await persistedQuery(session, "couponSummary", {});
          }
          const header = query ? `**HEB Coupons matching "${query}"**` : "**HEB Available Coupons**";
          return { content: `${header}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``, data: result };
        } catch (err) {
          return { error: `Error fetching HEB coupons: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: get cart ────────────────────────────────────────────────────────
    ctx.tools.register(
      "heb_get_cart",
      {
        displayName: "HEB: Get Cart",
        description: "Returns the current items in the HEB cart.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const cart = await getCart(session);
          return { content: formatCart(cart), data: cart };
        } catch (err) {
          return { error: `Error fetching HEB cart: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: add to cart ─────────────────────────────────────────────────────
    ctx.tools.register(
      "heb_add_to_cart",
      {
        displayName: "HEB: Add to Cart",
        description: "Adds a product to the HEB cart by product ID and quantity.",
        parametersSchema: {
          type: "object",
          properties: {
            productId: { type: "string", description: "HEB product ID" },
            quantity: { type: "number", description: "Quantity to set" },
          },
          required: ["productId", "quantity"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { productId, quantity } = params as { productId: string; quantity: number };
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const product = await getProductDetails(session, productId);
          const skuId = product.skuId ?? productId;
          const result = await addToCart(session, productId, skuId, quantity);
          return { content: `Added ${quantity}× **${product.name}** to cart. Cart now has ${result.cart?.itemCount ?? "?"} item(s).`, data: { productId, skuId, name: product.name, quantity, cartItemCount: result.cart?.itemCount ?? null, cartItems: result.cart?.items ?? [] } };
        } catch (err) {
          return { error: `Error adding to HEB cart: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: order history ───────────────────────────────────────────────────
    ctx.tools.register(
      "heb_get_order_history",
      {
        displayName: "HEB: Get Order History",
        description: "Returns recent HEB orders. Reads from local cache when available for speed.",
        parametersSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Number of recent orders to return (default 10)", default: 10 },
            fromCache: { type: "boolean", description: "Read from local cache (faster). Default true.", default: true },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { limit = 10, fromCache = true } = (params ?? {}) as { limit?: number; fromCache?: boolean };
        try {
          if (fromCache) {
            const cache = await ctx.state.get({ scopeKind: "instance", stateKey: "order-cache" }) as OrderCache | null;
            if (cache?.orders?.length) {
              const sorted = [...cache.orders].sort((a, b) => Date.parse(b.orderDate) - Date.parse(a.orderDate));
              const slice = sorted.slice(0, limit);
              const lines = slice.map((o, i) => {
                const items = o.itemNames.slice(0, 5).join(", ") + (o.itemNames.length > 5 ? ` +${o.itemNames.length - 5} more` : "");
                return `${i + 1}. **${o.orderDate.slice(0, 10)}** — ${o.itemCount ?? o.itemNames.length} items${o.total ? `, ${o.total}` : ""}${items ? `\n   ${items}` : ""}`;
              });
              return { content: `**Recent HEB Orders** (from cache, ${cache.orders.length} total)\n\n${lines.join("\n")}`, data: { source: "cache", totalCached: cache.orders.length, orders: slice } };
            }
          }
          const { cfg, session } = await getAuthedBearerSession(ctx);
          const response = await getOrders(session, { size: Math.min(limit, 20) });
          const orders: RawHistoryOrder[] = response.pageProps?.orders ?? [];
          return { content: formatOrderHistory(orders), data: { source: "live", orders } };
        } catch (err) {
          return { error: `Error fetching HEB order history: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: sync orders ─────────────────────────────────────────────────────
    ctx.tools.register(
      "heb_sync_orders",
      {
        displayName: "HEB: Sync Order History",
        description: "Pulls full order history from HEB, updates the local cache, and rebuilds the taste profile. Run this on first setup and periodically to keep data fresh.",
        parametersSchema: {
          type: "object",
          properties: {
            maxPages: { type: "number", description: "Max pages to pull (20 orders/page, default 20 = up to 400 orders)", default: 20 },
          },
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { maxPages = 20 } = (params ?? {}) as { maxPages?: number };
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          const existing = await ctx.state.get({ scopeKind: "instance", stateKey: "order-cache" }) as OrderCache | null;
          const rawOrders = await pullAllOrders(session, maxPages, 20);
          const records = rawOrders.map(toOrderRecord);

          const merged = new Map<string, OrderRecord>();
          for (const r of (existing?.orders ?? [])) merged.set(r.orderId, r);
          for (const r of records) merged.set(r.orderId, r);
          const allOrders = Array.from(merged.values());

          const cache: OrderCache = {
            lastSyncedAt: new Date().toISOString(),
            orders: allOrders,
            totalPulled: allOrders.length,
          };
          await ctx.state.set({ scopeKind: "instance", stateKey: "order-cache" }, cache);

          const profile = buildProfile(allOrders);
          await ctx.state.set({ scopeKind: "instance", stateKey: "order-profile" }, profile);

          return {
            content: [
              `**Order sync complete!**`,
              `- ${allOrders.length} orders in local cache`,
              `- ${profile.staples.length} staples identified`,
              `- ${profile.occasionals.length} occasionally ordered items`,
              profile.estimatedCadenceDays ? `- You shop approximately every ${profile.estimatedCadenceDays} days` : "",
              "",
              "Run `heb_get_order_profile` to see your full taste profile.",
            ].filter(Boolean).join("\n"),
            data: {
              totalOrders: allOrders.length,
              staplesCount: profile.staples.length,
              occasionalsCount: profile.occasionals.length,
              estimatedCadenceDays: profile.estimatedCadenceDays,
              staples: profile.staples,
              occasionals: profile.occasionals,
            },
          };
        } catch (err) {
          return { error: `Error syncing HEB orders: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: order profile ───────────────────────────────────────────────────
    ctx.tools.register(
      "heb_get_order_profile",
      {
        displayName: "HEB: Get Order Profile",
        description: "Returns your taste/habit profile built from order history — staples, frequency, top items, and shopping cadence.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const profile = await ctx.state.get({ scopeKind: "instance", stateKey: "order-profile" }) as OrderProfile | null;
          if (!profile) {
            return { content: "No profile built yet. Run `heb_sync_orders` first to pull your order history." };
          }
          return { content: formatProfile(profile), data: profile };
        } catch (err) {
          return { error: `Error fetching order profile: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: deal scout ──────────────────────────────────────────────────────
    ctx.tools.register(
      "heb_scout_deals",
      {
        displayName: "HEB: Scout Deals",
        description: "Compares the current weekly ad against your taste profile and returns personalised deal suggestions — including items you buy regularly and new items you might like.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);

          const [adResult, profile] = await Promise.all([
            getWeeklyAdProducts(session, { limit: 100 }),
            ctx.state.get({ scopeKind: "instance", stateKey: "order-profile" }) as Promise<OrderProfile | null>,
          ]);

          const adProducts = adResult.products;
          if (adProducts.length === 0) return { content: "No weekly ad products found.", data: { adProductCount: 0, yourStaplesOnSale: [], mightLike: [], other: [] } };
          if (!profile || profile.totalOrders === 0) {
            return { content: `Weekly ad has ${adProducts.length} items but no profile built yet. Run \`heb_sync_orders\` first for personalised suggestions.\n\n${formatWeeklyAd(adResult)}`, data: { adProductCount: adProducts.length, profileOrders: 0, yourStaplesOnSale: [], mightLike: [], other: adProducts } };
          }

          const staplesSet = new Set(profile.staples.map((s) => s.toLowerCase()));
          const allKnownSet = new Set([...profile.staples, ...profile.occasionals].map((s) => s.toLowerCase()));

          const yourStaplesOnSale: typeof adProducts = [];
          const mightLike: typeof adProducts = [];
          const other: typeof adProducts = [];

          for (const p of adProducts) {
            const nameLower = p.name.toLowerCase();
            if (staplesSet.has(nameLower) || [...staplesSet].some((s) => nameLower.includes(s) || s.includes(nameLower.split(" ")[0]))) {
              yourStaplesOnSale.push(p);
            } else if (allKnownSet.has(nameLower) || [...allKnownSet].some((s) => nameLower.includes(s.split(" ")[0]))) {
              mightLike.push(p);
            } else {
              other.push(p);
            }
          }

          const fmt = (p: (typeof adProducts)[0]) =>
            `- **${p.name}**${p.priceText ? ` — ${p.priceText}` : ""}${p.saleStory ? ` _(${p.saleStory})_` : ""}`;

          const lines = [
            `## 🛒 HEB Deal Scout`,
            `_${adProducts.length} deals this week · profile based on ${profile.totalOrders} orders_`,
            "",
          ];

          if (yourStaplesOnSale.length) {
            lines.push(`### ✅ Your staples on sale (${yourStaplesOnSale.length})`);
            lines.push(...yourStaplesOnSale.map(fmt));
            lines.push("");
          }
          if (mightLike.length) {
            lines.push(`### 🤔 Things you buy occasionally, on sale (${mightLike.length})`);
            lines.push(...mightLike.slice(0, 10).map(fmt));
            lines.push("");
          }
          if (other.length) {
            lines.push(`### 🆕 Other deals you might want to explore (${Math.min(other.length, 15)} of ${other.length})`);
            lines.push(...other.slice(0, 15).map(fmt));
          }

          return { content: lines.join("\n"), data: { adProductCount: adProducts.length, profileOrders: profile.totalOrders, yourStaplesOnSale, mightLike, other } };
        } catch (err) {
          return { error: `Error scouting deals: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: restock check ───────────────────────────────────────────────────
    ctx.tools.register(
      "heb_restock_check",
      {
        displayName: "HEB: Restock Check",
        description: "Checks your staples against typical purchase intervals and flags items that are likely overdue for restocking.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const profile = await ctx.state.get({ scopeKind: "instance", stateKey: "order-profile" }) as OrderProfile | null;
          if (!profile || profile.totalOrders === 0) {
            return { content: "No profile yet. Run `heb_sync_orders` first." };
          }

          const now = Date.now();
          const overdue: string[] = [];
          const comingSoon: string[] = [];
          const stocked: string[] = [];
          type RestockItem = { name: string; lastOrdered: string; daysSinceLast: number; avgDaysBetweenOrders: number; daysUntilReorder?: number };
          const overdueData: RestockItem[] = [];
          const comingSoonData: RestockItem[] = [];
          const stockedData: RestockItem[] = [];

          for (const item of profile.topItems) {
            if (!item.avgDaysBetweenOrders || !item.lastOrdered) continue;
            const daysSinceLast = (now - Date.parse(item.lastOrdered)) / 86400000;
            const overdueThreshold = item.avgDaysBetweenOrders * 1.2;
            const soonThreshold = item.avgDaysBetweenOrders * 0.9;
            if (daysSinceLast > overdueThreshold) {
              overdue.push(`- **${item.name}** — last ordered ${Math.round(daysSinceLast)}d ago (usual: every ${item.avgDaysBetweenOrders}d)`);
              overdueData.push({ name: item.name, lastOrdered: item.lastOrdered, daysSinceLast: Math.round(daysSinceLast), avgDaysBetweenOrders: item.avgDaysBetweenOrders });
            } else if (daysSinceLast > soonThreshold) {
              comingSoon.push(`- **${item.name}** — ${Math.round(item.avgDaysBetweenOrders - daysSinceLast)}d until typical reorder`);
              comingSoonData.push({ name: item.name, lastOrdered: item.lastOrdered, daysSinceLast: Math.round(daysSinceLast), avgDaysBetweenOrders: item.avgDaysBetweenOrders, daysUntilReorder: Math.round(item.avgDaysBetweenOrders - daysSinceLast) });
            } else {
              stocked.push(item.name);
              stockedData.push({ name: item.name, lastOrdered: item.lastOrdered, daysSinceLast: Math.round(daysSinceLast), avgDaysBetweenOrders: item.avgDaysBetweenOrders });
            }
          }

          if (overdue.length === 0 && comingSoon.length === 0) {
            return { content: "Everything looks stocked up — no items appear overdue based on your typical purchase patterns.", data: { overdue: [], comingSoon: [], stocked: stockedData } };
          }

          const lines = ["## 🔄 Restock Check", ""];
          if (overdue.length) {
            lines.push(`### ⚠️ Likely overdue (${overdue.length} items)`);
            lines.push(...overdue);
            lines.push("");
          }
          if (comingSoon.length) {
            lines.push(`### 📅 Coming up soon (${comingSoon.length} items)`);
            lines.push(...comingSoon);
          }
          return { content: lines.join("\n"), data: { overdue: overdueData, comingSoon: comingSoonData, stocked: stockedData } };
        } catch (err) {
          return { error: `Error running restock check: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: get account ─────────────────────────────────────────────────────
    ctx.tools.register(
      "heb_get_account",
      {
        displayName: "HEB: Get Account Details",
        description: "Returns HEB account profile, loyalty number, and saved addresses.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          const account = await getAccountDetails(session);
          return { content: formatAccountDetails(account), data: account };
        } catch (err) {
          return { error: `Error fetching HEB account: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: product details ─────────────────────────────────────────────────
    ctx.tools.register(
      "heb_product_details",
      {
        displayName: "HEB: Get Product Details",
        description: "Returns full details for a specific HEB product including nutrition info.",
        parametersSchema: {
          type: "object",
          properties: {
            productId: { type: "string", description: "HEB product ID" },
          },
          required: ["productId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { productId } = params as { productId: string };
        try {
          const { cfg, session } = await getAuthedBearerSession(ctx);
          if (cfg.storeNumber) await setStore(session, cfg.storeNumber);
          const product = await getProductDetails(session, productId);
          return { content: formatProductDetails(product), data: product };
        } catch (err) {
          return { error: `Error fetching HEB product details: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: get shopping lists ──────────────────────────────────────────────
    ctx.tools.register(
      "heb_get_shopping_lists",
      {
        displayName: "HEB: Get Shopping Lists",
        description: "Returns all HEB shopping lists on the account.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        try {
          const cfg = await getConfig(ctx);
          const session = buildCookieSession(cfg);
          const result = await getShoppingLists(session);
          if (result.lists.length === 0) return { content: "No shopping lists found on this account.", data: { lists: [], pageInfo: result.pageInfo } };
          return { content: formatShoppingLists(result.lists), data: result };
        } catch (err) {
          return { error: `Error fetching shopping lists: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: get shopping list items ──────────────────────────────────────────
    ctx.tools.register(
      "heb_get_shopping_list_items",
      {
        displayName: "HEB: Get Shopping List Items",
        description: "Returns all items in a specific HEB shopping list. Use this to see what products are in a list, including product IDs, names, brands, prices, and quantities.",
        parametersSchema: {
          type: "object",
          properties: {
            listId: { type: "string", description: "Shopping list ID (get from heb_get_shopping_lists)" },
          },
          required: ["listId"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { listId } = params as { listId: string };
        try {
          const cfg = await getConfig(ctx);
          const session = buildCookieSession(cfg);
          const list = await getShoppingList(session, listId);
          if (list.items.length === 0) return { content: `Shopping list "${list.name}" is empty.`, data: { id: list.id, name: list.name, items: [] } };
          return { content: formatShoppingList(list), data: list };
        } catch (err) {
          return { error: `Error fetching shopping list items: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: create shopping list ────────────────────────────────────────────
    ctx.tools.register(
      "heb_create_shopping_list",
      {
        displayName: "HEB: Create Shopping List",
        description: "Creates a new named shopping list on the HEB account.",
        parametersSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name for the new shopping list, e.g. 'Staples' or 'Weekly Essentials'" },
          },
          required: ["name"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { name } = params as { name: string };
        try {
          const cfg = await getConfig(ctx);
          const session = buildCookieSession(cfg);
          // Use raw persisted query — no SDK wrapper yet
          const result = await persistedQuery(session, "CreateShoppingListV2", { name });
          return { content: `Shopping list **"${name}"** created.\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``, data: result };
        } catch (err) {
          return { error: `Error creating shopping list: ${summarizeError(err)}` };
        }
      }
    );

    // ── Tool: add items to shopping list ──────────────────────────────────────
    ctx.tools.register(
      "heb_add_to_shopping_list",
      {
        displayName: "HEB: Add Items to Shopping List",
        description: "Adds one or more products to an existing HEB shopping list by list ID.",
        parametersSchema: {
          type: "object",
          properties: {
            listId: { type: "string", description: "Shopping list ID (get from heb_get_shopping_lists)" },
            productIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of HEB product IDs to add",
            },
          },
          required: ["listId", "productIds"],
        },
      },
      async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
        const { listId, productIds } = params as { listId: string; productIds: string[] };
        try {
          const cfg = await getConfig(ctx);
          const session = buildCookieSession(cfg);
          const items = productIds.map((id) => ({ productId: id, quantity: 1 }));
          const result = await persistedQuery(session, "AddShoppingListItemsV2", { listId, items });
          return { content: `Added ${productIds.length} item(s) to shopping list.\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``, data: { listId, addedProductIds: productIds, result } };
        } catch (err) {
          return { error: `Error adding to shopping list: ${summarizeError(err)}` };
        }
      }
    );

    // ── Data endpoints for UI ────────────────────────────────────────────────

    ctx.data.register("cached-deals", async () => {
      const cached = await ctx.state.get({ scopeKind: "instance", stateKey: "weekly-ad" }) as CachedDeals | null;
      return cached ?? { fetchedAt: null, weeklyAdText: "No data yet.", productCount: 0 };
    });

    ctx.data.register("config-status", async () => {
      const cfg = await getConfig(ctx);
      return {
        hasBearerToken: Boolean(cfg.hebAccessToken?.trim()),
        hasCookieAuth: Boolean(cfg.hebCookies),
        storeNumber: cfg.storeNumber ?? null,
        shoppingContext: cfg.shoppingContext ?? "EXPLORE_MY_STORE",
      };
    });

    ctx.data.register("order-profile", async () => {
      const profile = await ctx.state.get({ scopeKind: "instance", stateKey: "order-profile" }) as OrderProfile | null;
      const cache = await ctx.state.get({ scopeKind: "instance", stateKey: "order-cache" }) as OrderCache | null;
      return {
        profile: profile ?? null,
        cacheSize: cache?.orders.length ?? 0,
        lastSynced: cache?.lastSyncedAt ?? null,
      };
    });

    ctx.logger.info("HEB Grocery plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "HEB Grocery plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
