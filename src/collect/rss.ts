import Parser from "rss-parser";
import type { NewsItem } from "../types.js";

const parser = new Parser();

const FEED_TIMEOUT_MS = 15_000;
const USER_AGENT = "questail-postie/0.1 (+newsletter-agent)";

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

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

/** rss-parser가 버리는 <media:content> 이미지 URL을 원문 XML에서 직접 추출한다. */
function extractMediaImages(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const linkRaw = /<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(body)?.[1];
    if (!linkRaw) continue;
    const link = decodeXmlEntities(linkRaw);
    const tag =
      /<media:content\b[^>]*medium=["']image["'][^>]*>/i.exec(body)?.[0] ??
      /<media:content\b[^>]*>/i.exec(body)?.[0];
    const url = tag ? decodeXmlEntities(/url=["']([^"']+)["']/i.exec(tag)?.[1] ?? "") : "";
    if (link && url) map.set(link, url);
  }
  return map;
}

function feedSource(feedUrl: string): string {
  try {
    return new URL(feedUrl).hostname;
  } catch {
    return feedUrl;
  }
}

async function fetchFeedItems(feedUrl: string): Promise<NewsItem[]> {
  let res: Response;
  try {
    res = await fetch(feedUrl, {
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/rss+xml, application/xml, text/xml, */*",
      },
    });
  } catch {
    return [];
  }
  if (res.status === 429) return [];
  if (!res.ok) return [];
  let xml: string;
  try {
    xml = await res.text();
  } catch {
    return [];
  }
  let feed: { title?: string; items?: Array<Record<string, unknown>> };
  try {
    feed = (await parser.parseString(xml)) as typeof feed;
  } catch {
    return [];
  }
  const source = feedSource(feedUrl);
  const sourceName = feed.title?.trim().slice(0, 60) || source;
  const mediaImages = extractMediaImages(xml);
  const out: NewsItem[] = [];
  for (const raw of feed.items ?? []) {
    const entry = raw as {
      link?: string;
      title?: string;
      creator?: string;
      author?: string;
      contentSnippet?: string;
      content?: string;
      pubDate?: string;
      isoDate?: string;
      enclosure?: { url?: string; type?: string };
    };
    const link = entry.link ?? feedUrl;
    const title = entry.title ?? "(no title)";
    const enclosureUrl = entry.enclosure?.url ?? "";
    const enclosureType = entry.enclosure?.type ?? "";
    const imageUrl =
      enclosureUrl && (enclosureType === "" || enclosureType.startsWith("image/"))
        ? enclosureUrl
        : (mediaImages.get(link) ?? undefined);
    const author = entry.creator ?? entry.author ?? "";
    const snippet =
      entry.contentSnippet?.slice(0, 2000) ??
      entry.content?.slice(0, 2000) ??
      "";
    let publishedAt = Math.floor(Date.now() / 1000);
    const dateStr = entry.pubDate ?? entry.isoDate;
    if (dateStr) {
      const parsed = Date.parse(dateStr);
      if (!Number.isNaN(parsed)) publishedAt = Math.floor(parsed / 1000);
    }
        out.push({
          id: `rss-${hash16(link)}`,
          title,
          url: link,
          source,
          sourceName,
          imageUrl,
      feedType: "rss",
      publishedAt,
      author,
      content: snippet,
      lang: "unknown",
    });
  }
  return out;
}

export async function collectRss(
  urls: string[],
  poolCap: number,
): Promise<NewsItem[]> {
  const settled = await Promise.allSettled(urls.map((u) => fetchFeedItems(u)));
  const out: NewsItem[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") out.push(...r.value);
  }
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out.slice(0, poolCap);
}
