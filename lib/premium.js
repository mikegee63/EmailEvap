// lib/premium.js - EmailVanish Premium ($1.99/month): keeps chosen addresses receiving
// for as long as the subscription lasts. Receive-only, no sending.
//
// Design notes
// - Identity is the email the customer gives Stripe Checkout. No passwords: returning
//   users get a one-time sign-in link by email. Sessions are HttpOnly cookies.
// - Storage is SQLite in /home/emailvanish/data (OUTSIDE the web root and NOT the
//   shared 256 MB Redis). Free 10-minute inboxes stay in Redis exactly as before.
// - Inbound volume does not change at all: Mailgun already delivers to every address
//   ever issued. Premium only means we keep some of it instead of discarding it.
// - Config lives in /home/emailvanish/premium.env (mode 600, outside the web root).
//   If Stripe vars are missing the module loads in a disabled state and the routes
//   return 503, so a bad env can never take the free service down.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const Stripe = require("stripe");

const DOMAIN = "emailvanish.com";
const ADDR_RE = /^[a-f0-9]{8}@emailvanish\.com$/;
const LIMITS = {
  addressesPerAccount: 20,
  messagesPerAddress: 500,
  bodyBytes: 200 * 1024,
  subjectChars: 500,
  purgeDaysAfterCancel: 30,
  sessionDays: 90,
  loginLinkMinutes: 30
};
const STORING_STATUSES = new Set(["active", "past_due"]);

function loadEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) { /* missing env = disabled */ }
  return out;
}

// Small per-key throttle, in memory on purpose (single process, tiny volumes).
function limiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return true;
  };
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function mapStripeStatus(s) {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due") return "past_due";
  return "canceled"; // canceled, unpaid, incomplete, incomplete_expired, paused
}

function periodEndOf(sub) {
  // Newer Stripe API versions moved current_period_end onto the subscription items.
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  const v = (item && item.current_period_end) || (sub && sub.current_period_end) || null;
  return v ? v * 1000 : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'inactive',
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  current_period_end INTEGER,
  created_at INTEGER NOT NULL,
  canceled_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS addresses (
  address TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS addresses_account ON addresses(account_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  body TEXT,
  received_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_address ON messages(address, id);
`;

module.exports = function createPremium({ transporter, redisClient, log = console.log }) {
  const env = loadEnv("/home/emailvanish/premium.env");
  const enabled = !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET);
  const stripe = enabled ? new Stripe(env.STRIPE_SECRET_KEY) : null;
  const BASE_URL = env.BASE_URL || `https://${DOMAIN}`;
  const MAIL_FROM = env.MAIL_FROM || '"EmailVanish" <noreply@puresignalaudio.com>';
  const dataDir = env.DATA_DIR || "/home/emailvanish/data";
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const db = new Database(path.join(dataDir, "premium.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  if (!enabled) log("[premium] Stripe env incomplete, premium routes disabled");

  const q = {
    acctById: db.prepare("SELECT * FROM accounts WHERE id = ?"),
    acctByEmail: db.prepare("SELECT * FROM accounts WHERE email = ?"),
    acctByCustomer: db.prepare("SELECT * FROM accounts WHERE stripe_customer_id = ?"),
    acctInsert: db.prepare("INSERT INTO accounts (email, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    acctActivate: db.prepare("UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, status = 'active', cancel_at_period_end = 0, current_period_end = ?, canceled_at = NULL WHERE id = ?"),
    acctSetStatus: db.prepare("UPDATE accounts SET status = ?, cancel_at_period_end = ?, current_period_end = ?, canceled_at = ? WHERE id = ?"),
    acctMarkPurged: db.prepare("UPDATE accounts SET status = 'purged' WHERE id = ?"),
    acctsToPurge: db.prepare("SELECT id FROM accounts WHERE status = 'canceled' AND canceled_at < ?"),
    sessionInsert: db.prepare("INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    sessionGet: db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?"),
    sessionDelete: db.prepare("DELETE FROM sessions WHERE token = ?"),
    sessionsSweep: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    linkInsert: db.prepare("INSERT INTO login_links (token, email, expires_at) VALUES (?, ?, ?)"),
    linkTake: db.prepare("UPDATE login_links SET used = 1 WHERE token = ? AND used = 0 AND expires_at > ? RETURNING email"),
    linksSweep: db.prepare("DELETE FROM login_links WHERE expires_at <= ?"),
    addrGet: db.prepare("SELECT * FROM addresses WHERE address = ?"),
    addrList: db.prepare(`SELECT a.address, a.label, a.created_at,
                            (SELECT COUNT(*) FROM messages m WHERE m.address = a.address) AS total,
                            (SELECT COUNT(*) FROM messages m WHERE m.address = a.address AND m.read = 0) AS unread
                          FROM addresses a WHERE a.account_id = ? ORDER BY a.created_at`),
    addrCount: db.prepare("SELECT COUNT(*) AS n FROM addresses WHERE account_id = ?"),
    addrInsert: db.prepare("INSERT INTO addresses (address, account_id, label, created_at) VALUES (?, ?, ?, ?)"),
    addrLabel: db.prepare("UPDATE addresses SET label = ? WHERE address = ? AND account_id = ?"),
    addrDelete: db.prepare("DELETE FROM addresses WHERE address = ? AND account_id = ?"),
    addrsOfAccount: db.prepare("SELECT address FROM addresses WHERE account_id = ?"),
    keptStatus: db.prepare("SELECT ac.status FROM addresses a JOIN accounts ac ON ac.id = a.account_id WHERE a.address = ?"),
    msgInsert: db.prepare("INSERT INTO messages (address, sender, subject, body, received_at) VALUES (?, ?, ?, ?, ?)"),
    msgTrim: db.prepare("DELETE FROM messages WHERE address = ? AND id NOT IN (SELECT id FROM messages WHERE address = ? ORDER BY id DESC LIMIT ?)"),
    msgList: db.prepare("SELECT id, sender, subject, body, received_at, read FROM messages WHERE address = ? ORDER BY id DESC LIMIT 200"),
    msgMarkRead: db.prepare("UPDATE messages SET read = 1 WHERE address = ? AND read = 0"),
    msgDelete: db.prepare("DELETE FROM messages WHERE id = ? AND address IN (SELECT address FROM addresses WHERE account_id = ?)"),
    msgsDeleteAddr: db.prepare("DELETE FROM messages WHERE address = ?")
  };

  // ---- storage hooks used by the Mailgun webhook and the free generator ----

  function isKeptAddress(address) {
    return !!q.addrGet.get(String(address || "").toLowerCase());
  }

  // Called for every inbound message. Cheap: one indexed lookup. Stores only when the
  // address is kept AND the owning subscription is still paying (or in dunning).
  function storeIfKept(recipient, { sender, subject, body, timestamp }) {
    const address = String(recipient || "").toLowerCase();
    const row = q.keptStatus.get(address);
    if (!row || !STORING_STATUSES.has(row.status)) return false;
    let b = String(body || "");
    if (Buffer.byteLength(b) > LIMITS.bodyBytes) b = b.slice(0, LIMITS.bodyBytes) + "\n[truncated]";
    const tx = db.transaction(() => {
      q.msgInsert.run(address, String(sender || "").slice(0, 320), String(subject || "").slice(0, LIMITS.subjectChars), b, timestamp || Date.now());
      q.msgTrim.run(address, address, LIMITS.messagesPerAddress);
    });
    tx();
    return true;
  }

  // ---- account lifecycle ----

  function activateFromCheckoutSession(session) {
    const email = ((session.customer_details && session.customer_details.email) || session.customer_email || "").toLowerCase().trim();
    const customerId = typeof session.customer === "string" ? session.customer : (session.customer && session.customer.id);
    const subObj = typeof session.subscription === "object" ? session.subscription : null;
    const subId = subObj ? subObj.id : session.subscription;
    if (!email || !customerId) return null;
    const periodEnd = subObj ? periodEndOf(subObj) : null;
    let acct = q.acctByCustomer.get(customerId) || q.acctByEmail.get(email);
    if (!acct) {
      const info = q.acctInsert.run(email, customerId, subId || null, "active", periodEnd, Date.now());
      acct = q.acctById.get(info.lastInsertRowid);
      log(`[premium] new account #${acct.id} ${email}`);
    } else {
      q.acctActivate.run(customerId, subId || acct.stripe_subscription_id, periodEnd || acct.current_period_end, acct.id);
      acct = q.acctById.get(acct.id);
      log(`[premium] account #${acct.id} activated`);
    }
    const keep = session.metadata && session.metadata.keep;
    if (keep) { try { claimAddress(acct, String(keep)); } catch (e) { log(`[premium] keep failed: ${e.message}`); } }
    return acct;
  }

  function applySubscription(sub) {
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const acct = q.acctByCustomer.get(customerId);
    if (!acct) { log(`[premium] subscription event for unknown customer ${customerId}`); return; }
    const status = mapStripeStatus(sub.status);
    const canceledAt = status === "canceled" ? (acct.canceled_at || Date.now()) : null;
    q.acctSetStatus.run(status, sub.cancel_at_period_end ? 1 : 0, periodEndOf(sub) || acct.current_period_end, canceledAt, acct.id);
    log(`[premium] account #${acct.id} -> ${status}${sub.cancel_at_period_end ? " (cancels at period end)" : ""}`);
  }

  function claimAddress(acct, address) {
    address = address.toLowerCase().trim();
    if (!ADDR_RE.test(address)) throw new Error("That is not an EmailVanish address");
    const existing = q.addrGet.get(address);
    if (existing) {
      if (existing.account_id === acct.id) return existing;
      throw new Error("That address is already kept by another subscriber");
    }
    if (q.addrCount.get(acct.id).n >= LIMITS.addressesPerAccount) throw new Error(`Limit of ${LIMITS.addressesPerAccount} kept addresses reached`);
    q.addrInsert.run(address, acct.id, null, Date.now());
    log(`[premium] account #${acct.id} kept ${address}`);
    backfillFromRedis(address);
    return q.addrGet.get(address);
  }

  // A claim usually happens minutes after the address was used on the free page, often
  // after its 10-minute timer ran out. Whatever the free inbox still holds in Redis
  // (anything from the last 10 minutes, including mail that landed between expiry and
  // checkout) is copied into the Premium store so the subscriber does not lose it.
  function backfillFromRedis(address) {
    if (!redisClient) return;
    redisClient.lRange(`emails:${address}`, 0, -1).then(items => {
      if (!items || !items.length) return;
      const existing = new Set(db.prepare("SELECT received_at || '|' || subject AS k FROM messages WHERE address = ?").all(address).map(r => r.k));
      let n = 0;
      const tx = db.transaction(() => {
        for (const raw of items.slice().reverse()) {   // Redis list is newest-first
          let m; try { m = JSON.parse(raw); } catch (e) { continue; }
          if (existing.has(`${m.timestamp}|${m.subject}`)) continue;
          q.msgInsert.run(address, String(m.sender || "").slice(0, 320), String(m.subject || "").slice(0, LIMITS.subjectChars), String(m.body || "").slice(0, LIMITS.bodyBytes), m.timestamp || Date.now());
          n++;
        }
        q.msgTrim.run(address, address, LIMITS.messagesPerAddress);
      });
      tx();
      if (n) log(`[premium] backfilled ${n} message(s) from the free inbox for ${address}`);
    }).catch(e => log(`[premium] backfill failed for ${address}: ${e.message}`));
  }

  function newRandomAddress(acct) {
    for (let i = 0; i < 20; i++) {
      const a = `${crypto.randomBytes(4).toString("hex")}@${DOMAIN}`;
      if (!q.addrGet.get(a)) return claimAddress(acct, a);
    }
    throw new Error("Could not allocate an address, try again");
  }

  function purgeAccountData(accountId) {
    const tx = db.transaction(() => {
      for (const { address } of q.addrsOfAccount.all(accountId)) q.msgsDeleteAddr.run(address);
      db.prepare("DELETE FROM addresses WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
      q.acctMarkPurged.run(accountId);
    });
    tx();
  }

  function sweep() {
    const now = Date.now();
    q.sessionsSweep.run(now);
    q.linksSweep.run(now);
    const cutoff = now - LIMITS.purgeDaysAfterCancel * 86400000;
    for (const { id } of q.acctsToPurge.all(cutoff)) { purgeAccountData(id); log(`[premium] purged account #${id} (${LIMITS.purgeDaysAfterCancel} days after cancel)`); }
  }
  setInterval(sweep, 3600000).unref();
  sweep();

  // ---- HTTP helpers ----

  function setSessionCookie(res, acct) {
    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    q.sessionInsert.run(token, acct.id, now, now + LIMITS.sessionDays * 86400000);
    res.setHeader("Set-Cookie", `ev_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LIMITS.sessionDays * 86400}`);
  }
  function clearSessionCookie(res) {
    res.setHeader("Set-Cookie", "ev_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  }
  function currentAccount(req) {
    const token = parseCookies(req.headers.cookie).ev_session;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = q.sessionGet.get(token, Date.now());
    if (!s) return null;
    const acct = q.acctById.get(s.account_id);
    return acct && acct.status !== "purged" ? acct : null;
  }
  function requireAccount(req, res, next) {
    const acct = currentAccount(req);
    if (!acct) return res.status(401).json({ error: "Not signed in" });
    req.account = acct;
    next();
  }
  // Cookie auth + SameSite=Lax already blocks cross-site form posts; requiring JSON
  // closes the remaining gap since a plain <form> cannot send application/json.
  function requireJson(req, res, next) {
    if (!req.is("application/json")) return res.status(415).json({ error: "JSON required" });
    next();
  }
  function accountView(acct) {
    const daysLeft = acct.status === "canceled" && acct.canceled_at
      ? Math.max(0, Math.ceil((acct.canceled_at + LIMITS.purgeDaysAfterCancel * 86400000 - Date.now()) / 86400000)) : null;
    return {
      email: acct.email,
      emailIsEmailVanish: /@emailvanish\.com$/i.test(acct.email),
      status: acct.status,
      storing: STORING_STATUSES.has(acct.status),
      cancelAtPeriodEnd: !!acct.cancel_at_period_end,
      currentPeriodEnd: acct.current_period_end,
      purgeInDays: daysLeft,
      limits: { addresses: LIMITS.addressesPerAccount, messagesPerAddress: LIMITS.messagesPerAddress },
      addresses: q.addrList.all(acct.id)
    };
  }

  const checkoutLimit = limiter(10, 3600000);
  const loginIpLimit = limiter(5, 3600000);
  const loginEmailLimit = limiter(3, 3600000);

  // Stripe signs the raw body, so this MUST be mounted before bodyParser.json.
  function mountWebhook(app, express) {
    app.post("/premium/stripe-webhook", express.raw({ type: "application/json" }), (req, res) => {
      if (!enabled) return res.status(503).send("premium disabled");
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], env.STRIPE_WEBHOOK_SECRET);
      } catch (e) {
        log(`[premium] webhook signature failed: ${e.message}`);
        return res.status(400).send("bad signature");
      }
      try {
        const obj = event.data.object;
        switch (event.type) {
          case "checkout.session.completed":
            if (obj.mode === "subscription") activateFromCheckoutSession(obj);
            break;
          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted":
            applySubscription(obj);
            break;
          case "customer.updated": {
            // Email changed in the billing portal: keep the sign-in address in step.
            const acct = q.acctByCustomer.get(obj.id);
            const email = String(obj.email || "").toLowerCase().trim();
            if (acct && email && email !== acct.email) {
              const clash = q.acctByEmail.get(email);
              if (clash && clash.id !== acct.id) log(`[premium] account #${acct.id} email change refused, ${email} belongs to #${clash.id}`);
              else { db.prepare("UPDATE accounts SET email = ? WHERE id = ?").run(email, acct.id); log(`[premium] account #${acct.id} sign-in email updated`); }
            }
            break;
          }
          case "invoice.paid": {
            const acct = q.acctByCustomer.get(typeof obj.customer === "string" ? obj.customer : obj.customer.id);
            if (acct && acct.status === "past_due") { q.acctSetStatus.run("active", acct.cancel_at_period_end, acct.current_period_end, null, acct.id); log(`[premium] account #${acct.id} -> active (invoice paid)`); }
            break;
          }
          case "invoice.payment_failed": {
            const acct = q.acctByCustomer.get(typeof obj.customer === "string" ? obj.customer : obj.customer.id);
            if (acct && acct.status === "active") { q.acctSetStatus.run("past_due", acct.cancel_at_period_end, acct.current_period_end, null, acct.id); log(`[premium] account #${acct.id} -> past_due`); }
            break;
          }
          default: break;
        }
      } catch (e) {
        log(`[premium] webhook handler error: ${e.stack || e}`);
        return res.status(500).send("handler error");
      }
      res.json({ received: true });
    });
  }

  function mountRoutes(app) {
    app.get("/premium", (req, res) => res.redirect(302, "/premium.html"));

    app.get("/premium/config", (req, res) => res.json({ enabled, price: "$1.99/month", limits: LIMITS }));

    // Start a Checkout session. Optional { keep } claims a free address after payment.
    app.post("/premium/checkout", requireJson, async (req, res) => {
      if (!enabled) return res.status(503).json({ error: "Premium is not available right now" });
      if (!checkoutLimit(req.ip)) return res.status(429).json({ error: "Too many attempts, please try again later" });
      const keep = String((req.body && req.body.keep) || "").toLowerCase().trim();
      if (keep && !ADDR_RE.test(keep)) return res.status(400).json({ error: "That is not an EmailVanish address" });
      if (keep && q.addrGet.get(keep)) return res.status(409).json({ error: "That address is already kept by another subscriber" });
      const acct = currentAccount(req);
      try {
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
          success_url: `${BASE_URL}/premium.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${BASE_URL}/premium.html${keep ? "?keep=" + encodeURIComponent(keep) : ""}`,
          allow_promotion_codes: true,
          ...(acct && acct.stripe_customer_id ? { customer: acct.stripe_customer_id } : {}),
          metadata: keep ? { keep } : {},
          subscription_data: { metadata: { site: DOMAIN } }
        });
        res.json({ url: session.url });
      } catch (e) {
        log(`[premium] checkout create failed: ${e.message}`);
        res.status(502).json({ error: "Could not start checkout, please try again" });
      }
    });

    // Landing after Checkout: verify with Stripe (never trust the browser), sign in.
    app.get("/premium/session", async (req, res) => {
      if (!enabled) return res.status(503).json({ error: "Premium is not available right now" });
      const id = String(req.query.session_id || "");
      if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ error: "Bad session id" });
      try {
        const session = await stripe.checkout.sessions.retrieve(id, { expand: ["subscription"] });
        if (session.status !== "complete" || session.mode !== "subscription") return res.status(402).json({ error: "Payment not completed" });
        const acct = activateFromCheckoutSession(session);
        if (!acct) return res.status(500).json({ error: "Could not create account" });
        setSessionCookie(res, acct);
        res.json(accountView(acct));
      } catch (e) {
        log(`[premium] session verify failed: ${e.message}`);
        res.status(502).json({ error: "Could not verify payment" });
      }
    });

    // Passwordless sign-in: always 200 so the response does not reveal whether an
    // account exists. The link works once and expires in 30 minutes.
    app.post("/premium/login", requireJson, async (req, res) => {
      const email = String((req.body && req.body.email) || "").toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return res.status(400).json({ error: "Please enter a valid email address" });
      if (!loginIpLimit(req.ip) || !loginEmailLimit(email)) return res.status(429).json({ error: "Too many sign-in requests, please wait an hour" });
      const acct = q.acctByEmail.get(email);
      if (acct && acct.status !== "purged") {
        const token = crypto.randomBytes(32).toString("hex");
        q.linkInsert.run(token, email, Date.now() + LIMITS.loginLinkMinutes * 60000);
        const link = `${BASE_URL}/premium/login/${token}`;
        try {
          await transporter.sendMail({
            from: MAIL_FROM,
            to: email,
            subject: "Your EmailVanish Premium sign-in link",
            text: `Click to sign in to EmailVanish Premium:\n\n${link}\n\nThis link works once and expires in ${LIMITS.loginLinkMinutes} minutes. If you did not request it, you can ignore this email.\n`
          });
          log(`[premium] sign-in link sent to account #${acct.id}`);
        } catch (e) {
          log(`[premium] sign-in mail failed: ${e.message}`);
          return res.status(500).json({ error: "Could not send the sign-in email, please try again" });
        }
      }
      res.json({ ok: true, message: "If that email has a Premium subscription, a sign-in link is on its way." });
    });

    app.get("/premium/login/:token", (req, res) => {
      const token = String(req.params.token || "");
      if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).send("Bad link");
      const row = q.linkTake.get(token, Date.now());
      if (!row) return res.redirect(302, "/premium.html?login=expired");
      const acct = q.acctByEmail.get(row.email);
      if (!acct || acct.status === "purged") return res.redirect(302, "/premium.html?login=expired");
      setSessionCookie(res, acct);
      res.redirect(302, "/premium.html");
    });

    app.post("/premium/logout", (req, res) => {
      const token = parseCookies(req.headers.cookie).ev_session;
      if (token) q.sessionDelete.run(token);
      clearSessionCookie(res);
      res.json({ ok: true });
    });

    app.get("/premium/me", (req, res) => {
      const acct = currentAccount(req);
      if (!acct) return res.status(401).json({ error: "Not signed in" });
      res.json(accountView(acct));
    });

    app.post("/premium/portal", requireAccount, requireJson, async (req, res) => {
      if (!enabled || !req.account.stripe_customer_id) return res.status(503).json({ error: "Billing portal unavailable" });
      try {
        const s = await stripe.billingPortal.sessions.create({ customer: req.account.stripe_customer_id, return_url: `${BASE_URL}/premium.html` });
        res.json({ url: s.url });
      } catch (e) {
        log(`[premium] portal failed: ${e.message}`);
        res.status(502).json({ error: "Could not open the billing portal" });
      }
    });

    app.post("/premium/addresses", requireAccount, requireJson, (req, res) => {
      if (!STORING_STATUSES.has(req.account.status)) return res.status(402).json({ error: "Your subscription is not active" });
      try {
        const keep = String((req.body && req.body.keep) || "").trim();
        const row = keep ? claimAddress(req.account, keep) : newRandomAddress(req.account);
        res.json({ address: row.address, account: accountView(req.account) });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    app.patch("/premium/addresses/:address", requireAccount, requireJson, (req, res) => {
      const label = String((req.body && req.body.label) || "").slice(0, 60);
      const info = q.addrLabel.run(label || null, String(req.params.address).toLowerCase(), req.account.id);
      if (!info.changes) return res.status(404).json({ error: "Address not found" });
      res.json({ ok: true });
    });

    app.delete("/premium/addresses/:address", requireAccount, (req, res) => {
      const address = String(req.params.address).toLowerCase();
      const tx = db.transaction(() => {
        const info = q.addrDelete.run(address, req.account.id);
        if (info.changes) q.msgsDeleteAddr.run(address);
        return info.changes;
      });
      if (!tx()) return res.status(404).json({ error: "Address not found" });
      log(`[premium] account #${req.account.id} released ${address}`);
      res.json({ ok: true, account: accountView(req.account) });
    });

    app.get("/premium/addresses/:address/messages", requireAccount, (req, res) => {
      const address = String(req.params.address).toLowerCase();
      const row = q.addrGet.get(address);
      if (!row || row.account_id !== req.account.id) return res.status(404).json({ error: "Address not found" });
      const messages = q.msgList.all(address);
      q.msgMarkRead.run(address);
      res.json({ address, messages });
    });

    app.delete("/premium/messages/:id", requireAccount, (req, res) => {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
      const info = q.msgDelete.run(id, req.account.id);
      if (!info.changes) return res.status(404).json({ error: "Message not found" });
      res.json({ ok: true });
    });
  }

  return { enabled, mountWebhook, mountRoutes, storeIfKept, isKeptAddress, LIMITS, _db: db };
};
