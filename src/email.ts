/**
 * email.ts — minimal Resend sender for get_news_digest. Mirrors the box's
 * scripts/notify-email.sh (same POST https://api.resend.com/emails, same env
 * vars) so there's one mental model for "how astra sends mail", just reachable
 * from inside the Node process instead of a shell hook.
 *
 * KEY DIFFERENCE from notify-email.sh: that script is fail-OPEN (a missing key
 * or Resend outage must never abort a health-check/push timer). This helper is
 * fail-LOUD: get_news_digest is invoked interactively and PROMISES an email, so
 * if the send can't happen the caller must hear about it (the tool surfaces it
 * in the confirmation, e.g. "email FAILED (403) — digest returned inline only").
 * Throwing here, caught by the tool, gives that honest signal instead of a
 * silent "emailed" that never arrived.
 *
 * Resend testing-mode reminder (see astra .env.example): with no verified
 * domain, Resend only delivers from onboarding@resend.dev to the account's OWN
 * signup address (the .edu, NOT gmail). NOTIFY_EMAIL_TO is set accordingly.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SendEmailOpts {
  subject: string;
  text: string;
  /** Markdown rendered as a basic HTML body too, so the digest links are clickable. */
  html?: string;
}

export interface SendEmailResult {
  id: string;
  to: string;
}

/**
 * Send one email via Resend. Throws on any non-2xx or missing config so the
 * caller can report the failure honestly. Reads config from env at call time
 * (the service is started with /etc/grok-mcp.env loaded), matching notify-email.sh:
 *   RESEND_API_KEY     required
 *   NOTIFY_EMAIL_TO    default zazesty@gmail.com (overridden to the .edu in env while in testing mode)
 *   NOTIFY_EMAIL_FROM  default onboarding@resend.dev
 */
export async function sendEmail(opts: SendEmailOpts): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set on the server — cannot send the digest email. " +
        "(Set it in /etc/grok-mcp.env, or call with email:false to get the digest inline only.)",
    );
  }
  const to = process.env.NOTIFY_EMAIL_TO ?? "zazesty@gmail.com";
  const from = process.env.NOTIFY_EMAIL_FROM ?? "onboarding@resend.dev";

  const body: Record<string, unknown> = {
    from,
    to: [to],
    subject: opts.subject,
    text: opts.text,
  };
  if (opts.html) body.html = opts.html;

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    // 403 in testing mode = recipient isn't the Resend account's own signup
    // address; call that out specifically since it's the predictable trap.
    const hint =
      res.status === 403
        ? " (Resend testing mode only delivers to the account's own signup email; verify a domain to send elsewhere.)"
        : "";
    throw new Error(`Resend send failed ${res.status}: ${detail}${hint}`);
  }

  const data: any = await res.json().catch(() => ({}));
  return { id: data?.id ?? "(no id)", to };
}
