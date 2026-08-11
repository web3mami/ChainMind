import { NextResponse } from "next/server";

export const runtime = "edge";

/**
 * Apple App Site Association — universal links for the iOS app.
 * Served without .json extension and with application/json.
 */
export async function GET() {
  const body = {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: ["K833KYDJ8W.fun.chainmind.app"],
          paths: ["/research/*", "/ask", "/"],
        },
      ],
    },
    webcredentials: {
      apps: ["K833KYDJ8W.fun.chainmind.app"],
    },
  };
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
  });
}
