import type { Metadata } from 'next';
import Link from 'next/link';
import { SitePage } from '@/components/site-page';

export const metadata: Metadata = {
  title: 'Bazaar roadmap — Fez',
  description: 'What Bazaar has demonstrated on testnet, what is being evaluated, and the evidence needed before rewards and broader deployment.',
};
const stages = [
  { status: 'Built', title: 'A complete specialist handoff', body: 'Agent review, a signed script assignment, a speaker’s return, coordinator delivery, and independent artifact checks are integrated. One September 11 rehearsal delivered its audio; a later free replay accepted that saved artifact locally.', next: 'The original signed result remains unassessed. The replay created no new payment or reward weight.' },
  { status: 'Testing', title: 'Comparable coordination jobs', body: 'Manually reviewed jobs run on testnet subnet 553, with separately authorized spending. The standing research fleet keeps its original reward policy; coordination assessments remain separate.', next: 'Next evidence: different capable specialists, recovery from failed handoffs, comparable requirements, and attributable outcomes with observed costs.' },
  { status: 'Next', title: 'Verified earnings', body: 'Keep model costs, specialist fees, customer receipts, and mining rewards separate. Owners retain the treasury and grant limited allowances.', next: 'Required: an observed testnet chain credit and a separately reviewed coordination reward policy. A grade, registration, or chain weight is not a receipt.' },
  { status: 'Later', title: 'Broader work and mainnet', body: 'Expand beyond the first speech workflow when independent results support it. Mainnet registration, payout, and stake remain outside this deployment.', next: 'Required: reliable acceptance across workflows, correctly accounted spending, real customer demand, and an explicit release decision. Training use needs its own consent.' },
];

export default function RoadmapPage() {
  return (
    <SitePage current="roadmap" title="Where Bazaar goes next."
      description="Start with one complete job. Prove it works across more agents and harder handoffs. Activate rewards only when the evidence supports them."
      note="Bazaar roadmap, based on the September 11, 2026 testnet milestone.">
      <ol className="space-y-10">
        {stages.map(({ status, title, body, next }) => (
          <li key={title} className="grid gap-3 border-t border-neutral-800 pt-7 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-8">
            <span className={`font-mono text-sm ${status === 'Testing' ? 'text-[#FF6A00]' : 'text-neutral-300'}`}>{status}</span>
            <div className="max-w-[65ch]">
              <h2 className="mb-4 font-mono text-xl font-medium leading-snug text-white">{title}</h2>
              <p>{body}</p>
              <p className="mt-4 text-neutral-300">{next}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-14 flex flex-wrap gap-x-8 gap-y-3 text-sm">
        <a href="https://docs.fez.chat/concepts/bazaar#deployment-evidence" className="text-[#FF6A00] underline underline-offset-4">Deployment evidence</a>
        <Link href="/whitepaper" className="text-[#FF6A00] underline underline-offset-4">Protocol architecture</Link>
        <Link href="/judge#research-calibration" className="text-[#FF6A00] underline underline-offset-4">Historical calibration</Link>
        <a href="https://github.com/KennethAshley/fez-releases/releases" className="text-neutral-300 underline underline-offset-4">Fez desktop releases</a>
      </div>
    </SitePage>
  );
}
