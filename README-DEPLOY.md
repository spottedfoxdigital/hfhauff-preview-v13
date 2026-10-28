# H.F. Hauff site: runtime notes

Start: `bun server.ts` (PORT from env, default 3000). No dependencies.

## Environment variables (set in Railway, never commit)
| Var | Purpose |
|---|---|
| `RESEND_API_KEY` | Enables the contact form. If unset (or CONTACT_TO/CONTACT_FROM unset) the forms stay in fallback mode ("Please call or email us:" + site phone/email) and POST /api/contact returns the contact page with the fallback (503). |
| `CONTACT_TO` | Recipient(s), comma-separated. |
| `CONTACT_FROM` | Verified Resend sender, e.g. `H.F. Hauff Website <website@send.hfhauff.com>`. |
| `ALLOW_INDEX` | `1` = allow indexing, but only on the host `www.hfhauff.com`. Anything else = noindex. |
| `INDEX_HOST` | Optional override of the indexable host (default `www.hfhauff.com`). |

## Noindex switch
Default (ALLOW_INDEX unset, or any host other than www.hfhauff.com, e.g. *.up.railway.app):
`X-Robots-Tag: noindex, nofollow` on every response, `<meta name="robots" content="noindex,nofollow">` left in the HTML, `/robots.txt` = `Disallow: /`.
With `ALLOW_INDEX=1` and `Host: www.hfhauff.com`: no X-Robots-Tag, the meta robots tag is stripped from HTML, `/robots.txt` = `User-agent: * / Allow: /`.
Always noindex: `/thank-you/`, 404s, /api/contact responses.
Static hosts (GitHub Pages, file://) never run the server, so they keep the meta noindex and the form fallback.

## Contact endpoint
POST /api/contact (form-encoded). Honeypot field `website` must be empty. Max 5 posts per IP per 10 minutes.
Server-side validation (name required <=100, valid email, phone/company/comment length limits).
Sends via Resend HTTPS API with `reply_to` = submitter, then 303 -> /thank-you/. Any failure re-renders the contact page with the fallback (400/413/429/502/503).
