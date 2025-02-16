const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const redis = require("redis");
const sanitizeHtml = require("sanitize-html");

const app = express();
const PORT = process.env.PORT || 3000;

// Redis client setup
const redisClient = redis.createClient({
    url: "redis://red-cuougvdds78s738omp10:6379"
});
redisClient.connect().catch(console.error);

// Middleware to parse incoming JSON and form-encoded data
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// Serve static files
app.use(express.static(__dirname));

// Ensure the root URL loads index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Function to generate a random disposable email
function generateRandomEmail() {
    return `${crypto.randomBytes(4).toString("hex")}@emailvanish.com`;
}

// ✅ API to Assign a Random Email Address
app.get("/generate-email", async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    let email = await redisClient.get(userId);
    if (!email) {
        email = generateRandomEmail();
        await redisClient.setEx(userId, 600, email);
    }
    res.json({ email });
});

// ✅ Mailgun Webhook Route to Store Incoming Emails
app.post("/mailgun/webhook", async (req, res) => {
    const emailSize = req.headers["content-length"] || 0;
    const maxSize = 5 * 1024 * 1024; // 5MB limit

    if (emailSize > maxSize) {
        console.log("🚨 Email too large:", emailSize);
        return res.status(400).send("Email size exceeds the limit");
    }

    console.log("📩 Incoming Email:", req.body);

    const recipient = req.body.recipient;
    const sender = req.body.sender;
    const subject = req.body.subject;
    let bodyHtml = req.body["body-html"] || req.body["stripped-text"] || "No content";

    // ✅ Preserve Embedded Links Correctly
    bodyHtml = sanitizeHtml(bodyHtml, {
        allowedTags: ["b", "i", "em", "strong", "a", "p", "br"],
        allowedAttributes: {
            "a": ["href", "target", "rel"]
        },
        transformTags: {
            "a": (tagName, attribs) => {
                if (!attribs.href || !attribs.href.startsWith("http")) {
                    return {
                        tagName: "a",
                        attribs: { href: "#", target: "_blank", rel: "noopener noreferrer" }
                    };
                }
                return {
                    tagName: "a",
                    attribs: {
                        href: attribs.href,
                        target: "_blank",
                        rel: "noopener noreferrer"
                    },
                    text: attribs.href // Ensure the link text is preserved
                };
            }
        }
    });

    console.log(`📬 New email from ${sender} to ${recipient}`);
    console.log(`📌 Subject: ${subject}`);
    console.log(`📄 Cleaned Message: ${bodyHtml}`);

    if (!recipient) return res.status(400).send("Invalid recipient");

    // Store email in Redis
    const emailKey = `emails:${recipient}`;
    const emailData = JSON.stringify({ sender, subject, body: bodyHtml, timestamp: Date.now() });
    await redisClient.lPush(emailKey, emailData);
    await redisClient.expire(emailKey, 600); // Emails expire in 10 minutes

    res.status(200).send("Webhook received!");
});

// ✅ API to Retrieve Stored Emails
app.get("/get-emails", async (req, res) => {
    const email = req.query.email;
    if (!email) return res.json({ messages: [] });

    const messages = await redisClient.lRange(`emails:${email}`, 0, -1);
    res.json({ messages: messages.map(msg => JSON.parse(msg)) });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
