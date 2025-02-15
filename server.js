const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");

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

// ✅ Fix: Mailgun Webhook Route (POST request)
app.post("/mailgun/webhook", (req, res) => {
  console.log("📩 Incoming Email:", req.body);

  const recipient = req.body.recipient; // Email that received the message
  const sender = req.body.sender;       // Sender's email address
  const subject = req.body.subject;     // Email subject
  const body = req.body["stripped-text"] || "No text content"; // Email content

  console.log(`📬 New email from ${sender} to ${recipient}`);
  console.log(`📌 Subject: ${subject}`);
  console.log(`📄 Message: ${body}`);

  // Acknowledge Mailgun request
  res.status(200).send("Webhook received!");
});
// Temporary in-memory storage for received emails
let emailStore = {}; 

// ✅ Modify the Webhook Route to Store Emails
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
