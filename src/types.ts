/** questail-postie 공유 타입 계약. 워커는 이 파일을 수정하지 않는다. */

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceName?: string;
  imageUrl?: string;
  feedType: string;
  appId?: number;
  publishedAt: number;
  author: string;
  content: string;
  lang: string;
  /** 할인 합성 아이템 전용 구조화 필드 (source==="steam-sale"일 때만). */
  sale?: {
    gameName: string;
    percent: number;
    priceInitial?: string;
    priceFinal?: string;
  };
}

export interface ScoredItem extends NewsItem {
  score: number;
  labels: string[];
}

export interface Summary {
  id: string;
  title: string;
  url: string;
  appId?: number;
  gameName?: string;
  platforms?: string[];
  sourceName?: string;
  imageUrl?: string;
  // 원어 요약 — summarize 산출물. 항상 2~3개가 채워진다.
  bullets: string[];
  sourceLang: string;
  // 번역 산출물 — translate 노드가 채운다. 실패하면 undefined로 둔다.
  titleKo?: string;
  bulletsKo?: string[];
  // 한국어 번역이 실제로 성공했는가 (원어 transform 여부 아님).
  translated: boolean;
}

export interface Digest {
  text: string;
  textKo?: string;
}

export interface Verdict {
  id: string;
  pass: boolean;
  reason: string;
  regenerated: boolean;
}

export interface MetricRecord {
  ts: string;
  stage: string;
  count: number;
  detail: string;
}

export interface Audience {
  platforms: string[];
  genres: string[];
  exclude: string[];
  /** 소스 가중치 — 피드 URL 부분 문자열 매칭. 키 없으면 default. */
  source_weights: Record<string, number>;
  weights: {
    library_match: number;
    wishlist_match: number;
    recency_hours: number;
  };
  batch: {
    pool: number;
    shortlist: number;
    final: number;
    extra: number;
    sale: number;
  };
  output?: {
    show_game_line?: boolean;
  };
  steam_news_count: number;
  reddit_feeds: string[];
  press_feeds: string[];
}

/** 런타임에 SteamID로 확정하는 티어 appId (audience.yaml에 두지 않는 개인 설정) */
export interface TierAppIds {
  library_appids: number[];
  wishlist_appids: number[];
}

export type ResolvedAudience = Audience & TierAppIds;

export interface PersonalProfile {
  libraryAppIds: number[];
  wishlistAppids: number[];
  titleIndex: Array<{ appId: number; list: "library" | "wishlist"; names: string[] }>;
  weights: { libraryMatch: number; wishlistMatch: number; titleMatch: number; recency: number };
  recencyHours: number;
  /** Store 메타에 이름이 없어 제목 색인에서 빠진 appId 수 (작업 K) */
  noMeta: number;
}
