/**
 * Module 8 G7 — factory nguồn lịch sử BSR. Server-only; thiếu KEEPA_API_KEY
 * → provider mock (dữ liệu gắn source='keepa' nhưng là mô hình tất định,
 * không được coi là số liệu thật).
 */

import { KeepaClient } from "./client.ts";
import { MockKeepaProvider } from "./mock-keepa.ts";
import type { BsrHistoryProvider } from "./types.ts";

export type KeepaContext = {
  provider: BsrHistoryProvider;
  configured: boolean;
};

export function getKeepaProvider(env: NodeJS.ProcessEnv = process.env): KeepaContext {
  const key = env.KEEPA_API_KEY?.trim();
  if (key) return { configured: true, provider: new KeepaClient({ apiKey: key }) };
  return { configured: false, provider: new MockKeepaProvider() };
}

export * from "./types.ts";
export { KeepaClient } from "./client.ts";
export { MockKeepaProvider } from "./mock-keepa.ts";
