import nodemailer from 'nodemailer';

/**
 * Email: any SMTP mailbox works (the one behind contact@hkdevlab.com, Zoho, Google Workspace,
 * Resend's SMTP, Brevo…). With no SMTP_HOST configured, messages are printed to the console
 * instead of sent, so local development never emails anyone by accident.
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

export function createMailer() {
  const host = process.env.SMTP_HOST;
  const port = +process.env.SMTP_PORT || 587;
  const to = process.env.MAIL_TO || 'contact@hkdevlab.com';
  const from = process.env.MAIL_FROM || 'HK DevLab <contact@hkdevlab.com>';
  const live = Boolean(host);

  const transport = live
    ? nodemailer.createTransport({
        host, port,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        connectionTimeout: 10_000, socketTimeout: 15_000,
      })
    : nodemailer.createTransport({ jsonTransport: true });

  async function send(msg) {
    const info = await transport.sendMail(msg);
    if (!live) console.log(`[mail:dev] would send → ${msg.to} | ${msg.subject}`);
    return info;
  }

  return {
    live, to,
    async verify() { if (live) await transport.verify(); },

    /** Notifies the studio (reply-to = the visitor) and auto-replies to the visitor. Returns true if the studio notification went out. */
    async sendEnquiry(e) {
      const subject = `New enquiry: ${oneLine(e.service)} — ${oneLine(e.name)}`;
      let notified = false;
      try {
        await send({
          from, to, replyTo: { name: oneLine(e.name), address: e.email }, subject,     // structured, so the name can never alter the header
          text: `New enquiry from the HK DevLab website (#${e.id})\n\nName:    ${e.name}\nEmail:   ${e.email}\nNeeds:   ${e.service}\n\n${e.message}\n`,
          html: `<div style="font:15px/1.6 system-ui,sans-serif;color:#111"><h2 style="margin:0 0 12px">New enquiry #${e.id}</h2>
            <p><b>Name:</b> ${esc(e.name)}<br><b>Email:</b> <a href="mailto:${esc(e.email)}">${esc(e.email)}</a><br><b>Needs:</b> ${esc(e.service)}</p>
            <p style="white-space:pre-wrap;border-left:3px solid #0b74ff;padding-left:12px">${esc(e.message)}</p>
            <p style="color:#666;font-size:13px">Hit reply to answer ${esc(e.name)} directly.</p></div>`,
        });
        notified = true;
      } catch (err) {
        console.error('[mail] studio notification failed:', err.message);
      }

      try {
        await send({
          from, to: e.email, replyTo: to,
          subject: 'We got your message — HK DevLab',
          text: `Hi ${oneLine(e.name)},\n\nThanks for reaching out to HK DevLab. We've received your message about "${oneLine(e.service)}" and will get back to you personally, usually within one business day.\n\nFor reference, here's what you sent:\n\n${e.message}\n\n— The HK DevLab team\nhttps://hkdevlab.com · ${to}\n`,
        });
      } catch (err) {
        console.error('[mail] auto-reply failed:', err.message);
      }
      return notified;
    },
  };
}
