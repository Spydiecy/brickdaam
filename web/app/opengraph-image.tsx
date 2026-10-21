import { ImageResponse } from 'next/og';

// Preview card shown when the site is shared (X/Twitter, WhatsApp, Telegram...). Built once at build time.
export const alt = 'Brick Daam: LEGO prices across Indian stores';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  const studs = [0, 1, 2, 3];
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          background: '#FFD500',
          padding: '0 90px',
        }}
      >
        {/* A 2x2 brick seen from above, the same mark as the site logo. */}
        <div
          style={{
            width: 280,
            height: 280,
            borderRadius: 40,
            background: '#D01012',
            display: 'flex',
            flexWrap: 'wrap',
            alignContent: 'space-around',
            justifyContent: 'space-around',
            padding: 24,
          }}
        >
          {studs.map((i) => (
            <div key={i} style={{ width: 96, height: 96, borderRadius: 48, background: '#F0262A', boxShadow: '0 8px 0 #8E0A0D' }} />
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 70 }}>
          <div style={{ display: 'flex', fontSize: 120, fontWeight: 900, color: '#111', letterSpacing: -3 }}>
            Brick<span style={{ color: '#D01012' }}>daam</span>
          </div>
          <div style={{ fontSize: 44, fontWeight: 700, color: '#111', marginTop: 10, maxWidth: 640 }}>
            Live LEGO prices across Indian stores
          </div>
          <div style={{ fontSize: 30, color: '#333', marginTop: 22 }}>Blinkit · Zepto · Amazon · Flipkart · and more</div>
        </div>
      </div>
    ),
    size,
  );
}
