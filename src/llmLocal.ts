/**
 * 로컬 LLM 호출 판단 + postie 환경변수 해석.
 * 순수 헬퍼(stripLlmNoise·extractJsonPayload·warnFallback·타임아웃 상수)는
 * @questail/core 공개 API로 교체되어 여기서 정의하지 않는다.
 * OpenAI SDK 호출부는 summarize·translate·digest에 둔다.
 */

import { getLlmOptions } from "@questail/core";

/** 로컬호스트 baseURL 판정 (Ollama·LM Studio 등 로컬 추론 서버). */
export function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

/**
 * LLM 호출 가능 여부. "키가 있는가"가 아니라 "호출할 엔드포인트가 있는가"로 판정한다.
 * 키가 있으면 원격·로컬 모두 호출, 키가 없어도 로컬 엔드포인트면 호출한다.
 * 원격 baseURL + 키 없음은 폴백한다.
 */
export function canCallLlm(baseURL: string, apiKey?: string): boolean {
  if (apiKey && apiKey.trim()) return true;
  return isLocalhostUrl(baseURL);
}

/** OpenAI SDK는 빈 키에 throw하므로 로컬 경로용 더미 키를 채운다 (인증용이 아님). */
export function effectiveApiKey(apiKey?: string): string {
  return apiKey && apiKey.trim() ? apiKey : "local";
}

// ─── LLM 환경변수 해석 (QUESTAIL 우선·OPENAI 폴백) ────────────
// D2 확정: postie 기존 .env·README에 OPENAI_BASE_URL/OPENAI_API_KEY/MODEL 이름이
// 박혀 있어 전면 개명하지 않는다. core getLlmOptions()(QUESTAIL_LLM_*)가 비어 있을 때만
// 기존 이름을 쓴다.

export interface ResolvedLlmEnv {
  baseURL: string;
  apiKey?: string;
  model: string;
}

let fallbackWarned = false;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveLlmEnv(): ResolvedLlmEnv {
  const q = getLlmOptions();
  const qBase = q.baseUrl;
  const qKey = q.apiKey;
  const qModel = q.model;
  const oBase = nonEmpty(process.env.OPENAI_BASE_URL);
  const oKey = nonEmpty(process.env.OPENAI_API_KEY);
  const oModel = nonEmpty(process.env.MODEL);
  const usedFallback = (!qBase && Boolean(oBase)) || (!qKey && Boolean(oKey)) || (!qModel && Boolean(oModel));
  if (usedFallback && !fallbackWarned) {
    fallbackWarned = true;
    console.error("OPENAI_* 사용 중 — QUESTAIL_LLM_*로 옮기면 questail과 설정을 공유합니다");
  }
  return {
    baseURL: qBase ?? oBase ?? "https://api.openai.com/v1",
    apiKey: qKey ?? oKey,
    model: qModel ?? oModel ?? "gpt-4o-mini",
  };
}
