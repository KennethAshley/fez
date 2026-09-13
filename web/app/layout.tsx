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
    // Dark-only on purpose: the whole site commits to the black/ember
    // look; a theme toggle here would fork the brand in half.
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} dark`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">{children}</body>
    </html>
  );
}
