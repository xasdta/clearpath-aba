// HTML version of the one-click emails: real buttons instead of bare links. Every message still
// carries its plain-text twin (sendMail's `text`), which is what some clients and all spam
// filters read, so nothing here may say anything the text version doesn't.
//
// Email HTML is its own dialect: tables for layout, inline styles only, no web fonts or CSS
// classes, and buttons as padded links so they work in Outlook, Gmail and Apple Mail alike.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BTN = {
  primary: "background:#0d6b5b;color:#ffffff;border:1px solid #0d6b5b",
  secondary: "background:#ffffff;color:#94413a;border:1px solid #d9b3ae",
};

// paras: strings (plain text, escaped here). buttons: [{label, url, kind: "primary"|"secondary"}].
export function actionEmail({ preheader = "", greeting, paras = [], buttons = [], after = [], footer = [] }) {
  const p = (t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#182529">${esc(t)}</p>`;
  const btns = buttons.map((b) => `
        <td style="padding:0 12px 12px 0">
          <a href="${esc(b.url)}" style="${BTN[b.kind || "primary"]};display:inline-block;padding:13px 22px;border-radius:8px;font-size:16px;font-weight:600;text-decoration:none">${esc(b.label)}</a>
        </td>`).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f3f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f5"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dde5e3;border-radius:12px">
    <tr><td style="padding:22px 28px 0;font-size:15px;font-weight:700;color:#182529">ABA <span style="color:#0d6b5b">Openings</span></td></tr>
    <tr><td style="padding:22px 28px 8px">
      ${greeting ? p(greeting) : ""}
      ${paras.map(p).join("\n      ")}
      ${buttons.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 8px"><tr>${btns}</tr></table>` : ""}
      ${after.map(p).join("\n      ")}
    </td></tr>
    <tr><td style="padding:16px 28px 22px;border-top:1px solid #eef2f1;font-size:13px;line-height:1.5;color:#5d6d72">
      ${footer.map((f) => esc(f)).join("<br>")}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}
