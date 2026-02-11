import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const saveMemory = mutation({
  args: {
    userId: v.string(),
    key: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memories")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", args.userId).eq("key", args.key)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
      });
      return existing._id;
    }

    return await ctx.db.insert("memories", {
      userId: args.userId,
      key: args.key,
      value: args.value,
    });
  },
});

export const getMemory = query({
  args: {
    userId: v.string(),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("memories")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", args.userId).eq("key", args.key)
      )
      .first();
  },
});

export const listMemories = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const searchMemories = query({
  args: {
    userId: v.string(),
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const allMemories = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const searchTerm = args.query.toLowerCase().trim();
    
    // Normalize text: remove underscores, spaces, hyphens
    const normalizeText = (text: string) => 
      text.toLowerCase().replace(/[_\s-]/g, '');
    
    // Remove common suffixes for better matching (plural handling)
    const stemWord = (word: string) => {
      return word
        .replace(/s$/, '')      // dogs -> dog
        .replace(/es$/, '')     // boxes -> box
        .replace(/ies$/, 'y')   // babies -> baby
        .replace(/ing$/, '');   // running -> run
    };
    
    const normalizedSearch = normalizeText(searchTerm);
    const stemmedSearch = stemWord(normalizedSearch);
    
    // Split search into words for multi-word queries
    const searchWords = searchTerm.split(/\s+/).filter(w => w.length > 0);
    
    return allMemories.filter((m) => {
      const normalizedKey = normalizeText(m.key);
      const normalizedValue = normalizeText(m.value);
      const stemmedKey = stemWord(normalizedKey);
      const stemmedValue = stemWord(normalizedValue);
      
      // Check if any search word matches
      const wordMatch = searchWords.some(word => {
        const normalizedWord = normalizeText(word);
        const stemmedWord = stemWord(normalizedWord);
        return (
          normalizedKey.includes(normalizedWord) ||
          normalizedValue.includes(normalizedWord) ||
          stemmedKey.includes(stemmedWord) ||
          stemmedValue.includes(stemmedWord) ||
          m.key.toLowerCase().includes(word) ||
          m.value.toLowerCase().includes(word)
        );
      });
      
      // Check full query match
      const fullMatch = (
        normalizedKey.includes(normalizedSearch) ||
        normalizedValue.includes(normalizedSearch) ||
        stemmedKey.includes(stemmedSearch) ||
        stemmedValue.includes(stemmedSearch) ||
        m.key.toLowerCase().includes(searchTerm) ||
        m.value.toLowerCase().includes(searchTerm)
      );
      
      return wordMatch || fullMatch;
    });
  },
});

export const deleteMemory = mutation({
  args: {
    userId: v.string(),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db
      .query("memories")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", args.userId).eq("key", args.key)
      )
      .first();

    if (memory) {
      await ctx.db.delete(memory._id);
      return true;
    }
    return false;
  },
});

export const deleteAllMemories = mutation({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    for (const memory of memories) {
      await ctx.db.delete(memory._id);
    }

    return memories.length;
  },
});