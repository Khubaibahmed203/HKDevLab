import gsap from 'gsap';

const $ = (s, r = document) => r.querySelector(s);
const API = import.meta.env.VITE_API_URL || '';          // same origin by default

/** Contact links (from config.js) and the validated form → POST /api/contact. */
export function initContact(contact) {
  const SITE = contact;
  const list = $('#contactLinks');
  const link = (href, text, external) => {
    const a = document.createElement('a');
    a.href = href; a.textContent = text;
    if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer me'; }
    const li = document.createElement('li'); li.append(a); return li;
  };
  const items = [];
  if (SITE.email) items.push(link(`mailto:${SITE.email}`, SITE.email));
  SITE.socials.forEach((s) => items.push(link(s.href, s.label, /^https?:/i.test(s.href))));
  if (SITE.location) { const li = document.createElement('li'); const sp = document.createElement('span'); sp.className = 'contact__loc'; sp.textContent = SITE.location; li.append(sp); items.push(li); }
  list.replaceChildren(...items);
  if (!items.length) list.remove();

  const form = $('#form');
  const status = $('#formStatus');
  const submit = $('button[type="submit"]', form);
  const openedAt = Date.now();
  const fields = [
    { name: 'name', el: $('#fName'), err: $('#eName'), test: (v) => v.trim().length >= 2, msg: 'Please tell us your name.' },
    { name: 'email', el: $('#fEmail'), err: $('#eEmail'), test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()), msg: 'Please enter a valid email address.' },
    { name: 'message', el: $('#fMsg'), err: $('#eMsg'), test: (v) => v.trim().length >= 10, msg: 'A sentence or two about your project helps us reply properly.' },
  ];

  const show = (f, ok, msg = f.msg) => {
    f.el.setAttribute('aria-invalid', ok ? 'false' : 'true');
    f.el.setAttribute('aria-describedby', f.err.id);
    f.err.textContent = ok ? '' : msg;
    return ok;
  };
  const check = (f) => show(f, f.test(f.el.value));
  fields.forEach((f) => {
    f.el.addEventListener('blur', () => f.el.value && check(f));
    f.el.addEventListener('input', () => f.el.getAttribute('aria-invalid') === 'true' && check(f));
  });

  const setStatus = (text, kind = '') => { status.textContent = text; status.dataset.kind = kind; };
  const busy = (on) => { submit.disabled = on; submit.setAttribute('aria-busy', String(on)); submit.dataset.label ||= submit.firstChild.textContent; submit.firstChild.textContent = on ? 'Sending… ' : submit.dataset.label; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setStatus('');
    const bad = fields.filter((f) => !check(f));
    if (bad.length) { bad[0].el.focus(); return; }

    const data = Object.fromEntries(new FormData(form));
    busy(true);
    try {
      const res = await fetch(`${API}/api/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, elapsed: Date.now() - openedAt }),
      });
      const out = await res.json().catch(() => ({}));

      if (res.ok) {
        form.reset();
        fields.forEach((f) => show(f, true));
        setStatus(`Thank you, ${String(data.name).trim().split(' ')[0]}. Your message is in — we'll reply within one business day.`, 'ok');
      } else if (out.errors) {
        let first;
        fields.forEach((f) => { if (out.errors[f.name]) { show(f, false, out.errors[f.name]); first ||= f; } });
        first?.el.focus();
        setStatus(first ? '' : Object.values(out.errors)[0], 'error');
      } else {
        setStatus(out.error || `That didn't go through. Please email us at ${SITE.email}.`, 'error');
      }
    } catch {
      // server unreachable (offline, or the site is served without the API) → hand over to the visitor's mail app
      const subject = `New project enquiry — ${data.type}`;
      const body = `Name: ${data.name}\nEmail: ${data.email}\nNeed: ${data.type}\n\n${data.message}`;
      window.location.href = `mailto:${SITE.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      setStatus(`We couldn't reach our server, so we're opening your email app instead — or write to ${SITE.email}.`, 'error');
    } finally {
      busy(false);
    }
  });
}

/** Motion-allowed reveals for the marquee band and the finale. */
export function contactReveal() {
  gsap.from('.who .eyebrow, .marquee', {
    y: 40, opacity: 0, duration: 1, stagger: 0.12, ease: 'power3.out',
    scrollTrigger: { trigger: '.who', start: 'top 80%' },
  });
  gsap.from('.contact__copy > *', {
    y: 50, opacity: 0, duration: 1, stagger: 0.12, ease: 'power3.out', clearProps: 'transform,opacity',
    scrollTrigger: { trigger: '.contact', start: 'top 65%' },
  });
  gsap.from('.form', {
    y: 60, opacity: 0, duration: 1.1, ease: 'power3.out', clearProps: 'transform,opacity',
    scrollTrigger: { trigger: '.contact', start: 'top 60%' },
  });
}
