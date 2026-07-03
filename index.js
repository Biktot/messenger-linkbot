const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

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
    if (!subject) return sendMessage(senderId, "Usage: /reviewer <subject>");

    const { data, error } = await supabase
      .from('links')
      .select('url')
      .eq('subject', subject);

    if (error) return sendMessage(senderId, "Error fetching links.");
    if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}" yet.`);

    const list = data.map((l, i) => `${i + 1}. ${l.url}`).join('\n');
    return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
  }

  // /addlink <subject> <url>
  if (lower.startsWith('/addlink')) {
    const parts = trimmed.split(' ');
    const subject = parts[1]?.toLowerCase();
    const url = parts[2];
    if (!subject || !url) return sendMessage(senderId, "Usage: /addlink <subject> <url>");

    const { error } = await supabase.from('links').insert({ subject, url });
    if (error) return sendMessage(senderId, "Error saving link.");
    return sendMessage(senderId, `✅ Added to "${subject}".`);
  }

  // /subjects
  if (lower.startsWith('/subjects')) {
    const { data, error } = await supabase.from('links').select('subject');
    if (error) return sendMessage(senderId, "Error fetching subjects.");

    const subjects = [...new Set(data.map(d => d.subject))];
    if (subjects.length === 0) return sendMessage(senderId, "No subjects tracked yet.");
    return sendMessage(senderId, `📂 Subjects: ${subjects.join(', ')}`);
  }

  // Auto-detect #tag + link
  const tagMatch = trimmed.match(/#(\w+)/);
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (tagMatch && urlMatch) {
    const subject = tagMatch[1].toLowerCase();
    const url = urlMatch[0];
    const { error } = await supabase.from('links').insert({ subject, url });
    if (error) return sendMessage(senderId, "Error saving link.");
    return sendMessage(senderId, `✅ Filed under "${subject}".`);
  }
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text } }
    );
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
  }
}

app.get('/', (req, res) => res.send('Bot is running'));

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started');
});
