import OpenAI from "openai";
import type { Digest, NewsItem } from "./types.js";
import { canCallLlm, effectiveApiKey, stripLlmNoise, warnFallback } from "./llmLocal.js";

export interface DigestOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
}

const MAX_PARAGRAPH_CHARS = 1200;
const MAX_ITEMS = 30;

/** 평문 문단으로 정리한다. 줄·번호·불릿 흔적을 지우고 공백을 접어 이어 붙인다. */
function parseParagraph(raw: string): string {
  const text = raw
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_PARAGRAPH_CHARS ? text.slice(0, MAX_PARAGRAPH_CHARS) : text;
}

/**
 * 원어 브리핑 (평문 한 문단). 제목 목록 언어로 2~3문장, 읽는 사람에게 말하듯.
 * 한국어 번역은 translate 노드 담당 — textKo는 여기서 채우지 않는다.
 */
export async function buildDigest(
  items: NewsItem[],
  opts: DigestOptions,
): Promise<Digest> {
  if (items.length === 0 || !canCallLlm(opts.baseURL, opts.apiKey)) return { text: "" };
  try {
    const client = new OpenAI({ baseURL: opts.baseURL, apiKey: effectiveApiKey(opts.apiKey) });
    const list = items
      .slice(0, MAX_ITEMS)
      .map((it, i) => `${i + 1}. ${it.title} — ${it.sourceName ?? it.source}`)
      .join("\n");
    const response = await client.chat.completions.create({
      model: opts.model,
      messages: [
        {
          role: "system",
          content:
            "You glance over game news headlines and explain them to the reader in plain prose. " +
            "The reader is a heavy gamer who does not want to miss news about their own Steam library and wishlist games. " +
            "Do not cover every headline — focus on the 1-2 most important stories and mention the rest only as background flow, or omit them. " +
            "The number of sentences must not grow with the number of headlines. " +
            "Do not just list what happened — make each sentence show what matters to this reader and why, and what they should pay attention to or follow up on. " +
            "Start directly with the news itself, never with words referring to this briefing (e.g. headline/introduction/this article/today's briefing). " +
            "Reply in the language of the headlines, one paragraph of 2-3 sentences. " +
            "No line breaks, no numbers, no bullets. No markdown emphasis of any kind (no asterisks, underscores, or backticks) — write game names as plain text. " +
            "Do not invent facts.",
        },
        { role: "user", content: list },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "";
    return { text: parseParagraph(stripLlmNoise(raw)) };
  } catch (err) {
    warnFallback("digest", err);
    return { text: "" };
  }
}
