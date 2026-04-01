// /api/location.ts
import { VercelRequest, VercelResponse } from "@vercel/node"

const corsHeaders = {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

const DEFAULT_LOCATION = {
    city: "San Diego",
    lat: 32.8811,
    lng: -117.2374,
}

function cityLevel(coord: number): number {
    return Math.round(coord * 10) / 10  // ~10km, city center only
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // always set CORS headers first — before anything else
    // this ensures they're present even if the function crashes later
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))

    if (req.method === "OPTIONS") return res.status(204).end()

    // try to get live location from Redis
    // if anything fails, fall back to default — never return a 500
    let myLocation = DEFAULT_LOCATION

    try {
        const { Redis } = await import("@upstash/redis")

        if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
            const redis = new Redis({
                url: process.env.KV_REST_API_URL,
                token: process.env.KV_REST_API_TOKEN,
            })
            const stored: any = await redis.get("current_pos")
            if (stored && stored.lat && stored.lng) {
                myLocation = stored
            }
        }
    } catch (e) {
        console.log("Redis unavailable, using default location:", e)
        // continue with default — no crash
    }

    try {
        const vLat = parseFloat(req.headers["x-vercel-ip-latitude"] as string) || myLocation.lat
        const vLng = parseFloat(req.headers["x-vercel-ip-longitude"] as string) || myLocation.lng

        const R = 3958.8
        const dLat = (myLocation.lat - vLat) * (Math.PI / 180)
        const dLon = (myLocation.lng - vLng) * (Math.PI / 180)
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(vLat * (Math.PI / 180)) *
            Math.cos(myLocation.lat * (Math.PI / 180)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2)
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        const distance = Math.round(R * c)

        return res.status(200).json({
            myCity: myLocation.city || "San Diego",
            distance: isNaN(distance) ? 0 : distance,
            lat: myLocation.lat,
    lng: myLocation.lng,

        })
    } catch (e: any) {
        return res.status(200).json({
            myCity: DEFAULT_LOCATION.city,
            distance: 0,
        })
    }
}
