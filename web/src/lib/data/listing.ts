/**
 * Supabase reader cho Module 1 — Listing & Content.
 * Đọc từ public views: vexim_listings, vexim_listing_queue.
 */

import { createClient } from "@/lib/supabase/server";
import {
  LISTINGS_SELECT,
  LISTING_QUEUE_SELECT,
  type ListingRaw,
  readAll,
} from "./listing-model";

export async function readListings(): Promise<ListingRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<ListingRaw>((from, to) =>
    client
      .from("vexim_listings")
      .select(LISTINGS_SELECT)
      .order("status")
      .order("sku")
      .range(from, to),
  );
}

export async function readListingQueue(): Promise<ListingRaw[]> {
  const client = await createClient();
  if (!client) throw new Error("Supabase unavailable");

  return readAll<ListingRaw>((from, to) =>
    client
      .from("vexim_listing_queue")
      // vexim_listing_queue không có cột buy_box_* → select riêng, nếu không PostgREST
      // trả PGRST204 và cả trang L4 sập (không phải "chỉ thiếu một cột").
      .select(LISTING_QUEUE_SELECT)
      .order("error_count", { ascending: false })
      .order("sku")
      .range(from, to),
  );
}
