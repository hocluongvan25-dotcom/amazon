import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({
    commit: "ee1fcc1",
    hasOauthBypass: true,
    timestamp: new Date().toISOString(),
    bypassPaths: ["/api/cron","/api/webhooks","/api/whoami","/api/amazon/whoami","/api/oauth"],
  });
}
