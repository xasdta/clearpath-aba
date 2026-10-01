// Minimal SMTP client for first-contact outreach (implicit TLS on 465, AUTH LOGIN), no deps.
// Outreach goes through a real mailbox (Google Workspace, listings@sabrsoftware.com) because
// Resend's acceptable-use policy forbids cold email; Resend stays for transactional mail only.
//
// Sends multipart/alternative (plain text + HTML), both base64-encoded so no line-length or
// dot-stuffing edge case can corrupt the body. Header values are rejected if they contain
// CR/LF, so a hostile address or subject can't inject extra headers.
import tls from "node:tls";
import { randomBytes } from "node:crypto";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const clean = (v, what) => {
  if (/[\r\n]/.test(String(v))) throw new Error(`refusing ${what} with a line break`);
  return String(v);
};

// smtpUrl: smtps://user:app-password@smtp.gmail.com:465
export function parseSmtpUrl(url) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 465), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
}

export function smtpSend(box, { from, fromName, to, subject, text, html, replyTo, listUnsubscribe }) {
  from = clean(from, "from"); to = clean(to, "to"); subject = clean(subject, "subject");
  if (fromName) fromName = clean(fromName, "from name");
  if (replyTo) replyTo = clean(replyTo, "reply-to");
  if (listUnsubscribe) listUnsubscribe = clean(listUnsubscribe, "list-unsubscribe");
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: box.host, port: box.port, servername: box.host, timeout: 30000 });
    const domain = from.split("@")[1];
    const id = `<${randomBytes(12).toString("hex")}@${domain}>`;
    const boundary = `b_${randomBytes(10).toString("hex")}`;
    const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(b64(body))].join("\r\n");
    const msg = [
      `From: ${fromName ? `${encHeader(fromName)} <${from}>` : from}`, `To: ${to}`, `Subject: ${encHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: ${id}`, "MIME-Version: 1.0",
      ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
      ...(listUnsubscribe ? [`List-Unsubscribe: ${listUnsubscribe}`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
      html ? `Content-Type: multipart/alternative; boundary="${boundary}"` : "Content-Type: text/plain; charset=UTF-8",
      ...(html ? [] : ["Content-Transfer-Encoding: base64"]),
      "",
      html ? [part("text/plain", text), part("text/html", html), `--${boundary}--`, ""].join("\r\n") : wrap76(b64(text)),
      ".", "",
    ].join("\r\n");
    const script = [null, `EHLO ${domain}`, "AUTH LOGIN", b64(box.user), b64(box.pass), `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, "DATA", msg, "QUIT"];
    const expect = [220, 250, 334, 334, 235, 250, 250, 354, 250, 221];
    let buf = "", step = 0;
    sock.setEncoding("utf8");
    sock.on("timeout", () => { sock.destroy(); reject(new Error("smtp timeout")); });
    sock.on("error", reject);
    sock.on("data", (d) => {
      buf += d;
      const lines = buf.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last) || !buf.endsWith("\r\n")) return;   // wait for the final line of the reply
      const code = Number(last.slice(0, 3));
      buf = "";
      if (code !== expect[step]) { sock.destroy(); return reject(new Error(`smtp step ${step}: ${last.slice(0, 200)}`)); }
      step++;
      if (step >= script.length) { sock.end(); return resolve({ messageId: id }); }
      sock.write(script[step] + (step === 8 ? "" : "\r\n"));
    });
  });
}
