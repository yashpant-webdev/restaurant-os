import type { Metadata } from 'next';
import { Manrope, Syne } from 'next/font/google';
import './globals.css';
import { Shell } from '@/components/Shell';

const syne = Syne({ subsets: ['latin'], variable: '--font-syne', weight: ['500', '600', '700', '800'] });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope' });

export const metadata: Metadata = {
  title: 'Restaurant OS Dashboard',
  description: 'Central dashboard: live sales, menu, tables, staff, reports.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${syne.variable} ${manrope.variable}`}>
      <body className="antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
