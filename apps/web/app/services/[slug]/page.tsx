import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getCategories } from '../../../src/server';

export async function generateStaticParams() {
  return (await getCategories()).map(c => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const c = (await getCategories()).find(x => x.slug === slug);
  return c ? { title: `${c.name} in Mauritius`, description: `Book verified ${c.name.toLowerCase()} near you. Compare quotes, pay securely, approve when done.` } : {};
}

export default async function ServicePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = (await getCategories()).find(x => x.slug === slug);
  if (!c) notFound();
  return (
    <main className="container" style={{ padding: '40px 20px' }}>
      <h1>{c.name} near you</h1>
      <p className="muted">Verified, reviewed {c.name.toLowerCase()} across Mauritius. {c.requiresLicense ? 'All pros in this category hold a valid trade licence.' : ''} {c.requiresBackgroundCheck ? 'Every pro has passed a background check.' : ''}</p>
      <div className="row" style={{ margin: '20px 0 30px' }}>
        <a className="btn" href={`/request/new?categoryId=${c.id}`}>Get quotes</a>
        {c.urgencyAllowed ? <a className="btn urgent" href={`/request/new?categoryId=${c.id}&mode=urgent`}>⚡ Urgent</a> : null}
      </div>
      {c.children.length ? (
        <>
          <h2>What we can help with</h2>
          <div className="grid cats">{c.children.map(s => <a key={s.id} className="card link" href={`/request/new?categoryId=${s.id}`}><strong>{s.name}</strong></a>)}</div>
        </>
      ) : null}
      {c.instantAcceptPrice ? <div className="banner" style={{ marginTop: 24 }}>Emergency call-outs from Rs {Number(c.instantAcceptPrice).toLocaleString('en-MU')} — the first available pro can accept instantly.</div> : null}
    </main>
  );
}
