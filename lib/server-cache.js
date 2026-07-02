const memory = new Map();

async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return null;
  }

  try {
    const { createClient } = await import("@vercel/kv");
    return createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  } catch {
    return null;
  }
}

export async function cacheGet(key) {
  const kv = await getKv();
  if (kv) {
    try {
      return await kv.get(key);
    } catch {
      // fall through
    }
  }

  const item = memory.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memory.delete(key);
    return null;
  }
  return item.value;
}

export async function cacheSet(key, value, ttlSeconds = 1800) {
  const kv = await getKv();
  if (kv) {
    try {
      await kv.set(key, value, { ex: ttlSeconds });
    } catch {
      // fall through
    }
  }

  memory.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}
