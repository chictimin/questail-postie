import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { dirname, resolve } from "node:path";
import { fetchAppMeta } from "./collect/steam.js";
import { collectRss } from "./collect/rss.js";
import {
  collectSaleWatch,
  collectTierSteamNews,
  filterUnseenSteam,
  loadSeen,
  resolveTiers,
  saveSeen,
  updateSeen,
  type TierSet,
} from "./collect/tiers.js";
import { buildProfile } from "./personalize.js";
import { filterNews, rankFinal } from "./select.js";
import { buildDigest } from "./digest.js";
import { summarizeItems } from "./summarize.js";
import { verifySummaries } from "./verify.js";
import { publishAll } from "./publish.js";
import type {
  Audience,
  MetricRecord,
  NewsItem,
  PersonalProfile,
  ScoredItem,
  Summary,
  Verdict,
} from "./types.js";

export interface PipelineEnv {
  baseURL: string;
  apiKey?: string;
  model: string;
  webhookUrl?: string;
  outPath: string;
  metricsPath: string;
}

const PipelineState = Annotation.Root({
  rawItems: Annotation<NewsItem[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  profile: Annotation<PersonalProfile | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  filtered: Annotation<NewsItem[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  finalSel: Annotation<ScoredItem[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  summaries: Annotation<Summary[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  verdicts: Annotation<Verdict[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  digest: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  delivered: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

function nowIso(): string {
  return new Date().toISOString();
}

export async function runPipeline(
  aud: Audience,
  env: PipelineEnv,
): Promise<{ passed: Summary[]; verdicts: Verdict[]; metrics: MetricRecord[] }> {
  const metrics: MetricRecord[] = [];
  const meta = new Map<number, { name: string; genres: string[]; keywords: string[]; platforms: string[] }>();
  const byId = new Map<string, ScoredItem>();

  // 티어 확정 (STEAM 키 읽기 전용, 없으면 audience 폴백 — 질문 없이 진행).
  // Tier1 최근 플레이가 있으면 라이브러리 대신 쓰고, 없으면 설정값을 유지한다.
  // 하류 노드는 effAud를 그대로 받아 로직 변경 없이 동작한다.
  const tiers: TierSet = await resolveTiers(aud);
  const effAud: Audience = {
    ...aud,
    library_appids: tiers.recentAppIds.length > 0 ? tiers.recentAppIds : aud.library_appids,
    wishlist_appids: tiers.wishlistAppIds,
  };
  const seenPath = resolve(dirname(env.metricsPath), "seen.json");

  const graph = new StateGraph(PipelineState)
    .addNode("collect", async () => {
      const [{ tier0, tier1 }, rssItems] = await Promise.all([
        collectTierSteamNews(tiers),
        collectRss([...effAud.reddit_feeds, ...effAud.press_feeds], effAud.batch.pool),
      ]);
      const appIds = [...new Set([...effAud.library_appids, ...effAud.wishlist_appids])];
      await Promise.all(
        appIds.map(async (id) => {
          meta.set(id, await fetchAppMeta(id));
        }),
      );
      const saleItems = await collectSaleWatch(tiers.wishlistAppIds, meta);
      const seen = await loadSeen(seenPath);
      const freshSteam = filterUnseenSteam([...tier0, ...tier1], seen);
      updateSeen(seen, [...tier0, ...tier1]);
      await saveSeen(seenPath, seen);
      const steamItems = [...freshSteam, ...saleItems];
      const rawItems = [...steamItems, ...rssItems];
      metrics.push({
        ts: nowIso(),
        stage: "collect",
        count: rawItems.length,
        detail:
          `steam=${steamItems.length}(fresh=${freshSteam.length} sale=${saleItems.length}) ` +
          `rss=${rssItems.length} tier0=${tier0.length} tier1=${tier1.length} ` +
          `tiers=${tiers.steamSource}`,
      });
      return { rawItems };
    })
    .addNode("personalize", async () => {
      const profile = buildProfile(effAud, meta);
      metrics.push({
        ts: nowIso(),
        stage: "personalize",
        count: profile.titleIndex.length,
        detail: `library=${profile.libraryAppIds.length} wishlist=${profile.wishlistAppids.length}`,
      });
      return { profile };
    })
    .addNode("filter", async (state) => {
      const filtered = filterNews(state.rawItems, effAud);
      metrics.push({
        ts: nowIso(),
        stage: "filter",
        count: filtered.length,
        detail: `pool=${state.rawItems.length}`,
      });
      return { filtered };
    })
    .addNode("rank", async (state) => {
      const profile = state.profile;
      if (!profile) throw new Error("personalize 노드가 먼저 실행되어야 합니다.");
      const final = rankFinal(state.filtered, profile, effAud);
      for (const item of final) byId.set(item.id, item);
      metrics.push({
        ts: nowIso(),
        stage: "rank",
        count: final.length,
        detail: `labels=${final.map((f) => f.labels.join("+")).join(",")}`,
      });
      return { finalSel: final };
    })
    .addNode("summarize", async (state) => {
      const summaries = await summarizeItems(state.finalSel, {
        baseURL: env.baseURL,
        apiKey: env.apiKey,
        model: env.model,
      }, meta);
      metrics.push({
        ts: nowIso(),
        stage: "summarize",
        count: summaries.length,
        detail: `translated=${summaries.filter((s) => s.translated).length}`,
      });
      return { summaries };
    })
    .addNode("verify", async (state) => {
      const sourceOf = (id: string): NewsItem | undefined => byId.get(id);
      const { passed, verdicts } = await verifySummaries(
        state.summaries,
        sourceOf,
        async (s) => {
          const original = byId.get(s.id);
          if (!original) return s;
          const [retry] = await summarizeItems([original], {
            baseURL: env.baseURL,
            apiKey: env.apiKey,
            model: env.model,
          }, meta);
          return retry ?? s;
        },
      );
      metrics.push({
        ts: nowIso(),
        stage: "verify",
        count: passed.length,
        detail: verdicts
          .map((v) => `${v.id}:${v.pass ? "pass" : "fail"}${v.regenerated ? "(regen)" : ""}`)
          .join(" "),
      });
      return { summaries: passed, verdicts };
    })
    .addNode("publish", async (state) => {
      const { delivered } = await publishAll(state.summaries, {
        webhookUrl: env.webhookUrl,
        outPath: env.outPath,
      }, state.digest);
      metrics.push({
        ts: nowIso(),
        stage: "publish",
        count: state.summaries.length,
        detail: `delivered=${delivered}`,
      });
      return { delivered };
    })
    .addNode("briefing", async (state) => {
      const digest = await buildDigest(state.filtered, {
        baseURL: env.baseURL,
        apiKey: env.apiKey,
        model: env.model,
      });
      metrics.push({
        ts: nowIso(),
        stage: "digest",
        count: digest.linesKo.length,
        detail: `pool=${state.filtered.length}`,
      });
      return { digest: digest.linesKo };
    })
    .addEdge(START, "collect")
    .addEdge("collect", "personalize")
    .addEdge("personalize", "filter")
    .addEdge("filter", "rank")
    .addEdge("rank", "summarize")
    .addEdge("summarize", "verify")
    .addEdge("verify", "briefing")
    .addEdge("briefing", "publish")
    .addEdge("publish", END)
    .compile();

  const finalState = await graph.invoke({
    rawItems: [],
    profile: null,
    filtered: [],
    finalSel: [],
    summaries: [],
    verdicts: [],
    digest: [],
    delivered: false,
  });

  return { passed: finalState.summaries, verdicts: finalState.verdicts, metrics };
}
