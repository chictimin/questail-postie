import type { Audience, NewsItem, PersonalProfile, ScoredItem } from "./types.js";

function isRecent(publishedAt: number, recencyHours: number, nowSec: number): boolean {
  return nowSec - publishedAt <= recencyHours * 3600;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface TitlePattern {
  re: RegExp;
  list: "library" | "wishlist";
}

function buildTitlePatterns(profile: PersonalProfile): TitlePattern[] {
  return profile.titleIndex.flatMap((entry) =>
    entry.names
      .filter((n) => n.length >= 4)
      .map((n) => {
        // \b는 ASCII \w 기준이라 한글 앞뒤에 경계가 생기지 않는다.
        // 한글이 든 패턴은 \b 없이 부분 문자열 대조, ASCII만은 기존 유지.
        const hasHangul = /[가-힣]/.test(n);
        return {
          re: hasHangul ? new RegExp(escapeRegExp(n)) : new RegExp(`\\b${escapeRegExp(n)}\\b`),
          list: entry.list,
        };
      }),
  );
}

/** 소스 가중치 조회. url+source에 부분 매칭, 가장 긴 키 우선, 없으면 default. */
export function lookupSourceWeight(
  item: NewsItem,
  weights: Record<string, number>,
): { weight: number; grade: string } {
  const hay = `${item.url} ${item.source ?? ""}`.toLowerCase();
  let best = "";
  for (const key of Object.keys(weights)) {
    if (key === "default") continue;
    if (key.length > best.length && hay.includes(key.toLowerCase())) best = key;
  }
  const weight = best ? (weights[best] ?? weights.default ?? 0) : (weights.default ?? 0);
  const grade = weight >= 1.4 ? "press" : weight >= 0.8 ? "community" : "low";
  return { weight, grade };
}

/** 개인화 풀 소속 여부: appId가 라이브러리·위시에 매칭되거나 제목 매칭이 걸리는 항목. */
export function isPersonalItem(item: NewsItem, profile: PersonalProfile): boolean {
  if (item.appId !== undefined) {
    if (profile.libraryAppIds.includes(item.appId)) return true;
    if (profile.wishlistAppids.includes(item.appId)) return true;
  }
  const hay = `${item.title}\n${item.content}`.toLowerCase();
  return buildTitlePatterns(profile).some((p) => p.re.test(hay));
}

export interface FilterPools {
  sale: NewsItem[];
  personal: NewsItem[];
  general: NewsItem[];
}

/**
 * 예선. 제외어·URL 중복 제거는 공통으로 하고, 그 뒤 세 풀로 가른다.
 * sale(source==="steam-sale")을 먼저 떼어내 개인화 풀에 들어가지 않게 한다.
 * 각 풀을 최신순 정렬 후 따로 상한을 건다 (sale은 batch.sale, 나머지는 batch.pool).
 * 한 풀이 비어도 다른 풀이 메우지 않는다 (빈 섹션이 정상).
 */
export function filterNews(
  items: NewsItem[],
  aud: Audience,
  profile: PersonalProfile,
): FilterPools {
  const seen = new Set<string>();
  const sale: NewsItem[] = [];
  const personal: NewsItem[] = [];
  const general: NewsItem[] = [];
  for (const item of items) {
    if (aud.exclude.some((kw) => kw.length > 0 && item.title.includes(kw))) {
      continue;
    }
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    if (item.source === "steam-sale") sale.push(item);
    else if (isPersonalItem(item, profile)) personal.push(item);
    else general.push(item);
  }
  sale.sort((a, b) => b.publishedAt - a.publishedAt);
  personal.sort((a, b) => b.publishedAt - a.publishedAt);
  general.sort((a, b) => b.publishedAt - a.publishedAt);
  return {
    sale: sale.slice(0, aud.batch.sale),
    personal: personal.slice(0, aud.batch.pool),
    general: general.slice(0, aud.batch.pool),
  };
}

/** 본선. 한 풀에 대해 점수순으로 count건 뽑는다. */
export function rankFinal(
  items: NewsItem[],
  profile: PersonalProfile,
  aud: Audience,
  count?: number,
): ScoredItem[] {
  const library = new Set(profile.libraryAppIds);
  const wishlist = new Set(profile.wishlistAppids);
  const nowSec = Math.floor(Date.now() / 1000);
  const patterns = buildTitlePatterns(profile);
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
    // 소스 가산 (합산 방식). 등급 라벨로 선별 근거를 남긴다.
    const src = lookupSourceWeight(item, aud.source_weights ?? { default: 0 });
    score += src.weight;
    labels.add(`source:${src.grade}`);
    if (labels.size === 0) labels.add("unranked");
    return { ...item, score, labels: [...labels] };
  });
  scored.sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
  return scored.slice(0, count ?? aud.batch.final);
}
