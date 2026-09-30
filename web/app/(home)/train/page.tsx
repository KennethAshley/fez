import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { TrainingDashboard } from '@/components/training-dashboard';
import { serviceUrl } from '@/lib/training';
import styles from './train.module.css';

export const metadata: Metadata = {
  title: 'fez — training dashboard',
  description: 'Submit labeled datasets, follow training jobs, and inspect evaluated model artifacts. Development preview.',
  robots: { index: false, follow: false },
};

export default function TrainPage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const apiUrl = process.env.NEXT_PUBLIC_FEZ_TRAINING_API_URL || '';
  let configured = Boolean(url && key && apiUrl && !key.startsWith('sb_secret_'));
  try { if (configured) { serviceUrl(url); serviceUrl(apiUrl); } } catch { configured = false; }
  return <div className={styles.page}><div className={styles.container}>
    <SiteHeader tone="light" />
    <main id="main-content" tabIndex={-1}>
      <div className={styles.hero}><p className={styles.eyebrow}>FEZ / TRAINING / DEVELOPMENT PREVIEW</p><h1>A model for your decisions.</h1><p>Provide labeled examples, set your acceptance criteria, and inspect the measured result. This interface is in development; it is not a launched training service.</p></div>
      {configured ? <TrainingDashboard config={{ url, key, apiUrl }} /> : <section className={styles.panel} aria-labelledby="offline-title"><span className={styles.badge}>Not connected</span><h2 id="offline-title">Training is not configured here yet.</h2><p>Sign-in, uploads, and job submission become available once this environment is connected to Supabase and the training coordinator. No jobs are simulated.</p><div className={styles.actions}><Link href="/" className={styles.button}>Back to Fez</Link><Link href="/model" className={styles.secondary}>Explore the research ↗</Link></div></section>}
    </main>
    <footer className={styles.footer}><span>Fez training · Experimental</span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></footer>
  </div></div>;
}
