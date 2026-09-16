/**
 * Module 8 G6 — renderer THUẦN doc TipTap → React cho trang in.
 * Không nạp ProseMirror: PDF/screen in dùng đúng cây JSON đã lưu (bản đã duyệt
 * là bất biến), chip số/câu trích render y hệt editor nhưng chỉ đọc.
 */

import React from "react";
import type { TiptapDoc, TiptapNode } from "@/lib/research/domain";

type AnyNode = Record<string, unknown> & { type?: string };

function renderInline(node: TiptapNode | AnyNode, key: number): React.ReactNode {
  if (node.type === "text") {
    let out: React.ReactNode = node.text as string;
    const marks = (node.marks ?? []) as { type: string; attrs?: Record<string, unknown> }[];
    for (const mark of marks) {
      if (mark.type === "bold") out = <strong key={`b${key}`}>{out}</strong>;
      else if (mark.type === "italic") out = <em key={`i${key}`}>{out}</em>;
      else if (mark.type === "link") {
        out = (
          <a key={`l${key}`} href={String(mark.attrs?.href ?? "#")} className="pr-link">
            {out}
          </a>
        );
      }
    }
    return <React.Fragment key={key}>{out}</React.Fragment>;
  }
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type === "metricToken") {
    const a = (node.attrs ?? {}) as { key?: string; label?: string; value?: string };
    return (
      <span key={key} className="pr-chip pr-chip-metric" title={a.label}>
        <span aria-hidden>🔢 </span>
        {a.value}
      </span>
    );
  }
  if (node.type === "quoteChip") {
    const a = (node.attrs ?? {}) as {
      reviewId?: string;
      asin?: string;
      quote?: string;
      stars?: number | null;
      url?: string | null;
    };
    const body = (
      <>
        <span className="pr-chip-badge">
          {typeof a.stars === "number" ? `★${a.stars} ` : ""}
          {a.reviewId}
        </span>{" "}
        “{a.quote}”
      </>
    );
    return a.url ? (
      <a key={key} href={a.url} className="pr-chip pr-chip-quote">
        <span aria-hidden>💬 </span>
        {body}
      </a>
    ) : (
      <span key={key} className="pr-chip pr-chip-quote">
        <span aria-hidden>💬 </span>
        {body}
      </span>
    );
  }
  return null;
}

function renderBlock(node: TiptapNode | AnyNode, key: number): React.ReactNode {
  const content = (node.content ?? []) as TiptapNode[];
  switch (node.type) {
    case "paragraph":
      if (content.length === 0) return <p key={key} className="pr-empty" />;
      return <p key={key}>{content.map(renderInline)}</p>;
    case "heading":
      return <h3 key={key}>{content.map(renderInline)}</h3>;
    case "bulletList":
      return <ul key={key}>{content.map((li, i) => renderBlock(li, i))}</ul>;
    case "orderedList":
      return <ol key={key}>{content.map((li, i) => renderBlock(li, i))}</ol>;
    case "listItem":
      return (
        <li key={key}>
          {((node.content ?? []) as TiptapNode[]).map((p, i) => {
            const inner = (p.content ?? []) as TiptapNode[];
            if (p.type === "paragraph") return <React.Fragment key={i}>{inner.map(renderInline)}</React.Fragment>;
            return renderBlock(p, i);
          })}
        </li>
      );
    case "blockquote":
      return <blockquote key={key}>{content.map(renderBlock)}</blockquote>;
    default:
      if (content.length) return <React.Fragment key={key}>{content.map(renderBlock)}</React.Fragment>;
      return null;
  }
}

export function PrintDoc({ doc }: { doc: TiptapDoc | null | undefined }) {
  if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) {
    return <p className="pr-missing">— Chưa có nội dung phần này —</p>;
  }
  return <div className="pr-doc">{(doc.content as TiptapNode[]).map(renderBlock)}</div>;
}
