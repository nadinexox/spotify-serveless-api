// /api/now-playing.ts
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


export default async function handler(request: Request) {
  // Handle CORS preflight request
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  try {
      // Validate environment variables
      if (!process.env.SPOTIFY_REFRESH_TOKEN || 
          !process.env.SPOTIFY_CLIENT_ID || 
          !process.env.SPOTIFY_CLIENT_SECRET) {
        throw new Error('Missing required environment variables');
      }
  
      // Get access token
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
          refresh_token: process.env.SPOTIFY_REFRESH_TOKEN
        })
      });
  
      if (!tokenResponse.ok) {
        throw new Error(`Token request failed: ${tokenResponse.status}`);
      }
  
      const { access_token } = await tokenResponse.json() as TokenResponse;
  
      // Get currently playing song
      const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: {
          Authorization: `Bearer ${access_token}`
        }
      });
  
      if (response.status === 204) {
        return new Response(JSON.stringify({ isPlaying: false }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      if (!response.ok) {
        throw new Error(`Spotify API request failed: ${response.status}`);
      }

      const data = await response.json() as SpotifyResponse;
    const albumImageUrl = data.item?.album?.images[0]?.url || ''
 
    // extract colors server-side — runs in parallel with no extra round trip
    const [color1, color2, color3] = data.is_playing && albumImageUrl
      ? await extractGradientColors(albumImageUrl)
      : ['#7ec8a0', '#6ab5c4', '#a89fd8']


      return new Response(JSON.stringify({
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
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Error fetching now playing',
        details: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  }
