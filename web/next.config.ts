import type { NextConfig } from 'next';

// The tracker API (dist/api.js) listens on 127.0.0.1 only; the site proxies /api/* to it, so the
// browser only ever talks to this one origin. Note: rewrites are fixed at build time.
const API = process.env.LEGO_API_URL ?? 'http://127.0.0.1:4100';

// What the site may load. Everything is same-origin except Google Fonts (inlined by next/font,
// so not needed) and links out to the stores, which are plain navigations.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // Next.js inlines small bootstrap scripts
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          // Browsers that have seen the site over HTTPS refuse to use plain HTTP for a year.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        ],
      },
    ];
  },
  images: {
    // Set photos are served by the tracker as small cached WebP files (/api/img/...).
    unoptimized: true,
  },
  // web/ has its own lockfile; tell Next this folder is the project root.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
};

export default config;
