import { buildProfile } from "../src/personalize.js";
import { filterNews, rankFinal } from "../src/select.js";
import type { Audience, NewsItem } from "../src/types.js";

const now = Math.floor(Date.now() / 1000);
const H = 3600;
const DAY = 24 * H;

const aud: Audience = {
  personalize: true,
  library_appids: [440],
  wishlist_appids: [1940340],
  platforms: ["PC"],
  genres: ["RPG"],
  exclude: ["e스포츠"],
  weights: { library_match: 3.0, wishlist_match: 2.0, recency_hours: 72 },
  batch: { pool: 30, shortlist: 10, final: 2 },
  steam_news_count: 5,
  reddit_feeds: [],
  press_feeds: [],
};

const meta = new Map([
  [440, { name: "Team Fortress 2", genres: ["액션"], keywords: [] }],
  [1940340, { name: "Stardew Valley", genres: ["RPG"], keywords: [] }],
]);

const items: NewsItem[] = [
  {
    id: "steam-440-g1",
    title: "MGE.tf is back!",
    url: "https://example.com/tf2-mge",
    source: "steam",
    feedType: "1",
    appId: 440,
    publishedAt: now - H,
    author: "TF2 Team",
    content: "MGE.tf returns with new maps.",
    lang: "en",
  },
  {
    id: "rss-aaaa",
    title: "Stardew Valley 1.6 패치 정리",
    url: "https://example.com/sdv-16",
    source: "www.reddit.com",
    feedType: "rss",
    publishedAt: now - 2 * H,
    author: "u/farmer",
    content: "Stardew Valley adds a new festival in this update.",
    lang: "unknown",
  },
  {
    id: "rss-excl",
    title: "e스포츠 대회 상금 발표",
    url: "https://example.com/esports",
    source: "www.ign.com",
    feedType: "rss",
    publishedAt: now - 3 * H,
    author: "",
    content: "Tournament prize pool announced.",
    lang: "unknown",
  },
  {
    id: "rss-dup",
    title: "MGE.tf mirror",
    url: "https://example.com/tf2-mge",
    source: "www.reddit.com",
    feedType: "rss",
    publishedAt: now - 4 * H,
    author: "",
    content: "Duplicate of the steam item.",
    lang: "unknown",
  },
  {
    id: "rss-old",
    title: "주말에 할 인디 게임 추천",
    url: "https://example.com/indie-picks",
    source: "www.pcgamer.com",
    feedType: "rss",
    publishedAt: now - 30 * DAY,
    author: "",
    content: "Some old indie roundup.",
    lang: "unknown",
  },
  {
    id: "rss-fresh",
    title: "신작 어드벤처 출시 소식",
    url: "https://example.com/new-adventure",
    source: "www.pcgamer.com",
    feedType: "rss",
    publishedAt: now - 5 * H,
    author: "",
    content: "A fresh adventure game launches today.",
    lang: "unknown",
  },
];

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const profile = buildProfile(aud, meta);
console.log(`profile mode=${profile.mode} titleIndex=${profile.titleIndex.length}`);
if (profile.mode !== "personal") fail("profile.mode should be personal");
if (profile.titleIndex.length !== 2) fail("titleIndex should have 2 entries");

const filtered = filterNews(items, aud);
console.log(`filter: in=${items.length} out=${filtered.length}`);
console.log(`filter ids: ${filtered.map((i) => i.id).join(",")}`);
if (filtered.length !== 4) fail("filter should drop excluded + dup (6 -> 4)");
if (filtered.some((i) => i.id === "rss-excl" || i.id === "rss-dup")) {
  fail("excluded/dup items must be removed");
}

const ranked = rankFinal(filtered, profile, aud);
console.log(`rank final=${ranked.length}`);
for (const r of ranked) {
  console.log(`- ${r.id} score=${r.score} labels=${r.labels.join("+")} title=${r.title}`);
}
if (ranked.length !== 2) fail("final should be 2");
if (ranked[0].id !== "steam-440-g1") fail("top should be the steam library item");
if (ranked[0].score !== 4) fail(`steam item score should be 4, got ${ranked[0].score}`);
if (!ranked[0].labels.includes("library") || !ranked[0].labels.includes("recent")) {
  fail("steam item labels should include library+recent");
}
if (ranked[1].id !== "rss-aaaa") fail("second should be the title-match item");
if (ranked[1].score !== 2.5) fail(`title item score should be 2.5, got ${ranked[1].score}`);
if (!ranked[1].labels.includes("wishlist-title") || !ranked[1].labels.includes("recent")) {
  fail("title item labels should include wishlist-title+recent");
}

console.log("OK check:select");
