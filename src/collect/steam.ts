import type { NewsItem } from "../types.js";

interface SteamNewsItemRaw {
  gid: string;
  title: string;
  url: string;
  contents: string;
  author: string;
  feed_type: number;
  date: number;
}

interface SteamNewsResponse {
  appnews?: {
    newsitems?: SteamNewsItemRaw[];
  };
}

interface AppMeta {
  name: string;
  genres: string[];
  keywords: string[];
  platforms: string[];
}

const FETCH_TIMEOUT_MS = 15_000;

const metaCache = new Map<number, AppMeta>();

function toNewsItem(appId: number, raw: SteamNewsItemRaw): NewsItem {
  return {
    id: `steam-${appId}-${raw.gid}`,
    title: raw.title ?? "",
    url: raw.url ?? "",
    source: "steam",
    sourceName: "Steam 공지",
    feedType: String(raw.feed_type ?? ""),
    appId,
    publishedAt: Number(raw.date ?? 0),
    author: raw.author ?? "",
    content: raw.contents ?? "",
    lang: "en",
  };
}

export async function collectSteamNews(
  appIds: number[],
  countPerApp: number,
): Promise<NewsItem[]> {
  const out: NewsItem[] = [];
  for (const appId of appIds) {
    const endpoint = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=${countPerApp}&format=json`;
    try {
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as SteamNewsResponse;
      const items = data.appnews?.newsitems ?? [];
      for (const raw of items) {
        if (!raw.gid || !raw.url || !raw.title) continue;
        out.push(toNewsItem(appId, raw));
      }
    } catch {
      continue;
    }
  }
  return out;
}

export async function fetchAppMeta(appId: number): Promise<AppMeta> {
  const cached = metaCache.get(appId);
  if (cached) return cached;
  const fallback: AppMeta = { name: String(appId), genres: [], keywords: [], platforms: [] };
  try {
    const endpoint = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=korean`;
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      metaCache.set(appId, fallback);
      return fallback;
    }
    const data = (await res.json()) as Record<
      string,
      { success: boolean; data?: { name?: string; genres?: Array<{ description?: string }>; categories?: Array<{ description?: string }>; platforms?: { windows?: boolean; mac?: boolean; linux?: boolean } } }
    >;
    const entry = data[String(appId)];
    if (!entry?.success || !entry.data) {
      metaCache.set(appId, fallback);
      return fallback;
    }
    const plats = entry.data.platforms ?? {};
    const meta: AppMeta = {
      name: entry.data.name ?? String(appId),
      genres: (entry.data.genres ?? [])
        .map((g) => g.description ?? "")
        .filter((s) => s.length > 0),
      keywords: (entry.data.categories ?? [])
        .map((c) => c.description ?? "")
        .filter((s) => s.length > 0),
      platforms: [
        plats.windows ? "Windows" : "",
        plats.mac ? "macOS" : "",
        plats.linux ? "Linux" : "",
      ].filter((s) => s.length > 0),
    };
    metaCache.set(appId, meta);
    return meta;
  } catch {
    metaCache.set(appId, fallback);
    return fallback;
  }
}
