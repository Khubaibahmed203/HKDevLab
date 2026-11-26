/**
 * The verified business facts and the copy of every page beyond the homepage (service pages, About, case studies, blog).
 * ONE definition, used by:
 *   • content/seo.js            — the ProfessionalService JSON-LD (name, address, contact, founder, sameAs, services)
 *   • scripts/generate-pages.mjs — writes each page's HTML (with its FAQPage JSON-LD), public/sitemap.xml and public/llms.txt
 *   • vite.config.js            — the list of pages to build
 * Plain ES module, no dependencies — runs in Node and in the browser, like content/schema.js.
 *
 * Keep these facts identical to the business's profiles (Google Business Profile, LinkedIn, Clutch, Instagram, Facebook):
 * AI assistants and search engines trust what they can confirm in several places.
 * Add a profile to `sameAs` only once it really exists.
 */
export const BUSINESS = {
  name: 'HK DevLab',
  city: 'Attock',
  region: 'Punjab',
  country: 'Pakistan',
  countryCode: 'PK',
  email: 'contact@hkdevlab.com',
  whatsapp: '+92 324 0968723',
  whatsappUrl: 'https://wa.me/923240968723',
  foundingDate: '2026',
  founder: { name: 'Khubaib Ahmed', url: 'https://khubaib-portfolio-dev.vercel.app/' },
  socials: [
    { label: 'Instagram', href: 'https://www.instagram.com/hkdevlab/' },
    { label: 'Facebook', href: 'https://www.facebook.com/profile.php?id=61594621041246' },
  ],
  // LinkedIn, Google Business Profile, Clutch and GoodFirms: add each URL here once the profile exists.
  sameAs: [
    'https://www.instagram.com/hkdevlab/',
    'https://www.facebook.com/profile.php?id=61594621041246',
  ],
  knowsAbout: [
    'Website development', 'Web application development', 'AI assistants and chatbots', 'Business automation',
    'Custom software development', 'Next.js', 'React', 'Node.js', 'Python',
  ],
};

export const CTA_OFFER = 'Free 15-minute call or free website check — just send a message.';

/* ───────── tiny builders for page bodies: each block is rendered as escaped text, never as HTML ───────── */
const p = (text) => ({ type: 'p', text });
const h2 = (text) => ({ type: 'h2', text });
const ul = (items) => ({ type: 'ul', items });
const lead = (label, text) => ({ type: 'lead', label, text });   // "Label. text" with the label in bold

/* ═════════ service pages ═════════ */
export const SERVICES = [
  {
    slug: 'website-development',
    name: 'Website Development',
    title: 'Website Development for Small Businesses in Pakistan | HK DevLab',
    description: 'Fast, mobile-friendly business websites built by HK DevLab in Attock, Pakistan. Free website check and free 15-minute call.',
    h1: 'Business Websites That Bring Customers to You',
    intro: 'HK DevLab builds fast, mobile-friendly websites for small businesses, startups and personal brands in Pakistan. Most customers search on their phone first, so every site we build is designed for mobile, loads quickly, and makes it easy to call, WhatsApp or book you in one tap.',
    body: [
      h2('What you get'),
      ul([
        'A custom design that matches your brand — no generic template look',
        'Mobile-first layout with one-tap call and WhatsApp buttons',
        'Pages for your services, about, contact and location',
        'Basic on-page SEO: titles, descriptions, structured data and a sitemap',
        'Fast loading on Pakistani mobile networks',
        'A simple handover so you can update content yourself, plus support after launch',
      ]),
      lead('Who it\'s for:', 'shops, clinics, restaurants, salons, tutors, consultants, service businesses and personal brands.'),
      lead('How we work:', 'Discover → Design → Build → Launch → Grow.'),
    ],
    cta: 'Get a free website check or book a free 15-minute call',
    faq: [
      ['Do I need a website if I already have an Instagram or Facebook page?', 'Social pages are great for reach, but you don\'t own them and they are hard to find on Google. A website gives you one place you control, shows up in search, and builds trust with new customers.'],
      ['How long does a business website take?', 'It depends on the number of pages and features. After a short Discover call we share a clear timeline before any work starts.'],
      ['Will my website work on mobile?', 'Yes. Every site is designed mobile-first and tested on phones before launch.'],
      ['Can I update the website myself?', 'Yes. We can set up an easy way to edit text, images and services, and show you how to use it.'],
      ['Do you work with businesses outside Attock?', 'Yes. We work with businesses across Pakistan and abroad, online.'],
    ],
    related: ['/work/its4u-mobiles', '/blog/how-to-choose-web-developer-pakistan', '/blog/website-vs-instagram-page-small-business'],
  },
  {
    slug: 'web-app-development',
    name: 'Web App Development',
    title: 'Web Application Development in Pakistan | HK DevLab',
    description: 'Custom web apps, dashboards and portals built with React, Next.js and Node.js by HK DevLab, Attock, Pakistan.',
    h1: 'Web Apps Built Around How Your Business Works',
    intro: 'When spreadsheets and WhatsApp groups stop being enough, a web app brings your work into one place. HK DevLab builds custom web applications — dashboards, booking systems, customer portals, inventory and order tools — for startups and growing businesses in Pakistan.',
    body: [
      h2('What we build'),
      ul([
        'Admin dashboards and internal tools',
        'Booking and appointment systems',
        'Customer and member portals',
        'Order, inventory and lead management tools',
        'MVPs for startup ideas',
      ]),
      lead('Tech:', 'React, Next.js, TypeScript, Node.js, Python, databases, APIs and cloud hosting.'),
    ],
    cta: 'Tell us your idea — free 15-minute call',
    faq: [
      ['What is the difference between a website and a web app?', 'A website mainly shows information. A web app lets people do things — log in, book, order, manage data — like a tool that runs in the browser.'],
      ['Can you build an MVP for my startup idea?', 'Yes. We start with Discover to agree the smallest useful version, then build and launch it so you can test with real users.'],
      ['Will the app work on phones?', 'Yes. Web apps are built responsive, so they work on mobile, tablet and desktop browsers.'],
      ['Who owns the code?', 'Ownership terms are agreed in writing before the project starts.'],
    ],
    related: ['/services/custom-software', '/blog/how-to-choose-web-developer-pakistan'],
  },
  {
    slug: 'ai-assistants',
    name: 'AI Assistants & Automation',
    title: 'AI Assistants & Business Automation in Pakistan | HK DevLab',
    description: 'AI chat assistants and automation for Pakistani businesses — answer customer questions, take bookings and save time. Built by HK DevLab.',
    h1: 'AI Assistants That Answer Your Customers, Day and Night',
    intro: 'Customers message at all hours with the same questions: price, timing, location, availability. HK DevLab builds AI assistants and simple automations that handle routine questions, collect customer details and help with bookings, so you and your team can focus on the real work.',
    body: [
      h2('What an AI assistant can do'),
      ul([
        'Answer common questions about your products, services and timings',
        'Reply in English and Roman Urdu',
        'Share available slots and collect booking details',
        'Capture leads and pass them to you',
        'Work on your website, and connect to messaging channels where possible',
      ]),
      lead('Automation examples:', 'sending lead details to a sheet, follow-up messages, order notifications, simple reports.'),
    ],
    cta: 'DM or email "AI" for a free suggestion on what an assistant could do for your business',
    faq: [
      ['Will the AI assistant replace my staff?', 'No. It handles repetitive questions so your team can spend time on customers who are ready to buy.'],
      ['Can it reply in Urdu or Roman Urdu?', 'Yes, it can be set up to understand and reply in English and Roman Urdu.'],
      ['What happens if it can\'t answer a question?', 'It can pass the conversation or the customer\'s details to you.'],
      ['Which businesses benefit most?', 'Clinics, salons, restaurants, shops, tutors and service businesses that get many repeated questions.'],
    ],
    related: ['/blog/ai-assistant-for-small-business-pakistan'],
  },
  {
    slug: 'custom-software',
    name: 'Custom Software',
    jsonLdName: 'Custom Software Development',
    title: 'Custom Software Development in Pakistan | HK DevLab',
    description: 'Custom software built around your business process — planned, designed, built and supported by HK DevLab in Attock, Pakistan.',
    h1: 'Software Made for Your Process, Not the Other Way Around',
    intro: 'Off-the-shelf tools often force you to change how you work. HK DevLab designs and builds custom software that fits your process — from internal tools to integrations between the systems you already use.',
    body: [
      lead('Examples:', 'internal management systems, integrations and APIs, reporting tools, workflow automation, data cleanup and migration.'),
    ],
    cta: 'Book a free 15-minute call to talk through your process',
    faq: [
      ['When should I choose custom software over a ready-made tool?', 'When ready-made tools don\'t fit your workflow, need too many workarounds, or don\'t connect with your other systems.'],
      ['Do you provide support after launch?', 'Yes. Grow is part of our process — we stay available for fixes and improvements.'],
      ['How do you price projects?', 'After Discover we share a written scope and quote, so you know what you are paying for before we start.'],
    ],
    related: ['/services/web-app-development'],
  },
];

/* ═════════ about ═════════ */
export const ABOUT = {
  title: 'About HK DevLab — Web & AI Development Studio in Attock, Pakistan',
  description: 'HK DevLab is a digital development studio founded in 2026 by Khubaib Ahmed in Attock, Pakistan, building websites, web apps, AI assistants and custom software.',
  h1: 'About HK DevLab',
  intro: 'HK DevLab is a digital development studio founded in 2026 by Khubaib Ahmed in Attock, Pakistan. We build websites, web applications, AI assistants and custom software for startups, small businesses, entrepreneurs and personal brands.',
  body: [
    p('We started HK DevLab because many Pakistani businesses still depend only on social media pages, or on websites that are slow, hard to use on mobile, and hard to find. We want every business owner to have a clear, fast and useful online presence, and to use AI and automation in practical ways that save time.'),
    lead('How we work.', 'Every project follows five steps: Discover (we understand your business and goals), Design (we plan the look and the user journey), Build (we develop with modern tools like React, Next.js, Node.js and Python), Launch (we test and go live), and Grow (we keep improving after launch).'),
    lead('What we value.', 'Clear communication, honest scoping, and work that solves a real business problem.'),
    lead('Founder.', 'Khubaib Ahmed — Developer and founder of HK DevLab, working across web, mobile, software and AI automation — from AI agents and workflow automation to API integrations and custom business systems.'),
    { type: 'link', label: 'Portfolio:', href: 'https://khubaib-portfolio-dev.vercel.app/', text: 'khubaib-portfolio-dev.vercel.app' },
    lead('Contact.', 'Attock, Pakistan · contact@hkdevlab.com · WhatsApp +92 324 0968723'),
  ],
  related: ['/services/website-development', '/services/web-app-development', '/services/ai-assistants', '/services/custom-software', '/work/its4u-mobiles'],
};

/* ═════════ case studies ═════════ */
export const CASE_STUDIES = [
  {
    slug: 'its4u-mobiles',
    name: 'ITS4U Mobiles',
    title: 'ITS4U Mobiles — Phone Shop Website for a Multi-Branch Retailer in Attock | HK DevLab',
    description: 'How HK DevLab built the ITS4U Mobiles online store: a phone catalog, SIM guide, branch list, cart and order flow for a five-branch retailer around Attock.',
    h1: 'ITS4U Mobiles — an online store for a phone retailer with five branches around Attock',
    facts: [
      ['Client', 'ITS4U Mobiles (Waqar)'],
      ['Location', 'Attock, Punjab, with branches in Kamra, Fateh Jang, Pindi Gheb and Jand'],
      ['Industry', 'Mobile phone retail'],
      ['Service', 'Website development'],
      ['Built with', 'Next.js, hosted on Vercel'],
    ],
    liveUrl: 'https://its4u.vercel.app',
    // Shown under the facts. Refresh it with `npm run capture-project-previews -- --only its4u` when the site's design changes.
    screenshot: '/assets/projects/its4u-vercel-app-preview.webp',
    body: [
      lead('The challenge.', 'ITS4U Mobiles sells new and used iPhones and Android phones across five branches. Customers need to see what\'s in stock, understand which phones will work with their SIM, and order without visiting every branch.'),
      h2('What we built'),
      ul([
        'A catalog of new and used phones with iPhone and Android filters',
        'A "Which phone works with your SIM?" guide explaining PTA approved, factory unlocked, non-PTA, JV and SIM-locked phones',
        'Installment plan information for Android phones',
        'A branch list covering Attock, Kamra, Fateh Jang, Pindi Gheb and Jand',
        'A cart and a simple 4-step order flow with cash on delivery or pay at branch, and delivery or pickup',
        'A WhatsApp chat button and an Urdu version of the site',
      ]),
      lead('The process.', 'Discover (understanding the branches, stock types and how customers buy) → Design (a clear mobile-first catalog) → Build (Next.js) → Launch (live on Vercel) → Grow (ongoing updates).'),
    ],
    cta: 'Want a website like this for your shop?',
    related: ['/services/website-development'],
  },
];

/* ═════════ blog ═════════ */
export const BLOG = {
  title: 'Blog — Websites, Web Apps & AI for Pakistani Businesses | HK DevLab',
  description: 'Practical answers for Pakistani business owners about websites, web apps, AI assistants and choosing a developer, from HK DevLab in Attock.',
  h1: 'HK DevLab Blog',
  intro: 'Practical answers for business owners in Pakistan: websites, web apps, AI assistants and how to work with a developer.',
};

export const POSTS = [
  {
    slug: 'how-to-choose-web-developer-pakistan',
    title: 'How to Choose a Web Developer in Pakistan: A Practical Checklist',
    description: 'To choose a web developer in Pakistan, check real past work, a written scope and quote, a defined process with timelines, and support after launch.',
    published: '2026-11-26',
    answer: 'To choose a web developer in Pakistan, check four things: real past work you can open, a clear written scope and quote, a defined process with timelines, and support after launch. A developer who can\'t show these is a risk, however low the price.',
    body: [
      h2('1. Look at real work, not just screenshots.'),
      p('Ask for live links to sites or apps they built. Open them on your phone. Are they fast? Easy to use? Is it clear what the business does?'),
      h2('2. Ask how they work.'),
      p('A good developer has a process. At HK DevLab it is Discover, Design, Build, Launch and Grow. You should know what happens at each step and when you will see progress.'),
      h2('3. Get the scope in writing.'),
      p('The quote should list pages, features, revisions, hosting and who owns the code and domain. Vague quotes lead to arguments later.'),
      h2('4. Check mobile and speed.'),
      p('Most of your customers will visit on a phone. Ask how the developer makes sites fast and mobile-friendly.'),
      h2('5. Ask about after launch.'),
      p('Who fixes problems? Who updates content? Is there support, and on what terms?'),
      h2('6. Make sure you own your accounts.'),
      p('Your domain, hosting and business email should be registered in your name, with access shared with the developer, not the other way round.'),
      h2('7. Notice how they communicate.'),
      p('Do they reply clearly and on time before you pay? That rarely improves after.'),
      lead('Red flags:', 'no live portfolio, no written quote, pressure to pay everything upfront, promises like "guaranteed #1 on Google".'),
    ],
    cta: 'Want a second opinion on a quote or your current website? HK DevLab offers a free 15-minute call and a free website check',
    related: ['/services/website-development', '/services/web-app-development'],
  },
  {
    slug: 'website-vs-instagram-page-small-business',
    title: 'Website vs Instagram Page: What Does a Pakistani Small Business Need?',
    description: 'Most small businesses in Pakistan need both: Instagram or Facebook to be discovered, and a website to be found on Google and own their online presence.',
    published: '2026-11-26',
    answer: 'Most small businesses in Pakistan need both: Instagram or Facebook to be discovered and stay in touch, and a website to be found on Google, build trust and own their online presence. A social page alone leaves you depending on one platform\'s rules and reach.',
    body: [
      lead('What a social page does well:', 'shows your products and daily updates, lets people message you quickly, and helps you reach people through posts and ads.'),
      h2('Where a social page falls short'),
      ul([
        'It is hard to find when someone searches on Google for your service in your city.',
        'You don\'t control it — an account can be restricted or hacked.',
        'Information gets buried in old posts: prices, timings, location, policies.',
        'It can look less established to new or corporate customers.',
      ]),
      lead('What a website adds:', 'a permanent address for your business, pages that show up in search, a clear place for services, location and contact, and the option to add bookings, orders or an AI assistant.'),
      lead('A simple setup that works:', 'use Instagram and Facebook for reach, and link everything to a fast, mobile-friendly website with one-tap WhatsApp and call buttons.'),
    ],
    cta: 'Not sure where to start? Message HK DevLab for a free suggestion',
    related: ['/services/website-development'],
  },
  {
    slug: 'ai-assistant-for-small-business-pakistan',
    title: 'What Can an AI Assistant Do for a Clinic, Salon or Shop in Pakistan?',
    description: 'An AI assistant can answer routine customer questions at any hour, share timings, collect booking details and pass leads to you, in English or Roman Urdu.',
    published: '2026-11-26',
    answer: 'An AI assistant can answer your customers\' routine questions at any hour, share timings and availability, collect booking details and pass leads to you, in English or Roman Urdu. It doesn\'t replace your team; it takes the repetitive messages off their hands.',
    body: [
      h2('Questions an assistant can handle'),
      ul([
        '"Timing kya hai?" — opening hours and days off',
        '"Location bhej dein" — address and directions link',
        '"Kal ka slot free hai?" — available appointment times',
        '"Yeh service kitne ki hai?" — your listed rates, if you choose to share them',
        '"Home delivery hai?" — delivery areas and policy',
      ]),
      lead('Where it helps most:', 'clinics and labs (appointments), salons (bookings), restaurants and bakeries (menu and orders), tutors and academies (admissions questions), shops (stock and delivery questions).'),
      lead('What to prepare:', 'a list of your most common questions and answers, your timings, location, services and booking rules. The assistant is only as good as the information you give it.'),
      lead('What it should not do:', 'give medical, legal or financial advice, or make promises your staff can\'t keep. A well-built assistant knows when to hand over to a person.'),
    ],
    cta: 'HK DevLab designs AI assistants around how your business already works. Email or DM "AI" for a free suggestion',
    related: ['/services/ai-assistants'],
  },
];

/* ═════════ every page, for the build, the sitemap and llms.txt ═════════ */
export const LASTMOD = '2026-11-26';     // bump when a page's copy changes (the sitemap's <lastmod>)

export const PAGES = [
  { path: '/', name: 'Homepage', priority: 1.0, changefreq: 'weekly' },
  ...SERVICES.map((s) => ({ path: `/services/${s.slug}`, name: s.name, priority: 0.9, changefreq: 'monthly' })),
  { path: '/about', name: 'About HK DevLab', priority: 0.8, changefreq: 'monthly' },
  ...CASE_STUDIES.map((c) => ({ path: `/work/${c.slug}`, name: `${c.name} case study`, priority: 0.8, changefreq: 'monthly' })),
  { path: '/blog', name: 'Blog', priority: 0.7, changefreq: 'weekly' },
  ...POSTS.map((b) => ({ path: `/blog/${b.slug}`, name: b.title, priority: 0.7, changefreq: 'monthly', lastmod: b.published })),
];

/** The pages other than the homepage — each is built from <path>/index.html (see scripts/generate-pages.mjs). */
export const SUBPAGE_PATHS = PAGES.map((pg) => pg.path).filter((path) => path !== '/');

/** A page's display name, for "related" links. */
export const pageName = (path) => PAGES.find((pg) => pg.path === path)?.name || path;
