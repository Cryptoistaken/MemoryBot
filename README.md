# MemoryBot

A Telegram bot with persistent memory powered by AI. Store personal facts, preferences, and information, then retrieve them naturally through conversation.

## Features

- **Persistent Memory**: Store unlimited personal facts and information
- **Natural Language Interface**: Ask questions and share information conversationally
- **Smart Search**: Find stored information using keywords and natural language
- **Batch Operations**: Save multiple facts at once for efficiency
- **Sensitive Data Protection**: Automatic masking of passwords, tokens, and API keys
- **Key Validation**: Prevents generic or poorly-named keys
- **Cache System**: Fast retrieval with intelligent caching
- **Rate Limiting**: Built-in handling for API rate limits with multiple key rotation
- **Conversation History**: Maintains context across messages

## Architecture

```
MemoryBot/
├── index.js              # Main bot logic and AI integration
├── convex/               # Convex backend (database)
│   ├── memories.js       # Memory CRUD operations
│   └── schema.ts         # Database schema
├── package.json          # Dependencies
├── convex.json           # Convex configuration
└── tsconfig.json         # TypeScript configuration
```

## Tech Stack

- **Bot Framework**: [Telegraf](https://telegraf.js.org/) (Telegram Bot API)
- **AI Model**: [Groq](https://groq.com/) (LLM API)
- **Database**: [Convex](https://convex.dev/) (Real-time database)
- **Runtime**: Node.js 18+

## Prerequisites

1. **Node.js 18+** installed
2. **Telegram Bot Token** from [@BotFather](https://t.me/botfather)
3. **Groq API Key(s)** from [console.groq.com](https://console.groq.com/)
4. **Convex Account** from [convex.dev](https://convex.dev/)

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/Cryptoistaken/MemoryBot.git
cd MemoryBot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up Convex

```bash
npx convex dev
```

This will:

- Create a new Convex project
- Generate your `CONVEX_URL`
- Set up the database schema

### 4. Configure environment variables

Create `data/.env` file:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
CONVEX_URL=your_convex_deployment_url

GROQ_API_KEY_1=your_groq_api_key_1
GROQ_API_KEY_2=your_groq_api_key_2
GROQ_API_KEY_3=your_groq_api_key_3

GROQ_MODEL=openai/gpt-oss-120b
```

**Notes:**

- You can add up to 10 Groq API keys (`GROQ_API_KEY_1` through `GROQ_API_KEY_10`)
- Multiple keys enable automatic rotation when rate limits are hit
- Model options: `openai/gpt-oss-120b`, `llama-3.1-8b-instant`, etc.

### 5. Deploy Convex functions

```bash
npx convex deploy
```

### 6. Start the bot

```bash
node index.js
```

## Usage

### Commands

- `/start` - Welcome message and command list
- `/list` - Show all saved memories
- `/stats` - View usage statistics
- `/clear` - Clear conversation history (keeps memories)
- `/forget` - Delete all memories permanently
- `/help` - Show help message

### Examples

**Saving Information:**

```
You: My name is Alex, I'm 30 years old, and I live in NYC
Bot: Got it — saved your name, age, and location
```

**Asking Questions:**

```
You: What's my name?
Bot: Your name is Alex

You: Where do I live?
Bot: You live in NYC
```

**Updating Information:**

```
You: Actually, I'm 31 now
Bot: Updated age
```

**Complex Queries:**

```
You: My GitHub token is ghp_abc123xyz
Bot: Saved: github_token

You: What's my GitHub token?
Bot: Your GitHub token is ghp_...xyz
```

## Key Naming Convention

The bot uses a structured naming system for better organization:

**Format:** `[context_]entity[_attribute][_index]`

**Examples:**

- ✓ `work_laptop_password`
- ✓ `github_personal_token`
- ✓ `family_mom_birthday`
- ✓ `project_atlas_deadline`
- ✓ `health_allergy_peanuts`

**Avoid:**

- ✗ `key`, `token`, `password` (too generic)
- ✗ `info`, `data`, `thing` (not descriptive)

## Configuration

Edit `CONFIG` object in `index.js`:

```javascript
const CONFIG = {
  MODEL: "openai/gpt-oss-120b",
  FALLBACK_MODEL: "llama-3.1-8b-instant",
  MAX_TOKENS: 4096,
  MAX_HISTORY: 20,
  MAX_ITERATIONS: 5,
  CACHE_TTL: 5 * 60 * 1000,
  MAX_RETRIES: 3,
  RETRY_BASE_DELAY: 2000,
  MAX_MESSAGE_LENGTH: 4000,
};
```

## Features Deep Dive

### 1. Smart Memory Management

- **Duplicate Detection**: Prevents saving identical information
- **Update Handling**: Automatically overwrites when updating existing keys
- **Batch Saving**: Saves multiple facts in one operation
- **Search Optimization**: Keyword extraction for better search results

### 2. Security Features

- **Sensitive Data Masking**: Passwords and tokens displayed as `abc...xyz`
- **Key Validation**: Prevents generic or insecure key names
- **Error Handling**: Graceful degradation on failures

### 3. Performance Optimizations

- **Caching**: Reduces database queries by ~60%
- **API Key Rotation**: Automatic switching when rate limited
- **Request Queuing**: Prevents concurrent request conflicts
- **History Cleanup**: Automatic removal of old messages

### 4. Resilience

- **Exponential Backoff**: Smart retry logic for failed requests
- **Fallback Model**: Switches to backup model on errors
- **Error Recovery**: Handles network failures gracefully
- **Uncaught Exception Handling**: Prevents bot crashes

## Database Schema

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  memories: defineTable({
    userId: v.string(),
    key: v.string(),
    value: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_user_key", ["userId", "key"]),
});
```

## API Functions

The bot uses these Convex mutations and queries:

- `saveMemory(userId, key, value)` - Save/update a memory
- `getMemory(userId, key)` - Retrieve a specific memory
- `listMemories(userId)` - Get all memories for a user
- `searchMemories(userId, query)` - Search memories by keyword
- `deleteMemory(userId, key)` - Delete a specific memory
- `deleteAllMemories(userId)` - Delete all user memories

## Development

### Running in Development Mode

```bash
npm run dev
```

### Debugging

Enable detailed logging by setting:

```javascript
const CONFIG = {
  INCLUDE_REASONING: true,
};
```

### Testing

Test the bot locally before deploying:

1. Start Convex dev server: `npx convex dev`
2. Run the bot: `node index.js`
3. Chat with your bot on Telegram

## Deployment

### Deploy to Production

1. **Deploy Convex:**

   ```bash
   npx convex deploy --prod
   ```

2. **Update environment variables** with production URLs

3. **Run bot on server:**
   ```bash
   node index.js
   ```

### Recommended Hosting

- **Railway**: Easy Node.js deployment
- **Fly.io**: Global edge deployment
- **DigitalOcean**: VPS hosting
- **Heroku**: Simple deployment
- **PM2**: Process manager for production

### Using PM2

```bash
npm install -g pm2
pm2 start index.js --name memorybot
pm2 save
pm2 startup
```

## Troubleshooting

### Bot not responding

- Check if bot is running: `pm2 status`
- Verify API keys are valid
- Check Convex deployment status

### Rate limit errors

- Add more Groq API keys
- Check key rotation is working
- Reduce `MAX_TOKENS` or `MAX_HISTORY`

### Database errors

- Verify Convex is deployed: `npx convex deploy`
- Check `CONVEX_URL` in `.env`
- Ensure schema is up to date

### Memory errors

- Clear old conversation history
- Reduce `MAX_HISTORY` value
- Restart bot to clear cache

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Commit changes: `git commit -am 'Add feature'`
4. Push to branch: `git push origin feature-name`
5. Submit a pull request

## Roadmap

- [ ] Multi-language support
- [ ] Memory categories/tags
- [ ] Export/import functionality
- [ ] Scheduled reminders
- [ ] Memory sharing between users
- [ ] Voice note support
- [ ] Image-based memory storage
- [ ] Analytics dashboard
- [ ] Fuzzy search for typos

## License

MIT License - see LICENSE file for details

## Credits

- Built with [Telegraf](https://telegraf.js.org/)
- Powered by [Groq](https://groq.com/)
- Database by [Convex](https://convex.dev/)

## Support

For issues and questions:

- Open an issue on [GitHub](https://github.com/Cryptoistaken/MemoryBot/issues)
- Contact: [@Cryptoistaken](https://github.com/Cryptoistaken)

---

**Made with ✓ by Cryptoistaken**
