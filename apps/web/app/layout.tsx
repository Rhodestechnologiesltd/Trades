import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { Header, Providers } from '../src/client';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Trades — trusted local pros in Mauritius', template: '%s · Trades' },
  description: 'Book verified electricians, plumbers, cleaners, nannies, mechanics and more. Compare quotes, pay securely, and only release payment when the job is done.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'),
  openGraph: { type: 'website', siteName: 'Trades' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          {children}
          <footer className="site"><div className="container row spread"><span>© {new Date().getFullYear()} Trades Ltd · Mauritius</span><span>Payments processed securely by MIPS · <a href="/pro">Become a pro</a></span></div></footer>
        </Providers>
      </body>
    </html>
  );
}
