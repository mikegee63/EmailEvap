const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const redis = require("redis");
const sanitizeHtml = require("sanitize-html");
const nodemailer = require("nodemailer");

const app = express();
app.set('trust proxy', 'loopback');
const PORT = process.env.PORT || 3003;

// Redis client setup
const redisClient = redis.createClient({
    url: "redis://localhost:6379"
});
redisClient.connect().catch(console.error);

// Setup Nodemailer for sending contact form emails
const transporter = nodemailer.createTransport({
    sendmail: true,
    newline: 'unix',
    path: '/usr/sbin/sendmail'
});

// EmailVanish Premium ($1.99/mo kept addresses). Config in /home/emailvanish/premium.env,
// data in /home/emailvanish/data. Loads disabled (503s) if the env is incomplete.
const premium = require("./lib/premium")({ transporter, redisClient });
// Stripe verifies its signature over the RAW body, so this route must be mounted
// before bodyParser touches anything.
premium.mountWebhook(app, express);

// Middleware to parse incoming JSON and form-encoded data
app.use(bodyParser.json({ limit: "10mb" })); // Allow larger payloads
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// Block server internals from being downloaded via the static handler
app.use((req, res, next) => {
  if (/^\/(server\.js|aliexpressAds\.js|package\.json|package-lock\.json|README\.md|server\.log|node_modules(\/|$)|lib(\/|$))/i.test(req.path) || /\.bak(\.|$)/i.test(req.path)) {
    return res.status(403).send("Forbidden");
  }
  next();
});

// Serve static files (CSS, JS, images) directly from the root
app.use(express.static(__dirname));

// Rotating AliExpress affiliate ads
const { getRandomAdProducts } = require("./aliexpressAds");
app.get("/api/ads", (req, res) => {
  const count = Math.min(parseInt(req.query.count, 10) || 1, 4);
  res.json({ success: true, products: getRandomAdProducts(count) });
});

// Ensure the root URL loads index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Function to generate a random disposable email. Never hands out an address a
// Premium subscriber has kept (4.3 billion possibilities, so a retry is rare).
function generateRandomEmail() {
    for (let i = 0; i < 10; i++) {
        const email = `${crypto.randomBytes(4).toString("hex")}@emailvanish.com`;
        if (!premium.isKeptAddress(email)) return email;
    }
    return `${crypto.randomBytes(6).toString("hex")}@emailvanish.com`;
}

// ✅ API to Assign a Random Email Address to Users
app.get("/generate-email", async (req, res) => {
    const userId = req.query.userId;
    const forceNew = req.query.force === "true"; // Allow forcing a new email
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    let email = await redisClient.get(userId);
    if (!email || forceNew) {
        email = generateRandomEmail();
        await redisClient.setEx(userId, 600, email); // Store email with 10-minute expiration
    }
    res.json({ email });
});

// ✅ Mailgun Webhook Route to Store Incoming Emails
app.post("/mailgun/webhook", async (req, res) => {
  // console.log("📩 Incoming Email:", req.body); // Disabled: causes memory bloat

  const recipient = req.body.recipient;
  const sender = req.body.sender;
  const subject = req.body.subject;
  // Prefer the HTML version if available.
  let bodyHtml = req.body["body-html"] || req.body["stripped-text"] || "No content";

  // Log the raw email body for debugging.
  // console.log("Raw email body:", bodyHtml); // Disabled: causes memory bloat

  // Remove any extraneous encoded fragment that looks like "<a href="
  bodyHtml = bodyHtml.replace(/%3Ca%20href=/gi, '');

  // Sanitize the HTML without transforming <a> tags. Structural tags only, no
  // attributes except the link ones, no images (so no tracking pixels), no styles.
  bodyHtml = sanitizeHtml(bodyHtml, {
    allowedTags: ["b", "i", "em", "strong", "a", "p", "br", "u", "s", "hr",
                  "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "div", "span",
                  "table", "thead", "tbody", "tr", "td", "th"],
    allowedAttributes: {
      "a": ["href", "target", "rel"]
    },
    allowedSchemes: ["http", "https", "mailto"],
    // Do not perform any tag transformations.
    transformTags: {}
  });

  // Add target and rel attributes to <a> tags if missing.
  bodyHtml = bodyHtml.replace(/<a\s+(?!.*target=)(?!.*rel=)/gi, '<a target="_blank" rel="noopener noreferrer" ');

  console.log(`📬 New email from ${sender} to ${recipient}`);
  console.log(`📌 Subject: ${subject}`);
  // Disabled: cleaned message logging causes memory bloat

  if (!recipient) return res.status(400).send("Invalid recipient");

  const timestamp = Date.now();

  // Premium: keep it if a subscriber owns this address. Never lets the free path fail.
  try {
    if (premium.storeIfKept(recipient, { sender, subject, body: bodyHtml, timestamp })) {
      console.log(`💾 Kept for Premium subscriber: ${recipient}`);
    }
  } catch (e) {
    console.error("❌ Premium store failed:", e.message);
  }

  // Store the cleaned email in Redis.
  const emailKey = `emails:${recipient}`;
  const emailData = JSON.stringify({ sender, subject, body: bodyHtml, timestamp });
  await redisClient.lPush(emailKey, emailData);
  await redisClient.expire(emailKey, 600); // Emails expire in 10 minutes

  res.status(200).send("Webhook received!");
});

// ✅ API Endpoint for the Frontend to Fetch Emails
app.get("/get-emails", async (req, res) => {
    const email = req.query.email;
    if (!email) return res.json({ messages: [] });

    const messages = await redisClient.lRange(`emails:${email}`, 0, -1);
    res.json({ messages: messages.map(msg => JSON.parse(msg)) });
});

// ✅ Premium routes (/premium/*)
premium.mountRoutes(app);

// ✅ Contact Form Route
// Per-IP throttle for the contact form. In memory on purpose: one process, and
// losing the counters on restart is harmless for a form that sees a handful of
// genuine submissions a month.
const contactHits = new Map();
function contactAllowed(ip) {
    const now = Date.now();
    const recent = (contactHits.get(ip) || []).filter(t => now - t < 3600000);
    if (recent.length >= 3) { contactHits.set(ip, recent); return false; }
    recent.push(now);
    contactHits.set(ip, recent);
    if (contactHits.size > 5000) {           // keep the map from growing forever
        for (const [k, v] of contactHits) {
            if (!v.some(t => now - t < 3600000)) contactHits.delete(k);
        }
    }
    return true;
}

app.post("/send-contact", async (req, res) => {
    const { email, message, website } = req.body;

    // Honeypot: a real person never sees this field. Answer 200 so a bot thinks
    // it worked and moves on instead of retrying with different input.
    if (website) {
        console.log(`\u{1F41D} contact honeypot tripped from ${req.ip}`);
        return res.status(200).json({ success: "Message sent successfully!" });
    }

    if (!email || !message) {
        return res.status(400).json({ error: "Email and message are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim()) || String(email).length > 200) {
        return res.status(400).json({ error: "Please enter a valid email address" });
    }
    if (String(message).length > 5000) {
        return res.status(400).json({ error: "That message is too long" });
    }
    if (!contactAllowed(req.ip)) {
        return res.status(429).json({ error: "Too many messages from here. Please try again later." });
    }

    const mailOptions = {
        // Using puresignalaudio.com as the sender to ensure delivery (SPF/DKIM match)
        from: '"EmailVanish Contact" <noreply@puresignalaudio.com>',
        to: 'mikegee63@gmail.com',
        subject: 'New Contact Form Message from EmailVanish.com',
        text: `You have a new message from the EmailVanish contact form:\n\nFrom: ${email}\n\nMessage:\n${message}`,
        replyTo: String(email).replace(/[\r\n]/g, '').trim()
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📩 Contact form message sent from ${email}`);
        res.status(200).json({ success: "Message sent successfully!" });
    } catch (error) {
        console.error("❌ Error sending contact form email:", error);
        res.status(500).json({ error: "Failed to send message" });
    }
});

// Start the server
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
