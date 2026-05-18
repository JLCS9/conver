// GET /api/health
// Liveness probe. Always returns 200 with a timestamp.
// Used by docker-compose healthcheck and external uptime monitors.

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: true,
    service: "converflow-backend",
    version: process.env.npm_package_version ?? "0.1.0",
    timestamp: new Date().toISOString(),
  });
}
