/**
 * CLI drain hàng đợi thu thập Module 8 — chạy từ MÁY CÓ MẠNG RA Rainforest &
 * Supabase (VPS/Vercel/máy dev), KHÔNG cần Next.js server.
 *
 *   cd web
 *   npm run worker:research-collect -- --kinds=serp,products,reviews --max=20
 *
 * Tự nạp biến môi trường từ .env.local rồi .env (không ghi đè biến đã có trong
 * môi trường). Thiếu SUPABASE_SERVICE_ROLE_KEY → cổng no-op (chỉ thử provider,
 * không ghi DB); thiếu RAINFOREST_API_KEY → provider mock.
 *
 * LƯU Ý credits Rainforest: chỉ chạy lượt đã xếp hàng (queued). Sản phẩm
 * direct tốn 3 credits/ASIN; Collection bất đồng bộ không drain ở CLI này —
 * kết quả về qua webhook /api/webhooks/rainforest.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runResearchCollect } from "../lib/worker/run-research-collect.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "..");

for (const f of [".env.local", ".env"]) {
  const p = join(webRoot, f);
  if (!existsSync(p)) continue;
  for (const rawLine of readFileSync(p, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(`--${name}=`.length);
}

// G4: mặc định drain cả 'analyze' (phân tích pain bằng LLM sau khi review về);
// tách riêng bằng --kinds=reviews,analyze nếu chỉ muốn chạy phần phân tích.
const kinds = (arg("kinds") ?? "serp,products,reviews,analyze")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
const maxArg = Number(arg("max"));
const max = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : 20;

const result = await runResearchCollect({
  kinds,
  max,
  log: (line) => console.log(line),
});

console.log(JSON.stringify(result, null, 2));
if (result.mode !== "production") {
  console.warn(
    `\n[worker] mode=${result.mode} (provider=${result.providerName}, db=${result.db}). ` +
      "Cần đủ NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + RAINFOREST_API_KEY để chạy production.",
  );
  process.exitCode = 1;
}
