export interface Env {
  RESEND_API_KEY: string;
  TARGET_EMAIL: string;
}

// Warmup email templates - natural business style
const BEEFTOWN_TEMPLATES = [
  {
    subject: "New arrivals at Beeftown Store",
    html: `<p>Hi there,</p><p>We're excited to share that new products have just arrived at Beeftown Store! Browse our latest selection of premium items — all carefully sourced and ready to ship.</p><p>Visit us at <a href="https://example-store.com">example-store.com</a> to see what's new.</p><p>Best,<br>The Beeftown Team</p>`
  },
  {
    subject: "Your order confirmation — Beeftown Store",
    html: `<p>Thank you for your order!</p><p>We've received your order and it's being processed. You'll receive a shipping confirmation once your items are on their way.</p><p>Questions? Contact us at <a href="mailto:info@example-store.com">info@example-store.com</a>.</p><p>Warm regards,<br>Beeftown Store</p>`
  },
  {
    subject: "Beeftown Store — Weekly deals inside",
    html: `<p>Hello,</p><p>This week at Beeftown Store we have some great deals on our most popular products. Stock is limited so don't miss out!</p><p>Shop now at <a href="https://example-store.com">example-store.com</a>.</p><p>Cheers,<br>Beeftown Store Team</p>`
  },
  {
    subject: "Your subscription box is on its way",
    html: `<p>Great news!</p><p>Your monthly subscription box from Beeftown Store has been dispatched and is on its way to you. You can expect delivery within 2–3 business days.</p><p>Thank you for being a loyal subscriber.<br><br>Best,<br>Beeftown Store</p>`
  },
  {
    subject: "Receipt for your recent purchase",
    html: `<p>Hi,</p><p>Please find attached the receipt for your recent purchase from Beeftown Store. We hope you enjoy your order!</p><p>If you have any questions or concerns, don't hesitate to reach out at <a href="mailto:info@example-store.com">info@example-store.com</a>.</p><p>Thanks,<br>Beeftown Store</p>`
  },
  {
    subject: "We'd love your feedback — Beeftown Store",
    html: `<p>Hello,</p><p>How was your recent experience with Beeftown Store? We'd love to hear your thoughts. Your feedback helps us improve and serve you better.</p><p>Reply to this email or visit <a href="https://example-store.com/contact">example-store.com/contact</a>.</p><p>Many thanks,<br>Beeftown Store</p>`
  },
  {
    subject: "Beeftown Store — Important account notice",
    html: `<p>Dear customer,</p><p>This is a friendly reminder that your Beeftown Store account is active and in good standing. No action is required on your part.</p><p>Continue shopping at <a href="https://example-store.com">example-store.com</a>.</p><p>Kind regards,<br>Beeftown Store Support</p>`
  },
];

const YIDKO_TEMPLATES = [
  {
    subject: "Welcome to Yidko Solutions",
    html: `<p>Hi there,</p><p>Thank you for choosing Yidko Solutions for your e-commerce communication needs. We're here to help you build stronger customer relationships through smart, reliable messaging tools.</p><p>Get started at <a href="https://example-shop.com">example-shop.com</a>.</p><p>Best,<br>The Yidko Team</p>`
  },
  {
    subject: "Your order notification is live — Yidko Solutions",
    html: `<p>Hi,</p><p>Your automated order notification is now active and sending to your customers. You can monitor delivery status and open rates from your dashboard.</p><p>Questions? Reach us at <a href="mailto:info@example-shop.com">info@example-shop.com</a>.</p><p>Warm regards,<br>Yidko Solutions</p>`
  },
  {
    subject: "Shipping update from Yidko Solutions",
    html: `<p>Hello,</p><p>This is an automated shipping update for your recent order. Your package is on its way and expected to arrive within 2–3 business days.</p><p>Track your order or contact support at <a href="https://example-shop.com">example-shop.com</a>.</p><p>Cheers,<br>Yidko Solutions Team</p>`
  },
  {
    subject: "Customer inquiry received — Yidko Support Inbox",
    html: `<p>Hi,</p><p>A new customer inquiry has arrived in your Yidko Support Inbox. Please log in to review and respond within your SLA window.</p><p>Visit your inbox at <a href="https://example-shop.com">example-shop.com</a>.</p><p>Thanks,<br>Yidko Solutions</p>`
  },
  {
    subject: "Weekly messaging summary — Yidko Solutions",
    html: `<p>Hello,</p><p>Here's your weekly summary from Yidko Solutions: your automated messages reached customers with a strong delivery rate this week. Keep up the great work!</p><p>View your full report at <a href="https://example-shop.com">example-shop.com</a>.</p><p>Best,<br>Yidko Solutions</p>`
  },
  {
    subject: "We'd love your feedback — Yidko Solutions",
    html: `<p>Hi,</p><p>How has your experience been with Yidko Solutions? We're constantly improving our platform and your feedback means a lot to us.</p><p>Reply to this email or visit <a href="https://example-shop.com/contact">example-shop.com/contact</a>.</p><p>Many thanks,<br>Yidko Solutions</p>`
  },
  {
    subject: "Yidko Solutions — Account status update",
    html: `<p>Dear customer,</p><p>Your Yidko Solutions account is active and all communication channels are running normally. No action is required on your part.</p><p>Continue managing your messages at <a href="https://example-shop.com">example-shop.com</a>.</p><p>Kind regards,<br>Yidko Solutions Support</p>`
  },
];

const SENDERS = [
  { from: "Beeftown Store <info@example-store.com>", templates: BEEFTOWN_TEMPLATES },
  { from: "Yidko Solutions <info@example-shop.com>", templates: YIDKO_TEMPLATES },
];

export default {
  // Runs daily at 10:00 AM UTC
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await sendWarmupEmails(env);
  },

  // Also allow manual trigger via HTTP
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/trigger") {
      await sendWarmupEmails(env);
      return new Response("Warmup emails sent ✅", { status: 200 });
    }
    return new Response("Warmup worker running", { status: 200 });
  },
};

async function sendWarmupEmails(env: Env): Promise<void> {
  for (const sender of SENDERS) {
    const template = sender.templates[Math.floor(Math.random() * sender.templates.length)];
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: sender.from,
        to: [env.TARGET_EMAIL],
        subject: template.subject,
        html: template.html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to send warmup email from ${sender.from}: ${err}`);
    }
  }
}
