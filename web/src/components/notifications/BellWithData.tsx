"use client";

<<<<<<< Updated upstream
import { useEffect, useState, useCallback } from "react";
=======
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
function toneFromSeverity(s: AlertRow["severity"]): "red" | "amber" | "green" {
  return s;
}

export default function BellWithData({ session }: { session: Session }) {
  const supabase = session.mode === "demo" ? null : createClient();
  const fallback: NotificationItem[] = notificationsByPersona[session.persona] ?? [];
=======
export default function BellWithData({ session }: { session: Session }) {
  // Memo supabase client 1 lần duy nhất để tránh loop re-render
  const supabase = useMemo(() => {
    if (session.mode === "demo") return null;
    return createClient();
  }, [session.mode]);

  // Fallback cố định (dùng ref để không đổi qua mỗi render)
  const fallbackRef = useRef<NotificationItem[]>(notificationsByPersona[session.persona] ?? []);
  const fallback = fallbackRef.current;
>>>>>>> Stashed changes

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<NotificationItem[]>(fallback);
  const [live, setLive] = useState(false);
<<<<<<< Updated upstream

  const load = useCallback(async () => {
    if (!supabase) { setLoading(false); setLive(false); setItems(fallback); return; }
    try {
      const { data, error } = await supabase
        .from("ops.my_alerts")
        .select("*")
        .limit(30);
      if (error || !data) {
        setLive(false); setItems(fallback);
=======
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
>>>>>>> Stashed changes
      } else {
        const rows = data as AlertRow[];
        const mapped: NotificationItem[] = rows.map((r) => ({
          id: r.id,
          icon: r.severity === "red" ? "🚨" : r.severity === "amber" ? "⚠️" : "✅",
<<<<<<< Updated upstream
          tone: toneFromSeverity(r.severity),
=======
          tone: r.severity,
>>>>>>> Stashed changes
          title: r.title,
          detail: [r.seller_label ? `Shop ${r.seller_label}` : null, r.detail].filter(Boolean).join(" · "),
          time: relativeTime(r.fired_at),
          read: r.status !== "open",
          category: "alert" as const,
          href: "/module4/account-health",
        }));
<<<<<<< Updated upstream
        // Nếu DB trả 0 rows, hiển thị fallback để dropdown không trống, nhưng đánh dấu là data DB
        setItems(mapped.length > 0 ? mapped : fallback);
        setLive(true);
      }
    } catch {
      setLive(false); setItems(fallback);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, session.persona]);

  useEffect(() => { load(); }, [load]);

  // Mark-as-read: khi mở dropdown thì đánh dấu các alert đang hiển thị sang 'ack'
  const handleOpenChange = useCallback(async (open: boolean) => {
    if (!open || !supabase || !live) return;
    try {
      // Lấy các alert open gần đây nhất của user và mark ack
=======
        if (mapped.length === 0) {
          // DB trả rỗng → giữ mock nhưng đánh dấu LIVE để biết DB hoạt động
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
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
      // refresh
      load();
    } catch { /* ignore */ }
=======
      load();
    } catch {
      // ignore errors — mark-read là nice-to-have
    }
>>>>>>> Stashed changes
  }, [supabase, live, load]);

  return (
    <BellDropdown
      initial={items}
<<<<<<< Updated upstream
      unreadCount={items.filter((n) => !n.read).length}
=======
>>>>>>> Stashed changes
      live={live}
      loading={loading}
      onOpenChange={handleOpenChange}
      onRefresh={load}
    />
  );
}
