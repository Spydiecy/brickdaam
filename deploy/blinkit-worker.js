// Cloudflare Worker (free plan) that forwards Blinkit search requests for the tracker.
//
// Blinkit's firewall blocks cloud servers such as AWS, but accepts requests that start inside
// Cloudflare's own network. The tracker calls this Worker instead of calling Blinkit directly:
//
//   GET <worker-url>/?lat=28.43&lon=77.07                  first page of LEGO search results
//   GET <worker-url>/?lat=..&lon=..&next=/v1/layout/search?offset=12&...   a following page
//
// Every call needs the header  x-key: <KEY>  so strangers cannot use your Worker.
// Deploy: Cloudflare dashboard > Workers & Pages > Create > Hello World > Deploy > Edit code,
// paste this file, change KEY below to a long random string, Deploy. Put the same string in the
// server's .env as BLINKIT_WORKER_KEY and the Worker address as BLINKIT_WORKER_URL.

const KEY = 'REPLACE_WITH_A_LONG_RANDOM_STRING';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

export default {
  async fetch(req) {
    if (req.headers.get('x-key') !== KEY) return new Response('forbidden', { status: 403 });

    const u = new URL(req.url);
    const lat = u.searchParams.get('lat');
    const lon = u.searchParams.get('lon');
    if (!/^-?\d+(\.\d+)?$/.test(lat ?? '') || !/^-?\d+(\.\d+)?$/.test(lon ?? '')) {
      return new Response('lat and lon are required', { status: 400 });
    }

    // Only Blinkit's search endpoint can be reached through this Worker.
    const next = u.searchParams.get('next');
    const path = next ?? '/v1/layout/search?q=lego&search_type=type_to_search';
    if (!path.startsWith('/v1/layout/search?')) return new Response('bad path', { status: 400 });

    const r = await fetch(`https://blinkit.com${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        'accept-language': 'en-IN',
        origin: 'https://blinkit.com',
        referer: 'https://blinkit.com/s/?q=lego',
        'user-agent': UA,
        access_token: 'null',
        app_client: 'consumer_web',
        app_version: '1010101010',
        auth_key: 'c761ec3633c22afad934fb17a66385c1c06c5472b4898b866b7306186d0bb477',
        // A fresh id per call: one fixed id behind thousands of requests looks like a bot.
        device_id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        lat,
        lon,
        rn_bundle_version: '1009003012',
        session_uuid: crypto.randomUUID(),
        web_app_version: '1008010016',
        cookie: `gr_1_lat=${lat}; gr_1_lon=${lon}`,
      },
      body: '{}',
    });
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' },
    });
  },
};
