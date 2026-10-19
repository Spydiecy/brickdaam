// Everything the tracker needs, run by PM2: `npm run live` builds and (re)starts it.
//   lego-api     JSON API on 127.0.0.1:4100 (local only, no auth)
//   lego-worker  scrapes the stores on a schedule and runs "Fetch live rates" requests
//   lego-web     the website on 127.0.0.1:3000, proxies /api/* to lego-api
// Nothing listens on a public interface: on a server, Cloudflare Tunnel connects to port 3000.
//
// Settings come from a .env file next to this one (see .env.example), then from the shell.

const fs = require('node:fs');
const path = require('node:path');

/** Minimal .env reader (KEY=value lines, # comments), so no extra package is needed. */
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const env = { ...readEnv(path.join(__dirname, '.env')), ...process.env };
const pick = (keys) => Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
const shared = pick(['DB_PATH', 'IMG_DIR', 'BROWSER_CHANNEL', 'PLAYWRIGHT_BROWSERS_PATH', 'TZ']);
const logs = (name) => ({
  out_file: path.join(__dirname, 'logs', `${name}.out.log`),
  error_file: path.join(__dirname, 'logs', `${name}.err.log`),
  time: true,
});

module.exports = {
  apps: [
    {
      name: 'lego-api',
      script: 'dist/api.js',
      cwd: __dirname,
      env: {
        ...shared,
        HOST: '127.0.0.1',
        PORT: '4100',
        ...pick(['TRUST_CLOUDFLARE', 'MAX_PINCODES']),
      },
      max_memory_restart: '500M',
      ...logs('api'),
    },
    {
      name: 'lego-worker',
      script: 'dist/worker.js',
      cwd: __dirname,
      env: {
        ...shared,
        SCRAPE_CRON: env.SCRAPE_CRON ?? '*/5 * * * *',
        SCRAPE_CONCURRENCY: env.SCRAPE_CONCURRENCY ?? '2',
        ...pick(['SLOW_SCRAPE_CRON', 'LIVE_CONCURRENCY', 'ACTIVE_DAYS']),
      },
      // Chrome runs in its own processes; this caps the worker's Node side only.
      max_memory_restart: '1200M',
      ...logs('worker'),
    },
    {
      name: 'lego-web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 127.0.0.1',
      cwd: path.join(__dirname, 'web'),
      env: { NODE_ENV: 'production', LEGO_API_URL: 'http://127.0.0.1:4100' },
      max_memory_restart: '500M',
      ...logs('web'),
    },
  ],
};
