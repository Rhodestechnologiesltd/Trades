import { getCategories } from '../src/server';

export default async function Home() {
  const cats = await getCategories();
  return (
    <main>
      <div className="hero">
        <div className="container">
          <h1>Trusted local pros,<br />when you need them.</h1>
          <p>Electricians, plumbers, cleaners, nannies, mechanics, AC repair and more — verified, rated, and paid only when you're happy.</p>
          <div className="row" style={{ marginTop: 24 }}>
            <a className="btn light" href="/request/new">Get quotes</a>
            <a className="btn urgent" href="/request/new?mode=urgent">⚡ Urgent help now</a>
          </div>
        </div>
      </div>
      <section id="services">
        <div className="container">
          <h2>Popular services</h2>
          <div className="grid cats">
            {cats.map(c => (
              <a key={c.id} className="card link" href={`/services/${c.slug}`}>
                <strong>{c.name}</strong>
                <div className="faint">{c.urgencyAllowed ? 'Urgent & scheduled' : 'Book ahead'}{c.requiresLicense ? ' · licensed pros' : ''}{c.requiresBackgroundCheck ? ' · background-checked' : ''}</div>
              </a>
            ))}
            {!cats.length ? <p className="muted">Services are loading — please refresh in a moment.</p> : null}
          </div>
        </div>
      </section>
      <section style={{ background: '#fff' }}>
        <div className="container grid two">
          {[
            ['1. Describe the job', 'Tell us what you need, where and when. Add photos for accurate quotes.'],
            ['2. Compare quotes', 'Nearby verified pros send prices and arrival times. Counter-offer if you like.'],
            ['3. Pay securely', 'Card payment through MIPS. We hold the money until the work is done.'],
            ['4. Approve & review', 'Happy? Approve and your pro gets paid. Problem? Our team steps in.'],
          ].map(([t, b]) => <div key={t} className="card"><strong>{t}</strong><p className="muted" style={{ margin: '6px 0 0' }}>{b}</p></div>)}
        </div>
      </section>
    </main>
  );
}
