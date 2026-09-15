import OpenAI from "openai";
import type { ScoredItem, Summary } from "./types.js";

export interface SummarizeOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
}

const MAX_CONTENT_CHARS = 4000;
const MAX_LINE_CHARS = 200;

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

/** LLM 없이 쓰는 폴백: 본문 앞 3문장 + 제목 기반 인사이트. 파이프라인이 멈추지 않게 한다. */
function fallbackSummary(item: ScoredItem): Summary {
  const sentences = splitSentences(item.content);
  const bullets: [string, string, string] = [
    truncate(sentences[0] ?? item.title, MAX_LINE_CHARS),
    truncate(sentences[1] ?? item.title, MAX_LINE_CHARS),
    truncate(sentences[2] ?? item.title, MAX_LINE_CHARS),
  ];
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    appId: item.appId,
    bulletsKo: bullets,
    insightKo: truncate(
      `${item.title} 관련 소식이므로 원문에서 세부 내용을 확인하세요.`,
      MAX_LINE_CHARS,
    ),
    translated: false,
    sourceLang: detectSourceLang(item),
  };
}

function parseLlmPayload(raw: string, item: ScoredItem, translated: boolean): Summary {
  const sourceLang = detectSourceLang(item);
  const finish = (bullets: string[], insight: string): Summary => ({
    id: item.id,
    title: item.title,
    url: item.url,
    appId: item.appId,
    bulletsKo: [
      truncate(bullets[0] ?? item.title, MAX_LINE_CHARS),
      truncate(bullets[1] ?? item.title, MAX_LINE_CHARS),
      truncate(bullets[2] ?? item.title, MAX_LINE_CHARS),
    ],
    insightKo: truncate(insight || `${item.title} 관련 소식이므로 원문을 확인하세요.`, MAX_LINE_CHARS),
    translated,
    sourceLang,
  });

  try {
    const parsed = JSON.parse(raw) as { bullets?: unknown; insight?: unknown };
    if (Array.isArray(parsed.bullets) && typeof parsed.insight === "string") {
      const bullets = parsed.bullets.filter((b): b is string => typeof b === "string");
      if (bullets.length > 0) return finish(bullets, parsed.insight);
    }
  } catch {
    // JSON이 아니면 줄 단위 파싱으로 넘어간다.
  }
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 0);
  return finish(
    lines.slice(0, 3),
    lines.slice(3).join(" "),
  );
}

async function summarizeWithLlm(
  client: OpenAI,
  model: string,
  item: ScoredItem,
  isKoreanSource: boolean,
): Promise<Summary> {
  const content = item.content.slice(0, MAX_CONTENT_CHARS);
  const task = isKoreanSource
    ? "원문이 한국어이므로 한국어로 3줄 요약하고, insight도 한국어로 1줄 작성하라."
    : "원문이 외국어이므로 한국어로 3줄 요약하고, 독자 관점 인사이트를 한국어로 1줄 작성하라.";
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "너는 게임 뉴스를 한국어로 요약하는 어시스턴트다. " +
          "반드시 JSON으로만 답한다: {\"bullets\": [요약 3개], \"insight\": \"인사이트 1줄\"}. " +
          "각 항목은 200자 이하. 아래 원문 URL·제목·appId에 해당하는 게임에만 근거해 작성하고 다른 게임을 언급하지 않는다.",
      },
      {
        role: "user",
        content: [
          `제목: ${item.title}`,
          `appId: ${item.appId ?? "없음"}`,
          `원문 URL: ${item.url}`,
          task,
          "원문:",
          content,
        ].join("\n"),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? "";
  return parseLlmPayload(raw, item, !isKoreanSource);
}

export async function summarizeItems(
  items: ScoredItem[],
  opts: SummarizeOptions,
): Promise<Summary[]> {
  if (!opts.apiKey) {
    return items.map(fallbackSummary);
  }
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey });
  const results: Summary[] = [];
  for (const item of items) {
    try {
      const isKoreanSource = hasKorean(`${item.title}\n${item.content}`);
      results.push(await summarizeWithLlm(client, opts.model, item, isKoreanSource));
    } catch {
      results.push(fallbackSummary(item));
    }
  }
  return results;
}
