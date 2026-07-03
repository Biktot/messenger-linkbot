const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "linkbot"; // change this to your own random string
const PAGE_ACCESS_TOKEN = "EAAYUBmeRSi4BR3X2sLFhKzH33J21SO9UcdDocPdfk3MJpLBM5T8VCrZCHCE4scXYYZAfubRmLZAI900qD2tOozRoLTwZAykPx9Pd5e33HV4R4WSwgBqERECBFgblzqpIFxf5edRf6oOKo3a9ZAiuWm4FD2PG7yCLNU82kSnM0cxvcNnhAdnzETRBdOdYJmY9tkcN0P88crAZBdh4cDtgT8Mh3mWZBdwY6kEZCk5SLwEZD";

// In-memory storage: { subject: [ { url, date } ] }
const links = {};

// Webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Incoming messages (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const event = entry.messaging?.[0];
      if (event?.message?.text) {
        await handleMessage(event.message.text, event.sender.id);
      }
    }
  }

  res.status(200).send('EVENT_RECEIVED');
});

async function handleMessage(text, senderId) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // /reviewer <subject>
  if (lower.startsWith('/reviewer')) {
    const subject = trimmed.split(' ')[1]?.toLowerCase();
    if (!subject) {
      return sendMessage(senderId, "Usage: /reviewer <subject>");
    }
    const subjectLinks = links[subject];
    if (!subjectLinks || subjectLinks.length === 0) {
      return sendMessage(senderId, `No links found for "${subject}" yet.`);
    }
    const list = subjectLinks.map((l, i) => `${i + 1}. ${l.url}`).join('\n');
    return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
  }

  // /addlink <subject> <url>
  if (lower.startsWith('/addlink')) {
    const parts = trimmed.split(' ');
    const subject = parts[1]?.toLowerCase();
    const url = parts[2];
    if (!subject || !url) {
      return sendMessage(senderId, "Usage: /addlink <subject> <url>");
    }
    if (!links[subject]) links[subject] = [];
    links[subject].push({ url, date: new Date().toISOString() });
    return sendMessage(senderId, `✅ Added to "${subject}".`);
  }

  // /subjects
  if (lower.startsWith('/subjects')) {
    const subjects = Object.keys(links);
    if (subjects.length === 0) {
      return sendMessage(senderId, "No subjects tracked yet.");
    }
    return sendMessage(senderId, `📂 Subjects: ${subjects.join(', ')}`);
  }

  // Auto-detect #tag + link in normal messages
  const tagMatch = trimmed.match(/#(\w+)/);
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (tagMatch && urlMatch) {
    const subject = tagMatch[1].toLowerCase();
    const url = urlMatch[0];
    if (!links[subject]) links[subject] = [];
    links[subject].push({ url, date: new Date().toISOString() });
    return sendMessage(senderId, `✅ Filed under "${subject}".`);
  }
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text },
      }
    );
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
  }
}

app.get('/', (req, res) => res.send('Bot is running'));

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started');
});
