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

const conversationHistory = {}; // short-term in-process cache; source of truth is Supabase bot_state
const MAX_HISTORY_MESSAGES = 10;
const DAILY_AI_LIMIT = 60; // per-sender AI-powered calls per day (Groq/Tavily), generous for 2 users

const LAT = 15.5333;
const LON = 119.9333;

function addToHistory(senderId, role, content) {
  if (!conversationHistory[senderId]) conversationHistory[senderId] = [];
  conversationHistory[senderId].push({ role, content });
  if (conversationHistory[senderId].length > MAX_HISTORY_MESSAGES) {
    conversationHistory[senderId] = conversationHistory[senderId].slice(-MAX_HISTORY_MESSAGES);
  }
  // fire-and-forget persistence so a Render restart doesn't wipe context
  supabase.from('bot_state').upsert({ key: `history:${senderId}`, value: JSON.stringify(conversationHistory[senderId]) }).then(() => {}, () => {});
}

async function getHistory(senderId) {
  if (conversationHistory[senderId]) return conversationHistory[senderId];
  const { data } = await supabase.from('bot_state').select('value').eq('key', `history:${senderId}`).maybeSingle();
  try {
    const parsed = data?.value ? JSON.parse(data.value) : [];
    conversationHistory[senderId] = parsed;
    return parsed;
  } catch {
    return [];
  }
}

// ---------- PERSISTENT PER-SENDER STATE (survives restarts/deploys) ----------

async function getLastSubject(senderId) {
  const { data } = await supabase.from('bot_state').select('value').eq('key', `lastSubject:${senderId}`).maybeSingle();
  return data?.value || null;
}
async function setLastSubject(senderId, subject) {
  await supabase.from('bot_state').upsert({ key: `lastSubject:${senderId}`, value: subject });
}
async function getLastProject(senderId) {
  const { data } = await supabase.from('bot_state').select('value').eq('key', `lastProject:${senderId}`).maybeSingle();
  return data?.value || null;
}
async function setLastProject(senderId, project) {
  await supabase.from('bot_state').upsert({ key: `lastProject:${senderId}`, value: project });
}
async function getLastImage(senderId) {
  const { data } = await supabase.from('bot_state').select('value').eq('key', `lastImage:${senderId}`).maybeSingle();
  try {
    return data?.value ? JSON.parse(data.value) : null;
  } catch {
    return null;
  }
}
async function setLastImage(senderId, imageObj) {
  await supabase.from('bot_state').upsert({ key: `lastImage:${senderId}`, value: JSON.stringify(imageObj) });
}

// ---------- RATE LIMITING (protects Groq/Tavily usage) ----------

async function checkAndIncrementUsage(senderId) {
  const todayStr = getPHTime().toISOString().split('T')[0];
  const key = `usage:${senderId}:${todayStr}`;
  const { data } = await supabase.from('bot_state').select('value').eq('key', key).maybeSingle();
  const count = data?.value ? parseInt(data.value, 10) : 0;
  if (count >= DAILY_AI_LIMIT) return false;
  await supabase.from('bot_state').upsert({ key, value: String(count + 1) });
  return true;
}

// ---------- PROFILE NAME ----------

// Facebook's profile-fields Graph API endpoint is unreliable for apps in Development mode
// (frequently fails with error_subcode 33 regardless of permissions), so instead we let each
// person set their own display name once via a bot command, stored in bot_state.
async function getProfileName(psid) {
  const { data } = await supabase.from('bot_state').select('value').eq('key', `displayName:${psid}`).maybeSingle();
  return data?.value || 'Someone';
}
async function setDisplayName(psid, name) {
  await supabase.from('bot_state').upsert({ key: `displayName:${psid}`, value: name });
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

// Attempts to fetch the ACTUAL text content of a Google Docs link (not just the page title),
// using Google's plain-text export endpoint. This only works if the doc's sharing is set to
// "Anyone with the link can view" — if it's restricted, Google returns a sign-in page instead,
// which we detect and treat as a failure (falling back to title-only guessing).
// This is the real fix for subject-guessing being wrong: previously the AI was only ever shown
// a page title (often blank/generic for Docs), never the document's real content.
async function fetchGoogleDocText(url) {
  const match = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const docId = match[1];
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  try {
    const res = await axios.get(exportUrl, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = typeof res.data === 'string' ? res.data : '';
    // If sharing isn't public, Google redirects to a sign-in page instead of the doc's text —
    // detect that case and treat it as "couldn't read the doc" rather than feeding garbage to the AI.
    if (!text || text.length < 20 || /accounts\.google\.com|sign in to continue|google account/i.test(text.slice(0, 300))) {
      return null;
    }
    return text.slice(0, 1500); // cap length so we don't blow up the AI prompt on huge docs
  } catch {
    return null;
  }
}

// Builds the best available context for a URL: real document text when we can get it,
// otherwise falls back to the page title.
async function getUrlContext(url) {
  if (/docs\.google\.com\/document\//.test(url)) {
    const docText = await fetchGoogleDocText(url);
    if (docText) return { context: `Actual document content (excerpt):\n${docText}`, readReal: true };
  }
  const title = await fetchPageTitle(url);
  return { context: `Page title: ${title || '(unknown — could not read page or document content)'}`, readReal: false };
}

async function guessSubjectAndSummary(url) {
  const { context } = await getUrlContext(url);
  const raw = await askGroq(
    `You sort study reviewer links for a Philippine nursing student. Known subjects: anaphy, biochem, nstp, tfn, understanding_the_self, philippine_history. Base your answer on the ACTUAL CONTENT below whenever it's provided — do not guess a subject unrelated to what the content describes. Only invent a short one-word/underscored lowercase tag if the content genuinely doesn't match a known subject. Respond with ONLY:\nSUBJECT: <tag>\nSUMMARY: <one short sentence, max 15 words>`,
    `URL: ${url}\n${context}`
  );
  if (!raw) return { subject: 'misc', summary: '' };
  const subjectMatch = raw.match(/SUBJECT:\s*(.+)/i);
  const summaryMatch = raw.match(/SUMMARY:\s*(.+)/i);
  return {
    subject: subjectMatch ? slugifySubject(subjectMatch[1]) : 'misc',
    summary: summaryMatch ? summaryMatch[1].trim() : '',
  };
}

async function summarizeUrl(url) {
  const { context } = await getUrlContext(url);
  const raw = await askGroq('Write ONE short sentence (max 15 words) describing what this link actually covers, based on the content provided.', `URL: ${url}\n${context}`);
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
    `Extract a reminder description, due date, and recurrence from the message. Today's date is ${today} (Philippines). Respond with ONLY JSON: {"description":"<short description>","due_date":"YYYY-MM-DD","recurring":"none, weekly, or monthly"}. If no clear date, use null for due_date. Only set recurring if the user clearly implies repetition (e.g. "every week", "weekly", "every month") — otherwise "none".`,
    text
  );
  try {
    const parsed = JSON.parse((raw || '').replace(/```json|```/g, '').trim());
    return {
      description: parsed.description ?? null,
      due_date: parsed.due_date ?? null,
      recurring: ['weekly', 'monthly'].includes(parsed.recurring) ? parsed.recurring : 'none',
    };
  } catch {
    return { description: null, due_date: null, recurring: 'none' };
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

  const history = await getHistory(senderId);
  const raw = await askGroq(
    `You are a helpful assistant answering using live web search results provided below. Summarize the answer clearly and concisely (3-6 sentences) in your own words for a Philippine BSN nursing student on Messenger. Mention the source name briefly if relevant (e.g. "according to X"). Do not quote text verbatim — paraphrase. If the results don't actually answer the question, say so honestly.\n\nWeb search results:\n${context}`,
    query,
    history
  );
  return raw || "I found some results but couldn't summarize them right now.";
}

// ---------- NATURAL LANGUAGE ROUTING ----------

async function interpretNaturalLanguage(text, senderId) {
  const history = await getHistory(senderId);
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
  const history = await getHistory(senderId);
  const raw = await askGroq(
    `You are a friendly assistant chatting with a Philippine BSN nursing student on Messenger. Keep replies short (2-4 sentences), warm, conversational. Use history for context. ${BOT_FEATURES_DESCRIPTION}`,
    text, history
  );
  return raw || "Sorry, I'm having trouble responding right now.";
}

// ---------- WEATHER ----------

// Looks up any place name via Open-Meteo's free geocoding API (no key needed) — this is what
// lets "weather in Iba, Zambales" work instead of only ever showing Masinloc.
async function geocodeLocation(name) {
  try {
    const res = await axios.get('https://geocoding-api.open-meteo.com/v1/search', { params: { name, count: 1 } });
    const r = res.data.results?.[0];
    if (!r) return null;
    return { lat: r.latitude, lon: r.longitude, label: `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}` };
  } catch (err) {
    console.error('Geocode error:', err.message);
    return null;
  }
}

// dayOffset: null = default bundle (today + tomorrow, for the bare "weather" command, backward
// compatible with the old behavior). 0 = today, 1 = tomorrow, 2 = day after tomorrow, etc.
async function getWeatherReport(lat, lon, label, dayOffset) {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: lat, longitude: lon,
        daily: 'precipitation_probability_max,temperature_2m_max,temperature_2m_min',
        timezone: 'Asia/Manila',
        forecast_days: 8,
      },
    });
    const d = res.data.daily;

    if (dayOffset === null) {
      const todayRain = d.precipitation_probability_max[0];
      const tomorrowRain = d.precipitation_probability_max[1];
      const todayHigh = Math.round(d.temperature_2m_max[0]);
      const todayLow = Math.round(d.temperature_2m_min[0]);
      return `🌤️ ${label} weather:\nToday: ${todayLow}°–${todayHigh}°C, ${todayRain}% rain chance\nTomorrow: ${tomorrowRain}% rain chance\n${todayRain > 50 ? '☔ Bring an umbrella today!' : '✅ Low rain chance today.'}`;
    }

    if (dayOffset >= d.time.length) return `I can only see about a week ahead for ${label} — that day's too far out.`;
    const rain = d.precipitation_probability_max[dayOffset];
    const high = Math.round(d.temperature_2m_max[dayOffset]);
    const low = Math.round(d.temperature_2m_min[dayOffset]);
    const dayLabel = dayOffset === 0 ? 'Today' : dayOffset === 1 ? 'Tomorrow'
      : new Date(d.time[dayOffset]).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return `🌤️ ${label} weather — ${dayLabel}:\n${low}°–${high}°C, ${rain}% rain chance\n${rain > 50 ? '☔ Bring an umbrella!' : '✅ Low rain chance.'}`;
  } catch (err) {
    console.error('Weather error:', err.message);
    return `Couldn't fetch weather for ${label} right now.`;
  }
}

// Parses a free-text weather request for a day (today/tomorrow/day-after/weekday name) and an
// optional location ("weather in Iba, Zambales tomorrow"). Reuses the same prefix-based weekday
// matching as schedule parsing, so "wednesd", "saturd", etc. work here too.
function parseWeatherQuery(text) {
  const lower = text.toLowerCase();
  let dayOffset = 0;
  let explicitDay = false;

  if (/\b(day after tomorrow|next day|sa makalawa)\b/.test(lower)) {
    dayOffset = 2; explicitDay = true;
  } else if (/\b(tomorrow|tom|tmrw|tmrrw|2mrw)\b/.test(lower)) {
    dayOffset = 1; explicitDay = true;
  } else if (/\b(today|2day|tdy)\b/.test(lower)) {
    dayOffset = 0; explicitDay = true;
  } else {
    const words = lower.match(/[a-z]+/g) || [];
    outer:
    for (const word of words) {
      if (word.length < 3) continue;
      for (const [code, fullName] of Object.entries(FULL_DAY_NAMES)) {
        if (fullName.startsWith(word)) {
          const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
          const todayIdx = getPHTime().getUTCDay();
          const targetIdx = days.indexOf(code);
          let diff = targetIdx - todayIdx;
          if (diff < 0) diff += 7;
          dayOffset = diff;
          explicitDay = true;
          break outer;
        }
      }
    }
  }

  const locMatch = text.match(/\b(?:in|at)\s+([a-zA-Z0-9][a-zA-Z0-9\s,.]*)/i);
  let location = null;
  if (locMatch) {
    location = locMatch[1]
      .replace(/\b(today|tomorrow|tom|tmrw|day after tomorrow|next day|on \w+)\b.*$/i, '')
      .replace(/[,.\s]+$/, '')
      .trim();
    if (!location) location = null;
  }

  return { dayOffset, explicitDay, location };
}

async function handleWeatherRequest(senderId, text) {
  const { dayOffset, explicitDay, location } = parseWeatherQuery(text);
  let lat = LAT, lon = LON, label = 'Masinloc';

  if (location) {
    const geo = await geocodeLocation(location);
    if (geo) {
      lat = geo.lat; lon = geo.lon; label = geo.label;
    } else {
      await sendMessage(senderId, `Couldn't find "${location}" — showing Masinloc weather instead.`);
    }
  }

  // Bare "weather" (no day, no location) keeps the old today+tomorrow bundle for familiarity.
  const finalOffset = (!explicitDay && !location) ? null : dayOffset;
  const w = await getWeatherReport(lat, lon, label, finalOffset);
  addToHistory(senderId, 'assistant', w);
  return sendMessage(senderId, w);
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

// Converts a stored 24-hour "HH:MM" time into a display-friendly 12-hour "H:MM AM/PM" string.
// Storage stays 24-hour (correct for sorting/math); this is purely for what users see in messages.
function formatTime12h(time24) {
  if (!time24) return time24;
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${period}`;
}

const FULL_DAY_NAMES = { SUN: 'sunday', MON: 'monday', TUE: 'tuesday', WED: 'wednesday', THU: 'thursday', FRI: 'friday', SAT: 'saturday' };
const DAY_LABELS = { SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday' };

// Parses "today"/"tomorrow" (with common abbreviations) or any weekday name out of free text.
// Day-name matching is PREFIX-based rather than a fixed list of aliases: any word of 3+ letters
// that is a prefix of a real day name matches automatically (e.g. "tuesd", "saturd", "wednesd"),
// so new typos/truncations don't need a code change to be recognized.
// Returns { mode: 'today'|'tomorrow'|'day', dayCode } or null if nothing matched.
function parseScheduleTarget(text) {
  const lower = text.toLowerCase();
  if (/\b(tomorrow|tom|tmrw|tmrrw|2mrw)\b/.test(lower)) return { mode: 'tomorrow' };
  if (/\b(today|2day|tdy)\b/.test(lower)) return { mode: 'today' };
  const words = lower.match(/[a-z]+/g) || [];
  for (const word of words) {
    if (word.length < 3) continue;
    for (const [code, fullName] of Object.entries(FULL_DAY_NAMES)) {
      if (fullName.startsWith(word)) return { mode: 'day', dayCode: code };
    }
  }
  return null;
}

// `target` is either 'today', 'tomorrow', or an explicit day code like 'TUE'.
async function checkScheduleFor(target) {
  let day, label;
  if (target === 'today' || target === 'tomorrow') {
    const phTime = getPHTime();
    const targetDate = new Date(phTime);
    if (target === 'tomorrow') targetDate.setUTCDate(targetDate.getUTCDate() + 1);
    day = getDayCode(targetDate);
    label = target;
  } else {
    day = target; // already a day code like 'TUE'
    label = DAY_LABELS[day] || day;
  }

  if (day === 'MON' || day === 'SUN') return `No classes ${label} (${day === 'MON' ? 'No pasok' : 'Sunday'}).`;
  const { data, error } = await supabase.from('schedule').select('subject, start_time, end_time').eq('day', day).order('start_time', { ascending: true });
  if (error || !data || data.length === 0) return `No classes scheduled ${label}.`;
  const list = data.map(p => `• ${p.subject} (${formatTime12h(p.start_time)}–${formatTime12h(p.end_time)})`).join('\n');
  return `📅 Schedule for ${label} (${day}):\n${list}`;
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

async function runMorningBrief() {
  const phTime = getPHTime();
  const day = getDayCode(phTime);
  const recipients = await getAllRecipients();
  if (recipients.length === 0) return 'No recipients yet.';

  // Persistent guard: prevents duplicate "Good morning" greetings if this function gets triggered
  // more than once on the same day (e.g. both the internal scheduler AND an external cron-job.org
  // hit fire around 6 AM — this ensures only the first one actually sends the greeting).
  const todayStr = phTime.toISOString().split('T')[0];
  const { data: alreadySentData } = await supabase.from('bot_state').select('value').eq('key', 'lastMorningGreetingSentDate').maybeSingle();
  const alreadySentToday = alreadySentData?.value === todayStr;

  if (!alreadySentToday) {
    let messageText;
    if (day === 'MON' || day === 'SUN') {
      messageText = `☀️ Good morning! No classes today. Rest well!`;
    } else {
      const { data } = await supabase.from('schedule').select('subject, start_time').eq('day', day).order('start_time', { ascending: true }).limit(1);
      messageText = (data && data.length > 0) ? `☀️ Good morning! Your first class today is ${data[0].subject} at ${formatTime12h(data[0].start_time)}.` : `☀️ Good morning! No classes scheduled today.`;
    }
    for (const psid of recipients) await sendMessage(psid, messageText);
    await supabase.from('bot_state').upsert({ key: 'lastMorningGreetingSentDate', value: todayStr });
  }

  const lastCheck = await getLastReminderCheckDate();
  if (lastCheck !== todayStr) {
    const tomorrow = new Date(phTime);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const { data: dueReminders } = await supabase.from('reminders').select('id, description, due_date, recurring').in('due_date', [todayStr, tomorrowStr]);
    if (dueReminders && dueReminders.length > 0) {
      for (const r of dueReminders) {
        const when = r.due_date === todayStr ? 'TODAY' : 'TOMORROW';
        for (const psid of recipients) await sendMessage(psid, `⏰ Reminder: "${r.description}" is due ${when} (${r.due_date}).`);

        // Push recurring reminders forward once their due date arrives, instead of letting them go stale
        if (r.due_date === todayStr && r.recurring && r.recurring !== 'none') {
          const next = new Date(phTime);
          next.setUTCDate(next.getUTCDate() + (r.recurring === 'weekly' ? 7 : 30));
          const nextStr = next.toISOString().split('T')[0];
          await supabase.from('reminders').update({ due_date: nextStr }).eq('id', r.id);
        }
      }
    }
    await setLastReminderCheckDate(todayStr);
  }
  return `Sent to ${recipients.length} recipient(s).`;
}

async function runCheckSchedule() {
  const phTime = getPHTime();
  const day = getDayCode(phTime);
  const currentTime = getTimeString(phTime);
  const recipients = await getAllRecipients();
  if (recipients.length === 0) return 'No recipients yet.';
  if (day === 'MON' || day === 'SUN') return 'No class day.';

  const { data } = await supabase.from('schedule').select('subject, start_time, end_time').eq('day', day).order('start_time', { ascending: true });
  if (!data) return 'No schedule.';

  const nowMinutes = parseInt(currentTime.split(':')[0]) * 60 + parseInt(currentTime.split(':')[1]);
  for (const period of data) {
    const [sh, sm] = period.start_time.split(':').map(Number);
    const startMinutes = sh * 60 + sm;
    const diff = nowMinutes - startMinutes;
    if (diff >= 0 && diff < 15) {
      const periodKey = `${day}-${period.start_time}`;
      const lastNotified = await getLastNotifiedPeriod();
      if (lastNotified !== periodKey) {
        for (const psid of recipients) await sendMessage(psid, `📚 ${period.subject} is starting now (${formatTime12h(period.start_time)} - ${formatTime12h(period.end_time)}).`);
        await setLastNotifiedPeriod(periodKey);
      }
    }
  }
  return 'Checked.';
}

app.get('/cron/morning-brief', async (req, res) => {
  try {
    const result = await runMorningBrief();
    res.status(200).send(result);
  } catch (err) {
    console.error('Morning brief error:', err);
    res.status(500).send('Error');
  }
});

app.get('/cron/check-schedule', async (req, res) => {
  try {
    const result = await runCheckSchedule();
    res.status(200).send(result);
  } catch (err) {
    console.error('Check-schedule error:', err);
    res.status(500).send('Error');
  }
});

// ---------- HELPERS ----------

function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Normalizes any subject string (typed by a person OR generated by AI) into one consistent,
// single-word-ish slug. Without this, "trauma nursing/emergency nursing", "Trauma Nursing",
// and "trauma_nursing" would all be treated as different subjects, and multi-word subjects
// silently break the "remove <subject> <number>" command parser (which splits on spaces).
function slugifySubject(raw) {
  if (!raw) return 'misc';
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\/\\]+/g, '_')   // slashes -> underscore
    .replace(/\s+/g, '_')       // spaces -> underscore
    .replace(/[^a-z0-9_]/g, '') // strip anything not alphanumeric/underscore
    .replace(/_+/g, '_')        // collapse repeated underscores
    .replace(/^_|_$/g, '')      // trim leading/trailing underscore
    || 'misc';
}

// ---------- REVIEWER LINK ACTIONS ----------

async function listSubjectLinks(senderId, subjectRaw) {
  const subject = slugifySubject(subjectRaw);
  const { data, error } = await supabase.from('links').select('id, url, summary, added_by, created_at').eq('subject', subject).order('created_at', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching links."); }
  if (!data || data.length === 0) return sendMessage(senderId, `No links found for "${subject}" yet.`);
  await setLastSubject(senderId, subject);
  const list = data.map((l, i) => `${i + 1}. ${l.url} (${formatDate(l.created_at)}${l.added_by ? `, by ${l.added_by}` : ''})${l.summary ? `\n   — ${l.summary}` : ''}`).join('\n');
  return sendMessage(senderId, `📚 ${subject.toUpperCase()} reviewers:\n${list}`);
}

async function addLink(senderId, subjectRaw, url, opts = {}) {
  const subject = slugifySubject(subjectRaw);
  const { data: existingRows, error: fetchError } = await supabase.from('links').select('id, url').eq('subject', subject);
  if (fetchError) { console.error(fetchError); return sendMessage(senderId, "Error checking existing links."); }

  const exactDupe = existingRows?.find(r => r.url === url);
  if (exactDupe) { await setLastSubject(senderId, subject); return sendMessage(senderId, `⚠️ That exact link is already saved under "${subject}".`); }

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
  await setLastSubject(senderId, subject);
  return sendMessage(senderId, `✅ Added to "${subject}" by ${addedBy}.${summary ? `\n📝 ${summary}` : ''}${similarWarning}`);
}

async function removeByNumber(senderId, subjectRaw, number) {
  const subject = slugifySubject(subjectRaw);
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
  if (!data || data.length === 0) return sendMessage(senderId, `No results for "${keyword}" in your saved reviewers.${TAVILY_API_KEY ? ` Try "search ${keyword}" to look it up on the web instead.` : ''}`);
  const list = data.map((l, i) => `${i + 1}. [${l.subject.toUpperCase()}] ${l.url} (${formatDate(l.created_at)})`).join('\n');
  return sendMessage(senderId, `🔍 Results for "${keyword}":\n${list}`);
}

async function describeByNumber(senderId, subjectRaw, number) {
  const subject = slugifySubject(subjectRaw);
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
  await setLastProject(senderId, project);
  const list = data.map((l, i) => `${i + 1}. ${l.url} (${formatDate(l.created_at)}${l.added_by ? `, by ${l.added_by}` : ''})${l.summary ? `\n   — ${l.summary}` : ''}`).join('\n');
  return sendMessage(senderId, `🗂️ ${project.toUpperCase()} project links:\n${list}`);
}

async function addProjectLink(senderId, projectRaw, url) {
  const project = projectRaw.toLowerCase();
  const { data: existingRows, error: fetchError } = await supabase.from('projects').select('id, url').eq('project_name', project);
  if (fetchError) { console.error(fetchError); return sendMessage(senderId, "Error checking existing project links."); }
  const exactDupe = existingRows?.find(r => r.url === url);
  if (exactDupe) { await setLastProject(senderId, project); return sendMessage(senderId, `⚠️ That exact link is already saved under project "${project}".`); }

  let summary = null;
  if (GROQ_API_KEY) summary = await summarizeUrl(url);
  const addedBy = await getProfileName(senderId);

  const { error } = await supabase.from('projects').insert({ project_name: project, url, summary, added_by: addedBy });
  if (error) { console.error(error); return sendMessage(senderId, "Error saving project link."); }
  await setLastProject(senderId, project);
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

async function addReminder(senderId, description, dueDate, recurring = 'none') {
  const { error } = await supabase.from('reminders').insert({ description, due_date: dueDate, recurring });
  if (error) { console.error(error); return sendMessage(senderId, "Error saving reminder."); }
  return sendMessage(senderId, `⏰ Reminder set: "${description}" on ${dueDate}.${recurring !== 'none' ? ` (repeats ${recurring})` : ''}`);
}

async function listReminders(senderId) {
  const todayStr = getPHTime().toISOString().split('T')[0];
  const { data, error } = await supabase.from('reminders').select('id, description, due_date, recurring').gte('due_date', todayStr).order('due_date', { ascending: true });
  if (error) { console.error(error); return sendMessage(senderId, "Error fetching reminders."); }
  if (!data || data.length === 0) return sendMessage(senderId, "No upcoming reminders.");
  const list = data.map((r, i) => `${i + 1}. ${r.description} — ${r.due_date}${r.recurring && r.recurring !== 'none' ? ` (repeats ${r.recurring})` : ''}`).join('\n');
  return sendMessage(senderId, `⏰ Upcoming reminders:\n${list}`);
}

// ---------- TODOS ----------

async function addTodo(senderId, task) {
  const addedBy = await getProfileName(senderId);
  const assignMatch = task.match(/@(\w+)/);
  const cleanTask = task.replace(/@\w+/, '').trim();
  const assignSuffix = assignMatch ? `, assigned to @${assignMatch[1]}` : '';
  const { error } = await supabase.from('todos').insert({ task: `${cleanTask} (added by ${addedBy}${assignSuffix})` });
  if (error) { console.error(error); return sendMessage(senderId, "Error adding task."); }
  return sendMessage(senderId, `✅ Added to to-do list: "${cleanTask}"${assignMatch ? ` (assigned to @${assignMatch[1]})` : ''}`);
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
SUBJECT: <if it looks like a specific nursing subject, respond with ONE short lowercase word or short_underscored_tag only, e.g. "anaphy", "biochem", "nstp", "tfn", "trauma_nursing" — never a full phrase or sentence; otherwise "unknown">
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
    subject: subjectMatch ? slugifySubject(subjectMatch[1]) : 'unknown',
    content: contentMatch ? contentMatch[1].trim() : '',
  };
}

async function handleImage(imageUrl, senderId) {
  await addRecipient(senderId);
  if (!GROQ_API_KEY) {
    return sendMessage(senderId, "I can see you sent an image, but image recognition isn't set up right now.");
  }
  if (!(await checkAndIncrementUsage(senderId))) return sendMessage(senderId, "⚠️ You've hit today's AI usage limit. Try again tomorrow!");
  await sendTypingOn(senderId);

  const result = await analyzeImage(imageUrl);
  if (!result) return sendMessage(senderId, "I couldn't quite make sense of that image.");

  await setLastImage(senderId, { url: imageUrl, summary: result.content });

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

// ---------- TYPO CORRECTION FOR SINGLE-WORD COMMANDS ----------

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

const KNOWN_SINGLE_WORD_COMMANDS = [
  'help', 'reviewers', 'recent', 'projects', 'allprojects', 'reminders',
  'todos', 'weather', 'export', 'subjects', 'links',
];

// Corrects near-miss typos of known one-word commands (e.g. "Hekp" -> "help")
// so they hit the fast deterministic path instead of falling through to the AI chat fallback.
// Only applies to single-word messages to avoid mangling normal sentences.
function correctTypo(word) {
  if (KNOWN_SINGLE_WORD_COMMANDS.includes(word)) return word;
  if (word.length < 3) return word;
  for (const cmd of KNOWN_SINGLE_WORD_COMMANDS) {
    const maxDistance = cmd.length <= 5 ? 1 : 2;
    if (Math.abs(cmd.length - word.length) <= maxDistance && levenshtein(word, cmd) <= maxDistance) {
      return cmd;
    }
  }
  return word;
}

// ---------- MESSAGE HANDLER ----------

async function handleMessage(text, senderId) {
  await addRecipient(senderId);
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  const rawLower = trimmed.toLowerCase();
  const lower = words.length === 1 ? correctTypo(rawLower) : rawLower;
  addToHistory(senderId, 'user', trimmed);

  if (lower === 'help' || lower === '/help') return sendHelp(senderId);

  if (lower.startsWith('iam ') || lower.startsWith("i'm ") || lower.startsWith('im ')) {
    const name = trimmed.replace(/^(iam|i'm|im)\s+/i, '').trim();
    if (!name) return sendMessage(senderId, 'Usage: iam <your name>');
    await setDisplayName(senderId, name);
    return sendMessage(senderId, `✅ Got it, I'll call you ${name} from now on.`);
  }

  // Catch questions about notification mechanics deterministically — this is a question about
  // HOW/WHEN the bot notifies, not a request to see the schedule itself. Answer with hardcoded
  // facts about the actual mechanism rather than letting the AI guess or misroute to check_schedule.
  if (/when (will|do|does|did).*(notify|notified)|what time.*(notify|notified)|(notify|notified|notification|alert).*(when|what time)|when.*(notify|notification|alert)|how.*(notify|notification|alert).*work/.test(lower)) {
    return sendMessage(senderId,
      `🔔 Here's how notifications work:\n\n` +
      `☀️ Morning brief — every day at 6:00 AM (Philippine time), I send your first class of the day plus any reminders due today/tomorrow.\n\n` +
      `📚 Class-start alerts — I check every minute, and message you within the first 15 minutes after each class period begins (based on your saved schedule).\n\n` +
      `Both only fire on days you actually have classes — Sundays and Mondays are skipped since there's no pasok.\n\n` +
      `Want to see today's or tomorrow's actual schedule? Just ask "schedule today" or "schedule tomorrow".`
    );
  }

  // Catch feature/capability/identity questions deterministically — don't let the LLM classifier guess,
  // but reply conversationally (via Groq) instead of dumping the raw command list.
  if (/\bfeatur|what (can|do) you do|\bcommands?\b|\bcapabilit|what (are|is) you|who are you|what('| i)?s this bot|what bot is this/.test(lower)) {
    if (!GROQ_API_KEY) return sendHelp(senderId);
    const chatText = await chatReply(trimmed, senderId);
    addToHistory(senderId, 'assistant', chatText);
    return sendMessage(senderId, `${chatText}\n\n(Type "help" anytime for the full command list.)`);
  }

  if (lower === 'reviewers') return listAllReviewers(senderId);
  if (lower === 'recent') return listRecent(senderId);
  if (lower === 'projects') return listProjectNames(senderId);
  if (lower === 'allprojects') return listAllProjects(senderId);
  if (lower === 'reminders') return listReminders(senderId);
  if (lower === 'todos') return listTodos(senderId);
  if (lower === 'export') return exportAll(senderId);

  if (lower.startsWith('search ')) {
    const query = trimmed.slice(7).trim();
    if (!query) return sendMessage(senderId, "Usage: search <query>");
    if (!TAVILY_API_KEY) return sendMessage(senderId, "Web search isn't set up right now (missing TAVILY_API_KEY).");
    if (!(await checkAndIncrementUsage(senderId))) return sendMessage(senderId, "⚠️ You've hit today's AI usage limit. Try again tomorrow!");
    await sendTypingOn(senderId);
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
    const { description, due_date, recurring } = await parseReminder(rest);
    if (!description || !due_date) return sendMessage(senderId, "Couldn't figure out the description/date. Try: remind nstp project july 20");
    return addReminder(senderId, description, due_date, recurring);
  }

  if (lower.startsWith('explain ')) {
    const topic = trimmed.slice(8).trim();
    if (!topic) return sendMessage(senderId, "Usage: explain <topic>");
    if (!GROQ_API_KEY) return sendMessage(senderId, "Explain feature isn't set up right now.");
    if (!(await checkAndIncrementUsage(senderId))) return sendMessage(senderId, "⚠️ You've hit today's AI usage limit. Try again tomorrow!");
    await sendTypingOn(senderId);
    const explanation = await explainTopic(topic);
    addToHistory(senderId, 'assistant', explanation);
    return sendMessage(senderId, `📖 ${explanation}`);
  }

  if (lower.startsWith('flashcards ')) {
    const subject = words[1]?.toLowerCase();
    if (!subject) return sendMessage(senderId, "Usage: flashcards <subject>");
    if (!GROQ_API_KEY) return sendMessage(senderId, "Flashcards feature isn't set up right now.");
    if (!(await checkAndIncrementUsage(senderId))) return sendMessage(senderId, "⚠️ You've hit today's AI usage limit. Try again tomorrow!");
    await sendTypingOn(senderId);
    const cards = await generateFlashcards(subject);
    return sendMessage(senderId, `🃏 Flashcards — ${subject.toUpperCase()}:\n${cards}`);
  }

  if (lower.startsWith('save that as ') || lower.startsWith('save as ')) {
    const subject = lower.startsWith('save that as ') ? trimmed.slice(13).trim().toLowerCase() : trimmed.slice(8).trim().toLowerCase();
    const lastImg = await getLastImage(senderId);
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
    if (!(await checkAndIncrementUsage(senderId))) return sendMessage(senderId, "⚠️ You've hit today's AI usage limit. Try again tomorrow!");
    await sendTypingOn(senderId);
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
  if (lower === 'links') return listAllReviewers(senderId);
  if (lower === 'subjects') return listSubjects(senderId);

  if (lower.startsWith('removeproject ')) {
    const restWords = words.slice(1);
    if (restWords.length >= 2 && !isNaN(parseInt(restWords[1], 10))) {
      return removeProjectByNumber(senderId, restWords[0].toLowerCase(), parseInt(restWords[1], 10));
    }
    const number = parseInt(restWords[0], 10);
    const project = await getLastProject(senderId);
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
    const subject = await getLastSubject(senderId);
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
    await sendTypingOn(senderId);
    const { subject, summary } = await guessSubjectAndSummary(url);
    return addLink(senderId, subject, url, { summary, autoSummarize: false });
  }

  // Catch schedule questions deterministically — any phrasing ("sched for tue", "schedule for
  // tuesday", "what is my schedule for tuesday", "schedule today/tomorrow") gets parsed directly
  // instead of relying on the AI classifier, which previously defaulted to "today" for anything
  // it didn't recognize (e.g. a specific weekday name). Placed after all specific command
  // prefixes above so it can't hijack things like "todo check schedule with adviser".
  if (/\bsched(ule)?\b/.test(lower)) {
    const target = parseScheduleTarget(trimmed);
    const resolved = target ? (target.mode === 'day' ? target.dayCode : target.mode) : 'today';
    const r = await checkScheduleFor(resolved);
    addToHistory(senderId, 'assistant', r);
    return sendMessage(senderId, r);
  }

  // Catch weather questions deterministically — same reasoning as schedule above: placed after
  // all specific command prefixes so it can't hijack things like "todo check weather forecast",
  // but still catches any phrasing ("weather", "weather tomorrow", "weather in Iba Zambales").
  if (/\bweather\b/.test(lower)) {
    return handleWeatherRequest(senderId, trimmed);
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
        const subj = parsed.subject?.toLowerCase() || await getLastSubject(senderId);
        if (subj && parsed.number) return removeByNumber(senderId, subj, parsed.number);
        break;
      }
      case 'add': if (parsed.subject && parsed.url) return addLink(senderId, parsed.subject.toLowerCase(), parsed.url); break;
      case 'list_project': if (parsed.project) return listProjectLinks(senderId, parsed.project.toLowerCase()); break;
      case 'list_projects': return listProjectNames(senderId);
      case 'add_project': if (parsed.project && parsed.url) return addProjectLink(senderId, parsed.project.toLowerCase(), parsed.url); break;
      case 'check_schedule': {
        const parsedTarget = parseScheduleTarget(trimmed);
        const target = parsedTarget ? (parsedTarget.mode === 'day' ? parsedTarget.dayCode : parsedTarget.mode) : (parsed.when === 'tomorrow' ? 'tomorrow' : 'today');
        const r = await checkScheduleFor(target);
        addToHistory(senderId, 'assistant', r);
        return sendMessage(senderId, r);
      }
      case 'weather': {
        return handleWeatherRequest(senderId, trimmed);
      }
      case 'list_todos': return listTodos(senderId);
      case 'add_todo': if (parsed.task) return addTodo(senderId, parsed.task); break;
      case 'list_reminders': return listReminders(senderId);
      case 'save_last_image': {
        const subject = parsed.subject?.toLowerCase();
        const lastImg = await getLastImage(senderId);
        await addLink(senderId, subject, lastImg.url, { summary: lastImg.summary, autoSummarize: false, skipSimilarCheck: true });
        return;
      }
      case 'web_search': {
        if (!parsed.query) break;
        if (!TAVILY_API_KEY) return sendMessage(senderId, "Web search isn't set up right now (missing TAVILY_API_KEY).");
        if (!(await checkAndIncrementUsage(senderId))) return sendMessage(senderId, "⚠️ You've hit today's AI usage limit. Try again tomorrow!");
        await sendTypingOn(senderId);
        const answer = await answerWithWebSearch(parsed.query, senderId);
        addToHistory(senderId, 'assistant', answer);
        return sendMessage(senderId, `🌐 ${answer}`);
      }
      case 'chat':
      default: {
        if (!(await checkAndIncrementUsage(senderId))) return sendMessage(senderId, "⚠️ You've hit today's AI usage limit. Try again tomorrow!");
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

async function sendTypingOn(recipientId) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, { recipient: { id: recipientId }, sender_action: 'typing_on' });
  } catch (err) {
    console.error('Typing indicator error:', err.response?.data || err.message);
  }
}

app.get('/', (req, res) => res.send('Bot is running'));

// ---------- INTERNAL SCHEDULER (replaces need for external cron-job.org triggers) ----------
//
// Runs entirely inside this Node process using PH time. The /cron/* HTTP endpoints above are
// kept as a manual-trigger fallback (e.g. for testing via browser), but are no longer required
// for normal operation.
//
// IMPORTANT: this only works while the process is awake. On Render's free tier the service
// sleeps after ~15 min of no incoming HTTP traffic, which would silently stop this scheduler too.
// The self-ping below hits this same service's own URL every 10 minutes specifically to prevent
// that — as long as SELF_URL (or Render's auto-provided RENDER_EXTERNAL_URL) is set correctly,
// the app keeps itself perpetually awake without needing cron-job.org at all.

let lastMorningBriefDate = null; // in-process guard against double-firing within the same minute

async function schedulerTick() {
  try {
    await runCheckSchedule();
  } catch (err) {
    console.error('Internal scheduler (check-schedule) error:', err);
  }

  try {
    const phTime = getPHTime();
    const hh = phTime.getUTCHours();
    const mm = phTime.getUTCMinutes();
    const todayStr = phTime.toISOString().split('T')[0];
    // Fires once, at 06:00 PH time, per calendar day
    if (hh === 6 && mm === 0 && lastMorningBriefDate !== todayStr) {
      lastMorningBriefDate = todayStr;
      await runMorningBrief();
    }
  } catch (err) {
    console.error('Internal scheduler (morning-brief) error:', err);
  }
}

const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || null;

async function selfPing() {
  if (!SELF_URL) return;
  try {
    await axios.get(SELF_URL, { timeout: 10000 });
  } catch (err) {
    console.error('Self-ping error:', err.message);
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started');
  setInterval(schedulerTick, 60 * 1000); // check every minute
  if (SELF_URL) {
    setInterval(selfPing, 10 * 60 * 1000); // keep-alive ping every 10 min
    console.log(`Self-ping enabled: ${SELF_URL}`);
  } else {
    console.log('Self-ping disabled: set SELF_URL env var to enable (e.g. https://messenger-linkbot.onrender.com)');
  }
});
