import './global.css';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

// The site's voice is terminal-native (the home pages are all-mono on
// black). Docs read long, so prose gets a sans — but the same Plex
// superfamily, so chrome and body are siblings, not strangers.
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
