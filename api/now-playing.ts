// /api/now-playing.ts
//
// Rate-limit safe: every visitor's browser asks this every few seconds, but Spotify is only asked
// about once every 10 seconds in total. The answer, the Spotify token and any "slow down" (429)
// from Spotify are kept in your Upstash Redis, which all of Vercel's servers share. On a 429 it
// keeps showing the last song instead of an error.
import { Redis } from '@upstash/redis';

export const config = {
  runtime: 'edge'
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface TokenResponse {
  access_token: string;
}

interface SpotifyResponse {
  is_playing: boolean;
  progress_ms?: number;
  item?: {
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album: {
      name: string;
      images: Array<{ url: string }>;
    };
    external_urls?: {
      spotify?: string;
    };
  };
}

function getLuminance(r: number, g: number, b: number): number {
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255)
}
 
function getSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  return max - min
}
 
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}
 
function clampColor(r: number, g: number, b: number): [number, number, number] {
  // convert to HSL
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const delta = max - min
  let l = (max + min) / 2
  let s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (delta !== 0) {
    if (max === rn)      h = ((gn - bn) / delta) % 6
    else if (max === gn) h = (bn - rn) / delta + 2
    else                 h = (rn - gn) / delta + 4
    h = Math.round(h * 60)
    if (h < 0) h += 360
  }
  // only clamp extremes — dark floor, neon ceiling
  l = Math.max(0.35, l)
  s = Math.min(0.65, s)
  // back to rgb
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l - c / 2
  let r1 = 0, g1 = 0, b1 = 0
  if      (h < 60)  { r1 = c; g1 = x; b1 = 0 }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0 }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c }
  else              { r1 = c; g1 = 0; b1 = x }
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ]
}
 
async function extractGradientColors(imageUrl: string): Promise<[string, string, string]> {
  const fallback: [string, string, string] = ['#7ec8a0', '#6ab5c4', '#a89fd8']
 
  try {
    const res = await fetch(imageUrl)
    if (!res.ok) return fallback
 
    const buffer = await res.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    type RGB = [number, number, number]
    const samples: RGB[] = []
 
    for (let i = 0; i < bytes.length - 2; i += 150) {
      const r = bytes[i], g = bytes[i + 1], b = bytes[i + 2]
      const brightness = (r + g + b) / 3
      // exclude near-black bytes
      if (brightness > 50) {
        samples.push([r, g, b])
      }
    }
 
    if (samples.length < 3) return fallback
 
    // pick 6 maximally spread seeds
    const seeds: RGB[] = [samples[0]]
    while (seeds.length < 6 && seeds.length < samples.length) {
      let best = samples[0]
      let bestDist = 0
      for (const s of samples) {
        const minDist = Math.min(...seeds.map(seed =>
          Math.sqrt((s[0]-seed[0])**2 + (s[1]-seed[1])**2 + (s[2]-seed[2])**2)
        ))
        if (minDist > bestDist) { bestDist = minDist; best = s }
      }
      seeds.push(best)
    }
 
    // average nearby samples around each seed
    const palette: RGB[] = seeds.map(seed => {
      const near = samples.filter(s =>
        Math.sqrt((s[0]-seed[0])**2 + (s[1]-seed[1])**2 + (s[2]-seed[2])**2) < 80
      )
      if (near.length === 0) return seed
      const avg = near.reduce(
        (acc, c) => [acc[0]+c[0], acc[1]+c[1], acc[2]+c[2]] as RGB,
        [0, 0, 0] as RGB
      ).map(v => Math.round(v / near.length)) as RGB
      return avg
    })
 
    // clamp each color
    const clamped = palette.map(([r, g, b]) => clampColor(r, g, b))
 
    // sort: color1 = lightest, color2 = most saturated, color3 = second most saturated
    const sorted = [...clamped].sort((a, b) =>
      getLuminance(b[0], b[1], b[2]) - getLuminance(a[0], a[1], a[2])
    )
    const [lightest, ...rest] = sorted
    const byVibrancy = rest.sort((a, b) =>
      getSaturation(b[0], b[1], b[2]) - getSaturation(a[0], a[1], a[2])
    )
 
    return [
      rgbToHex(...lightest),
      rgbToHex(...(byVibrancy[0] ?? lightest)),
      rgbToHex(...(byVibrancy[1] ?? lightest)),
    ]
  } catch {
    return fallback
  }
}


const FRESH_SECONDS = 10;     // how long one Spotify answer is reused for everyone
const FALLBACK_COLORS = ['#7ec8a0', '#6ab5c4', '#a89fd8'];

const redis = new Redis({
  url: process.env.KV_REST_API_URL || '',
  token: process.env.KV_REST_API_TOKEN || '',
});

type Cached = { at: number; body: Record<string, unknown> };

function json(body: unknown, status = 200, cache = `public, s-maxage=${FRESH_SECONDS}, stale-while-revalidate=30`) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...corsHeaders },
  });
}

// Redis is a helper, never a blocker: if it's down, the API still works like before
async function rget<T>(...keys: string[]): Promise<(T | null)[]> {
  try { return (await redis.mget<(T | null)[]>(...keys)) ?? keys.map(() => null); }
  catch { return keys.map(() => null); }
}
async function rset(key: string, value: unknown, seconds?: number) {
  try { seconds ? await redis.set(key, value, { ex: Math.max(1, Math.round(seconds)) }) : await redis.set(key, value); }
  catch {}
}

class RateLimited extends Error {
  constructor(public retryAfter: number) { super('Spotify API request failed: 429'); }
}

async function getAccessToken(cachedToken: string | null): Promise<string> {
  if (cachedToken) return cachedToken;
  const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      )}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.SPOTIFY_REFRESH_TOKEN as string
    })
  });
  if (tokenResponse.status === 429) {
    throw new RateLimited(Number(tokenResponse.headers.get('retry-after')) || 60);
  }
  if (!tokenResponse.ok) {
    throw new Error(`Token request failed: ${tokenResponse.status}`);
  }
  const { access_token, expires_in } = await tokenResponse.json() as TokenResponse & { expires_in?: number };
  // keep it for its whole life (usually 1 hour), minus a minute of safety
  await rset('np:token', access_token, (expires_in || 3600) - 60);
  return access_token;
}

async function askSpotify(cachedToken: string | null): Promise<Record<string, unknown>> {
  let access_token = await getAccessToken(cachedToken);
  let response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  // saved token expired early → get a fresh one and try once more
  if (response.status === 401 && cachedToken) {
    access_token = await getAccessToken(null);
    response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
  }

  if (response.status === 429) {
    throw new RateLimited(Number(response.headers.get('retry-after')) || 60);
  }
  if (response.status === 204) {
    return { isPlaying: false };
  }
  if (!response.ok) {
    throw new Error(`Spotify API request failed: ${response.status}`);
  }

  const data = await response.json() as SpotifyResponse;
  const albumImageUrl = data.item?.album?.images[0]?.url || '';

  const [color1, color2, color3] = data.is_playing && albumImageUrl
    ? await extractGradientColors(albumImageUrl)
    : FALLBACK_COLORS;

  return {
    isPlaying: data.is_playing,
    title: data.item?.name || '',
    artist: data.item?.artists[0]?.name || '',
    album: data.item?.album?.name || '',
    albumImageUrl,
    progressMs: data.progress_ms || 0,
    durationMs: data.item?.duration_ms || 0,
    songUrl: data.item?.external_urls?.spotify || '',
    color1,
    color2,
    color3,
  };
}

// While Spotify has us on a time-out, keep the song moving forward on its own
function aged(c: Cached): Record<string, unknown> {
  const b = c.body;
  if (b.isPlaying && typeof b.progressMs === 'number' && typeof b.durationMs === 'number') {
    const progressMs = b.progressMs + (Date.now() - c.at);
    if (progressMs < b.durationMs) return { ...b, progressMs };
  }
  return b;
}

export default async function handler(request: Request) {
  // Handle CORS preflight request
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (!process.env.SPOTIFY_REFRESH_TOKEN ||
      !process.env.SPOTIFY_CLIENT_ID ||
      !process.env.SPOTIFY_CLIENT_SECRET) {
    return json({ error: 'Error fetching now playing', details: 'Missing required environment variables' }, 500, 'no-store');
  }

  // one Redis round trip: last answer, saved token, and whether Spotify told us to wait
  const [last, token, blocked] = await rget<any>('np:last', 'np:token', 'np:blocked');
  const lastAnswer = last as Cached | null;

  // fresh enough → everyone shares it, Spotify isn't asked
  if (lastAnswer && Date.now() - lastAnswer.at < FRESH_SECONDS * 1000) {
    return json(aged(lastAnswer));
  }
  // Spotify said slow down → wait it out, keep showing the last song
  if (blocked) {
    return lastAnswer ? json(aged(lastAnswer)) : json({ isPlaying: false });
  }

  try {
    const body = await askSpotify(token as string | null);
    await rset('np:last', { at: Date.now(), body } satisfies Cached);
    return json(body);
  } catch (error) {
    if (error instanceof RateLimited) {
      await rset('np:blocked', 1, error.retryAfter);
    }
    if (lastAnswer) return json(aged(lastAnswer));
    if (error instanceof RateLimited) return json({ isPlaying: false });
    return json({
      error: 'Error fetching now playing',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500, 'no-store');
  }
}