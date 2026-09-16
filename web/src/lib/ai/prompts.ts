/**
 * Module 8 G4 — prompt map/reduce cho phân cụm điểm đau review.
 *
 * Quy tắc chống hallucination (đặc tả mục 7):
 *  - Chỉ được trích NGUYÊN VĂN câu trong trường `body` của đúng reviewId đó,
 *    ≤ 25 từ; tuyệt đối không thêm thông tin không có trong review.
 *  - Không bịa số liệu, không sinh điểm/vetô, không gắn reviewId bừa.
 *  - Output JSON thuần theo schema; không viết gì ngoài JSON.
 */

import type {
  AnalysisReview,
  PainObservation,
} from "../research/domain/pain.ts";
import type { MapChunkInput, ReducePainInput } from "./types.ts";

const RULES = `Bạn là chuyên gia R&D thương mại điện tử Amazon (làm việc cho công ty bán hàng Việt Nam).
Nhiệm vụ: phân tích review 1-3 SAO của đối thủ để tìm ĐIỂM ĐAU khách hàng.

BA CỤM PHÂN LOẠI (dùng đúng mã):
- "quality": lỗi/chất lượng sản phẩm (gỉ sét, gãy vỡ, hỏng nhanh, vật liệu kém, không hoạt động, hao mòn sớm).
- "expectation_gap": nhận hàng LỆCH KỲ VỌNG so với listing (nhỏ/to hơn ảnh, màu sai, tính năng không như mô tả, cảm giác rẻ tiền, thiếu phụ kiện QUẢNG CÁO).
- "logistics": đóng gói & vận hành (hộp móp, hàng hư do vận chuyển, giao thiếu món trong kiện, chậm trễ, niêm phong, hướng dẫn lắp ráp).

QUY TẮC BẮT BUỘC:
1. Chỉ trích NGUYÊN VĂN cụm câu ngắn (tối đa 25 từ) nằm trong chính "body" của review được trích, không sửa từ, không dịch câu trích.
2. Mỗi quan sát phải gắn đúng "review_id" của review chứa câu đó; KHÔNG được gán bừa id.
3. Chỉ dùng thông tin có thật trong review; review không nói điểm đau rõ thì bỏ qua.
4. Không bịa số liệu, không sinh điểm số, không kết luận ngoài nội dung review.
5. Chỉ trả JSON thuần theo đúng schema, không markdown, không lời dẫn.`;

function reviewLine(r: AnalysisReview): string {
  return JSON.stringify({
    review_id: r.sourceReviewId,
    asin: r.asin,
    stars: r.stars,
    title: r.title,
    body: r.body,
    verified: r.verified,
    helpful: r.helpfulCount,
    photos: r.photosCount,
    date: r.reviewDate,
  });
}

export function buildMapMessages(input: MapChunkInput): { role: "system" | "user"; content: string }[] {
  const list = input.reviews.map(reviewLine).join("\n");
  const ctx = input.context
    ? `Bối cảnh ngách: sản phẩm "${input.context.title ?? ""}" (từ khóa: ${(input.context.keywords ?? []).join(", ")}; marketplace ${input.context.marketplace ?? "US"}).\n`
    : "";
  return [
    {
      role: "system",
      content: `${RULES}

TRẢ VỀ JSON:
{
  "observations": [
    {
      "review_id": "id đúng của review",
      "cluster": "quality | expectation_gap | logistics",
      "sub_label": "nhãn phụ ngắn bằng tiếng Việt (vd: gỉ sét, sai kích thước, móp hộp) hoặc null",
      "pain_title": "tên điểm đau ngắn gọn bằng tiếng Việt",
      "quote": "cụm câu NGUYÊN VĂN đúng ngôn ngữ trong body, <=25 từ"
    }
  ]
}
Mỗi review có thể có 0-2 quan sát; ưu tiên điểm đau ĐẶC THỂ, có câu trích rõ. Không có pain thì trả mảng rỗng.`,
    },
    {
      role: "user",
      content: `${ctx}Hồ sơ thẩm định ${input.assessmentId} · lô review số ${input.chunkIndex + 1} (${input.reviews.length} review 1-3 sao):\n\n${list}`,
    },
  ];
}

export function buildReduceMessages(
  input: ReducePainInput,
): { role: "system" | "user"; content: string }[] {
  // KHÔNG gửi lại full body (đã có ở bước map): gửi quan sát + metadata để
  // tiết kiệm token; hệ thống sẽ ĐẾM LẠI tần suất/nghiêm trọng sau bước này.
  const meta = new Map(
    input.reviews.map((r) => [
      r.sourceReviewId,
      {
        asin: r.asin,
        stars: r.stars,
        verified: r.verified,
        helpful: r.helpfulCount,
        photos: r.photosCount,
        date: r.reviewDate,
      },
    ]),
  );
  const observations = input.observations.map((o: PainObservation) => ({
    review_id: o.reviewId,
    cluster: o.cluster,
    sub_label: o.subLabel,
    pain_title: o.painTitle,
    quote: o.quote,
    meta: meta.get(o.reviewId) ?? null,
  }));

  return [
    {
      role: "system",
      content: `Bạn là trưởng nhóm R&D. Từ các QUAN SÁT ĐÃ TRÍCH DẪN (bước map), hãy TỔNG HỢP thành 3-5 điểm đau chính của cả ngách.

NGUYÊN TẮC:
1. Gom các quan sát cùng bản chất thành 1 pain; "review_ids" liệt kê ĐÚNG các review_id có trong danh sách quan sát thuộc pain (không bịa id).
2. item_key là slug bất biến viết thường không dấu, gạch nối (vd "rusting-steel-frame"), duy nhất trong kết quả.
3. Đề xuất hướng xử lý:
   - factory_requirement: yêu cầu với XƯỞNG SẢN XUẤT (tiếng Việt, cụ thể, đo được) hoặc null nếu chỉ cần sửa listing.
   - listing_fix: sửa mô tả/ảnh/A+ trên trang Amazon hoặc null.
   - test_method và acceptance_standard: cách kiểm chứng khi nhận mẫu (tiếng Việt) hoặc null.
   - cost_impact_estimate: ước tính sơ bộ tác động chi phí (chuỗi mô tả, vd "+0.3-0.5 USD/đơn vị") hoặc null.
   - effort_hint: 1=nặng? KHÔNG — 1 là RẤT NHẸ (sửa text listing), 2=trung bình (đổi quy cách đóng gói/kiểm soát QC), 3=NẶNG (đổi khuôn/vật liệu/điện tử/chứng nhận).
4. KHÔNG bịa: mọi review_id phải có trong dữ liệu; không thêm số liệu tần suất/nghiêm trọng (hệ thống tự tính).
5. Viết narratives: 2-4 câu tiếng Việt cho TỪNG cụm có dữ liệu, thuật ngữ kỹ thuật tiếng Anh để trong ngoặc; không gắn số chưa được cung cấp.
6. executive_narrative: 3-5 câu tóm tắt điều hành tiếng Việt (pain lớn nhất, hướng cải tiến chính), cấm số bịa.
7. Chỉ trả JSON thuần theo schema.

TRẢ VỀ JSON:
{
  "drafts": [
    {
      "item_key": "slug-khong-dau",
      "cluster": "quality | expectation_gap | logistics",
      "title": "Tên điểm đau tiếng Việt",
      "sub_label": "nhãn phụ hoặc null",
      "review_ids": ["..."],
      "effort_hint": 1,
      "factory_requirement": "... hoặc null",
      "listing_fix": "... hoặc null",
      "test_method": "... hoặc null",
      "acceptance_standard": "... hoặc null",
      "cost_impact_estimate": "... hoặc null"
    }
  ],
  "narratives": { "quality": "...", "expectation_gap": "...", "logistics": "..." },
  "executive_narrative": "..."
}`,
    },
    {
      role: "user",
      content: `Hồ sơ ${input.assessmentId} · ${input.observations.length} quan sát đã trích dẫn:\n\n${JSON.stringify(
        observations,
      )}`,
    },
  ];
}
