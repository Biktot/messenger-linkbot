const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
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

// ---------- AI HELPERS ----------

async function askGemini(systemPrompt, userMessage) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: userMessage }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error('Gemini error:', err.response?.data || err.message);
    return null;
  }
}

async function fetchPageTitle(url) {
  try {
    const res = await axios.get(url, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const match = res.data.match(/<title>(.*?)<\/title>/is);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

async function guessSubjectAndSummary(url) {
  const title = await fetchPageTitle(url);
  const raw = await askGemini(
    'You help sort study reviewer links for a nursing student (subjects like anaphy, biochem, nstp, theoretical foundation of nursing, philippine history). Given a link and its page title, respond with ONLY two lines, no extra text:\nSUBJECT: <one short lowercase word/tag guessing the subject>\nSUMMARY: <one short sentence describing what the link likely covers>',
    `URL: ${url}\nPage title: ${title || '(unknown)'}`
  );
  if (!raw) return { subject: 'misc', summary: '' };

  const subjectMatch = raw.match(/SUBJECT:\s*(.+)/i);
  const summaryMatch = raw.match(/SUMMARY:\s*(.+)/i);
  return {
    subject: subjectMatch ? subjectMatch[1].trim().toLowerCase().split(/\s+/)[0] : 'misc',
    summary: summaryMatch ? summaryMatch[1].trim() : '',
  };
}

async function interpretNaturalLanguage(text) {
  const raw = await askGemini(
    `You control a study-reviewer bot. Map the user's message to ONE action. Respond with ONLY JSON, no extra text, in one of these shapes:
{"action":"list_links","subject":"<subject>"}
{"action":"list_subjects"}
{"action":"remove","subject":"<subject or null>","number":<number>}
{"action":"add","subject":"<subject>","url":"<url>"}
{"action":"unknown"}
Use "unknown" if the message isn't related to managing reviewer links.`,
    text
  );
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { action: 'unknown' };
  }
}

// ---------- CORE ACTIONS ----------

async function listSubjectLinks(senderId, subject) {
  const { data, error } = await supabase
    .from('links')
    .select('id, url, summary')
    .eq('subject', subject)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('List error:', error);
    return sendMessage(senderId, "Error fetching links.");
  }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}" yet.`);

  lastSubjectBySender[senderId] = subject;
  const list = data.map((l, i) => `${i + 1}. ${l.url}${l.summary ? `\n   — ${l.summary}` : ''}`).join('\n');
  return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
}

async function addLink(senderId, subject, url, summary = null) {
  const { error } = await supabase.from('links').insert({ subject, url, summary });
  if (error) {
    console.error('Addlink error:', error);
    return sendMessage(senderId, "Error saving link.");
  }
  lastSubjectBySender[senderId] = subject;
  return sendMessage(senderId, `✅ Added to "${subject}".${summary ? `\n📝 ${summary}` : ''}`);
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

// ---------- MESSAGE HANDLER ----------

async function handleMessage(text, senderId) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/);

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

  // ---- BARE LINK -> AI GUESSES SUBJECT + SUMMARY ----
  const bareUrlMatch = trimmed.match(/^https?:\/\/\S+$/);
  if (bareUrlMatch && GEMINI_API_KEY) {
    const url = bareUrlMatch[0];
    await sendMessage(senderId, "🤖 Let me figure out where this goes...");
    const { subject, summary } = await guessSubjectAndSummary(url);
    return addLink(senderId, subject, url, summary);
  }

  // ---- NATURAL LANGUAGE FALLBACK ----
  if (GEMINI_API_KEY) {
    const parsed = await interpretNaturalLanguage(trimmed);
    switch (parsed.action) {
      case 'list_links':
        if (parsed.subject) return listSubjectLinks(senderId, parsed.subject.toLowerCase());
        break;
      case 'list_subjects':
        return listSubjects(senderId);
      case 'remove': {
        const subj = parsed.subject?.toLowerCase() || lastSubjectBySender[senderId];
        if (!subj) return sendMessage(senderId, "Which subject did you mean?");
        if (parsed.number) return removeByNumber(senderId, subj, parsed.number);
        break;
      }
      case 'add':
        if (parsed.subject && parsed.url) return addLink(senderId, parsed.subject.toLowerCase(), parsed.url);
        break;
      default:
        break;
    }
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
