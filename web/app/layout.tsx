import './global.css';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

// Plex Mono carries the headings and navigation; Plex Sans keeps longer
// articles readable within the same type family.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    // Product and research routes retain their dark surfaces; the homepage
    // defines its own light presentation.
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} dark`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">{children}</body>
    </html>
  );
}
