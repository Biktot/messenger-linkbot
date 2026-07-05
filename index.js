const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const lastSubjectBySender = {};
const lastProjectBySender = {};
const lastImageBySender = {};
const conversationHistory = {};
const MAX_HISTORY_MESSAGES = 10;

const LAT = 15.5333;
const LON = 119.9333;

function addToHistory(senderId, role, content) {
  if (!conversationHistory[senderId]) conversationHistory[senderId] = [];
  conversationHistory[senderId].push({ role, content });
  if (conversationHistory[senderId].length > MAX_HISTORY_MESSAGES) {
    conversationHistory[senderId] = conversationHistory[senderId].slice(-MAX_HISTORY_MESSAGES);
  }
}
function getHistory(senderId) {
  return conversationHistory[senderId] || [];
}

// ---------- PROFILE NAME ----------

async function getProfileName(psid) {
  try {
    const res = await axios.get(`https://graph.facebook.com/${psid}`, {
      params: { fields: 'first_name,last_name', access_token: PAGE_ACCESS_TOKEN },
    });
    return `${res.data.first_name || ''} ${res.data.last_name || ''}`.trim() || 'Someone';
  } catch (err) {
    console.error('Profile fetch error:', err.response?.data || err.message);
    return 'Someone';
  }
}

// ---------- GROQ TEXT HELPERS ----------

async function askGroq(systemPrompt, userMessage, history = []) {
  if (!GROQ_API_KEY) return null;
  try {
    const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages, max_tokens: 400, temperature: 0.5 },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return response.data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('Groq error:', err.response?.data || err.message);
    return null;
  }
}

// ---------- GROQ VISION HELPER ----------

async function askGroqVision(prompt, imageUrl) {
  if (!GROQ_API_KEY) return null;
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 600,
      },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    return response.data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('Vision error:', err.response?.data || err.message);
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
    `You sort study reviewer links for a Philippine nursing student. Known subjects: anaphy, biochem, nstp, tfn, philippine history. If unclear, invent a short one-word lowercase tag. Respond with ONLY:\nSUBJECT: <tag>\nSUMMARY: <one short sentence, max 15 words>`,
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
  const raw = await askGroq('Write ONE short sentence (max 15 words) describing what this link likely covers.', `URL: ${url}\nPage title: ${title || '(unknown)'}`);
  return raw || '';
}

async function checkSimilar(existingUrls, newUrl) {
  if (existingUrls.length === 0) return null;
  const raw = await askGroq('Check if a new link duplicates the topic of existing links. Respond with ONLY "YES" or "NO".', `Existing:\n${existingUrls.join('\n')}\n\nNew: ${newUrl}`);
  return raw?.trim().toUpperCase() === 'YES';
}

async function generateQuiz(subject) {
  const raw = await askGroq('You are a nursing school reviewer. Generate 3 short practice questions (no answers), numbered 1-3.', `Topic: ${subject}`);
  return raw || 'Could not generate quiz questions right now.';
}

async function generateFlashcards(subject) {
  const raw = await askGroq('Generate 5 flashcards for this nursing topic. Format strictly as:\nQ1: ...\nA1: ...\nQ2: ...\nA2: ...\n(up to Q5/A5)', `Topic: ${subject}`);
  return raw || 'Could not generate flashcards right now.';
}

async function explainTopic(topic) {
  const raw = await askGroq('You are a nursing school tutor. Explain the given topic clearly and concisely in 4-6 sentences, appropriate for a BSN student reviewing for exams.', `Topic: ${topic}`);
  return raw || "Couldn't generate an explanation right now.";
}

async function answerQuestions(questionsText) {
  const raw = await askGroq(
    'You are a nursing school tutor. Answer each of the following question(s) clearly and concisely, one at a time. If multiple choice, give the correct answer and a brief explanation. If open-ended, give a solid concise answer appropriate for a BSN nursing student.',
    questionsText
  );
  return raw || "I couldn't generate answers for that.";
}

async function parseReminder(text) {
  const today = getPHTime().toISOString().split('T')[0];
  const raw = await askGroq(
    `Extract a reminder description and due date from the message. Today's date is ${today} (Philippines). Respond with ONLY JSON: {"description":"<short description>","due_date":"YYYY-MM-DD"}. If no clear date, use null for due_date.`,
    text
  );
  try {
    return JSON.parse((raw || '').replace(/```json|```/g, '').trim());
  } catch {
    return { description: null, due_date: null };
  }
}

// ---------- WEB SEARCH (Tavily API) ----------

async function webSearch(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 5,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const data = res.data;
    const results = [];

    if (data.answer) {
      results.push({ title: 'Tavily Answer', snippet: data.answer, link: '' });
    }
    if (data.results) {
      for (const item of data.results.slice(0, 5)) {
        results.push({ title: item.title, snippet: item.content || '', link: item.url });
      }
    }
    return results;
  } catch (err) {
    console.error('Web search error:', err.response?.data || err.message);
    return null;
  }
}

async function answerWithWebSearch(query, senderId) {
  const results = await webSearch(query);
  if (!results || results.length === 0) {
    return "I couldn't find anything on the web for that right now.";
  }
  const context = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.link}`)
    .join('\n\n');

  const history = getHistory(senderId);
  const raw = await askGroq(
    `You are a helpful assistant answering using live web search results provided below. Summarize the answer clearly and concisely (3-6 sentences) in your own words for a Philippine BSN nursing student on Messenger. Mention the source name briefly if relevant (e.g. "according to X"). Do not quote text verbatim — paraphrase. If the results don't actually answer the question, say so honestly.\n\nWeb search results:\n${context}`,
    query,
    history
  );
  return raw || "I found some results but couldn't summarize them right now.";
}

// ---------- NATURAL LANGUAGE ROUTING ----------

async function interpretNaturalLanguage(text, senderId) {
  const history = getHistory(senderId);
  const raw = await askGroq(
    `You control a bot with these real features: reviewer links by subject, project links by project name, a daily class schedule (checkable + automatic alerts), a quiz generator, flashcards, topic explanations, deadline reminders, weather check, a shared to-do list, image analysis (send a photo of notes/diagrams/questions), and live web search for current information not in your own knowledge. Map the message to ONE action as JSON only:
{"action":"list_links","subject":"<subject>"}
{"action":"list_subjects"}
{"action":"list_all"}
{"action":"list_recent"}
{"action":"remove","subject":"<subject or null>","number":<number>}
{"action":"add","subject":"<subject>","url":"<url>"}
{"action":"find","keyword":"<keyword>"}
{"action":"list_project","project":"<project name>"}
{"action":"list_projects"}
{"action":"add_project","project":"<project name>","url":"<url>"}
{"action":"check_schedule","when":"today or tomorrow"}
{"action":"weather"}
{"action":"list_todos"}
{"action":"add_todo","task":"<task>"}
{"action":"list_reminders"}
{"action":"save_last_image","subject":"<subject>"}
{"action":"web_search","query":"<search query>"}
{"action":"chat"}
Use "save_last_image" if the user says something like "save that as <subject>" referring to a recently sent image. Use "web_search" for questions about current events, news, facts you may not know, prices, real-world lookups, or anything requiring up-to-date information from the internet. Use "chat" for casual conversation, questions about the bot's own features, or anything else.`,
    text, history
  );
  try {
    return JSON.parse((raw || '').replace(/```json|```/g, '').trim());
  } catch {
    return { action: 'chat' };
  }
}

const BOT_FEATURES_DESCRIPTION = `
Real features (only mention these, don't invent others):
1. Reviewer links by subject. 2. Project links by project name. 3. Daily class schedule (checkable + automatic alerts). 4. Quiz generator ("quiz <subject>"). 5. Flashcards ("flashcards <subject>"). 6. Topic explanations ("explain <topic>"). 7. Deadline reminders ("remind <description> <date>", "reminders" to list). 8. Weather check ("weather"). 9. Shared to-do list ("todo <task>", "todos", "done <number>"). 10. Image analysis — send a photo and it identifies if it's study notes, a diagram, a schedule, or a question, and responds accordingly (transcribes notes, answers questions, etc). 11. Web search for current info ("search <query>", or just ask a factual/current-events question). 12. Normal conversation with memory.
`;

async function chatReply(text, senderId) {
  const history = getHistory(senderId);
  const raw = await askGroq(
    `You are a friendly assistant chatting with a Philippine BSN nursing student on Messenger. Keep replies short (2-4 sentences), warm, conversational. Use history for context. ${BOT_FEATURES_DESCRIPTION}`,
    text, history
  );
  return raw || "Sorry, I'm having trouble responding right now.";
}

// ---------- WEATHER ----------

async function getWeather() {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: LAT, longitude: LON,
        daily: 'precipitation_probability_max,temperature_2m_max,temperature_2m_min',
        timezone: 'Asia/Manila',
      },
    });
    const d = res.data.daily;
    const todayRain = d.precipitation_probability_max[0];
    const tomorrowRain = d.precipitation_probability_max[1];
    const todayHigh = Math.round(d.temperature_2m_max[0]);
    const todayLow = Math.round(d.temperature_2m_min[0]);
    return `🌤️ Masinloc weather:\nToday: ${todayLow}°–${todayHigh}°C, ${todayRain}% rain chance\nTomorrow: ${tomorrowRain}% rain chance\n${todayRain > 50 ? '☔ Bring an umbrella today!' : '✅ Low rain chance today.'}`;
  } catch (err) {
    console.error('Weather error:', err.message);
    return "Couldn't fetch weather right now.";
  }
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

async function checkScheduleFor(when) {
  const phTime = getPHTime();
  const targetDate = new Date(phTime);
  if (when === 'tomorrow') targetDate.setUTCDate(targetDate.getUTCDate() + 1);
  const day = getDayCode(targetDate);
  if (day === 'MON' || day === 'SUN') return `No classes ${when} (${day === 'MON' ? 'No pasok' : 'Sunday'}).`;
  const { data, error } = await supabase.from('schedule').select('subject, start_time, end_time').eq('day', day).order('start_time', { ascending: true });
  if (error || !data || data.length === 0) return `No classes scheduled ${when}.`;
  const list = data.map(p => `• ${p.subject} (${p.start_time}–${p.end_time})`).join('\n');
  return `📅 Schedule for ${when} (${day}):\n${list}`;
}

async function addRecipient(psid) { await supabase.from('recipients').upsert({ psid }); }
async function getAllRecipients() {
  const { data } = await supabase.from('recipients').select('psid');
  return data ? data.map(r => r.psid) : [];
}
async function getLastNotifiedPeriod() {
  const { data } = await supabase.from('bot_state').select('value').eq('key', 'last_notified_period').maybeSingle();
  return data?.value || null;
}
async function setLastNotifiedPeriod(periodKey) {
  await supabase.from('bot_state').upsert({ key: 'last_notified_period', value: periodKey });
}
async function getLastReminderCheckDate() {
  const { data } = await supabase.from('bot_state').select('value').eq('key', 'last_reminder_check').maybeSingle();
  return data?.value || null;
}
async function setLastReminderCheckDate(dateStr) {
  await supabase.from('bot_state').upsert({ key: 'last_reminder_check', value: dateStr });
}

// ---------- WEBHOOK ----------

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const event = entry.messaging?.[0];
      if (event?.message?.text) {
        await handleMessage(event.message.text, event.sender.id);
      } else if (event?.message?.attachments) {
        const imageAttachment = event.message.attachments.find(a => a.type === 'image');
        if (imageAttachment) await handleImage(imageAttachment.payload.url, event.sender.id);
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
    const recipients = await getAllRecipients();
    if (recipients.length === 0) return res.status(200).send('No recipients yet.');

    let messageText;
    if (day === 'MON' || day === 'SUN') {
      messageText = `☀️ Good morning! No classes today. Rest well!`;
    } else {
      const { data } = await supabase.from('schedule').select('subject, start_time').eq('day', day).order('start_time', { ascending: true }).limit(1);
      messageText = (data && data.length > 0) ? `☀️ Good morning! Your first class today is ${data[0].subject} at ${data[0].start_time}.` : `☀️ Good morning! No classes scheduled today.`;
    }
    for (const psid of recipients) await sendMessage(psid, messageText);

    const todayStr = phTime.toISOString().split('T')[0];
    const lastCheck = await getLastReminderCheckDate();
    if (lastCheck !== todayStr) {
      const tomorrow = new Date(phTime);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const { data: dueReminders } = await supabase.from('reminders').select('description, due_date').in('due_date', [todayStr, tomorrowStr]);
      if (dueReminders && dueReminders.length > 0) {
        for (const r of dueReminders) {
          const when = r.due_date === todayStr ? 'TODAY' : 'TOMORROW';
          for (const psid of recipients) await sendMessage(psid, `⏰ Reminder: "${r.description}" is due ${when} (${r.due_date}).`);
        }
      }
      await setLastReminderCheckDate(todayStr);
    }
    res.status(200).send(`Sent to ${recipients.length} recipient(s).`);
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
    const recipients = await getAllRecipients();
    if (recipients.length === 0) return res.status(200).send('No recipients yet.');
    if (day === 'MON' || day === 'SUN') return res.status(200).send('No class day.');

    const { data } = await supabase.from('schedule').select('subject, start_time, end_time').eq('day', day).order('start_time', { ascending: true });
    if (!data) return res.status(200).send('No schedule.');

    const nowMinutes = parseInt(currentTime.split(':')[0]) * 60 + parseInt(currentTime.split(':')[1]);
    for (const period of data) {
      const [sh, sm] = period.start_time.split(':').map(Number);
      const startMinutes = sh * 60 + sm;
      const diff = nowMinutes - startMinutes;
      if (diff >= 0 && diff < 15) {
        const periodKey = `${day}-${period.start_time}`;
        const lastNotified = await getLastNotifiedPeriod();
        if (lastNotified !== periodKey) {
          for (const psid of recipients) await sendMessage(psid, `📚 ${period.subject} is starting now (${period.start_time} - ${period.end_time}).`);
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
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------- REVIEWER LINK ACTIONS ----------

async function listSubjectLinks(senderId, subjectRaw) {
  const subject = subjectRaw.toLowerCase();
  const { data, error } = await supabase.from('links').select('id, url, summary, added_by, created_at').eq('subject', subject).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}" yet.`);
  lastSubjectBySender[senderId] = subject;
  const list = data.map((l, i) => `${i + 1}. ${l.url} (${formatDate(l.created_at)}${l.added_by ? `, by ${l.added_by}` : ''})${l.summary ? `\n   — ${l.summary}` : ''}`).join('\n');
  return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
}

async function addLink(senderId, subjectRaw, url, opts = {}) {
  const subject = subjectRaw.toLowerCase();
  const { data: existingRows, error: fetchError } = await supabase.from('links').select('id, url').eq('subject', subject);
  if (fetchError) { console.error(fetchError); return sendMessage(senderId, "Error checking existing links."); }

  const exactDupe = existingRows?.find(r => r.url === url);
  if (exactDupe) { lastSubjectBySender[senderId] = subject; return sendMessage(senderId, `⚠️ That exact link is already saved under "${subject}".`); }

  let summary = opts.summary ?? null;
  if (summary === null && GROQ_API_KEY && opts.autoSummarize !== false) summary = await summarizeUrl(url);

  let similarWarning = '';
  if (GROQ_API_KEY && existingRows?.length > 0 && opts.skipSimilarCheck !== true) {
    const isSimilar = await checkSimilar(existingRows.map(r => r.url), url);
    if (isSimilar) similarWarning = `\n⚠️ Heads up: this looks similar to another link already saved there.`;
  }

  const addedBy = await getProfileName(senderId);
  const { error } = await supabase.from('links').insert({ subject, url, summary, added_by: addedBy });
  if (error) { console.error(error); return sendMessage(senderId, "Error saving link."); }
  lastSubjectBySender[senderId] = subject;
  return sendMessage(senderId, `✅ Added to "${subject}" by ${addedBy}.${summary ? `\n📝 ${summary}` : ''}${similarWarning}`);
}

async function removeByNumber(senderId, subjectRaw, number) {
  const subject = subjectRaw.toLowerCase();
  const { data, error } = await supabase.from('links').select('id, url').eq('subject', subject).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}".`);
  if (number > data.length || number < 1) return sendMessage(senderId, `"${subject}" only has ${data.length} link(s).`);
  const target = data[number - 1];
  const { error: deleteError } = await supabase.from('links').delete().eq('id', target.id);
  if (deleteError) { console.error(deleteError); return sendMessage(senderId, "Error removing link."); }
  return sendMessage(senderId, `🗑️ Removed #${number} from "${subject}": ${target.url}`);
}

async function listSubjects(senderId) {
  const { data, error } = await supabase.from('links').select('subject');
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching subjects."); }
  const subjects = [...new Set(data.map(d => d.subject.toLowerCase()))];
  if (subjects.length === 0) return sendMessage(senderId, "No subjects tracked yet.");
  return sendMessage(senderId, `📂 Subjects: ${subjects.join(', ')}`);
}

async function listAllReviewers(senderId) {
  const { data, error } = await supabase.from('links').select('subject, url, summary, added_by, created_at').order('subject', { ascending: true }).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching reviewers."); }
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
      output += `  ${i + 1}. ${row.url} (${formatDate(row.created_at)}${row.added_by ? `, by ${row.added_by}` : ''})${row.summary ? `\n     — ${row.summary}` : ''}\n`;
    });
  }
  return sendMessage(senderId, output.trim());
}

async function listRecent(senderId) {
  const { data, error } = await supabase.from('links').select('subject, url, summary, added_by, created_at').order('created_at', { ascending: false }).limit(10);
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching recent links."); }
  if (!data || data.length === 0) return sendMessage(senderId, "No links saved yet.");
  const list = data.map((l, i) => `${i + 1}. [${l.subject.toUpperCase()}] ${l.url} (${formatDate(l.created_at)}${l.added_by ? `, by ${l.added_by}` : ''})`).join('\n');
  return sendMessage(senderId, `🕒 Recently added:\n${list}`);
}

async function findLinks(senderId, keyword) {
  const { data, error } = await supabase.from('links').select('subject, url, summary, created_at').or(`subject.ilike.%${keyword}%,url.ilike.%${keyword}%,summary.ilike.%${keyword}%`).order('created_at', { ascending: false });
  if (error) { console.error(error); return sendMessage(senderId, "Error searching links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No results for "${keyword}".`);
  const list = data.map((l, i) => `${i + 1}. [${l.subject.toUpperCase()}] ${l.url} (${formatDate(l.created_at)})`).join('\n');
  return sendMessage(senderId, `🔍 Results for "${keyword}":\n${list}`);
}

async function describeByNumber(senderId, subjectRaw, number) {
  const subject = subjectRaw.toLowerCase();
  const { data, error } = await supabase.from('links').select('id, url, summary').eq('subject', subject).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching link."); }
  if (!data || number > data.length || number < 1) return sendMessage(senderId, `Couldn't find #${number} in "${subject}".`);
  const target = data[number - 1];
  if (target.summary) return sendMessage(senderId, `📝 ${target.summary}`);
  if (!GROQ_API_KEY) return sendMessage(senderId, "No summary available.");
  const summary = await summarizeUrl(target.url);
  await supabase.from('links').update({ summary }).eq('id', target.id);
  return sendMessage(senderId, `📝 ${summary || 'Could not generate a summary.'}`);
}

// ---------- PROJECT LINK ACTIONS ----------

async function listProjectLinks(senderId, projectRaw) {
  const project = projectRaw.toLowerCase();
  const { data, error } = await supabase.from('projects').select('id, url, summary, added_by, created_at').eq('project_name', project).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching project links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for project "${project}" yet.`);
  lastProjectBySender[senderId] = project;
  const list = data.map((l, i) => `${i + 1}. ${l.url} (${formatDate(l.created_at)}${l.added_by ? `, by ${l.added_by}` : ''})${l.summary ? `\n   — ${l.summary}` : ''}`).join('\n');
  return sendMessage(senderId, `🗂️ ${project.toUpperCase()} project links:\n${list}`);
}

async function addProjectLink(senderId, projectRaw, url) {
  const project = projectRaw.toLowerCase();
  const { data: existingRows, error: fetchError } = await supabase.from('projects').select('id, url').eq('project_name', project);
  if (fetchError) { console.error(fetchError); return sendMessage(senderId, "Error checking existing project links."); }
  const exactDupe = existingRows?.find(r => r.url === url);
  if (exactDupe) { lastProjectBySender[senderId] = project; return sendMessage(senderId, `⚠️ That exact link is already saved under project "${project}".`); }

  let summary = null;
  if (GROQ_API_KEY) summary = await summarizeUrl(url);
  const addedBy = await getProfileName(senderId);

  const { error } = await supabase.from('projects').insert({ project_name: project, url, summary, added_by: addedBy });
  if (error) { console.error(error); return sendMessage(senderId, "Error saving project link."); }
  lastProjectBySender[senderId] = project;
  return sendMessage(senderId, `✅ Added to project "${project}" by ${addedBy}.${summary ? `\n📝 ${summary}` : ''}`);
}

async function removeProjectByNumber(senderId, projectRaw, number) {
  const project = projectRaw.toLowerCase();
  const { data, error } = await supabase.from('projects').select('id, url').eq('project_name', project).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching project links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for project "${project}".`);
  if (number > data.length || number < 1) return sendMessage(senderId, `Project "${project}" only has ${data.length} link(s).`);
  const target = data[number - 1];
  const { error: deleteError } = await supabase.from('projects').delete().eq('id', target.id);
  if (deleteError) { console.error(deleteError); return sendMessage(senderId, "Error removing project link."); }
  return sendMessage(senderId, `🗑️ Removed #${number} from project "${project}": ${target.url}`);
}

async function listProjectNames(senderId) {
  const { data, error } = await supabase.from('projects').select('project_name');
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching projects."); }
  const names = [...new Set(data.map(d => d.project_name.toLowerCase()))];
  if (names.length === 0) return sendMessage(senderId, "No projects tracked yet.");
  return sendMessage(senderId, `🗂️ Projects: ${names.join(', ')}`);
}

async function listAllProjects(senderId) {
  const { data, error } = await supabase.from('projects').select('project_name, url, summary, added_by, created_at').order('project_name', { ascending: true }).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching projects."); }
  if (!data || data.length === 0) return sendMessage(senderId, "No project links saved yet.");
  const grouped = {};
  for (const row of data) {
    const proj = row.project_name.toLowerCase();
    if (!grouped[proj]) grouped[proj] = [];
    grouped[proj].push(row);
  }
  let output = "🗂️ All Projects:\n";
  for (const project of Object.keys(grouped)) {
    output += `\n${project.toUpperCase()}:\n`;
    grouped[project].forEach((row, i) => {
      output += `  ${i + 1}. ${row.url} (${formatDate(row.created_at)}${row.added_by ? `, by ${row.added_by}` : ''})${row.summary ? `\n     — ${row.summary}` : ''}\n`;
    });
  }
  return sendMessage(senderId, output.trim());
}

// ---------- REMINDERS ----------

async function addReminder(senderId, description, dueDate) {
  const { error } = await supabase.from('reminders').insert({ description, due_date: dueDate });
  if (error) { console.error(error); return sendMessage(senderId, "Error saving reminder."); }
  return sendMessage(senderId, `⏰ Reminder set: "${description}" on ${dueDate}.`);
}

async function listReminders(senderId) {
  const todayStr = getPHTime().toISOString().split('T')[0];
  const { data, error } = await supabase.from('reminders').select('id, description, due_date').gte('due_date', todayStr).order('due_date', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching reminders."); }
  if (!data || data.length === 0) return sendMessage(senderId, "No upcoming reminders.");
  const list = data.map((r, i) => `${i + 1}. ${r.description} — ${r.due_date}`).join('\n');
  return sendMessage(senderId, `⏰ Upcoming reminders:\n${list}`);
}

// ---------- TODOS ----------

async function addTodo(senderId, task) {
  const addedBy = await getProfileName(senderId);
  const { error } = await supabase.from('todos').insert({ task: `${task} (added by ${addedBy})` });
  if (error) { console.error(error); return sendMessage(senderId, "Error adding task."); }
  return sendMessage(senderId, `✅ Added to to-do list: "${task}"`);
}

async function listTodos(senderId) {
  const { data, error } = await supabase.from('todos').select('id, task').order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching to-do list."); }
  if (!data || data.length === 0) return sendMessage(senderId, "To-do list is empty.");
  const list = data.map((t, i) => `${i + 1}. ${t.task}`).join('\n');
  return sendMessage(senderId, `✅ To-Do List:\n${list}`);
}

async function completeTodo(senderId, number) {
  const { data, error } = await supabase.from('todos').select('id, task').order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching to-do list."); }
  if (!data || number > data.length || number < 1) return sendMessage(senderId, `Couldn't find #${number} on the list.`);
  const target = data[number - 1];
  await supabase.from('todos').delete().eq('id', target.id);
  return sendMessage(senderId, `✅ Marked done and removed: "${target.task}"`);
}

// ---------- EXPORT ----------

async function exportAll(senderId) {
  const { data: links } = await supabase.from('links').select('subject, url').order('subject', { ascending: true });
  const { data: projects } = await supabase.from('projects').select('project_name, url').order('project_name', { ascending: true });

  let output = "📦 FULL EXPORT\n\n📚 REVIEWERS:\n";
  output += (links || []).map(l => `[${l.subject}] ${l.url}`).join('\n') || '(none)';
  output += "\n\n🗂️ PROJECTS:\n";
  output += (projects || []).map(p => `[${p.project_name}] ${p.url}`).join('\n') || '(none)';

  if (output.length > 1900) output = output.slice(0, 1900) + '\n... (truncated, too long for one message)';
  return sendMessage(senderId, output);
}

// ---------- IMAGE ANALYSIS ----------

async function analyzeImage(imageUrl) {
  const raw = await askGroqVision(
    `Analyze this image and respond with ONLY this format, no extra text:
TYPE: <one of: reviewer_notes, diagram, schedule, question, random, other>
SUBJECT: <if it looks like a specific nursing subject like anaphy/biochem/nstp/tfn, name it; otherwise "unknown">
CONTENT: <see rules below>

Rules for CONTENT based on TYPE:
- reviewer_notes: transcribe/summarize the key points in 2-4 sentences
- diagram: describe what it shows
- schedule: summarize the schedule/document
- question: transcribe the exact question(s) or questionnaire items shown, verbatim, each on its own line
- random/other: describe the image in 1-2 sentences`,
    imageUrl
  );
  if (!raw) return null;
  const typeMatch = raw.match(/TYPE:\s*(.+)/i);
  const subjectMatch = raw.match(/SUBJECT:\s*(.+)/i);
  const contentMatch = raw.match(/CONTENT:\s*([\s\S]+)/i);
  return {
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : 'other',
    subject: subjectMatch ? subjectMatch[1].trim().toLowerCase() : 'unknown',
    content: contentMatch ? contentMatch[1].trim() : '',
  };
}

async function handleImage(imageUrl, senderId) {
  await addRecipient(senderId);
  if (!GROQ_API_KEY) {
    return sendMessage(senderId, "I can see you sent an image, but image recognition isn't set up right now.");
  }
  await sendMessage(senderId, "🖼️ Looking at that...");

  const result = await analyzeImage(imageUrl);
  if (!result) return sendMessage(senderId, "I couldn't quite make sense of that image.");

  lastImageBySender[senderId] = { url: imageUrl, summary: result.content };

  if (result.type === 'question') {
    await sendMessage(senderId, `📝 Found a question! Let me work on it...`);
    const answers = await answerQuestions(result.content);
    return sendMessage(senderId, `📝 Question(s) detected:\n${result.content}\n\n✅ Answer(s):\n${answers}`);
  }

  if (result.type === 'reviewer_notes') {
    const subject = result.subject !== 'unknown' ? result.subject : 'misc';
    await addLink(senderId, subject, imageUrl, { summary: result.content, autoSummarize: false, skipSimilarCheck: true });
    return sendMessage(senderId, `📸 Looks like study notes! I've saved it under "${subject}" with a summary:\n📝 ${result.content}`);
  }

  if (result.type === 'diagram') {
    return sendMessage(senderId, `📊 This looks like a diagram:\n${result.content}\n\nWant me to save it as a reviewer under a subject? Just say "save that as <subject>".`);
  }

  if (result.type === 'schedule') {
    return sendMessage(senderId, `🗓️ This looks like a schedule/document:\n${result.content}`);
  }

  return sendMessage(senderId, `🖼️ ${result.content}`);
}

// ---------- HELP ----------

function sendHelp(senderId) {
  const helpText =
`🤖 Bot Commands

📚 REVIEWERS: reviewer <subject> <link>, reviewer <subject>, reviewers, recent, subjects, find <keyword>, describe <subject> <number>, remove <number>

🗂️ PROJECTS: project/pr/proj <name> <link>, project <name>, projects, allprojects, removeproject <name> <number>

📅 SCHEDULE: ask "schedule today/tomorrow", automatic alerts

⏰ REMINDERS: remind <description> <date>, reminders

✅ TO-DO: todo <task>, todos, done <number>

📖 STUDY: quiz <subject>, flashcards <subject>, explain <topic>

🖼️ IMAGES: just send a photo — I'll identify notes, diagrams, schedules, or questions (and answer them!)

🌐 WEB SEARCH: search <query>, or just ask about current events/facts — I'll look it up live

🌤️ weather

📦 export — dump everything

Or just chat normally — I remember our conversation!`;
  return sendMessage(senderId, helpText);
}

// ---------- MESSAGE HANDLER ----------

async function handleMessage(text, senderId) {
  await addRecipient(senderId);
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/);
  addToHistory(senderId, 'user', trimmed);

  if (lower === 'help' || lower === '/help') return sendHelp(senderId);

  // Catch feature/capability/identity questions deterministically — don't let the LLM classifier guess
  if (/\bfeatur|what (can|do) you do|\bcommands?\b|\bcapabilit|what (are|is) you|who are you|what('| i)?s this bot|what bot is this/.test(lower)) {
    return sendHelp(senderId);
  }

  if (lower === 'reviewers') return listAllReviewers(senderId);
  if (lower === 'recent') return listRecent(senderId);
  if (lower === 'projects') return listProjectNames(senderId);
  if (lower === 'allprojects') return listAllProjects(senderId);
  if (lower === 'reminders') return listReminders(senderId);
  if (lower === 'todos') return listTodos(senderId);
  if (lower === 'weather') { const w = await getWeather(); addToHistory(senderId, 'assistant', w); return sendMessage(senderId, w); }
  if (lower === 'export') return exportAll(senderId);

  if (lower.startsWith('search ')) {
    const query = trimmed.slice(7).trim();
    if (!query) return sendMessage(senderId, "Usage: search <query>");
    if (!TAVILY_API_KEY) return sendMessage(senderId, "Web search isn't set up right now (missing TAVILY_API_KEY).");
    await sendMessage(senderId, "🌐 Searching...");
    const answer = await answerWithWebSearch(query, senderId);
    addToHistory(senderId, 'assistant', answer);
    return sendMessage(senderId, `🌐 ${answer}`);
  }

  if (lower.startsWith('done ')) {
    const number = parseInt(words[1], 10);
    if (!number) return sendMessage(senderId, "Usage: done <number>");
    return completeTodo(senderId, number);
  }

  if (lower.startsWith('todo ')) {
    const task = trimmed.slice(5).trim();
    if (!task) return sendMessage(senderId, "Usage: todo <task>");
    return addTodo(senderId, task);
  }

  if (lower.startsWith('remind ')) {
    const rest = trimmed.slice(7).trim();
    if (!GROQ_API_KEY) return sendMessage(senderId, "Reminder parsing needs AI, which isn't set up right now.");
    const { description, due_date } = await parseReminder(rest);
    if (!description || !due_date) return sendMessage(senderId, "Couldn't figure out the description/date. Try: remind nstp project july 20");
    return addReminder(senderId, description, due_date);
  }

  if (lower.startsWith('explain ')) {
    const topic = trimmed.slice(8).trim();
    if (!topic) return sendMessage(senderId, "Usage: explain <topic>");
    if (!GROQ_API_KEY) return sendMessage(senderId, "Explain feature isn't set up right now.");
    await sendMessage(senderId, "📖 Let me explain that...");
    const explanation = await explainTopic(topic);
    addToHistory(senderId, 'assistant', explanation);
    return sendMessage(senderId, `📖 ${explanation}`);
  }

  if (lower.startsWith('flashcards ')) {
    const subject = words[1]?.toLowerCase();
    if (!subject) return sendMessage(senderId, "Usage: flashcards <subject>");
    if (!GROQ_API_KEY) return sendMessage(senderId, "Flashcards feature isn't set up right now.");
    await sendMessage(senderId, "🃏 Making flashcards...");
    const cards = await generateFlashcards(subject);
    return sendMessage(senderId, `🃏 Flashcards — ${subject.toUpperCase()}:\n${cards}`);
  }

  if (lower.startsWith('save that as ') || lower.startsWith('save as ')) {
    const subject = lower.startsWith('save that as ') ? trimmed.slice(13).trim().toLowerCase() : trimmed.slice(8).trim().toLowerCase();
    const lastImg = lastImageBySender[senderId];
    if (!lastImg) return sendMessage(senderId, "I don't have a recent image to save. Send one first.");
    await addLink(senderId, subject, lastImg.url, { summary: lastImg.summary, autoSummarize: false, skipSimilarCheck: true });
    return;
  }

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

  if (lower.startsWith('project ') || lower.startsWith('pr ') || lower.startsWith('proj ')) {
    const projectName = words[1]?.toLowerCase();
    const url = words[2];
    if (!projectName) return sendMessage(senderId, "Usage: project <name> [link]");
    if (url && /^https?:\/\//.test(url)) return addProjectLink(senderId, projectName, url);
    return listProjectLinks(senderId, projectName);
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

  if (lower.startsWith('removeproject ')) {
    const restWords = words.slice(1);
    if (restWords.length >= 2 && !isNaN(parseInt(restWords[1], 10))) {
      return removeProjectByNumber(senderId, restWords[0].toLowerCase(), parseInt(restWords[1], 10));
    }
    const number = parseInt(restWords[0], 10);
    const project = lastProjectBySender[senderId];
    if (!project) return sendMessage(senderId, "Try 'project <name>' first, or use 'removeproject <name> <number>'.");
    if (!number) return sendMessage(senderId, "Usage: removeproject <number> OR removeproject <name> <number>");
    return removeProjectByNumber(senderId, project, number);
  }

  if (lower.startsWith('remove ')) {
    const restWords = words.slice(1);
    if (restWords.length >= 2 && !isNaN(parseInt(restWords[1], 10))) {
      return removeByNumber(senderId, restWords[0].toLowerCase(), parseInt(restWords[1], 10));
    }
    const number = parseInt(restWords[0], 10);
    const subject = lastSubjectBySender[senderId];
    if (!subject) return sendMessage(senderId, "Try 'reviewer <subject>' first, or use 'remove <subject> <number>'.");
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

  if (GROQ_API_KEY) {
    const parsed = await interpretNaturalLanguage(trimmed, senderId);
    switch (parsed.action) {
      case 'list_links': if (parsed.subject) return listSubjectLinks(senderId, parsed.subject.toLowerCase()); break;
      case 'list_subjects': return listSubjects(senderId);
      case 'list_all': return listAllReviewers(senderId);
      case 'list_recent': return listRecent(senderId);
      case 'find': if (parsed.keyword) return findLinks(senderId, parsed.keyword); break;
      case 'remove': {
        const subj = parsed.subject?.toLowerCase() || lastSubjectBySender[senderId];
        if (subj && parsed.number) return removeByNumber(senderId, subj, parsed.number);
        break;
      }
      case 'add': if (parsed.subject && parsed.url) return addLink(senderId, parsed.subject.toLowerCase(), parsed.url); break;
      case 'list_project': if (parsed.project) return listProjectLinks(senderId, parsed.project.toLowerCase()); break;
      case 'list_projects': return listProjectNames(senderId);
      case 'add_project': if (parsed.project && parsed.url) return addProjectLink(senderId, parsed.project.toLowerCase(), parsed.url); break;
      case 'check_schedule': {
        const r = await checkScheduleFor(parsed.when === 'tomorrow' ? 'tomorrow' : 'today');
        addToHistory(senderId, 'assistant', r);
        return sendMessage(senderId, r);
      }
      case 'weather': {
        const w = await getWeather();
        addToHistory(senderId, 'assistant', w);
        return sendMessage(senderId, w);
      }
      case 'list_todos': return listTodos(senderId);
      case 'add_todo': if (parsed.task) return addTodo(senderId, parsed.task); break;
      case 'list_reminders': return listReminders(senderId);
      case 'save_last_image': {
        const subject = parsed.subject?.toLowerCase();
        const lastImg = lastImageBySender[senderId];
        if (!subject || !lastImg) break;
        await addLink(senderId, subject, lastImg.url, { summary: lastImg.summary, autoSummarize: false, skipSimilarCheck: true });
        return;
      }
      case 'web_search': {
        if (!parsed.query) break;
        if (!TAVILY_API_KEY) return sendMessage(senderId, "Web search isn't set up right now (missing TAVILY_API_KEY).");
        await sendMessage(senderId, "🌐 Searching...");
        const answer = await answerWithWebSearch(parsed.query, senderId);
        addToHistory(senderId, 'assistant', answer);
        return sendMessage(senderId, `🌐 ${answer}`);
      }
      case 'chat':
      default: {
        const chatText = await chatReply(trimmed, senderId);
        addToHistory(senderId, 'assistant', chatText);
        return sendMessage(senderId, chatText);
      }
    }
  }

  return sendMessage(senderId, `❓ Type "help" to see what I can do.`);
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, { recipient: { id: recipientId }, message: { text } });
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
  }
}

app.get('/', (req, res) => res.send('Bot is running'));
app.listen(process.env.PORT || 3000, () => console.log('Server started'));
