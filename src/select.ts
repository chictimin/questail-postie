import type { Audience, NewsItem, PersonalProfile, ScoredItem } from "./types.js";

function isRecent(publishedAt: number, recencyHours: number, nowSec: number): boolean {
  return nowSec - publishedAt <= recencyHours * 3600;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function filterNews(items: NewsItem[], aud: Audience): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    if (aud.exclude.some((kw) => kw.length > 0 && item.title.includes(kw))) {
      continue;
    }
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out.slice(0, aud.batch.pool);
}

export function rankFinal(
  items: NewsItem[],
  profile: PersonalProfile,
  aud: Audience,
): ScoredItem[] {
  const library = new Set(profile.libraryAppIds);
  const wishlist = new Set(profile.wishlistAppids);
  const nowSec = Math.floor(Date.now() / 1000);
  const patterns = profile.titleIndex.flatMap((entry) =>
    entry.names
      .filter((n) => n.length >= 4)
      .map((n) => ({
        re: new RegExp(`\\b${escapeRegExp(n)}\\b`),
        list: entry.list,
      })),
  );
  const scored: ScoredItem[] = items.map((item) => {
    let score = 0;
    const labels = new Set<string>();
    if (item.appId !== undefined && library.has(item.appId)) {
      score += profile.weights.libraryMatch;
      labels.add("library");
    }
    if (item.appId !== undefined && wishlist.has(item.appId)) {
      score += profile.weights.wishlistMatch;
      labels.add("wishlist");
    }
    const hay = `${item.title}\n${item.content}`.toLowerCase();
    const titleKinds = new Set<"library" | "wishlist">();
    for (const p of patterns) {
      if (p.re.test(hay)) titleKinds.add(p.list);
    }
    for (const kind of titleKinds) {
      score += profile.weights.titleMatch;
      labels.add(kind === "library" ? "library-title" : "wishlist-title");
    }
    if (isRecent(item.publishedAt, profile.recencyHours, nowSec)) {
      score += profile.weights.recency;
      labels.add("recent");
    }
    if (labels.size === 0) labels.add("unranked");
    return { ...item, score, labels: [...labels] };
  });
  scored.sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
  return scored.slice(0, aud.batch.final);
}
