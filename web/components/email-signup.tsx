'use client';

import { useState } from 'react';

export function EmailSignup() {
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');

  return (
    <div className="mx-auto mt-8 w-full max-w-sm text-left">
      <form onSubmit={async event => {
        event.preventDefault();
        if (status === 'pending') return;
        const data = new FormData(event.currentTarget);
        setStatus('pending');
        try {
          const response = await fetch('/api/email-signups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: data.get('email'), website: data.get('website') }),
            signal: AbortSignal.timeout(15000),
          });
          setStatus(response.ok && (await response.json()).ok === true ? 'success' : 'error');
        } catch {
          setStatus('error');
        }
      }}>
        <label htmlFor="signup-email" className="block text-xs text-neutral-200">Get Fez updates</label>
        <p id="signup-description" className="mt-2 text-xs leading-relaxed text-neutral-400">
          Release updates and occasional beta feedback requests. Optional.
        </p>
        {status !== 'success' && (
          <>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                id="signup-email" name="email" type="email" required maxLength={254}
                autoComplete="email" placeholder="Your email" aria-describedby="signup-description"
                disabled={status === 'pending'}
                className="min-w-0 flex-1 border border-neutral-700 bg-black px-3 py-3 text-sm text-neutral-200 placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
              />
              <button type="submit" disabled={status === 'pending'}
                className="border border-neutral-700 px-4 py-3 text-xs text-neutral-200 transition-colors hover:border-[#FF6A00] hover:text-[#FF6A00] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] disabled:opacity-50">
                {status === 'pending' ? 'Saving…' : 'Keep me posted'}
              </button>
            </div>
            <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
          </>
        )}
        <div role="status" aria-live="polite" className="mt-2 text-xs text-neutral-200">
          {status === 'success' && "You're on the list. Thanks for trying Fez."}
        </div>
        {status === 'error' && <p role="alert" className="mt-2 text-xs text-orange-300">Couldn&apos;t save your email. Please try again.</p>}
        <a href="/privacy" className="mt-2 inline-block text-xs text-neutral-400 underline underline-offset-4 hover:text-neutral-200">Privacy</a>
      </form>
    </div>
  );
}
