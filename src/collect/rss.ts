import Parser from "rss-parser";
import type { NewsItem } from "../types.js";

const parser = new Parser();

function hash16(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ input.charCodeAt(input.length - 1 - i), 16777619);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

function feedSource(feedUrl: string): string {
  try {
    return new URL(feedUrl).hostname;
  } catch {
    return feedUrl;
  }
}

export async function collectRss(
  urls: string[],
  poolCap: number,
): Promise<NewsItem[]> {
  const out: NewsItem[] = [];
  for (const feedUrl of urls) {
    try {
      const feed = await parser.parseURL(feedUrl);
      const source = feedSource(feedUrl);
      for (const entry of feed.items ?? []) {
        const link = entry.link ?? feedUrl;
        const title = entry.title ?? "(no title)";
        const author =
          (entry as { creator?: string }).creator ?? entry.author ?? "";
        const snippet =
          entry.contentSnippet?.slice(0, 2000) ??
          entry.content?.slice(0, 2000) ??
          "";
        let publishedAt = Math.floor(Date.now() / 1000);
        if (entry.pubDate) {
          const parsed = Date.parse(entry.pubDate);
          if (!Number.isNaN(parsed)) publishedAt = Math.floor(parsed / 1000);
        } else if (entry.isoDate) {
          const parsed = Date.parse(entry.isoDate);
          if (!Number.isNaN(parsed)) publishedAt = Math.floor(parsed / 1000);
        }
        out.push({
          id: `rss-${hash16(link)}`,
          title,
          url: link,
          source,
          feedType: "rss",
          publishedAt,
          author,
          content: snippet,
          lang: "unknown",
        });
      }
    } catch {
      continue;
    }
  }
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out.slice(0, poolCap);
}
