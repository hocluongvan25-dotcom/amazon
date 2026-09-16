/**
 * Module 8 — chi tiết hồ sơ thẩm định: /research/[id]
 * G1 render kết quả engine từ giả định đã lưu (tài chính + scorecard 2 trụ).
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { Chip, MockDataNotice, NoAccess, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/session";
import type { PersonaKey } from "@/lib/roles";
import { readAssessmentDetail, readCollectionData } from "@/lib/data/research";
import { readPainData } from "@/lib/data/research-pain";
import { createClient } from "@/lib/supabase/server";
import { CollectionPanel } from "./CollectionPanel";
import { MarketConcentrationPanel } from "./MarketConcentrationPanel";
import { PainPanel } from "./PainPanel";
import {
  STATUS_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
  shortDate,
} from "@/lib/data/research-model";
import { ResearchResultView, pct } from "../ResearchResultView";

const ALLOWED: PersonaKey[] = ["ceo"];

export default async function ResearchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!ALLOWED.includes(session.persona)) return <NoAccess />;

  const { id } = await params;
  const [detail, collection, pain, db] = await Promise.all([
    readAssessmentDetail(id),
    readCollectionData(id),
    readPainData(id),
    createClient(),
  ]);
  if (!detail) notFound();
  if (!collection) notFound();
  if (!pain) notFound();
  const { row, result } = detail;

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <Link href="/research" className="text-[12.5px] font-bold text-soft hover:text-ink">
          ← Danh sách hồ sơ thẩm định
        </Link>
        <Link
          href={`/research/${id}/editor`}
          className="rounded-lg bg-blue-700 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-800"
        >
          ✍️ Mở Report Canvas
        </Link>
      </div>
      <PageHeader
        title={row.title}
        sub={`${row.code} · ${STATUS_LABEL[row.status] ?? row.status} · ${row.analyst_name ?? ""} · tạo ${shortDate(row.created_at)}`}
        desc={`Engine ${result.engineVersion} · TTL số liệu 30 ngày (tới ${shortDate(row.data_expires_at)})`}
      />
      {id.startsWith("demo-") && (
        <MockDataNotice what="Hồ sơ này là số liệu minh họa tính từ engine G1, không phải ngách khách hàng thật." />
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {row.verdict ? <Chip tone={VERDICT_TONE[row.verdict]}>{VERDICT_LABEL[row.verdict]}</Chip> : null}
        <Chip tone="gray">Bi quan {pct(row.pess_margin_pct)} · Cơ sở {pct(row.base_margin_pct)}</Chip>
        <Chip tone="gray">{row.keywords ? (row.keywords as string[]).join(", ") : ""}</Chip>
      </div>
      <ResearchResultView result={result} />

      <div className="mt-4">
        <MarketConcentrationPanel competitors={collection.competitors} velocity={collection.velocity} />
      </div>

      <div className="mt-4">
        <CollectionPanel assessmentId={id} data={collection} connected={!!db} />
      </div>

      <div className="mt-4">
        <PainPanel assessmentId={id} data={pain} connected={!!db} />
      </div>
    </>
  );
}
