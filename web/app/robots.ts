import type { MetadataRoute } from 'next';

const SITE_URL = process.env.SITE_URL ?? 'https://brickdaam.duckdns.org';

// Search engines may read the pages, but not the API (large, changes every few minutes).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: '/api/' }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
