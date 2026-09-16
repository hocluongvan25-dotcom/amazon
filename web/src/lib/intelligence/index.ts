/**
 * Module 8 G2 — factory tầng intelligence.
 * Server-only: đọc env khi job chạy. Thiếu key → provider mock kèm cờ
 * `configured=false` để job/cron quyết định 'skipped' (không làm đỏ dashboard).
 */

import { MockIntelligenceProvider } from "./mock-intelligence.ts";
import { RainforestClient } from "./rainforest/client.ts";
import type { IntelligenceProvider } from "./types.ts";

export type IntelligenceContext = {
  provider: IntelligenceProvider;
  /** true khi có RAINFOREST_API_KEY thật */
  configured: boolean;
};

export function getIntelligenceProvider(env: NodeJS.ProcessEnv = process.env): IntelligenceContext {
  const key = env.RAINFOREST_API_KEY?.trim();
  if (key) {
    return {
      configured: true,
      provider: new RainforestClient({
        apiKey: key,
        webhookSecret: env.RAINFOREST_WEBHOOK_SECRET?.trim(),
        webhookBaseUrl: env.RAINFOREST_WEBHOOK_BASE_URL?.trim(),
      }),
    };
  }
  return { configured: false, provider: new MockIntelligenceProvider() };
}

export * from "./types.ts";
export { MockIntelligenceProvider } from "./mock-intelligence.ts";
export { RainforestClient } from "./rainforest/client.ts";
