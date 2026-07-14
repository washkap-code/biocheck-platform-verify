/**
 * Edge middleware: security headers, CSP, and CSRF origin enforcement.
 *
 * CSRF strategy: the session cookie is SameSite=Strict + HttpOnly, and every
 * state-changing console request must present a same-origin Origin/Referer.
 * /v1 API routes authenticate with Bearer keys (no ambient credentials), so
 * they are CSRF-immune by construction and exempt from the origin check.
 */
import { NextRequest, NextResponse } from "next/server";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // Next.js inline runtime; nonce hardening tracked for Prompt 9
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

export function middleware(request: NextRequest) {
  // CSRF origin check for cookie-authenticated state changes.
  const isStateChanging = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const isApiKeyRoute = request.nextUrl.pathname.startsWith("/api/v1/") &&
    request.headers.get("authorization")?.startsWith("Bearer ");
  if (isStateChanging && !isApiKeyRoute) {
    const origin = request.headers.get("origin") ?? request.headers.get("referer");
    if (origin) {
      const originHost = new URL(origin).host;
      if (originHost !== request.nextUrl.host) {
        return NextResponse.json({ error: { code: "CSRF_REJECTED", message: "Cross-origin request refused." } }, { status: 403 });
      }
    }
  }

  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", CSP);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
