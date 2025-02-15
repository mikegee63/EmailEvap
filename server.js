const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse incoming JSON and form-encoded data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (CSS, JS, images) directly from the root
app.use(express.static(__dirname));

// Ensure the root URL loads index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Temporary in-memory storage for received emails and active user sessions
let emailStore = {}; 
let userSessions = {}; // Fix: Ensure userSessions is defined

// Function to generate a random disposable email
function generateRandomEmail() {
    return `${crypto.randomBytes(4).toString("hex")}@emailvanish.com`;
}

// ✅ API to Assign a Random Email Address to Users
app.get("/generate-email", (req, res) => {
    const userId = req.query.userId;

    if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
    }

    if (userSessions[userId]) {
        return res.json({ email: userSessions[userId] });
    }

    const randomEmail = generateRandomEmail();
    userSessions[userId] = randomEmail;
    res.json({ email: randomEmail });
});

// ✅ Mailgun Webhook Route to Store Incoming Emails
app.post("/mailgun/webhook", (req, res) => {
    console.log("📩 Incoming Email:", req.body);

    const recipient = req.body.recipient; // The temp email address
    const sender = req.body.sender; // Who sent the email
    const subject = req.body.subject; // Email subject
    const body = req.body["stripped-text"] || "No text content"; // Email content

    console.log(`📬 New email from ${sender} to ${recipient}`);
    console.log(`📌 Subject: ${subject}`);
    console.log(`📄 Message: ${body}`);

    // Store email in memory (organized by recipient address)
    if (!emailStore[recipient]) {
        emailStore[recipient] = [];
    }
    emailStore[recipient].push({ sender, subject, body });

    console.log("📂 Current Email Store:", JSON.stringify(emailStore, null, 2)); // Debugging line

    res.status(200).send("Webhook received!");
});

// ✅ API Endpoint for the Frontend to Fetch Emails
app.get("/get-emails", (req, res) => {
    const email = req.query.email;
    if (!email || !emailStore[email]) {
        return res.json({ messages: [] }); // Return empty if no emails found
    }
    res.json({ messages: emailStore[email] });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
