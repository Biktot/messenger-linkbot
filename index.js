const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const lastSubjectBySender = {};

// ---------- GROQ HELPERS ----------

async function askGroq(systemPrompt, userMessage) {
  if (!GROQ_API_KEY) return null;
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 300,
        temperature: 0.5,
      },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return response.data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('Groq error:', err.response?.data || err.message);
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
  const raw = await askGroq(
    `You sort study reviewer links for a Philippine nursing student. Known subjects: anaphy, biochem, nstp, tfn, philippine history. If it clearly matches one, use it; otherwise invent a short one-word lowercase tag. Respond with ONLY:\nSUBJECT: <tag>\nSUMMARY: <one short sentence, max 15 words>`,
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

async function summarizeUrl(url) {
  const title = await fetchPageTitle(url);
  const raw = await askGroq(
    'Write ONE short sentence (max 15 words) describing what this study link likely covers. No preamble, just the sentence.',
    `URL: ${url}\nPage title: ${title || '(unknown)'}`
  );
  return raw || '';
}

async function checkSimilar(subject, newUrl, existingUrls) {
  if (existingUrls.length === 0) return null;
  const raw = await askGroq(
    'You check if a new study link duplicates the topic of existing links in the same subject. Respond with ONLY "YES" or "NO" — YES only if the new link very likely covers the same specific topic as one of the existing ones.',
    `Existing links:\n${existingUrls.join('\n')}\n\nNew link: ${newUrl}`
  );
  return raw?.trim().toUpperCase() === 'YES';
}

async function interpretNaturalLanguage(text) {
  const raw = await askGroq(
    `You control a study-reviewer bot. Map the message to ONE action as JSON only, no extra text:
{"action":"list_links","subject":"<subject>"}
{"action":"list_subjects"}
{"action":"list_all"}
{"action":"list_recent"}
{"action":"remove","subject":"<subject or null>","number":<number>}
{"action":"add","subject":"<subject>","url":"<url>"}
{"action":"find","keyword":"<keyword>"}
{"action":"chat"}
Use "chat" if the message is casual conversation, a question, or anything not about managing reviewer links.`,
    text
  );
  try {
    return JSON.parse((raw || '').replace(/```json|```/g, '').trim());
  } catch {
    return { action: 'chat' };
  }
}

async function generateQuiz(subject) {
  const raw = await askGroq(
    'You are a nursing school reviewer. Generate 3 short practice questions (no answers) about the given topic, numbered 1-3. Keep each question one line.',
    `Topic: ${subject}`
  );
  return raw || 'Could not generate quiz questions right now.';
}

async function chatReply(text) {
  const raw = await askGroq(
    `You are a friendly, helpful assistant chatting with a Philippine BSN nursing student inside Messenger. Keep replies short (2-4 sentences max), warm, and conversational — like texting a helpful friend. You can casually mention you also manage their study reviewer links if it fits naturally, but don't force it every time.`,
    text
  );
  return raw || "Sorry, I'm having trouble responding right now.";
}

// ---------- SCHEDULE HELPERS ----------

function getPHTime() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function getDayCode(phDate) {
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return days[phDate.getUTCDay()];
}

function getTimeString(phDate) {
  const h = String(phDate.getUTCHours()).padStart(2, '0');
  const m = String(phDate.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

async function getRecipientPSID() {
  const { data } = await supabase.from('bot_state').select('value').eq('key', 'recipient_psid').maybeSingle();
  return data?.value || null;
}

async function setRecipientPSID(psid) {
  await supabase.from('bot_state').upsert({ key: 'recipient_psid', value: psid });
}

async function getLastNotifiedPeriod() {
  const { data } = await supabase.from('bot_state').select('value').eq('key', 'last_notified_period').maybeSingle();
  return data?.value || null;
}

async function setLastNotifiedPeriod(periodKey) {
  await supabase.from('bot_state').upsert({ key: 'last_notified_period', value: periodKey });
}

// ---------- WEBHOOK ----------

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

// ---------- CRON ENDPOINTS ----------

app.get('/cron/morning-brief', async (req, res) => {
  try {
    const phTime = getPHTime();
    const day = getDayCode(phTime);
    const psid = await getRecipientPSID();
    if (!psid) return res.status(200).send('No recipient set yet.');

    if (day === 'MON' || day === 'SUN') {
      await sendMessage(psid, `☀️ Good morning! No classes today. Rest well!`);
      return res.status(200).send('Sent: no class day.');
    }

    const { data, error } = await supabase
      .from('schedule')
      .select('subject, start_time, end_time')
      .eq('day', day)
      .order('start_time', { ascending: true })
      .limit(1);

    if (error || !data || data.length === 0) {
      await sendMessage(psid, `☀️ Good morning! No classes scheduled today.`);
      return res.status(200).send('Sent: no classes.');
    }

    const first = data[0];
    await sendMessage(psid, `☀️ Good morning! Your first class today is ${first.subject} at ${first.start_time}.`);
    res.status(200).send('Sent.');
  } catch (err) {
    console.error('Morning brief error:', err);
    res.status(500).send('Error');
  }
});

app.get('/cron/check-schedule', async (req, res) => {
  try {
    const phTime = getPHTime();
    const day = getDayCode(phTime);
    const currentTime = getTimeString(phTime);
    const psid = await getRecipientPSID();
    if (!psid) return res.status(200).send('No recipient set yet.');
    if (day === 'MON' || day === 'SUN') return res.status(200).send('No class day.');

    const { data, error } = await supabase
      .from('schedule')
      .select('subject, start_time, end_time')
      .eq('day', day)
      .order('start_time', { ascending: true });

    if (error || !data) return res.status(200).send('No schedule.');

    const nowMinutes = parseInt(currentTime.split(':')[0]) * 60 + parseInt(currentTime.split(':')[1]);

    for (const period of data) {
      const [sh, sm] = period.start_time.split(':').map(Number);
      const startMinutes = sh * 60 + sm;
      const diff = nowMinutes - startMinutes;

      if (diff >= 0 && diff < 15) {
        const periodKey = `${day}-${period.start_time}`;
        const lastNotified = await getLastNotifiedPeriod();
        if (lastNotified !== periodKey) {
          await sendMessage(psid, `📚 ${period.subject} is starting now (${period.start_time} - ${period.end_time}).`);
          await setLastNotifiedPeriod(periodKey);
        }
      }
    }
    res.status(200).send('Checked.');
  } catch (err) {
    console.error('Check-schedule error:', err);
    res.status(500).send('Error');
  }
});

// ---------- HELPERS ----------

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------- CORE ACTIONS ----------

async function listSubjectLinks(senderId, subjectRaw) {
  const subject = subjectRaw.toLowerCase();
  const { data, error } = await supabase
    .from('links')
    .select('id, url, summary, created_at')
    .eq('subject', subject)
    .order('created_at', { ascending: true });

  if (error) { console.error('List error:', error); return sendMessage(senderId, "Error fetching links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}" yet.`);

  lastSubjectBySender[senderId] = subject;
  const list = data.map((l, i) => `${i + 1}. ${l.url} (${formatDate(l.created_at)})${l.summary ? `\n   — ${l.summary}` : ''}`).join('\n');
  return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
}

async function addLink(senderId, subjectRaw, url, opts = {}) {
  const subject = subjectRaw.toLowerCase();
  const { data: existingRows, error: fetchError } = await supabase.from('links').select('id, url').eq('subject', subject);
  if (fetchError) { console.error('Fetch existing error:', fetchError); return sendMessage(senderId, "Error checking existing links."); }

  const exactDupe = existingRows?.find(r => r.url === url);
  if (exactDupe) {
    lastSubjectBySender[senderId] = subject;
    return sendMessage(senderId, `⚠️ That exact link is already saved under "${subject}".`);
  }

  let summary = opts.summary ?? null;
  if (summary === null && GROQ_API_KEY && opts.autoSummarize !== false) {
    summary = await summarizeUrl(url);
  }

  let similarWarning = '';
  if (GROQ_API_KEY && existingRows && existingRows.length > 0 && opts.skipSimilarCheck !== true) {
    const isSimilar = await checkSimilar(subject, url, existingRows.map(r => r.url));
    if (isSimilar) similarWarning = `\n⚠️ Heads up: this looks similar to another link already saved there.`;
  }

  const { error } = await supabase.from('links').insert({ subject, url, summary });
  if (error) { console.error('Addlink error:', error); return sendMessage(senderId, "Error saving link."); }
  lastSubjectBySender[senderId] = subject;
  return sendMessage(senderId, `✅ Added to "${subject}".${summary ? `\n📝 ${summary}` : ''}${similarWarning}`);
}

async function removeByNumber(senderId, subjectRaw, number) {
  const subject = subjectRaw.toLowerCase();
  const { data, error } = await supabase.from('links').select('id, url').eq('subject', subject).order('created_at', { ascending: true });
  if (error) { console.error('Removelink fetch error:', error); return sendMessage(senderId, "Error fetching links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}".`);
  if (number > data.length || number < 1) return sendMessage(senderId, `"${subject}" only has ${data.length} link(s).`);

  const target = data[number - 1];
  const { error: deleteError } = await supabase.from('links').delete().eq('id', target.id);
  if (deleteError) { console.error('Removelink delete error:', deleteError); return sendMessage(senderId, "Error removing link."); }
  return sendMessage(senderId, `🗑️ Removed #${number} from "${subject}": ${target.url}`);
}

async function listSubjects(senderId) {
  const { data, error } = await supabase.from('links').select('subject');
  if (error) { console.error('Subjects error:', error); return sendMessage(senderId, "Error fetching subjects."); }
  const subjects = [...new Set(data.map(d => d.subject.toLowerCase()))];
  if (subjects.length === 0) return sendMessage(senderId, "No subjects tracked yet.");
  return sendMessage(senderId, `📂 Subjects: ${subjects.join(', ')}`);
}

async function listAllReviewers(senderId) {
  const { data, error } = await supabase.from('links').select('subject, url, summary, created_at').order('subject', { ascending: true }).order('created_at', { ascending: true });
  if (error) { console.error('Reviewers error:', error); return sendMessage(senderId, "Error fetching reviewers."); }
  if (!data || data.length === 0) return sendMessage(senderId, "No reviewers saved yet.");

  const grouped = {};
  for (const row of data) {
    const subj = row.subject.toLowerCase();
    if (!grouped[subj]) grouped[subj] = [];
    grouped[subj].push(row);
  }

  let output = "📚 All Reviewers:\n";
  for (const subject of Object.keys(grouped)) {
    output += `\n${subject.toUpperCase()}:\n`;
    grouped[subject].forEach((row, i) => {
      output += `  ${i + 1}. ${row.url} (${formatDate(row.created_at)})${row.summary ? `\n     — ${row.summary}` : ''}\n`;
    });
  }
  return sendMessage(senderId, output.trim());
}

async function listRecent(senderId) {
  const { data, error } = await supabase.from('links').select('subject, url, summary, created_at').order('created_at', { ascending: false }).limit(10);
  if (error) { console.error('Recent error:', error); return sendMessage(senderId, "Error fetching recent links."); }
  if (!data || data.length === 0) return sendMessage(senderId, "No links saved yet.");
  const list = data.map((l, i) => `${i + 1}. [${l.subject.toUpperCase()}] ${l.url} (${formatDate(l.created_at)})${l.summary ? `\n   — ${l.summary}` : ''}`).join('\n');
  return sendMessage(senderId, `🕒 Recently added:\n${list}`);
}

async function findLinks(senderId, keyword) {
  const { data, error } = await supabase.from('links').select('subject, url, summary, created_at').or(`subject.ilike.%${keyword}%,url.ilike.%${keyword}%,summary.ilike.%${keyword}%`).order('created_at', { ascending: false });
  if (error) { console.error('Find error:', error); return sendMessage(senderId, "Error searching links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No results for "${keyword}".`);
  const list = data.map((l, i) => `${i + 1}. [${l.subject.toUpperCase()}] ${l.url} (${formatDate(l.created_at)})`).join('\n');
  return sendMessage(senderId, `🔍 Results for "${keyword}":\n${list}`);
}

async function describeByNumber(senderId, subjectRaw, number) {
  const subject = subjectRaw.toLowerCase();
  const { data, error } = await supabase.from('links').select('id, url, summary').eq('subject', subject).order('created_at', { ascending: true });
  if (error) { console.error('Describe fetch error:', error); return sendMessage(senderId, "Error fetching link."); }
  if (!data || number > data.length || number < 1) return sendMessage(senderId, `Couldn't find #${number} in "${subject}".`);

  const target = data[number - 1];
  if (target.summary) return sendMessage(senderId, `📝 ${target.summary}`);
  if (!GROQ_API_KEY) return sendMessage(senderId, "No summary available.");
  const summary = await summarizeUrl(target.url);
  await supabase.from('links').update({ summary }).eq('id', target.id);
  return sendMessage(senderId, `📝 ${summary || 'Could not generate a summary for this link.'}`);
}

function sendHelp(senderId) {
  const helpText =
`🤖 Reviewer Bot Commands

Add a link:
- reviewer <subject> <link>
- #<subject> <link>
- paste a bare link — AI guesses the subject

View links:
- reviewer <subject>
- reviewers (all)
- recent (last 10)

Subjects:
- links / subjects

Search:
- find <keyword>
- describe <subject> <number>

Practice questions:
- quiz <subject>

Remove:
- remove <number>
- remove <subject> <number>

Help:
- help

Or just chat with me normally — I'll respond like a regular assistant!`;
  return sendMessage(senderId, helpText);
}

// ---------- MESSAGE HANDLER ----------

async function handleMessage(text, senderId) {
  await setRecipientPSID(senderId);

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/);

  if (lower === 'help' || lower === '/help') return sendHelp(senderId);
  if (lower === 'reviewers' || lower === '/reviewers') return listAllReviewers(senderId);
  if (lower === 'recent' || lower === '/recent') return listRecent(senderId);

  if (lower.startsWith('find ')) {
    const keyword = trimmed.slice(5).trim();
    if (!keyword) return sendMessage(senderId, "Usage: find <keyword>");
    return findLinks(senderId, keyword);
  }

  if (lower.startsWith('describe ')) {
    const subject = words[1]?.toLowerCase();
    const number = parseInt(words[2], 10);
    if (!subject || !number) return sendMessage(senderId, "Usage: describe <subject> <number>");
    return describeByNumber(senderId, subject, number);
  }

  if (lower.startsWith('quiz ')) {
    const subject = words[1]?.toLowerCase();
    if (!subject) return sendMessage(senderId, "Usage: quiz <subject>");
    if (!GROQ_API_KEY) return sendMessage(senderId, "Quiz feature isn't set up right now.");
    await sendMessage(senderId, "🤔 Generating a few practice questions...");
    const quiz = await generateQuiz(subject);
    return sendMessage(senderId, `📝 Quick practice — ${subject.toUpperCase()}:\n${quiz}`);
  }

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

  if (lower.startsWith('/subjects')) return listSubjects(senderId);
  if (lower === 'links' || lower === 'subjects') return listSubjects(senderId);

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
    if (url && /^https?:\/\//.test(url)) return addLink(senderId, subject, url);
    return listSubjectLinks(senderId, subject);
  }

  const tagMatch = trimmed.match(/#(\w+)/);
  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (tagMatch && urlMatch) return addLink(senderId, tagMatch[1].toLowerCase(), urlMatch[0]);

  const bareUrlMatch = trimmed.match(/^https?:\/\/\S+$/);
  if (bareUrlMatch && GROQ_API_KEY) {
    const url = bareUrlMatch[0];
    await sendMessage(senderId, "🤖 Let me figure out where this goes...");
    const { subject, summary } = await guessSubjectAndSummary(url);
    return addLink(senderId, subject, url, { summary, autoSummarize: false });
  }

  // Natural language: try to detect a command, otherwise just chat
  if (GROQ_API_KEY) {
    const parsed = await interpretNaturalLanguage(trimmed);
    switch (parsed.action) {
      case 'list_links':
        if (parsed.subject) return listSubjectLinks(senderId, parsed.subject.toLowerCase());
        break;
      case 'list_subjects':
        return listSubjects(senderId);
      case 'list_all':
        return listAllReviewers(senderId);
      case 'list_recent':
        return listRecent(senderId);
      case 'find':
        if (parsed.keyword) return findLinks(senderId, parsed.keyword);
        break;
      case 'remove': {
        const subj = parsed.subject?.toLowerCase() || lastSubjectBySender[senderId];
        if (subj && parsed.number) return removeByNumber(senderId, subj, parsed.number);
        break;
      }
      case 'add':
        if (parsed.subject && parsed.url) return addLink(senderId, parsed.subject.toLowerCase(), parsed.url);
        break;
      case 'chat':
      default: {
        const reply = await chatReply(trimmed);
        return sendMessage(senderId, reply);
      }
    }
  }

  return sendMessage(senderId, `❓ Type "help" to see what I can do.`);
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
