const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const lastSubjectBySender = {};

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

// ---------- CORE ACTIONS ----------

async function listSubjectLinks(senderId, subject) {
  const { data, error } = await supabase
    .from('links')
    .select('id, url')
    .eq('subject', subject)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('List error:', error);
    return sendMessage(senderId, "Error fetching links.");
  }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}" yet.`);

  lastSubjectBySender[senderId] = subject;
  const list = data.map((l, i) => `${i + 1}. ${l.url}`).join('\n');
  return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
}

async function addLink(senderId, subject, url) {
  const { error } = await supabase.from('links').insert({ subject, url });
  if (error) {
    console.error('Addlink error:', error);
    return sendMessage(senderId, "Error saving link.");
  }
  lastSubjectBySender[senderId] = subject;
  return sendMessage(senderId, `✅ Added to "${subject}".`);
}

async function removeByNumber(senderId, subject, number) {
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
  if (number > data.length || number < 1) return sendMessage(senderId, `"${subject}" only has ${data.length} link(s).`);

  const target = data[number - 1];
  const { error: deleteError } = await supabase.from('links').delete().eq('id', target.id);
  if (deleteError) {
    console.error('Removelink delete error:', deleteError);
    return sendMessage(senderId, "Error removing link.");
  }
  return sendMessage(senderId, `🗑️ Removed #${number} from "${subject}": ${target.url}`);
}

async function listSubjects(senderId) {
  const { data, error } = await supabase.from('links').select('subject');
  if (error) {
    console.error('Subjects error:', error);
    return sendMessage(senderId, "Error fetching subjects.");
  }
  const subjects = [...new Set(data.map(d => d.subject))];
  if (subjects.length === 0) return sendMessage(senderId, "No subjects tracked yet.");
  return sendMessage(senderId, `📂 Subjects: ${subjects.join(', ')}`);
}

function sendHelp(senderId) {
  const helpText =
`🤖 Reviewer Bot Commands

Add a link:
• reviewer <subject> <link>
• /addlink <subject> <link>
• #<subject> <link>

View links:
• reviewer <subject>
• /reviewer <subject>

List all subjects:
• links
• subjects
• /subjects

Remove a link:
• remove <number>  (uses last subject you viewed/added)
• remove <subject> <number>
• /removelink <subject> <number>

Help:
• help`;
  return sendMessage(senderId, helpText);
}

// ---------- MESSAGE HANDLER ----------

async function handleMessage(text, senderId) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/);

  // ---- HELP ----
  if (lower === 'help' || lower === '/help') {
    return sendHelp(senderId);
  }

  // ---- SLASH COMMANDS ----
  if (lower.startsWith('/reviewer')) {
    const subject = words[1]?.toLowerCase();
    if (!subject) return sendMessage(senderId, "Usage: /reviewer <subject>");
    return listSubjectLinks(senderId, subject);
  }

  if (lower.startsWith('/addlink')) {
    const subject = words[1]?.toLowerCase();
    const url = words[2];
    if (!subject || !url) return sendMessage(senderId, "Usage: /addlink <subject> <url>");
    return addLink(senderId, subject, url);
  }

  if (lower.startsWith('/removelink')) {
    const subject = words[1]?.toLowerCase();
    const number = parseInt(words[2], 10);
    if (!subject || !number) return sendMessage(senderId, "Usage: /removelink <subject> <number>");
    return removeByNumber(senderId, subject, number);
  }

  if (lower.startsWith('/subjects')) {
    return listSubjects(senderId);
  }

  // ---- CASUAL COMMANDS ----
  if (lower === 'links' || lower === 'subjects') {
    return listSubjects(senderId);
  }

  if (lower.startsWith('remove ')) {
    const restWords = words.slice(1);
    if (restWords.length >= 2 && !isNaN(parseInt(restWords[1], 10))) {
      const subject = restWords[0].toLowerCase();
      const number = parseInt(restWords[1], 10);
      return removeByNumber(senderId, subject, number);
    }
    const number = parseInt(restWords[0], 10);
    const subject = lastSubjectBySender[senderId];
    if (!subject) return sendMessage(senderId, "I don't know which subject — try 'reviewer <subject>' first, or use 'remove <subject> <number>'.");
    if (!number) return sendMessage(senderId, "Usage: remove <number> OR remove <subject> <number>");
    return removeByNumber(senderId, subject, number);
  }

  if (lower.startsWith('reviewer ')) {
    const subject = words[1]?.toLowerCase();
    const url = words[2];
    if (!subject) return sendMessage(senderId, "Usage: reviewer <subject> [link]");
    if (url && /^https?:\/\//.test(url)) {
      return addLink(senderId, subject, url);
    }
    return listSubjectLinks(senderId, subject);
  }

  // ---- AUTO-TAG DETECTION ----
  const tagMatch = trimmed.match(/#(\w+)/);
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (tagMatch && urlMatch) {
    const subject = tagMatch[1].toLowerCase();
    const url = urlMatch[0];
    return addLink(senderId, subject, url);
  }

  // ---- FALLBACK: unrecognized message, gently point to help ----
  if (lower.startsWith('reviewer') || lower.startsWith('remove') || urlMatch) {
    return sendMessage(senderId, `Not sure what you meant. Type "help" to see all commands.`);
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
