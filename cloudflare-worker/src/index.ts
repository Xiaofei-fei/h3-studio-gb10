interface Env {
  H3_ORIGIN: Fetcher;
}

function makeOriginRequest(request: Request): Request {
  const publicUrl = new URL(request.url);
  const originUrl = new URL(`http://localhost:5174${publicUrl.pathname}${publicUrl.search}`);
  const headers = new Headers(request.headers);
  headers.delete('host');

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  return new Request(originUrl, init);
}

function withApiNoStore(response: Response, pathname: string): Response {
  if (!pathname.startsWith('/api/')) return response;

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const response = await env.H3_ORIGIN.fetch(makeOriginRequest(request));
      return withApiNoStore(response, new URL(request.url).pathname);
    } catch {
      return new Response('H3 Studio origin is temporarily unavailable.', {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
  },
} satisfies ExportedHandler<Env>;
