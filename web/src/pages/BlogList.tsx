const blogs = [
  {
    slug: 'blog1',
    title: 'New York to Raleigh Bus: Complete 2026 Guide',
    excerpt: 'Daily departures from 103 Canal Street starting from $80. Schedules, overnight tips, and what to expect on the NY→Raleigh Chinatown bus route.',
    cover: '/blogs/blog1-cover.png',
    route: 'New York → Raleigh, NC',
    price: 'From $80',
    time: '~9.5 hrs',
    href: '/blogs/blog1.html',
  },
  {
    slug: 'blog2',
    title: 'New York to Charlotte Bus: Tickets & Schedule 2026',
    excerpt: 'Wanda Coach connects Chinatown to Charlotte from $100 — 10h45m fastest ride with overnight options. The complete booking guide for 2026.',
    cover: '/blogs/blog2-cover.png',
    route: 'New York → Charlotte, NC',
    price: 'From $100',
    time: '~10h 45m',
    href: '/blogs/blog2.html',
  },
  {
    slug: 'blog3',
    title: "New York to Atlanta Bus: Is Chinatown Route Worth It?",
    excerpt: "Yes, it's 17–21 hours — but after doing the math on flights and hotels, the overnight Wanda Coach from Canal Street might be the smarter choice.",
    cover: '/blogs/blog3-cover.png',
    route: 'New York → Atlanta, GA',
    price: 'From $120',
    time: '17–21 hrs',
    href: '/blogs/blog3.html',
  },
]

export default function BlogList() {
  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif", background: '#f8f7f3', minHeight: '100vh' }}>

      {/* Nav */}
      <nav style={{ background: '#191919', padding: '0 32px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a href="https://wandacoach.com" target="_blank" rel="noopener noreferrer"
            style={{ color: '#d6bf65', fontWeight: 700, fontSize: 16, textDecoration: 'none', letterSpacing: '.5px' }}>
            Wanda Coach
          </a>
          <span style={{ color: '#555', fontSize: 12 }}>›</span>
          <span style={{ color: '#999', fontSize: 13 }}>Blog</span>
        </div>
        <a href="https://wandacoach.com/search-bus" target="_blank" rel="noopener noreferrer"
          style={{ background: '#d6bf65', color: '#191919', padding: '6px 16px', borderRadius: 5, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
          Book Now
        </a>
      </nav>

      {/* Hero */}
      <div style={{ background: '#191919', padding: '56px 24px 52px', textAlign: 'center' }}>
        <p style={{ color: '#d6bf65', fontSize: 11, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 14 }}>
          Travel Blog
        </p>
        <h1 style={{ color: '#fff', fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', fontWeight: 800, marginBottom: 16, lineHeight: 1.2, letterSpacing: '-.02em' }}>
          East Coast Bus Travel Guides
        </h1>
        <p style={{ color: '#b0a070', maxWidth: 500, margin: '0 auto', fontSize: '1rem', lineHeight: 1.7 }}>
          Honest, detailed guides for the most popular Chinatown bus routes from New York — schedules, tips, and what to actually expect.
        </p>
      </div>

      {/* Gold divider */}
      <div style={{ height: 3, background: 'linear-gradient(90deg, #cbae3d, #d6bf65, #cbae3d)' }} />

      {/* Cards */}
      <main style={{ maxWidth: 1060, margin: '0 auto', padding: '48px 20px 80px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 28 }}>
          {blogs.map((b) => (
            <a key={b.slug} href={b.href}
              style={{ display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 10, overflow: 'hidden', textDecoration: 'none', border: '1px solid #e8e0c8', boxShadow: '0 2px 8px rgba(0,0,0,.06)', transition: 'box-shadow .2s' }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 6px 20px rgba(0,0,0,.12)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,.06)')}
            >
              {/* Cover */}
              <div style={{ height: 196, overflow: 'hidden', background: '#191919' }}>
                <img src={b.cover} alt={b.title}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', display: 'block' }} />
              </div>

              {/* Body */}
              <div style={{ padding: '18px 20px 16px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span style={{ display: 'inline-block', background: '#fffdf0', color: '#8a7200', border: '1px solid #e8d87a', borderRadius: 4, padding: '2px 9px', fontSize: 11, fontWeight: 700, marginBottom: 10, letterSpacing: '.3px' }}>
                  {b.route}
                </span>
                <h2 style={{ color: '#1a1a1a', fontSize: '1rem', fontWeight: 700, lineHeight: 1.4, marginBottom: 10 }}>
                  {b.title}
                </h2>
                <p style={{ color: '#787878', fontSize: '0.875rem', lineHeight: 1.65, flex: 1, marginBottom: 14 }}>
                  {b.excerpt}
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f0ece0', paddingTop: 12 }}>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <span style={{ fontSize: 12, color: '#464646', fontWeight: 600 }}>{b.price}</span>
                    <span style={{ fontSize: 12, color: '#999' }}>{b.time}</span>
                  </div>
                  <span style={{ color: '#bca71b', fontSize: 12, fontWeight: 700 }}>
                    Read guide →
                  </span>
                </div>
              </div>
            </a>
          ))}
        </div>

        <p style={{ textAlign: 'center', color: '#ababab', fontSize: 12, marginTop: 48 }}>
          Preview build — content pending final review before publishing to wandacoach.com
        </p>
      </main>
    </div>
  )
}
