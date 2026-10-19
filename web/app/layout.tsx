import type { Metadata } from 'next';
import { Figtree, Noto_Sans_Devanagari } from 'next/font/google';
import { Header } from '@/components/Header';
import { PincodeProvider } from '@/components/PincodeProvider';
import './globals.css';

const font = Figtree({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800', '900'], variable: '--font' });

const hindi = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  weight: ['800', '900'],
  variable: '--font-hindi',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Brick Daam · LEGO prices across Indian stores',
  description: 'Live LEGO set prices from Blinkit, Zepto, Amazon, Flipkart and more, for your pincode.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${font.variable} ${hindi.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <PincodeProvider>
          <Header />
          <main id="main">{children}</main>
        </PincodeProvider>
        <footer className="footer">
          <div className="wrap footer-inner">
            <p>
              Prices are read from each store’s public pages for your pincode and can change at any moment.
              Check the store before you buy.
            </p>
            <p>
              LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this site. Set images and
              data from Rebrickable.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
