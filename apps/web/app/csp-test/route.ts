export const dynamic = "force-dynamic";

const csp = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export async function GET() {
  const html = `<!doctype html><html><body><form method="post" action="/csp-test"><button type="submit">Submit</button></form></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp } });
}

export async function POST() {
  return Response.redirect("https://example.com/callback?code=test123", 302);
}
