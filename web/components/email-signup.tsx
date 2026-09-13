'use client';

import { useState } from 'react';

export function EmailSignup() {
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');

  return (
    <div className="w-full text-left">
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
        <label htmlFor="signup-email" className="block text-xl font-medium tracking-tight text-neutral-100">Get Fez updates</label>
        <p id="signup-description" className="mt-3 max-w-xs text-sm leading-6 text-neutral-400">
          We’re sharing the Mac app with a small group first. Get release updates
          and occasional beta feedback requests.
        </p>
        {status !== 'success' && (
          <>
            <div className="mt-6 flex items-center gap-4 border-b border-neutral-600 focus-within:border-[#FF6A00]">
              <input
                id="signup-email" name="email" type="email" required maxLength={254}
                autoComplete="email" placeholder="Your email" aria-describedby="signup-description"
                disabled={status === 'pending'}
                className="min-h-12 min-w-0 flex-1 bg-transparent py-3 text-base text-neutral-100 placeholder:text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00]"
              />
              <button type="submit" disabled={status === 'pending'}
                className="min-h-12 shrink-0 py-3 text-xs font-medium text-[#FF6A00] transition-colors hover:text-[#FF8533] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FF6A00] disabled:opacity-50">
                {status === 'pending' ? 'Saving…' : 'Keep me posted'}
              </button>
            </div>
            <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
          </>
        )}
        <div role="status" aria-live="polite" className="mt-3 text-sm text-neutral-200">
          {status === 'success' && "You're on the list. We'll keep you posted."}
        </div>
        {status === 'error' && <p role="alert" className="mt-2 text-sm text-orange-300">Couldn&apos;t save your email. Please try again.</p>}
        <a href="/privacy" className="mt-2 inline-block text-xs text-neutral-400 underline underline-offset-4 hover:text-neutral-200">Privacy</a>
      </form>
    </div>
  );
}
