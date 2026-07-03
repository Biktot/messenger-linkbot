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

  if (lower.startsWith('/reviewer')) {
    const subject = trimmed.split(' ')[1]?.toLowerCase();
    if (!subject) return sendMessage(senderId, "Usage: /reviewer <subject>");

    const { data, error } = await supabase
      .from('links')
      .select('id, url')
      .eq('subject', subject)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Reviewer error:', error);
      return sendMessage(senderId, "Error fetching links.");
    }
    if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}" yet.`);

    const list = data.map((l, i) => `${i + 1}. ${l.url}`).join('\n');
    return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
  }

  if (lower.startsWith('/addlink')) {
    const parts = trimmed.split(' ');
    const subject = parts[1]?.toLowerCase();
    const url = parts[2];
    if (!subject || !url) return sendMessage(senderId, "Usage: /addlink <subject> <url>");

    const { error } = await supabase.from('links').insert({ subject, url });
    if (error) {
      console.error('Addlink error:', error);
      return sendMessage(senderId, "Error saving link.");
    }
    return sendMessage(senderId, `✅ Added to "${subject}".`);
  }

  if (lower.startsWith('/removelink')) {
    const parts = trimmed.split(' ');
    const subject = parts[1]?.toLowerCase();
    const number = parseInt(parts[2], 10);
    if (!subject || !number || number < 1) {
      return sendMessage(senderId, "Usage: /removelink <subject> <number>\n(use /reviewer <subject> to see numbers)");
    }

    const { data, error } = await supabase
      .from('links')
      .select('id, url')
      .eq('subject', subject)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Removelink fetch error:', error);
      return sendMessage(senderId, "Error fetching links.");
    }
    if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}".`);
    if (number > data.length) return sendMessage(senderId, `"${subject}" only has ${data.length} link(s).`);

    const target = data[number - 1];
    const { error: deleteError } = await supabase.from('links').delete().eq('id', target.id);

    if (deleteError) {
      console.error('Removelink delete error:', deleteError);
      return sendMessage(senderId, "Error removing link.");
    }
    return sendMessage(senderId, `🗑️ Removed #${number} from "${subject}": ${target.url}`);
  }

  if (lower.startsWith('/subjects')) {
    const { data, error } = await supabase.from('links').select('subject');
    if (error) {
      console.error('Subjects error:', error);
      return sendMessage(senderId, "Error fetching subjects.");
    }

    const subjects = [...new Set(data.map(d => d.subject))];
    if (subjects.length === 0) return sendMessage(senderId, "No subjects tracked yet.");
    return sendMessage(senderId, `📂 Subjects: ${subjects.join(', ')}`);
  }

  const tagMatch = trimmed.match(/#(\w+)/);
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (tagMatch && urlMatch) {
    const subject = tagMatch[1].toLowerCase();
    const url = urlMatch[0];
    const { error } = await supabase.from('links').insert({ subject, url });
    if (error) {
      console.error('Autotag error:', error);
      return sendMessage(senderId, "Error saving link.");
    }
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
