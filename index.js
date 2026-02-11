#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config({ path: "./data/.env" });

import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";
import OpenAI from "openai";
import chalk from "chalk";

const CONFIG = {
  MODEL: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  FALLBACK_MODEL: "openai/gpt-oss-20b",
  MAX_TOKENS: 4096,
  MAX_HISTORY: 20,
  MAX_ITERATIONS: 5,
  INCLUDE_REASONING: false,
  CACHE_TTL: 5 * 60 * 1000,
  MAX_RETRIES: 3,
  RETRY_BASE_DELAY: 2000,
  MAX_MESSAGE_LENGTH: 4000,
};

const log = {
  info: (msg) => console.log(chalk.blue("INFO"), chalk.white(msg)),
  success: (msg) => console.log(chalk.green("SUCCESS"), chalk.white(msg)),
  error: (msg) => console.log(chalk.red("ERROR"), chalk.white(msg)),
  warning: (msg) => console.log(chalk.yellow("WARNING"), chalk.white(msg)),
  debug: (msg) => console.log(chalk.gray("DEBUG"), chalk.gray(msg)),
  bot: (user, msg) => console.log(chalk.cyan("USER"), chalk.gray(`[${user}]`), chalk.white(msg)),
  ai: (msg) => {
    const lines = msg.split("\n");
    lines.forEach((line, i) => {
      if (i === 0) console.log(chalk.magenta("AI"), chalk.white(line));
      else console.log(chalk.white("    " + line));
    });
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[\*\-]\s+/gm, "• ")
    .trim();
}

function normalizeKey(key) {
  return key.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function validateKey(key) {
  const normalized = normalizeKey(key);
  
  if (normalized.length < 2) {
    return { valid: false, error: "Key too short (min 2 chars)" };
  }
  if (normalized.length > 100) {
    return { valid: false, error: "Key too long (max 100 chars)" };
  }
  
  const genericKeys = [
    "key", "value", "info", "data", "thing", "item", "note", "fact",
    "detail", "text", "content", "field", "var", "temp", "test"
  ];
  
  if (genericKeys.includes(normalized)) {
    return { 
      valid: false, 
      error: `Key "${normalized}" is too generic. Use descriptive names like "github_token" or "mom_birthday"` 
    };
  }
  
  if (!normalized.includes("_") && normalized.length < 6) {
    log.warning(`Key "${normalized}" might be too vague. Consider adding context.`);
  }
  
  return { valid: true, normalized };
}

function maskSensitive(value, key = "") {
  const sensitivePatterns = [
    /password/i, /token/i, /key/i, /secret/i, /credential/i, /auth/i
  ];
  
  const isSensitive = sensitivePatterns.some(p => p.test(key));
  
  if (isSensitive && value.length > 8) {
    return value.substring(0, 3) + "..." + value.substring(value.length - 3);
  }
  
  return value;
}

class APIKeyManager {
  constructor() {
    this.keys = [];
    this.state = new Map();

    for (let i = 1; i <= 10; i++) {
      const raw = process.env[`GROQ_API_KEY_${i}`];
      if (raw?.trim()) {
        const k = raw.trim();
        this.keys.push(k);
        this.state.set(k, { blockedUntil: 0, failCount: 0 });
      }
    }
    if (!this.keys.length) throw new Error("No GROQ API keys found in .env");
    this.idx = 0;
    log.success(`Loaded ${this.keys.length} API key(s)`);
  }

  pick() {
    const now = Date.now();
    
    for (let i = 0; i < this.keys.length; i++) {
      const j = (this.idx + i) % this.keys.length;
      const state = this.state.get(this.keys[j]);
      if (state.blockedUntil <= now && state.failCount < 3) {
        this.idx = (j + 1) % this.keys.length;
        return this.keys[j];
      }
    }
    
    let best = this.keys[0];
    for (const k of this.keys) {
      const bestState = this.state.get(best);
      const kState = this.state.get(k);
      if (kState.blockedUntil < bestState.blockedUntil) {
        best = k;
      }
    }
    return best;
  }

  block(key, ms) {
    const s = this.state.get(key);
    if (s) {
      s.blockedUntil = Date.now() + ms;
      s.failCount++;
      log.warning(`Key blocked for ${Math.ceil(ms / 1000)} seconds (fail count: ${s.failCount})`);
    }
  }

  resetFailures(key) {
    const s = this.state.get(key);
    if (s) s.failCount = 0;
  }

  waitTime(key) {
    return Math.max(0, (this.state.get(key)?.blockedUntil ?? 0) - Date.now());
  }
}

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  _entry(uid) {
    const e = this.store.get(String(uid));
    if (!e) return null;
    if (Date.now() - e.ts > CONFIG.CACHE_TTL) {
      this.store.delete(String(uid));
      return null;
    }
    return e;
  }

  getAll(uid) { 
    return this._entry(uid)?.map ?? null; 
  }

  get(uid, key) {
    return this._entry(uid)?.map.get(key) ?? null;
  }

  setAll(uid, arr) {
    const m = new Map();
    for (const { key, value } of arr) m.set(key, value);
    this.store.set(String(uid), { map: m, ts: Date.now() });
  }

  upsert(uid, key, value) {
    const e = this._entry(uid);
    if (e) {
      e.map.set(key, value);
      e.ts = Date.now();
    }
  }

  remove(uid, key) {
    this._entry(uid)?.map.delete(key);
  }

  isDuplicate(uid, key, value) {
    return this._entry(uid)?.map.get(key) === value;
  }

  invalidate(uid) {
    this.store.delete(String(uid));
  }
  
  size(uid) {
    return this._entry(uid)?.map.size ?? 0;
  }
}

class RequestQueue {
  constructor() {
    this.chains = new Map();
    this.stats = new Map();
  }

  enqueue(uid, fn) {
    const count = (this.stats.get(uid) ?? 0) + 1;
    this.stats.set(uid, count);
    
    const prev = this.chains.get(uid) ?? Promise.resolve();
    const task = new Promise((resolve, reject) => {
      prev.finally(() => fn().then(resolve, reject));
    });
    this.chains.set(uid, task.catch(() => {}));
    return task;
  }
  
  getStats(uid) {
    return this.stats.get(uid) ?? 0;
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save ONE fact. Use save_memories for multiple facts.",
      parameters: {
        type: "object",
        properties: {
          key: { 
            type: "string", 
            description: "Descriptive snake_case key (e.g., 'github_token', 'mom_birthday', 'work_laptop_password')" 
          },
          value: { 
            type: "string", 
            description: "The information to remember" 
          },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memories",
      description: "Save MULTIPLE facts in one call. More efficient than multiple save_memory calls.",
      parameters: {
        type: "object",
        properties: {
          memories: {
            type: "array",
            description: "Array of {key, value} pairs",
            items: {
              type: "object",
              properties: {
                key: { 
                  type: "string", 
                  description: "Descriptive snake_case key" 
                },
                value: { 
                  type: "string", 
                  description: "The information" 
                },
              },
              required: ["key", "value"],
            },
          },
        },
        required: ["memories"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory",
      description: "Get one memory by exact key, or list ALL memories if key is omitted.",
      parameters: {
        type: "object",
        properties: {
          key: { 
            type: "string", 
            description: "Exact key (optional). Omit to list all." 
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memories",
      description: "Search memories by keyword. Use broad terms first (e.g., 'github' not 'what is my github token'). This is your PRIMARY tool for answering questions.",
      parameters: {
        type: "object",
        properties: {
          query: { 
            type: "string", 
            description: "Search keyword(s) - keep it short and relevant" 
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description: "Delete a specific memory by key.",
      parameters: {
        type: "object",
        properties: {
          key: { 
            type: "string", 
            description: "Exact key to delete" 
          },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
];

const apiKeys = new APIKeyManager();
const convex = new ConvexClient(process.env.CONVEX_URL);
const cache = new MemoryCache();
const queue = new RequestQueue();

async function executeTool(name, args, userId) {
  const uid = String(userId);
  log.debug(`${name}(${JSON.stringify(args)})`);

  try {
    switch (name) {
      case "save_memory": {
        const validation = validateKey(args.key);
        if (!validation.valid) {
          log.warning(`Invalid key: ${validation.error}`);
          return `Error: ${validation.error}`;
        }
        
        const key = validation.normalized;
        const value = args.value;

        if (!value || value.trim().length === 0) {
          return "Error: Cannot save empty value";
        }

        if (cache.isDuplicate(uid, key, value)) {
          log.debug(`Skipped duplicate: ${key}`);
          return `Already saved: ${key}`;
        }

        await convex.mutation(api.memories.saveMemory, { userId: uid, key, value });
        cache.upsert(uid, key, value);
        
        const masked = maskSensitive(value, key);
        log.success(`Memory saved: ${key} = ${masked}`);
        return `Saved: ${key}`;
      }

      case "save_memories": {
        if (!args.memories || args.memories.length === 0) {
          return "Error: No memories provided";
        }

        const results = [];
        const toSave = [];
        
        for (const m of args.memories) {
          const validation = validateKey(m.key);
          if (!validation.valid) {
            results.push(`Skipped ${m.key}: ${validation.error}`);
            continue;
          }
          
          const key = validation.normalized;
          
          if (!m.value || m.value.trim().length === 0) {
            results.push(`Skipped ${key}: empty value`);
            continue;
          }
          
          if (cache.isDuplicate(uid, key, m.value)) {
            log.debug(`Skipped duplicate: ${key}`);
            results.push(`Already saved: ${key}`);
            continue;
          }
          
          toSave.push({ key, value: m.value });
        }
        
        for (const { key, value } of toSave) {
          await convex.mutation(api.memories.saveMemory, { userId: uid, key, value });
          cache.upsert(uid, key, value);
          
          const masked = maskSensitive(value, key);
          log.success(`Memory saved: ${key} = ${masked}`);
          results.push(`Saved: ${key}`);
        }
        
        return results.length > 0 ? results.join("\n") : "No memories saved";
      }

      case "get_memory": {
        if (args.key) {
          const key = normalizeKey(args.key);
          
          const cached = cache.get(uid, key);
          if (cached) {
            log.debug(`Cache hit: ${key}`);
            return `${key}: ${cached}`;
          }
          
          const mem = await convex.query(api.memories.getMemory, { userId: uid, key });
          if (mem) {
            cache.upsert(uid, key, mem.value);
            return `${mem.key}: ${mem.value}`;
          }
          return `No memory found: ${key}`;
        }
        
        const all = await convex.query(api.memories.listMemories, { userId: uid });
        cache.setAll(uid, all);
        
        if (all.length === 0) {
          return "No memories saved yet.";
        }
        
        return all.map((m) => `${m.key}: ${m.value}`).join("\n");
      }

      case "search_memories": {
        if (!args.query || args.query.trim().length === 0) {
          return "Error: Search query cannot be empty";
        }
        
        const mems = await convex.query(api.memories.searchMemories, {
          userId: uid,
          query: args.query,
        });
        
        log.debug(`Search "${args.query}" → ${mems.length} result(s)`);
        
        if (mems.length === 0) {
          return `Nothing found for: ${args.query}`;
        }
        
        return mems.map((m) => `${m.key}: ${m.value}`).join("\n");
      }

      case "delete_memory": {
        const key = normalizeKey(args.key);
        const ok = await convex.mutation(api.memories.deleteMemory, { userId: uid, key });
        
        if (ok) {
          cache.remove(uid, key);
          log.success(`Memory deleted: ${key}`);
          return `Deleted: ${key}`;
        }
        
        return `No memory found: ${key}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    log.error(`Tool execution error in ${name}: ${err.message}`);
    return `Error executing ${name}: ${err.message}`;
  }
}

async function groqChat(messages, tools) {
  let lastErr;

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    const apiKey = apiKeys.pick();

    const wait = apiKeys.waitTime(apiKey);
    if (wait > 0) {
      log.debug(`Waiting ${Math.ceil(wait / 1000)}s for key cooldown…`);
      await sleep(wait);
    }

    const client = new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    });

    const params = {
      model: CONFIG.MODEL,
      messages,
      max_tokens: CONFIG.MAX_TOKENS,
      temperature: 0.1,
    };
    
    if (tools) {
      params.tools = tools;
      params.tool_choice = "auto";
    }

    try {
      const response = await client.chat.completions.create(params);
      apiKeys.resetFailures(apiKey);
      return response;
    } catch (err) {
      lastErr = err;

      if (err.status === 429) {
        const match = err.message.match(/try again in ([\d.]+)s/i);
        const cooldown = match
          ? parseFloat(match[1]) * 1000 + 500
          : CONFIG.RETRY_BASE_DELAY * Math.pow(2, attempt - 1);

        apiKeys.block(apiKey, cooldown);
        log.warning(`429 attempt ${attempt}/${CONFIG.MAX_RETRIES} — waiting ${Math.ceil(cooldown / 1000)}s`);
        
        if (attempt < CONFIG.MAX_RETRIES) {
          await sleep(cooldown);
          continue;
        }
      }

      if (err.status === 400) {
        log.error(`Bad request (400): ${err.message}`);
        throw new Error("Invalid request format. Please try rephrasing.");
      }

      if (err.status >= 500) {
        log.error(`Server error (${err.status}): ${err.message}`);
        if (attempt < CONFIG.MAX_RETRIES) {
          await sleep(CONFIG.RETRY_BASE_DELAY * attempt);
          continue;
        }
      }

      throw err;
    }
  }

  throw lastErr;
}

const conversations = new Map();

function getHistory(uid) {
  if (!conversations.has(uid)) conversations.set(uid, []);
  return conversations.get(uid);
}

function pushHistory(uid, role, content) {
  const h = getHistory(uid);
  h.push({ role, content, timestamp: Date.now() });
  
  while (h.length > CONFIG.MAX_HISTORY) {
    h.shift();
  }
}

function clearOldHistory(uid, maxAge = 30 * 60 * 1000) {
  const h = getHistory(uid);
  const now = Date.now();
  const filtered = h.filter(msg => (now - msg.timestamp) < maxAge);
  conversations.set(uid, filtered);
}

const SYSTEM_PROMPT = `You are a memory assistant with persistent database access via tools. Your role: store user facts and retrieve them on demand.

━━━ PROCESSING PIPELINE ━━━

For EVERY user message, follow this sequence:

1. CLASSIFY intent (pick ONE):
   Q = Question/Query seeking information
   S = Statement/Fact to save
   U = Update/Correction to existing data
   D = Delete/Forget request
   L = List/Review all memories
   C = Casual chat (greeting, thanks, etc.)

2. EXECUTE based on classification:

[Q] QUESTION FLOW:
→ Extract search keywords (strip filler: what/when/where/is/my/the/a/do/you)
→ search_memories(keywords) — try broad terms first
→ If empty: try alternate keywords OR get_memory() to scan all
→ Answer ONLY from results. If nothing: "I don't have that saved yet"
→ CRITICAL: NEVER save during question flow

[S] STATEMENT FLOW:
→ Extract ALL distinct facts
→ search_memories(key concepts) to check existing data
→ Compare: only save if value differs or key doesn't exist
→ save_memories(batch) if 2+ facts, save_memory if exactly 1
→ Confirm briefly: "Noted — [summary]"

[U] UPDATE FLOW:
→ search_memories to locate existing entry
→ save_memory with SAME key + NEW value (overwrites)
→ Confirm: "Updated [key]"

[D] DELETE FLOW:
→ search_memories to find exact key
→ delete_memory(key)
→ Confirm deletion

[L] LIST FLOW:
→ get_memory() with no key
→ Display clean numbered format

[C] CHAT FLOW:
→ Respond naturally, no tools

━━━ KEY NAMING SYSTEM ━━━

Format: [context_]entity[_attribute][_index]

Context prefixes (use when relevant):
  work_, personal_, family_, friend_, health_, finance_, 
  travel_, home_, project_, hobby_, study_

Entity types:
  name, birthday, phone, email, address, password, 
  api_key, token, deadline, appointment, goal, preference

Attributes (when needed):
  _primary, _secondary, _expires, _created, _updated

Index (for multiples):
  _1, _2, _3 or _child1, _child2

EXAMPLES:
✓ work_laptop_password, home_wifi_password_guest
✓ github_personal_token, aws_access_key_prod
✓ project_atlas_deadline, project_atlas_owner
✓ family_mom_birthday, family_sister_name
✓ health_allergy_peanuts, health_medication_daily
✓ finance_bank_routing, finance_tax_deadline_2025
✓ friend_alex_phone, friend_alex_birthday
✓ study_french_teacher, study_french_level

✗ Avoid: key, token, password, info, data, thing, detail (too generic)

Special cases:
• User's own info: just use entity (name, birthday, email)
• Credentials: always prefix with service (groq_api_key, not api_key)
• People: prefix with relationship (boss_name, not name)

━━━ SEARCH OPTIMIZATION ━━━

Keyword extraction rules:
1. Remove question words (what/when/where/who/how/which)
2. Remove possessive (my/your/their/our)
3. Remove articles (a/an/the)
4. Keep nouns and key descriptors
5. If nothing found, broaden: "github token" → "github" → "token"

Examples:
"What's my GitHub token?" → search: "github token"
"When is mom's birthday?" → search: "mom birthday"
"What's that project deadline?" → search: "project deadline"

━━━ GUARDRAILS ━━━

NEVER do these:
✗ Re-save data you just retrieved from search
✗ Save the user's question itself
✗ Guess or hallucinate facts not in database
✗ Use markdown formatting (**, *, \`, #, >)
✗ Call save tools during question answering
✗ Store duplicate key-value pairs
✗ Ask permission before saving (just save it)
✗ Explain tool names or internal process to user

ALWAYS do these:
✓ Search before saving to prevent duplicates
✓ Save immediately when user states facts
✓ Use batch operations when possible
✓ Keep responses to 1-2 sentences
✓ Answer only from retrieved data
✓ Admit when you don't have information

━━━ RESPONSE STYLE ━━━

Format: Plain text, conversational, concise
Tone: Warm but efficient, helpful not chatty
Length: 1-2 sentences (unless listing/explaining)

Confirmation templates:
• Saving: "Got it — [brief summary]"
• Updating: "Updated [key]"
• Deleting: "Deleted [key]"
• Not found: "I don't have that saved"
• Listing: Use "1. key: value" format

━━━ EDGE CASES ━━━

Ambiguous statements:
"My name is Alex" → STATEMENT (save it)
"My name?" → QUESTION (search for it)
When unclear: default to QUESTION first

Contradictory info:
Old: "favorite_color: blue"
New: "My favorite color is red"
→ Auto-update, don't ask for confirmation

Implied facts:
"I'm heading to Japan next week"
→ Save: travel_destination_next: "Japan, next week"

Multiple people with same name:
Differentiate: friend_alex_phone vs coworker_alex_phone

━━━ EFFICIENCY OPTIMIZATIONS ━━━

1. Batch operations: Use save_memories for multiple facts
2. Preemptive search: Check existence before saving
3. Smart defaults: Infer context from conversation
4. Minimal confirmations: Don't repeat full values
5. No redundancy: One search, one save, done

━━━ VALIDATION LOGIC ━━━

Before saving, verify:
• Key is lowercase_snake_case
• Key is descriptive (not generic)
• Value is substantive (not empty/null)
• Not a duplicate of existing data

Before searching, verify:
• Keywords are relevant (not full sentences)
• At least one meaningful term provided`;

async function chat(userId, userMessage) {
  if (Math.random() < 0.1) {
    clearOldHistory(userId);
  }

  pushHistory(userId, "user", userMessage);

  if (!cache.getAll(userId)) {
    try {
      const all = await convex.query(api.memories.listMemories, {
        userId: String(userId),
      });
      cache.setAll(userId, all);
      log.debug(`Cache loaded: ${all.length} memories`);
    } catch (e) {
      log.debug(`Cache pre-load failed: ${e.message}`);
    }
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...getHistory(userId).map(({ role, content }) => ({ role, content })),
  ];

  let finalResponse = "";

  for (let iter = 1; iter <= CONFIG.MAX_ITERATIONS; iter++) {
    log.debug(`Iteration ${iter}/${CONFIG.MAX_ITERATIONS}`);

    let completion;
    try {
      completion = await groqChat(messages, TOOLS);
    } catch (err) {
      log.error(`Groq error: ${err.message}`);

      if (err.status === 400 || err.status === 429 || err.status >= 500) {
        log.warning("Trying fallback model…");
        try {
          const fallbackMessages = [
            { 
              role: "system", 
              content: "You are a helpful memory assistant. Answer from conversation context. Keep it short, no markdown." 
            },
            ...getHistory(userId).slice(-5).map(({ role, content }) => ({ role, content })),
          ];
          
          const fb = await groqChat(fallbackMessages, null);
          const txt = fb.choices[0].message.content ?? "Sorry, please try again in a moment.";
          pushHistory(userId, "assistant", txt);
          return stripMarkdown(txt);
        } catch (fallbackErr) {
          log.error(`Fallback also failed: ${fallbackErr.message}`);
          throw new Error("Service temporarily unavailable. Please try again in a moment.");
        }
      }
      
      throw err;
    }

    const msg = completion.choices[0].message;

    if (msg.reasoning && CONFIG.INCLUDE_REASONING) {
      log.debug(`Reasoning: ${msg.reasoning.substring(0, 150)}…`);
    }

    if (!msg.tool_calls?.length) {
      const reply = msg.content || "I'm here to help you remember things.";
      pushHistory(userId, "assistant", reply);
      finalResponse = reply;
      break;
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    const toolResults = [];
    for (const tc of msg.tool_calls) {
      let args;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        log.error(`Bad JSON from model: ${tc.function.arguments}`);
        const errorResult = {
          role: "tool",
          tool_call_id: tc.id,
          content: "Error: invalid arguments format",
        };
        messages.push(errorResult);
        toolResults.push(errorResult.content);
        continue;
      }

      try {
        const result = await executeTool(tc.function.name, args, userId);
        const toolMsg = {
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        };
        messages.push(toolMsg);
        toolResults.push(result);
      } catch (toolErr) {
        log.error(`Tool error: ${toolErr.message}`);
        const errorResult = {
          role: "tool",
          tool_call_id: tc.id,
          content: `Error: ${toolErr.message}`,
        };
        messages.push(errorResult);
        toolResults.push(errorResult.content);
      }
    }

    if (iter === CONFIG.MAX_ITERATIONS && toolResults.length > 0) {
      finalResponse = toolResults.join("\n");
      break;
    }
  }

  if (!finalResponse) {
    finalResponse = "I processed your request but couldn't generate a complete response. Please try again.";
  }

  pushHistory(userId, "assistant", finalResponse);
  return stripMarkdown(finalResponse);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.command("start", (ctx) =>
  ctx.reply(
    `Hi! I'm your memory assistant.

Tell me anything and I'll remember it.
Ask me questions and I'll recall what you said.

Commands:
/list - Show all memories
/stats - Show usage statistics
/clear - Clear conversation history
/forget - Delete all memories
/help - Show this message`,
  ),
);

bot.command("help", (ctx) => ctx.telegram.sendMessage(ctx.chat.id, 
  `Commands:
/start - Welcome message
/list - Show all saved memories
/stats - Your usage statistics
/clear - Clear conversation (keeps memories)
/forget - Delete ALL memories (permanent!)
/help - This help message`
));

bot.command("list", async (ctx) => {
  try {
    const mems = await convex.query(api.memories.listMemories, {
      userId: String(ctx.from.id),
    });
    
    if (!mems.length) {
      return ctx.reply("No memories saved yet. Tell me something about yourself!");
    }
    
    const grouped = {};
    for (const m of mems) {
      const prefix = m.key.split("_")[0];
      if (!grouped[prefix]) grouped[prefix] = [];
      grouped[prefix].push(m);
    }
    
    let txt = `Your memories (${mems.length}):\n\n`;
    
    if (Object.keys(grouped).length > 5) {
      txt += mems.map((m, i) => `${i + 1}. ${m.key}: ${m.value}`).join("\n");
    } else {
      for (const [prefix, items] of Object.entries(grouped)) {
        txt += `${prefix}:\n`;
        items.forEach(m => txt += `  • ${m.key}: ${m.value}\n`);
        txt += "\n";
      }
    }
    
    if (txt.length > CONFIG.MAX_MESSAGE_LENGTH) {
      const chunks = [];
      let chunk = "";
      for (const line of txt.split("\n")) {
        if (chunk.length + line.length > CONFIG.MAX_MESSAGE_LENGTH) {
          chunks.push(chunk);
          chunk = line + "\n";
        } else {
          chunk += line + "\n";
        }
      }
      if (chunk) chunks.push(chunk);
      
      for (const c of chunks) {
        await ctx.reply(c);
        await sleep(100);
      }
    } else {
      ctx.reply(txt);
    }
  } catch (err) {
    log.error(`List error: ${err.message}`);
    ctx.reply("Sorry, couldn't retrieve memories. Please try again.");
  }
});

bot.command("stats", async (ctx) => {
  try {
    const mems = await convex.query(api.memories.listMemories, {
      userId: String(ctx.from.id),
    });
    
    const cacheSize = cache.size(ctx.from.id);
    const requestCount = queue.getStats(ctx.from.id);
    const historySize = getHistory(ctx.from.id).length;
    
    ctx.reply(
      `Your Statistics:\n\n` +
      `Memories stored: ${mems.length}\n` +
      `Cached: ${cacheSize}\n` +
      `Conversation length: ${historySize} messages\n` +
      `Total requests: ${requestCount}`
    );
  } catch (err) {
    log.error(`Stats error: ${err.message}`);
    ctx.reply("Sorry, couldn't retrieve statistics.");
  }
});

bot.command("clear", (ctx) => {
  conversations.delete(ctx.from.id);
  ctx.reply("✓ Conversation cleared. Your memories are still saved.");
});

bot.command("forget", async (ctx) => {
  try {
    const n = await convex.mutation(api.memories.deleteAllMemories, {
      userId: String(ctx.from.id),
    });
    cache.invalidate(ctx.from.id);
    ctx.reply(`✓ Deleted ${n} memories. Starting fresh!`);
  } catch (err) {
    log.error(`Forget error: ${err.message}`);
    ctx.reply("Sorry, couldn't delete memories. Please try again.");
  }
});

bot.on(message("text"), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) {
    return ctx.reply("Unknown command. Try /help for available commands.");
  }

  const user = ctx.from.username || ctx.from.first_name || "User";
  log.bot(user, text);

  try {
    const response = await queue.enqueue(ctx.from.id, async () => {
      await ctx.sendChatAction("typing");
      return chat(ctx.from.id, text);
    });
    
    log.ai(response);
    
    if (response.length > CONFIG.MAX_MESSAGE_LENGTH) {
      const parts = response.match(new RegExp(`.{1,${CONFIG.MAX_MESSAGE_LENGTH}}`, "g"));
      for (const part of parts) {
        await ctx.reply(part);
        await sleep(100);
      }
    } else {
      await ctx.reply(response);
    }
  } catch (err) {
    log.error(`Bot error: ${err.message}`);
    
    const errorMsg = err.message.includes("temporarily unavailable")
      ? err.message
      : "Sorry, something went wrong. Please try again in a moment.";
    
    ctx.reply(errorMsg);
  }
});

async function start() {
  console.log("\n" + "=".repeat(60));
  console.log(chalk.bold.cyan("           Memory Telegram Bot v2.0"));
  console.log("=".repeat(60) + "\n");

  const required = ["TELEGRAM_BOT_TOKEN", "CONVEX_URL"];
  for (const env of required) {
    if (!process.env[env]) {
      log.error(`${env} not set in environment`);
      process.exit(1);
    }
  }

  try {
    await groqChat([{ role: "user", content: "hi" }], null);
    log.success(`Connected to Groq API (${CONFIG.MODEL})`);
  } catch (e) {
    log.error(`Groq connection failed: ${e.message}`);
    log.warning("Bot will start but may not work properly");
  }

  await bot.launch();
  log.success("Bot is running and accepting messages\n");
  
  log.info(`Max history: ${CONFIG.MAX_HISTORY} messages`);
  log.info(`Cache TTL: ${CONFIG.CACHE_TTL / 1000}s`);
  log.info(`Max iterations: ${CONFIG.MAX_ITERATIONS}`);
}

process.once("SIGINT", () => {
  log.info("Received SIGINT, shutting down...");
  bot.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", () => {
  log.info("Received SIGTERM, shutting down...");
  bot.stop("SIGTERM");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log.error(`Uncaught exception: ${err.message}`);
  log.error(err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  log.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
});

start().catch((e) => {
  log.error(`Startup failed: ${e.message}`);
  process.exit(1);
});