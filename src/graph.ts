import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { collectSteamNews, fetchAppMeta } from "./collect/steam.js";
import { collectRss } from "./collect/rss.js";
import { selectNews } from "./select.js";
import { summarizeItems } from "./summarize.js";
import { verifySummaries } from "./verify.js";
import { publishAll } from "./publish.js";
import type {
  Audience,
  MetricRecord,
  NewsItem,
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
  const meta = new Map<number, { name: string; genres: string[]; keywords: string[] }>();
  const byId = new Map<string, ScoredItem>();

  const graph = new StateGraph(PipelineState)
    .addNode("collect", async () => {
      const appIds = [...new Set([...aud.library_appids, ...aud.wishlist_appids])];
      const [steamItems, rssItems] = await Promise.all([
        collectSteamNews(appIds, aud.steam_news_count),
        collectRss([...aud.reddit_feeds, ...aud.press_feeds], aud.batch.pool),
      ]);
      await Promise.all(
        appIds.map(async (id) => {
          meta.set(id, await fetchAppMeta(id));
        }),
      );
      const rawItems = [...steamItems, ...rssItems];
      metrics.push({
        ts: nowIso(),
        stage: "collect",
        count: rawItems.length,
        detail: `steam=${steamItems.length} rss=${rssItems.length}`,
      });
      return { rawItems };
    })
    .addNode("select", async (state) => {
      const { shortlist, final } = selectNews(state.rawItems, aud, meta);
      for (const item of final) byId.set(item.id, item);
      metrics.push({
        ts: nowIso(),
        stage: "select",
        count: final.length,
        detail: `pool=${state.rawItems.length} shortlist=${shortlist.length} labels=${final.map((f) => f.labels.join("+")).join(",")}`,
      });
      return { finalSel: final };
    })
    .addNode("summarize", async (state) => {
      const summaries = await summarizeItems(state.finalSel, {
        baseURL: env.baseURL,
        apiKey: env.apiKey,
        model: env.model,
      });
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
          });
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
      });
      metrics.push({
        ts: nowIso(),
        stage: "publish",
        count: state.summaries.length,
        detail: `delivered=${delivered}`,
      });
      return { delivered };
    })
    .addEdge(START, "collect")
    .addEdge("collect", "select")
    .addEdge("select", "summarize")
    .addEdge("summarize", "verify")
    .addEdge("verify", "publish")
    .addEdge("publish", END)
    .compile();

  const finalState = await graph.invoke({
    rawItems: [],
    finalSel: [],
    summaries: [],
    verdicts: [],
    delivered: false,
  });

  return { passed: finalState.summaries, verdicts: finalState.verdicts, metrics };
}
