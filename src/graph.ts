import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { dirname, resolve } from "node:path";
import { fetchAppMetaMap } from "./collect/steam.js";
import { collectRss } from "./collect/rss.js";
import {
  collectSaleWatch,
  collectTierSteamNews,
  filterUnseenSteam,
  loadSeen,
  resolveTiers,
  saveSeen,
  updateSeen,
  type SeenStore,
  type TierSet,
} from "./collect/tiers.js";
import { buildProfile } from "./personalize.js";
import { filterNews, isPersonalItem, rankFinal } from "./select.js";
import { buildDigest } from "./digest.js";
import { summarizeItems } from "./summarize.js";
import { translateToKorean } from "./translate.js";
import { verifySummaries } from "./verify.js";
import { publishAll } from "./publish.js";
import type {
  Audience,
  MetricRecord,
  NewsItem,
  PersonalProfile,
  ResolvedAudience,
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
  showGameLine?: boolean;
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
  sale: Annotation<NewsItem[]>({
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
  digest: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  digestKo: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  delivered: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

function nowIso(): string {
  return new Date().toISOString();
}

function shortTitle(title: string, max = 40): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

export async function runPipeline(
  aud: Audience,
  env: PipelineEnv,
): Promise<{ passed: Summary[]; verdicts: Verdict[]; metrics: MetricRecord[] }> {
  const metrics: MetricRecord[] = [];
  const meta = new Map<number, { name: string; genres: string[]; keywords: string[]; platforms: string[] }>();
  const byId = new Map<string, ScoredItem>();
  const sectionOf = new Map<string, "personal" | "extra">();

  // 티어 확정 (STEAM 키 읽기 전용, 없으면 빈 티어 — RSS만으로 계속).
  // library = 최근 플레이(비면 보유 전체), wishlist = 위시 전수.
  // 하류 노드는 effAud를 그대로 받아 로직 변경 없이 동작한다.
  const tiers: TierSet = await resolveTiers(aud.demo_appids ?? []);
  const effAud: ResolvedAudience = {
    ...aud,
    library_appids: tiers.libraryAppIds,
    wishlist_appids: tiers.wishlistAppIds,
  };
  const seenPath = resolve(dirname(env.metricsPath), "seen.json");
  // seen 지연 저장용. collect에서 필터는 하되 저장은 publish 성공 후에만 한다.
  // 하류 실패 시 수집분이 영구 seen 처리되어 사라지는 것을 막는다.
  // 기록 대상은 실제 발행된 요약분 id만이다 (sale 제외).
  let pendingSeen: SeenStore | null = null;

  const graph = new StateGraph(PipelineState)
    .addNode("collect", async () => {
      const [{ tier0, tier1 }, rssItems] = await Promise.all([
        collectTierSteamNews(tiers),
        collectRss([...effAud.reddit_feeds, ...effAud.press_feeds], effAud.batch.pool),
      ]);
      const appIds = [...new Set([...effAud.library_appids, ...effAud.wishlist_appids])];
      for (const [id, metaItem] of await fetchAppMetaMap(appIds)) meta.set(id, metaItem);
      const saleItems = await collectSaleWatch(tiers.wishlistAppIds, meta);
      const seen = await loadSeen(seenPath);
      const freshSteam = filterUnseenSteam([...tier0, ...tier1], seen);
      // 저장은 publish 성공 후로 미룬다. 필터만 여기서 해서 요약 대상을 줄인다.
      pendingSeen = seen;
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
      console.log(
        `[1/9] 수집 — Steam ${steamItems.length}건(신규 ${freshSteam.length}·할인 ${saleItems.length}) · RSS ${rssItems.length}건 (총 ${rawItems.length})`,
      );
      return { rawItems };
    })
    .addNode("personalize", async () => {
      const profile = buildProfile(effAud, meta);
      metrics.push({
        ts: nowIso(),
        stage: "personalize",
        count: profile.titleIndex.length,
        detail: `library=${profile.libraryAppIds.length} wishlist=${profile.wishlistAppids.length} noMeta=${profile.noMeta}`,
      });
      console.log(
        tiers.steamSource === "demo"
          ? `[2/9] 개인화 프로필 — 데모 목록 ${tiers.libraryAppIds.length + tiers.wishlistAppIds.length}종 (Steam 키 미등록)`
          : `[2/9] 개인화 프로필 — 라이브러리 ${profile.libraryAppIds.length}종 · 위시리스트 ${profile.wishlistAppids.length}종`,
      );
      return { profile };
    })
    .addNode("filter", async (state) => {
      const profile = state.profile;
      if (!profile) throw new Error("personalize 노드가 먼저 실행되어야 합니다.");
      const pools = filterNews(state.rawItems, effAud, profile);
      metrics.push({
        ts: nowIso(),
        stage: "filter",
        count: pools.personal.length + pools.general.length,
        detail: `pool=${state.rawItems.length} personal=${pools.personal.length} general=${pools.general.length} sale=${pools.sale.length}`,
      });
      console.log(
        `[3/9] 예선 — ${state.rawItems.length}건 → 개인화 ${pools.personal.length}건 · 일반 ${pools.general.length}건 · 할인 ${pools.sale.length}건`,
      );
      return { filtered: [...pools.personal, ...pools.general], sale: pools.sale };
    })
    .addNode("rank", async (state) => {
      const profile = state.profile;
      if (!profile) throw new Error("personalize 노드가 먼저 실행되어야 합니다.");
      const personalPool = state.filtered.filter((i) => isPersonalItem(i, profile));
      const generalPool = state.filtered.filter((i) => !isPersonalItem(i, profile));
      const personal = rankFinal(personalPool, profile, effAud, effAud.batch.final);
      const extra = rankFinal(generalPool, profile, effAud, effAud.batch.extra);
      const final = [...personal, ...extra];
      for (const item of personal) {
        byId.set(item.id, item);
        sectionOf.set(item.id, "personal");
      }
      for (const item of extra) {
        byId.set(item.id, item);
        sectionOf.set(item.id, "extra");
      }
      metrics.push({
        ts: nowIso(),
        stage: "rank",
        count: final.length,
        detail:
          `personal=${personal.length} labels=${personal.map((f) => f.labels.join("+")).join(",")} ` +
          `extra=${extra.length} labels=${extra.map((f) => f.labels.join("+")).join(",")}`,
      });
      console.log(`[4/9] 본선 — 개인화 ${personal.length}건 · 그 외 ${extra.length}건 선정`);
      return { finalSel: final };
    })
    .addNode("summarize", async (state) => {
      const summaries = await summarizeItems(state.finalSel, {
        baseURL: env.baseURL,
        apiKey: env.apiKey,
        model: env.model,
      }, meta, (done, total, title) => {
        console.log(`[5/9] 요약 (${done}/${total}) ${shortTitle(title)}`);
      });
      metrics.push({
        ts: nowIso(),
        stage: "summarize",
        count: summaries.length,
        // translated는 "번역 성공" 의미라 summarize 단계에선 항상 0. 원어 분포만 기록.
        detail: `sourceKo=${summaries.filter((s) => s.sourceLang === "ko").length}`,
      });
      console.log(`[5/9] 요약 완료 — ${summaries.length}건`);
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
      const regen = verdicts.filter((v) => v.regenerated).length;
      const fail = verdicts.filter((v) => !v.pass).length;
      metrics.push({
        ts: nowIso(),
        stage: "verify",
        count: passed.length,
        detail: verdicts
          .map((v) => `${v.id}:${v.pass ? "pass" : "fail"}${v.regenerated ? "(regen)" : ""}`)
          .join(" "),
      });
      console.log(`[6/9] 검수 — ${state.summaries.length}건 중 ${passed.length}건 통과, ${regen}건 재생성, ${fail}건 탈락`);
      return { summaries: passed, verdicts };
    })
    .addNode("publish", async (state) => {
      // 번역된 digest가 있으면 쓰고, 없으면 원어 그대로 (항목별 원어 표기는 publish 내부).
      const digestOut = state.digestKo ? state.digestKo : state.digest;
      const personal = state.summaries.filter((s) => (sectionOf.get(s.id) ?? "personal") === "personal");
      const extra = state.summaries.filter((s) => sectionOf.get(s.id) === "extra");
      const { delivered, parts } = await publishAll({ personal, extra, sale: state.sale }, {
        webhookUrl: env.webhookUrl,
        outPath: env.outPath,
        showGameLine: env.showGameLine,
      }, digestOut);
      // 파일 저장이 성공한 뒤에만 발행 기록. publishAll은 파일 쓰기 실패 시 throw하므로
      // 여기 도달 = 파일 저장 성공 = Discord 실패(delivered=false)여도 기록한다.
      // 기록은 실제 발행된 요약분 id만 — sale은 상태가 바뀌면 다시 알려야 하므로 제외.
      let seenIds = 0;
      if (pendingSeen) {
        updateSeen(pendingSeen, [...personal, ...extra].map((s) => s.id));
        await saveSeen(seenPath, pendingSeen);
        seenIds = Object.keys(pendingSeen.published).length;
        pendingSeen = null;
      }
      metrics.push({
        ts: nowIso(),
        stage: "publish",
        count: state.summaries.length,
        detail: `delivered=${delivered} parts=${parts} sale=${state.sale.length} seen=${seenIds}ids`,
      });
      console.log(
        `[9/9] 발행 — 개인화 ${personal.length} · 그 외 ${extra.length} · 할인 ${state.sale.length} — ${env.outPath} 저장 · ` +
          (env.webhookUrl ? `Discord ${parts}개 메시지 전송 ${delivered ? "성공" : "실패"}` : "파일 저장만(웹훅 없음)") +
          ` · seen 발행 기록 ${seenIds}건`,
      );
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
        count: digest.text ? 1 : 0,
        detail: `chars=${digest.text.length} pool=${state.filtered.length}`,
      });
      console.log(
        digest.text
          ? `[7/9] 브리핑 생성 — 평문 ${digest.text.length}자`
          : `[7/9] 브리핑 건너뜀 (원문 없음 또는 LLM 실패)`,
      );
      return { digest: digest.text };
    })
    .addNode("translate", async (state) => {
      const report = await translateToKorean(state.summaries, { text: state.digest }, {
        baseURL: env.baseURL,
        apiKey: env.apiKey,
        model: env.model,
      }, (done, total, title) => {
        console.log(`[8/9] 번역 (${done}/${total}) ${shortTitle(title)}`);
      });
      metrics.push({
        ts: nowIso(),
        stage: "translate",
        count: report.ok + report.ko,
        detail: `ok=${report.ok} ko=${report.ko} failed=${report.failed} skipped=${report.skipped} sourceKo=${report.sourceKo}`,
      });
      console.log(
        `[8/9] 번역 완료 — 성공 ${report.ok + report.ko}건 · 실패 ${report.failed}건 · 건너뜀 ${report.skipped}건`,
      );
      return { summaries: report.summaries, digestKo: report.digestKo };
    })
    .addEdge(START, "collect")
    .addEdge("collect", "personalize")
    .addEdge("personalize", "filter")
    .addEdge("filter", "rank")
    .addEdge("rank", "summarize")
    .addEdge("summarize", "verify")
    .addEdge("verify", "briefing")
    .addEdge("briefing", "translate")
    .addEdge("translate", "publish")
    .addEdge("publish", END)
    .compile();

  const finalState = await graph.invoke({
    rawItems: [],
    profile: null,
    filtered: [],
    sale: [],
    finalSel: [],
    summaries: [],
    verdicts: [],
    digest: "",
    digestKo: "",
    delivered: false,
  });

  return { passed: finalState.summaries, verdicts: finalState.verdicts, metrics };
}
