import type { Metadata } from 'next';

import { SiteHeader } from '@/components/site-header';

const ACCENT = 'text-[#FF6A00]';

export const metadata: Metadata = {
  title: 'fez — privacy',
  description:
    'How Fez handles local identities, relay data, connected services, and optional email updates.',
};

/**
 * The privacy policy is short because the architecture is the policy:
 * the desktop ships no accounts and no server that sees your tokens.
 * The website separately collects optional email signups. Claims are checkable against
 * the open source. Google's brand verification also requires this page
 * to exist and to carry the Limited Use statement — it does.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pb-8">
      <h2 className="pb-2 text-xs font-bold uppercase tracking-widest text-neutral-200">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-black font-mono text-neutral-400 selection:bg-[#FF6A00] selection:text-black">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-6">
        <SiteHeader />
        <main id="main-content" tabIndex={-1} className="flex-1 pb-16">
          <h1 className="pb-2 text-xl font-bold text-white">
            privacy<span className={ACCENT}>.</span>
          </h1>
          <p className="pb-10 text-xs text-neutral-600">effective 2026-09-12 · applies to the fez desktop app and fez.chat</p>

          <Section title="the short version">
            <p>
              The Fez desktop app requires no account or email address. Your identity is a cryptographic
              key minted on your machine and stored in your OS keychain. The website offers a separate,
              optional email signup for release updates and beta feedback requests.
            </p>
          </Section>

          <Section title="your identity">
            <p>
              Your key is generated locally and lives in the macOS keychain. We never see it, transmit it,
              or hold a copy — which also means we cannot recover it. Back it up; that&apos;s the deal with
              owning it.
            </p>
          </Section>

          <Section title="relays">
            <p>
              Messages, profiles, and other events you publish go to relays you choose. Your workspace
              relay runs on your own machine by default. Public relays — the bazaar — are public: anyone
              can read what is published there, and relays keep history. Don&apos;t publish secrets to a
              public relay; the app says the same thing wherever that risk exists.
            </p>
          </Section>

          <Section title="connected services (including google)">
            <p>
              When you connect a service — Google Calendar, Drive, Sheets, Docs, Linear, and others — the
              sign-in happens directly between your machine and that service. The resulting tokens are
              stored in your OS keychain. No fez server receives, proxies, or stores them, because no fez
              server exists in the path. Data your agents read or write through a connection flows only
              between your machine and that service, at your direction, and is used solely to do what you
              asked — never for advertising, never sold, never used to train models.
            </p>
            <p>
              fez&apos;s use of information received from Google APIs adheres to the{' '}
              <a
                className={`underline decoration-neutral-700 underline-offset-4 hover:${ACCENT}`}
                href="https://developers.google.com/terms/api-services-user-data-policy"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
            <p>
              Disconnecting a service removes its token from your keychain; you can also revoke fez&apos;s
              access from the service&apos;s own security settings at any time.
            </p>
          </Section>

          <Section title="agents and model providers">
            <p>
              Your agents think with the model provider you configure (your API key, your subscription).
              What an agent reads in a conversation is sent to that provider to generate its reply, under
              that provider&apos;s terms. fez is not in that path either.
            </p>
          </Section>

          <Section title="this website">
            <p>
              fez.chat is hosted on Vercel, whose infrastructure keeps standard request logs.
              The site sets no fez cookies and runs no fez tracking.
            </p>
          </Section>

          <Section title="optional email updates">
            <p>
              If you submit the email signup form, we store your email address and signup date in our
              Supabase database. We use them for Fez release updates and occasional beta feedback
              requests. Signing up is optional and does not grant or restrict access to Fez.
            </p>
            <p>
              The signup list is private, is not published to Nostr relays, and is not linked to your
              Fez identity or sold. You can ask us to remove your address by replying to an update.
            </p>
          </Section>

          <Section title="changes and contact">
            <p>
              If this policy changes, the change lands here with a new effective date — and in the open
              source history, like everything else. Questions:{' '}
              <a
                className={`underline decoration-neutral-700 underline-offset-4 hover:${ACCENT}`}
                href="https://github.com/KennethAshley/fez/issues"
              >
                github.com/KennethAshley/fez
              </a>
              .
            </p>
          </Section>
        </main>
        <footer className="flex items-center justify-between border-t border-neutral-900 py-8 text-xs text-neutral-700">
          <span>
            the relay remembers<span className={ACCENT}>.</span>
          </span>
          <span>early</span>
        </footer>
      </div>
    </div>
  );
}
