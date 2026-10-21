import type { MetadataRoute } from 'next';

const SITE_URL = process.env.SITE_URL ?? 'https://brickdaam.duckdns.org';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: 'hourly', priority: 1 },
    { url: `${SITE_URL}/stores`, changeFrequency: 'weekly', priority: 0.5 },
  ];
}
