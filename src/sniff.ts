#!/usr/bin/env node

/**
 * questail-postie sniff — BYOK 대화형 설정
 *
 *   pnpm sniff
 *
 * OPENAI_BASE_URL / OPENAI_API_KEY / MODEL / DISCORD_WEBHOOK_URL을
 * 물어보고 프로젝트 루트의 .env에 저장한다 (.env는 gitignore).
 * questail의 `sniff`와 같은 패턴이다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

interface LineReader {
  question: (prompt: string) => Promise<string>;
  close: () => void;
}

/**
 * tsx 실행 환경에서 readline.question이 두 번째 호출부터 resolve되지 않는
 * 문제를 피하기 위한 raw stdin 라인 리더. 파이프·TTY 모두 동작한다.
 */
function createLineReader(): LineReader {
  let buffer = "";
  let ended = false;
  const queued: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queued.push(line);
    }
  });
  process.stdin.on("end", () => {
    ended = true;
    if (buffer.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter(buffer);
      else queued.push(buffer);
      buffer = "";
    }
    let waiter: ((line: string) => void) | undefined;
    while ((waiter = waiters.shift())) waiter("");
  });
  process.stdin.resume();

  return {
    question: (prompt: string): Promise<string> => {
      process.stdout.write(prompt);
      const next = queued.shift();
      if (next !== undefined || ended) return Promise.resolve((next ?? "").trim());
      return new Promise((resolve) => {
        waiters.push((line) => resolve(line.trim()));
      });
    },
    close: () => {
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.pause();
    },
  };
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = resolve(ROOT, ".env");

function loadEnvFile(filepath: string): void {
  if (!existsSync(filepath)) return;
  const content = readFileSync(filepath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

function ask(rl: LineReader, question: string): Promise<string> {
  return rl.question(question);
}

function maskValue(value: string): string {
  if (value.length <= 4) return value.slice(0, 1) + "*".repeat(Math.max(0, value.length - 1));
  const keep = Math.min(4, Math.floor(value.length / 3));
  return value.slice(0, keep) + "*".repeat(value.length - keep * 2) + value.slice(-keep);
}

async function promptKey(
  rl: LineReader,
  envName: string,
  label: string,
  defaultValue = "",
  optional = false,
): Promise<string> {
  const current = process.env[envName] ?? "";
  if (current) {
    console.log(`현재 ${envName}: ${maskValue(current)}`);
    const reuse = await ask(rl, `${label} 그대로 쓰려면 Enter, 새로 입력하려면 값을 입력: `);
    if (!reuse) return current;
    return reuse;
  }
  const hint = defaultValue ? ` (기본값: ${defaultValue})` : "";
  const input = await ask(rl, `${label}${hint}: `);
  if (!input && !optional && !defaultValue) {
    console.log(`${envName} 없이 진행합니다. 요약은 폴백 모드로 동작합니다.`);
  }
  return input || defaultValue;
}

async function saveEnv(entries: Record<string, string>): Promise<void> {
  let lines: string[] = [];
  if (existsSync(ENV_FILE)) {
    lines = (await readFile(ENV_FILE, "utf-8")).split("\n");
  }
  for (const [key, value] of Object.entries(entries)) {
    const entry = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx !== -1) lines[idx] = entry;
    else lines.push(entry);
  }
  await writeFile(ENV_FILE, `${lines.join("\n").trim()}\n`, "utf-8");
  for (const [key, value] of Object.entries(entries)) process.env[key] = value;
}

async function main(): Promise<void> {
  loadEnvFile(ENV_FILE);
  const rl = createLineReader();
  console.log("questail-postie 설정 (BYOK). Enter로 건너뛰기 가능.\n");

  const baseURL = await promptKey(
    rl,
    "OPENAI_BASE_URL",
    "OpenAI 호환 베이스 URL",
    "https://api.openai.com/v1",
  );
  const apiKey = await promptKey(rl, "OPENAI_API_KEY", "LLM API 키", "", true);
  const model = await promptKey(rl, "MODEL", "모델명", "gpt-4o-mini");
  const webhook = await promptKey(rl, "DISCORD_WEBHOOK_URL", "Discord 웹훅 URL", "", true);

  await saveEnv({
    OPENAI_BASE_URL: baseURL,
    OPENAI_API_KEY: apiKey,
    MODEL: model,
    DISCORD_WEBHOOK_URL: webhook,
  });
  console.log(`\n저장 완료: ${ENV_FILE}`);

  const run = await ask(rl, "지금 파이프라인을 실행할까요? (Y/n): ");
  rl.close();
  if (!run.toLowerCase().startsWith("n")) {
    const { runPipeline } = await import("./graph.js");
    const { parse: parseYaml } = await import("yaml");
    const audienceRaw = await readFile(resolve(ROOT, "audience.yaml"), "utf-8");
    const aud = parseYaml(audienceRaw);
    const { appendFile, mkdir } = await import("node:fs/promises");
    const outPath = resolve(ROOT, "output/latest.md");
    const metricsPath = resolve(ROOT, "store/metrics.jsonl");
    const { passed, verdicts, metrics } = await runPipeline(aud, {
      baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY || undefined,
      model: process.env.MODEL ?? "gpt-4o-mini",
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
      outPath,
      metricsPath,
    });
    await mkdir(dirname(metricsPath), { recursive: true });
    for (const record of metrics) {
      await appendFile(metricsPath, `${JSON.stringify(record)}\n`, "utf-8");
    }
    console.log(`선정 ${passed.length}건, 검수 실패 ${verdicts.filter((v) => !v.pass).length}건`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
