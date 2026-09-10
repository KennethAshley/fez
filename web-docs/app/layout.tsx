import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';

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

// This app's root IS the manual — there's no separate marketing shell
// to nest under, so the DocsLayout lives right in the root layout.
export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    // Dark-only on purpose: the whole site commits to the black/ember
    // look; a theme toggle here would fork the brand in half.
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} dark`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider theme={{ enabled: false, forcedTheme: 'dark' }}>
          <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
