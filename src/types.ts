/** questail-postie 공유 타입 계약. 워커는 이 파일을 수정하지 않는다. */

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  feedType: string;
  appId?: number;
  publishedAt: number;
  author: string;
  content: string;
  lang: string;
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
  bulletsKo: [string, string, string];
  insightKo: string;
  translated: boolean;
  sourceLang: string;
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
  personalize: boolean;
  library_appids: number[];
  wishlist_appids: number[];
  platforms: string[];
  genres: string[];
  exclude: string[];
  weights: {
    library_match: number;
    wishlist_match: number;
    recency_hours: number;
  };
  batch: {
    pool: number;
    shortlist: number;
    final: number;
  };
  steam_news_count: number;
  reddit_feeds: string[];
  press_feeds: string[];
}
