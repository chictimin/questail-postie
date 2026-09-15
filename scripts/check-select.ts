import { buildProfile } from "../src/personalize.js";
import { filterNews, rankFinal } from "../src/select.js";
import type { Audience, NewsItem } from "../src/types.js";

const now = Math.floor(Date.now() / 1000);
const H = 3600;
const DAY = 24 * H;

const aud: Audience = {
  library_appids: [440],
  wishlist_appids: [1940340, 1245620],
  platforms: ["PC"],
  genres: ["RPG"],
  exclude: ["e스포츠"],
  weights: { library_match: 3.0, wishlist_match: 2.0, recency_hours: 72 },
  batch: { pool: 30, shortlist: 10, final: 2, extra: 1, sale: 5 },
  source_weights: {
    default: 1.0,
    "reddit.com/r/Games": 1.2,
    "reddit.com/r/indiegames": 0.3,
    "reddit.com/r/GameDeals": 0.5,
    "pcgamer.com": 2.0,
  },
  steam_news_count: 5,
  reddit_feeds: [],
  press_feeds: [],
};

const meta = new Map([
  [440, { name: "Team Fortress 2", genres: ["액션"], keywords: [], platforms: ["Windows", "macOS", "Linux"] }],
  [1940340, { name: "Stardew Valley", genres: ["RPG"], keywords: [], platforms: ["Windows", "macOS", "Linux"] }],
  [1245620, { name: "엘든 링", genres: ["RPG"], keywords: [], platforms: ["Windows"] }],
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
  {
    id: "rss-ko",
    title: "엘든 링 DLC 소식 정리",
    url: "https://example.com/elden-ring-dlc",
    source: "www.example.com",
    feedType: "rss",
    publishedAt: now - 6 * H,
    author: "",
    content: "엘든 링 확장팩의 새로운 지역이 공개됐다.",
    lang: "unknown",
  },
  {
    id: "rss-press",
    title: "Same-hour press review roundup",
    url: "https://www.pcgamer.com/press-review-roundup",
    source: "www.pcgamer.com",
    feedType: "rss",
    publishedAt: now - H,
    author: "",
    content: "Press review of the week.",
    lang: "en",
  },
  {
    id: "rss-promo",
    title: "Same-hour self-promo devlog",
    url: "https://www.reddit.com/r/indiegames/comments/xyz/my_game/",
    source: "www.reddit.com",
    feedType: "rss",
    publishedAt: now - H,
    author: "",
    content: "Check out my game please.",
    lang: "en",
  },
  {
    id: "sale-1940340",
    title: "Stardew Valley 30% 할인 중",
    url: "https://store.steampowered.com/app/1940340/",
    source: "steam-sale",
    sourceName: "Steam 할인",
    feedType: "sale",
    appId: 1940340,
    publishedAt: now,
    author: "",
    content: "Stardew Valley이(가) Steam에서 30% 할인 중이다.",
    lang: "ko",
    sale: { gameName: "Stardew Valley", percent: 30, priceFinal: "₩ 11,200" },
  },
];

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const profile = buildProfile(aud, meta);
console.log(`profile titleIndex=${profile.titleIndex.length} library=${profile.libraryAppIds.join(",")}`);
if (profile.titleIndex.length !== 3) fail("titleIndex should have 3 entries");

const pools = filterNews(items, aud, profile);
console.log(`filter: in=${items.length} personal=${pools.personal.length} general=${pools.general.length} sale=${pools.sale.length}`);
console.log(`personal ids: ${pools.personal.map((i) => i.id).join(",")}`);
console.log(`general ids: ${pools.general.map((i) => i.id).join(",")}`);
console.log(`sale ids: ${pools.sale.map((i) => i.id).join(",")}`);
if (pools.personal.length + pools.general.length + pools.sale.length !== 8) fail("filter should drop excluded + dup (10 -> 8)");
if (pools.personal.some((i) => i.id === "rss-excl" || i.id === "rss-dup")) {
  fail("excluded/dup items must be removed");
}
if (pools.personal.length !== 3) fail("personal pool should be steam-440-g1 + rss-aaaa + rss-ko");
if (pools.general.length !== 4) fail("general pool should be rss-press + rss-promo + rss-old + rss-fresh");
if (!pools.general.some((i) => i.id === "rss-old") || !pools.general.some((i) => i.id === "rss-fresh")) {
  fail("general pool must contain rss-old and rss-fresh");
}
if (pools.sale.length !== 1 || pools.sale[0].id !== "sale-1940340") {
  fail("sale pool should hold only the steam-sale item (out of personal)");
}

const ranked = rankFinal(pools.personal, profile, aud, aud.batch.final);
console.log(`rank final=${ranked.length}`);
for (const r of ranked) {
  console.log(`- ${r.id} score=${r.score} labels=${r.labels.join("+")} title=${r.title}`);
}
if (ranked.length !== 2) fail("final should be 2");
if (ranked[0].id !== "steam-440-g1") fail("top should be the steam library item");
if (ranked[0].score !== 5) fail(`steam item score should be 5 (4 + source default 1.0), got ${ranked[0].score}`);
if (!ranked[0].labels.includes("library") || !ranked[0].labels.includes("recent")) {
  fail("steam item labels should include library+recent");
}
if (!ranked[0].labels.includes("source:community")) {
  fail(`steam item labels should include source:community, got ${ranked[0].labels.join("+")}`);
}
if (ranked[1].id !== "rss-aaaa") fail("second should be the title-match item");
if (ranked[1].score !== 3.5) fail(`title item score should be 3.5 (2.5 + source default 1.0), got ${ranked[1].score}`);
if (!ranked[1].labels.includes("wishlist-title") || !ranked[1].labels.includes("recent")) {
  fail("title item labels should include wishlist-title+recent");
}

const rankedExtra = rankFinal(pools.general, profile, aud, aud.batch.extra);
console.log(`rank extra=${rankedExtra.length}`);
for (const r of rankedExtra) {
  console.log(`- ${r.id} score=${r.score} labels=${r.labels.join("+")} title=${r.title}`);
}
if (rankedExtra.length !== 1) fail("extra should be 1");
if (rankedExtra[0].id !== "rss-press") fail("extra top should be the press item (source weight beats recency-only)");
if (!rankedExtra[0].labels.includes("source:press")) {
  fail(`press item labels should include source:press, got ${rankedExtra[0].labels.join("+")}`);
}

// 동일 시각 발행: 언론이 인디 자가홍보보다 위로 올라와야 한다.
const rankedGeneralWide = rankFinal(pools.general, profile, aud, 4);
const order = rankedGeneralWide.map((r) => r.id);
console.log(`general order: ${order.join(",")}`);
if (order[0] !== "rss-press") fail("press must outrank self-promo at the same hour");
const promoHit = rankedGeneralWide.find((r) => r.id === "rss-promo");
if (!promoHit || !promoHit.labels.includes("source:low")) {
  fail(`promo item labels should include source:low, got ${promoHit?.labels.join("+")}`);
}
if (order.indexOf("rss-press") > order.indexOf("rss-promo")) {
  fail("press must rank above self-promo");
}

// 한글 게임명 매칭: \b가 한글에 안 먹히는 결함 회귀 방지.
// rss-ko는 final=2에 못 들지만 풀 3위로 personal 소속 + wishlist-title 라벨이어야 한다.
const rankedWide = rankFinal(pools.personal, profile, aud, 3);
const koHit = rankedWide.find((r) => r.id === "rss-ko");
if (!koHit) fail("rss-ko should be in personal pool ranking");
if (!koHit.labels.includes("wishlist-title")) {
  fail(`rss-ko labels should include wishlist-title, got ${koHit.labels.join("+")}`);
}
console.log(`ko title match: ${koHit.id} score=${koHit.score} labels=${koHit.labels.join("+")}`);

console.log("OK check:select");
