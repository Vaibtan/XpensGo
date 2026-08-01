import { getCloudflareContext } from "@opennextjs/cloudflare";

function forwardToApi(request: Request): Promise<Response> {
  const { env } = getCloudflareContext();
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, "https://xpensego-api.internal");

  return env.API.fetch(new Request(target, request));
}

export const dynamic = "force-dynamic";

export const GET = forwardToApi;
export const POST = forwardToApi;
export const PUT = forwardToApi;
export const PATCH = forwardToApi;
export const DELETE = forwardToApi;
