"use client";

/**
 * Module 8 G5 — custom node TipTap cho "số khóa cứng" và "câu trích truy gốc".
 * Hai node inline, atom: không gõ/sửa được nội dung bên trong; người viết chỉ
 * chèn/xóa NGUYÊN CHIP. Mọi attr đều do máy sinh (không có UI tự bịa).
 */

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { MetricToken, QuoteToken } from "@/lib/research/domain";

/* ------------------------------ METRIC ---------------------------------- */

function MetricTokenView(props: NodeViewProps) {
  const { label, value } = props.node.attrs as unknown as MetricToken;
  return (
    <NodeViewWrapper as="span" contentEditable={false} className="not-prose align-middle">
      <span
        title={`Số khóa cứng: ${label}`}
        className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[12px] font-medium text-blue-800"
      >
        <span className="text-blue-400" aria-hidden>🔢</span>
        {value}
      </span>
    </NodeViewWrapper>
  );
}

export const MetricTokenNode = Node.create({
  name: "metricToken",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      key: { default: "" },
      label: { default: "" },
      value: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-metric-token]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-metric-token": HTMLAttributes.key }),
      `${HTMLAttributes.label}: ${HTMLAttributes.value}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MetricTokenView);
  },
});

/* ------------------------------ QUOTE ----------------------------------- */

function stars(n: number | null): string {
  if (typeof n !== "number") return "★";
  return `★${n}`;
}

function QuoteChipView(props: NodeViewProps) {
  const q = props.node.attrs as unknown as QuoteToken;
  const body = (
    <>
      <span className="mr-1 rounded bg-amber-200/70 px-1 text-[10px] font-bold text-amber-900">
        {stars(q.stars)} {q.reviewId}
      </span>
      <span>&ldquo;{q.quote}&rdquo;</span>
    </>
  );
  return (
    <NodeViewWrapper as="span" contentEditable={false} className="not-prose align-middle">
      {q.url ? (
        <a
          href={q.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Câu trích gốc từ review ${q.reviewId} (ASIN ${q.asin}${q.reviewDate ? `, ${q.reviewDate.slice(0, 10)}` : ""}) — mở Amazon để đối chiếu`}
          className="mx-0.5 inline max-w-md items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[12px] text-amber-900 underline decoration-dotted hover:bg-amber-100"
        >
          <span className="text-amber-500" aria-hidden>💬</span>
          {body}
        </a>
      ) : (
        <span
          title={`Câu trích review ${q.reviewId} (ASIN ${q.asin}${q.reviewDate ? `, ${q.reviewDate.slice(0, 10)}` : ""})`}
          className="mx-0.5 inline max-w-md items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[12px] text-amber-900"
        >
          <span className="text-amber-500" aria-hidden>💬</span>
          {body}
        </span>
      )}
    </NodeViewWrapper>
  );
}

export const QuoteChipNode = Node.create({
  name: "quoteChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      reviewId: { default: "" },
      asin: { default: "" },
      quote: { default: "" },
      stars: { default: null },
      reviewDate: { default: null },
      url: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-quote-chip]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-quote-chip": HTMLAttributes.reviewId }),
      HTMLAttributes.quote,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(QuoteChipView);
  },
});
