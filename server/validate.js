export const DEFAULT_TYPES = ['A new website', 'A web application', 'AI / automation', 'Custom software', 'Not sure yet'];

// strip control characters (keep \n and \t) so nothing odd reaches the DB or an email header
const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(8) + String.fromCharCode(11, 12) + String.fromCharCode(14) + '-' + String.fromCharCode(31, 127) + ']', 'g');
const clean = (v) => String(v ?? '').replace(CTRL, '').trim();

/** Returns { value } on success or { errors } (field → message) on failure. `types` = the menu options currently on the site. */
export function validateEnquiry(body = {}, types = DEFAULT_TYPES) {
  const errors = {};
  const name = clean(body.name);
  const email = clean(body.email).toLowerCase();
  const service = clean(body.type ?? body.service) || types[types.length - 1];
  const message = clean(body.message);

  if (name.length < 2 || name.length > 100) errors.name = 'Please tell us your name.';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Please enter a valid email address.';
  if (!types.includes(service)) errors.type = 'Please choose one of the options.';
  if (message.length < 10) errors.message = 'A sentence or two about your project helps us reply properly.';
  else if (message.length > 5000) errors.message = 'Please keep your message under 5,000 characters.';

  return Object.keys(errors).length ? { errors } : { value: { name, email, service, message } };
}
