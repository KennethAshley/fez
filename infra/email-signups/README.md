# Website email signups

Optional email collection for fez.chat. Stores an address and its first signup
date; sends no mail and does not gate downloads or create a Fez identity.

## Deploy

1. Apply `schema.sql` to the existing company Supabase project
   (`oxspgofacphchtuduaum`). The table has RLS enabled and no public grants.
2. Deploy `index.ts` as the `email-signups` edge function with JWT verification
   off. It accepts anonymous submissions and uses the runtime's built-in
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to write privately.
3. Deploy the website after the function is available. `/api/email-signups`
   proxies to that function. `FEZ_EMAIL_SIGNUPS_URL` can point preview/local
   environments at a separate function; no service key belongs in the browser.

Export `public.fez_email_signups` to CSV through the Supabase dashboard when
needed. Delete an address there when someone asks to be removed. Add a mailing
service with unsubscribe handling when sending updates; this feature only
collects addresses, without verifying ownership or sending confirmation mail.

Repeated submissions preserve the first signup date and return the same
confirmation as new submissions. The endpoint never returns stored addresses.
Validation, a small request-size limit, and a form honeypot reject malformed
submissions and basic bots. The honeypot is not a rate limit or a CAPTCHA.

Run the regression check from `packages/fez-evals`:

```sh
npx vitest --run tests/website-email-signups.test.ts
```

It exercises both request handlers with storage HTTP responses controlled by
the test; deployment still needs a real insert and private-table access check.
