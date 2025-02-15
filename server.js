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

// ✅ Mailgun Webhook Route
app.post("/mailgun/webhook", (req, res) => {
  console.log("📩 Incoming Email:", req.body);

  const recipient = req.body.recipient; // The email that received the message
  const sender = req.body.sender; // The email sender
  const subject = req.body.subject; // Email subject
  const body = req.body["stripped-text"] || "No text content"; // Plain text content of the email

  console.log(`📬 New email from ${sender} to ${recipient}`);
  console.log(`📌 Subject: ${subject}`);
  console.log(`📄 Message: ${body}`);

  // Acknowledge the webhook request
  res.status(200).send("Webhook received!");
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
