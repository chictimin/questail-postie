import type { Audience, NewsItem, ScoredItem } from "./types.js";

interface AppMetaInfo {
  name: string;
  genres: string[];
  keywords: string[];
}

const RECENCY_BONUS = 1.0;

function isRecent(publishedAt: number, recencyHours: number, nowSec: number): boolean {
  return nowSec - publishedAt <= recencyHours * 3600;
}

export function selectNews(
  items: NewsItem[],
  aud: Audience,
  _meta: Map<number, AppMetaInfo>,
): { shortlist: ScoredItem[]; final: ScoredItem[] } {
  void _meta;
  const seen = new Set<string>();
  const pool: NewsItem[] = [];
  for (const item of items) {
    if (aud.exclude.some((kw) => kw.length > 0 && item.title.includes(kw))) {
      continue;
    }
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    pool.push(item);
  }
  pool.sort((a, b) => b.publishedAt - a.publishedAt);
  const capped = pool.slice(0, aud.batch.pool);

  if (!aud.personalize) {
    const flat: ScoredItem[] = capped.map((item) => ({
      ...item,
      score: 0,
      labels: ["general"],
    }));
    return {
      shortlist: flat.slice(0, aud.batch.shortlist),
      final: flat.slice(0, aud.batch.final),
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const library = new Set(aud.library_appids);
  const wishlist = new Set(aud.wishlist_appids);

  const scored: ScoredItem[] = capped.map((item) => {
    let score = 0;
    const labels: string[] = [];
    if (item.appId !== undefined && library.has(item.appId)) {
      score += aud.weights.library_match;
      labels.push("library");
    }
    if (item.appId !== undefined && wishlist.has(item.appId)) {
      score += aud.weights.wishlist_match;
      labels.push("wishlist");
    }
    if (isRecent(item.publishedAt, aud.weights.recency_hours, nowSec)) {
      score += RECENCY_BONUS;
      labels.push("recent");
    }
    if (labels.length === 0) labels.push("general");
    return { ...item, score, labels };
  });

  scored.sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
  return {
    shortlist: scored.slice(0, aud.batch.shortlist),
    final: scored.slice(0, aud.batch.final),
  };
}
