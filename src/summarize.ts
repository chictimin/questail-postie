import OpenAI from "openai";
import type { ScoredItem, Summary } from "./types.js";
import { canCallLlm, effectiveApiKey, extractJsonPayload, warnFallback, LLM_TIMEOUT_MS, LLM_MAX_RETRIES } from "./llmLocal.js";

export interface SummarizeOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
}

const MAX_CONTENT_CHARS = 4000;
/** 원어 요약 상한. 한국어 상한(MAX_LINE_CHARS_KO)과 분리 — 값 근거는 /tmp 실측 보고 참조. */
export const MAX_LINE_CHARS_SRC = 300;

function hasKorean(text: string): boolean {
  return /[가-힣]/.test(text);
}

function detectSourceLang(item: ScoredItem): string {
  const text = `${item.title}\n${item.content}`;
  if (hasKorean(text)) return "ko";
  if (item.lang && item.lang !== "unknown") return item.lang;
  return "en";
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export interface GameMeta {
  name: string;
  platforms: string[];
}

/**
 * LLM 없이 쓰는 폴백: 원문 앞 3문장 절취를 bullets에 넣는다.
 * Ko 필드는 건드리지 않는다(빈 채로 두어 translate가 실패扱いで 원어 발행을 하게 한다).
 * translated는 항상 false — "번역 성공" 의미.
 */
function fallbackSummary(
  item: ScoredItem,
  meta?: Map<number, GameMeta>,
): Summary {
  const sentences = splitSentences(item.content);
  const bullets: string[] = [
    truncate(sentences[0] ?? item.title, MAX_LINE_CHARS_SRC),
    truncate(sentences[1] ?? item.title, MAX_LINE_CHARS_SRC),
    truncate(sentences[2] ?? item.title, MAX_LINE_CHARS_SRC),
  ];
  const game = item.appId !== undefined ? meta?.get(item.appId) : undefined;
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    appId: item.appId,
    gameName: game?.name,
    platforms: game?.platforms ?? [],
    sourceName: item.sourceName,
    imageUrl: item.imageUrl,
    bullets,
    sourceLang: detectSourceLang(item),
    translated: false,
  };
}

function parseLlmPayload(
  raw: string,
  item: ScoredItem,
  meta?: Map<number, GameMeta>,
): Summary {
  const sourceLang = detectSourceLang(item);
  const game = item.appId !== undefined ? meta?.get(item.appId) : undefined;
  const finish = (bullets: string[]): Summary => ({
    id: item.id,
    title: item.title,
    url: item.url,
    appId: item.appId,
    gameName: game?.name,
    platforms: game?.platforms ?? [],
    sourceName: item.sourceName,
    imageUrl: item.imageUrl,
    // 2~3개로 정규화한다. 모자라면 제목으로 메운다.
    bullets: [bullets[0], bullets[1], bullets[2]]
      .map((b) => truncate(b ?? item.title, MAX_LINE_CHARS_SRC))
      .slice(0, Math.max(2, Math.min(3, bullets.length || 2))),
    sourceLang,
    // 번역이 아니다. Ko는 translate 노드 담당.
    translated: false,
  });

  try {
    const parsed = JSON.parse(raw) as { bullets?: unknown };
    if (Array.isArray(parsed.bullets)) {
      const bullets = parsed.bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0);
      if (bullets.length >= 2 && bullets.length <= 3) return finish(bullets);
    }
  } catch {
    // JSON이 아니면 줄 단위 파싱으로 넘어간다.
  }
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 0);
  return finish(lines.slice(0, 3));
}

/**
 * 원어 요약. 영어 원문이면 영어로 2~3줄, 한국어 원문이면 한국어로.
 * 번역(titleKo/bulletsKo)은 여기서 만들지 않는다.
 */
async function summarizeWithLlm(
  client: OpenAI,
  model: string,
  item: ScoredItem,
  isKoreanSource: boolean,
  meta?: Map<number, GameMeta>,
): Promise<Summary> {
  const content = item.content.slice(0, MAX_CONTENT_CHARS);
  const task = isKoreanSource
    ? "The source is Korean. Summarize in Korean: 2-3 bullet lines."
    : "The source is English. Summarize in English: 2-3 bullet lines. Do NOT translate to Korean.";
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You summarize game news in the source language. " +
          "Reply with JSON only: {\"bullets\": [2-3 summary lines]}. " +
          "Each item max 300 chars. Base strictly on the given article (title, appId game, URL, body). " +
          "Do not mention other games. Do not invent dates, numbers, or events not in the article.",
      },
      {
        role: "user",
        content: [
          `Title: ${item.title}`,
          `appId: ${item.appId ?? "none"}`,
          `Source URL: ${item.url}`,
          task,
          "Article:",
          content,
        ].join("\n"),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? "";
  return parseLlmPayload(extractJsonPayload(raw), item, meta);
}

export type SummarizeProgress = (done: number, total: number, title: string) => void;

export async function summarizeItems(
  items: ScoredItem[],
  opts: SummarizeOptions,
  meta?: Map<number, GameMeta>,
  onProgress?: SummarizeProgress,
): Promise<Summary[]> {
  if (!canCallLlm(opts.baseURL, opts.apiKey)) {
    return items.map((item) => fallbackSummary(item, meta));
  }
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: effectiveApiKey(opts.apiKey), timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
  const results: Summary[] = [];
  for (const [i, item] of items.entries()) {
    try {
      const isKoreanSource = hasKorean(`${item.title}\n${item.content}`);
      results.push(await summarizeWithLlm(client, opts.model, item, isKoreanSource, meta));
    } catch (err) {
      warnFallback("summarize", err);
      results.push(fallbackSummary(item, meta));
    }
    onProgress?.(i + 1, items.length, item.title);
  }
  return results;
}
