/**
 * Module 8 G7 — interface nguồn lịch sử BSR (Keepa).
 * Chỉ đọc lịch sử BSR; mọi giá trị đi vào engine mùa vụ qua BsrPoint.
 */

import type { BsrPoint } from "../../research/domain/seasonality.ts";

export type KeepaDomain = {
  id: number;
  code: string; // marketplace mã quốc gia
  label: string;
};

/** Mã domain Keepa (theo Keepa API docs): US=1, UK=2, DE=3, FR=4, JP=5, CA=6. */
export const KEEPA_DOMAINS: Record<string, KeepaDomain> = {
  US: { id: 1, code: "US", label: "Amazon.com" },
  UK: { id: 2, code: "UK", label: "Amazon.co.uk" },
  DE: { id: 3, code: "DE", label: "Amazon.de" },
  FR: { id: 4, code: "FR", label: "Amazon.fr" },
  JP: { id: 5, code: "JP", label: "Amazon.co.jp" },
  CA: { id: 6, code: "CA", label: "Amazon.ca" },
};

export type BsrHistoryQuery = {
  asins: string[];
  marketplace?: string;
  /** số NGÀY nhìn lại (mặc định 365) */
  sinceDays?: number;
};

export interface BsrHistoryProvider {
  readonly name: string;
  /** true khi có khóa/cấu hình thật */
  readonly configured: boolean;
  fetchBsrHistory(query: BsrHistoryQuery): Promise<{ points: BsrPoint[]; asinsFound: number }>;
}
