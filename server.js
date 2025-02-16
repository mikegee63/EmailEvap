const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const redis = require("redis");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Redis client setup
const redisClient = redis.createClient({
    url: "redis://red-cuougvdds78s738omp10:6379"
});

// ✅ Debugging: Log Redis connection status
redisClient.on("connect", () => console.log("✅ Connected to Redis"));
redisClient.on("error", (err) => console.error("🚨 Redis Error:", err));

redisClient.connect().catch(console.error);

// ✅ Middleware to parse incoming JSON and form-encoded data
app.use(bodyParser.json({ limit: "10mb" })); // Allow larger payloads
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

// ✅ Serve static files (CSS, JS, images) directly from the root
app.use(express.static(__dirname));

// ✅ Ensure the root URL loads index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ✅ Function to generate a random disposable email
function generateRandomEmail() {
    return `${crypto.randomBytes(4).toString("hex")}@emailvanish.com`;
}

// ✅ API to Assign a Random Email Address to Users
app.get("/generate-email", async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    let email = await redisClient.get(userId);
    if (!email) {
        email = generateRandomEmail();
        await redisClient.setEx(userId, 600, email); // Store email with 10-minute expiration
    }
    console.log(`🔹 Assigned Email for ${userId}: ${email}`);
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
    const body = req.body["stripped-text"] || "No text content";

    console.log(`📬 New email from ${sender} to ${recipient}`);
    console.log(`📌 Subject: ${subject}`);
    console.log(`📄 Message: ${body}`);

    if (!recipient) return res.status(400).send("Invalid recipient");

    // ✅ Store email in Redis
    const emailKey = `emails:${recipient}`;
    const emailData = JSON.stringify({ sender, subject, body, timestamp: Date.now() });
    await redisClient.lPush(emailKey, emailData);
    await redisClient.expire(emailKey, 600); // Emails expire in 10 minutes

    // ✅ Debugging: Check if email was stored in Redis
    const storedMessages = await redisClient.lRange(emailKey, 0, -1);
    console.log("📝 Messages in Redis after storing:", storedMessages);

    res.status(200).send("Webhook received!");
});

// ✅ API Endpoint for the Frontend to Fetch Emails
app.get("/get-emails", async (req, res) => {
    const email = req.query.email;
    if (!email) return res.json({ messages: [] });

    const emailKey = `emails:${email}`;
    console.log("🔍 Fetching emails for key:", emailKey);

    const messages = await redisClient.lRange(emailKey, 0, -1);
    console.log("📤 Retrieved Messages from Redis:", messages);

    res.json({ messages: messages.map(msg => JSON.parse(msg)) });
});

// ✅ Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
