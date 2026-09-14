// lib/premiumAdmin.js - operator page for EmailVanish Premium at /premium/admin.
//
// Separate login from subscribers: ADMIN_USER + ADMIN_PASS_HASH (scrypt) in premium.env.
// Admin sessions live in memory (single process; a restart signs the admin out, which
// is fine). Every data route requires the ev_admin cookie. The HTML lives in lib/ so the
// static handler's /lib/ guard keeps it out of casual enumeration; the route serves it.

const crypto = require("crypto");
const path = require("path");

const SESSION_HOURS = 12;

function hashPassword(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(String(pass), salt, 32).toString("hex")}`;
}
function verifyPassword(pass, stored) {
  const [, salt, hex] = String(stored || "").split("$");
  if (!salt || !hex) return false;
  const a = Buffer.from(hex, "hex"), b = crypto.scryptSync(String(pass), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports.hashPassword = hashPassword;

module.exports.mount = function mount(app, ctx) {
  const { db, q, env, log, setSessionCookie, purgeAccountData, parseCookies, limiter, LIMITS, STORING_STATUSES } = ctx;
  const enabled = !!(env.ADMIN_USER && env.ADMIN_PASS_HASH);
  if (!enabled) { log("[premium-admin] ADMIN_USER/ADMIN_PASS_HASH missing, admin disabled"); }

  const sessions = new Map(); // token -> expires
  const loginLimit = limiter(5, 15 * 60000);

  function isAdmin(req) {
    const t = parseCookies(req.headers.cookie).ev_admin;
    if (!t) return false;
    const exp = sessions.get(t);
    if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
    return true;
  }
  function requireAdmin(req, res, next) {
    if (!isAdmin(req)) return res.status(401).json({ error: "Admin sign-in required" });
    next();
  }
  function requireJson(req, res, next) {
    if (!req.is("application/json")) return res.status(415).json({ error: "JSON required" });
    next();
  }

  const stmts = {
    overview: db.prepare(`SELECT
        (SELECT COUNT(*) FROM accounts WHERE status = 'active') AS active,
        (SELECT COUNT(*) FROM accounts WHERE status = 'past_due') AS past_due,
        (SELECT COUNT(*) FROM accounts WHERE status = 'canceled') AS canceled,
        (SELECT COUNT(*) FROM accounts WHERE status = 'purged') AS purged,
        (SELECT COUNT(*) FROM accounts WHERE status = 'active' AND stripe_customer_id IS NULL) AS comped,
        (SELECT COUNT(*) FROM addresses) AS addresses,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM messages WHERE received_at > ?) AS messages_24h,
        (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS live_sessions`),
    accounts: db.prepare(`SELECT a.*,
        (SELECT COUNT(*) FROM addresses x WHERE x.account_id = a.id) AS address_count,
        (SELECT COUNT(*) FROM messages m JOIN addresses x ON x.address = m.address WHERE x.account_id = a.id) AS message_count,
        (SELECT MAX(m.received_at) FROM messages m JOIN addresses x ON x.address = m.address WHERE x.account_id = a.id) AS last_message_at
      FROM accounts a ORDER BY a.created_at DESC`),
    account: db.prepare("SELECT * FROM accounts WHERE id = ?"),
    addresses: db.prepare(`SELECT x.address, x.label, x.created_at,
        (SELECT COUNT(*) FROM messages m WHERE m.address = x.address) AS total,
        (SELECT MAX(received_at) FROM messages m WHERE m.address = x.address) AS last_at
      FROM addresses x WHERE x.account_id = ? ORDER BY x.created_at`),
    recentForAccount: db.prepare(`SELECT m.id, m.address, m.sender, m.subject, m.received_at FROM messages m
      JOIN addresses x ON x.address = m.address WHERE x.account_id = ? ORDER BY m.id DESC LIMIT 50`),
    recentAll: db.prepare(`SELECT m.id, m.address, m.sender, m.subject, m.received_at, x.account_id
      FROM messages m LEFT JOIN addresses x ON x.address = m.address ORDER BY m.id DESC LIMIT 100`),
    addrOwner: db.prepare("SELECT account_id FROM addresses WHERE address = ?"),
    addrDelete: db.prepare("DELETE FROM addresses WHERE address = ?"),
    msgsDeleteAddr: db.prepare("DELETE FROM messages WHERE address = ?"),
    acctByEmail: db.prepare("SELECT * FROM accounts WHERE email = ?"),
    acctInsertComp: db.prepare("INSERT INTO accounts (email, status, current_period_end, created_at) VALUES (?, 'active', ?, ?)"),
    acctSetComp: db.prepare("UPDATE accounts SET status = 'active', canceled_at = NULL, current_period_end = ? WHERE id = ?"),
    acctSetStatus: db.prepare("UPDATE accounts SET status = ?, canceled_at = ? WHERE id = ?"),
    acctDeleteRow: db.prepare("DELETE FROM accounts WHERE id = ?")
  };

  app.get("/premium/admin", (req, res) => {
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(__dirname, "admin.html"));
  });

  app.post("/premium/admin/login", requireJson, (req, res) => {
    if (!enabled) return res.status(503).json({ error: "Admin is not configured" });
    if (!loginLimit(req.ip)) return res.status(429).json({ error: "Too many attempts, wait 15 minutes" });
    const { user, pass } = req.body || {};
    if (user !== env.ADMIN_USER || !verifyPassword(pass, env.ADMIN_PASS_HASH)) {
      log(`[premium-admin] failed login from ${req.ip}`);
      return res.status(401).json({ error: "Wrong username or password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_HOURS * 3600000);
    res.setHeader("Set-Cookie", `ev_admin=${token}; Path=/premium/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
    log(`[premium-admin] admin signed in from ${req.ip}`);
    res.json({ ok: true });
  });

  app.post("/premium/admin/logout", (req, res) => {
    sessions.delete(parseCookies(req.headers.cookie).ev_admin);
    res.setHeader("Set-Cookie", "ev_admin=; Path=/premium/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    res.json({ ok: true });
  });

  app.get("/premium/admin/api/overview", requireAdmin, (req, res) => {
    const now = Date.now();
    const o = stmts.overview.get(now - 86400000, now);
    let dbBytes = 0;
    for (const f of [db.name, db.name + "-wal"]) { try { dbBytes += require("fs").statSync(f).size; } catch (e) {} }  // WAL mode: recent data sits in -wal
    res.json({ ...o, mrr: +(((o.active - o.comped) * 1.99).toFixed(2)), dbBytes, limits: LIMITS, storingStatuses: [...STORING_STATUSES] });
  });

  app.get("/premium/admin/api/accounts", requireAdmin, (req, res) => {
    res.json({ accounts: stmts.accounts.all().map(a => ({ ...a, comped: a.status === "active" && !a.stripe_customer_id })) });
  });

  app.get("/premium/admin/api/accounts/:id", requireAdmin, (req, res) => {
    const acct = stmts.account.get(Number(req.params.id));
    if (!acct) return res.status(404).json({ error: "No such account" });
    res.json({ account: acct, addresses: stmts.addresses.all(acct.id), recent: stmts.recentForAccount.all(acct.id) });
  });

  app.get("/premium/admin/api/messages/recent", requireAdmin, (req, res) => {
    res.json({ messages: stmts.recentAll.all() });
  });

  // Support: open the subscriber's own dashboard in this browser.
  app.post("/premium/admin/api/accounts/:id/signin-as", requireAdmin, requireJson, (req, res) => {
    const acct = stmts.account.get(Number(req.params.id));
    if (!acct || acct.status === "purged") return res.status(404).json({ error: "No such account" });
    setSessionCookie(res, acct);
    log(`[premium-admin] admin signed in as account #${acct.id}`);
    res.json({ ok: true, url: "/premium.html" });
  });

  // Complimentary access: create or reactivate an account with no Stripe customer.
  app.post("/premium/admin/api/comp", requireAdmin, requireJson, (req, res) => {
    const email = String((req.body && req.body.email) || "").toLowerCase().trim();
    const days = Math.min(3650, Math.max(1, Number(req.body && req.body.days) || 365));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: "Valid email required" });
    const until = Date.now() + days * 86400000;
    let acct = stmts.acctByEmail.get(email);
    if (acct) { stmts.acctSetComp.run(until, acct.id); }
    else { const info = stmts.acctInsertComp.run(email, until, Date.now()); acct = stmts.account.get(info.lastInsertRowid); }
    log(`[premium-admin] comp granted to account #${acct.id} for ${days} days`);
    res.json({ ok: true, account: stmts.account.get(acct.id) });
  });

  // Stop storage for an account without touching Stripe (abuse handling).
  app.post("/premium/admin/api/accounts/:id/status", requireAdmin, requireJson, (req, res) => {
    const acct = stmts.account.get(Number(req.params.id));
    if (!acct) return res.status(404).json({ error: "No such account" });
    const status = String((req.body && req.body.status) || "");
    if (!["active", "canceled"].includes(status)) return res.status(400).json({ error: "status must be active or canceled" });
    stmts.acctSetStatus.run(status, status === "canceled" ? Date.now() : null, acct.id);
    log(`[premium-admin] account #${acct.id} status forced to ${status}`);
    res.json({ ok: true, account: stmts.account.get(acct.id) });
  });

  app.delete("/premium/admin/api/addresses/:address", requireAdmin, (req, res) => {
    const address = String(req.params.address).toLowerCase();
    const row = stmts.addrOwner.get(address);
    if (!row) return res.status(404).json({ error: "Address not kept" });
    db.transaction(() => { stmts.addrDelete.run(address); stmts.msgsDeleteAddr.run(address); })();
    log(`[premium-admin] released ${address} from account #${row.account_id}`);
    res.json({ ok: true });
  });

  // Purge = delete addresses, messages, sessions; the account row stays as 'purged'
  // for the audit trail. ?hard=1 also removes the row.
  app.delete("/premium/admin/api/accounts/:id", requireAdmin, (req, res) => {
    const acct = stmts.account.get(Number(req.params.id));
    if (!acct) return res.status(404).json({ error: "No such account" });
    purgeAccountData(acct.id);
    if (req.query.hard === "1") stmts.acctDeleteRow.run(acct.id);
    log(`[premium-admin] account #${acct.id} purged${req.query.hard === "1" ? " and deleted" : ""}`);
    res.json({ ok: true });
  });

  return { enabled };
};
