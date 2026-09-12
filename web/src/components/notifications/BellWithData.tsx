"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import BellDropdown from "@/components/notifications/BellDropdown";
import { notificationsByPersona } from "@/lib/data/mock";
import type { Session } from "@/lib/auth/session";
import type { NotificationItem } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";

type AlertRow = {
  id: string;
  severity: "red" | "amber" | "green";
  title: string;
  detail: string | null;
  status: "open" | "ack" | "resolved";
  fired_at: string;
  seller_label: string | null;
};

function relativeTime(iso: string) {
  const d = new Date(iso).getTime();
  if (!d) return "";
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "vừa xong";
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const day = Math.floor(h / 24);
  return `${day} ngày trước`;
}

export default function BellWithData({ session }: { session: Session }) {
  const supabase = useMemo(() => {
    if (session.mode === "demo") return null;
    return createClient();
  }, [session.mode]);

  const fallbackRef = useRef<NotificationItem[]>(notificationsByPersona[session.persona] ?? []);
  const fallback = fallbackRef.current;

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<NotificationItem[]>(fallback);
  const [live, setLive] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      setLive(false);
      setItems(fallback);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("ops.my_alerts")
        .select("id,severity,title,detail,status,fired_at,seller_label")
        .limit(30);
      if (!mountedRef.current) return;
      if (error || !data) {
        setLive(false);
        setItems(fallback);
      } else {
        const rows = data as AlertRow[];
        const mapped: NotificationItem[] = rows.map((r) => ({
          id: r.id,
          icon: r.severity === "red" ? "🚨" : r.severity === "amber" ? "⚠️" : "✅",
          tone: r.severity,
          title: r.title,
          detail: [r.seller_label ? `Shop ${r.seller_label}` : null, r.detail].filter(Boolean).join(" · "),
          time: relativeTime(r.fired_at),
          read: r.status !== "open",
          category: "alert" as const,
          href: "/module4/account-health",
        }));
        if (mapped.length === 0) {
          setItems(fallback);
        } else {
          setItems(mapped);
        }
        setLive(true);
      }
    } catch {
      if (!mountedRef.current) return;
      setLive(false);
      setItems(fallback);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [supabase, fallback]);

  useEffect(() => {
    load();
  }, [load]);

  const handleOpenChange = useCallback(async (open: boolean) => {
    if (!open || !supabase || !live) return;
    try {
      const { data } = await supabase
        .from("ops.my_alerts")
        .select("id")
        .eq("status", "open")
        .limit(20);
      const openIds = (data ?? []).map((r) => (r as { id: string }).id);
      if (openIds.length === 0) return;
      await supabase
        .from("ops.alerts")
        .update({ status: "ack" })
        .in("id", openIds);
      load();
    } catch {
      // ignore
    }
  }, [supabase, live, load]);

  return (
    <BellDropdown
      initial={items}
      live={live}
      loading={loading}
      onOpenChange={handleOpenChange}
      onRefresh={load}
    />
  );
}
