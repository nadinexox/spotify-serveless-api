import { Redis } from '@upstash/redis'
import { VercelRequest, VercelResponse } from '@vercel/node';

// Connect using your specific environment variable names
const redis = new Redis({
  url: process.env.KV_REST_API_URL || "",
  token: process.env.KV_REST_API_TOKEN || "",
})

const header = (req: VercelRequest, name: string) => {
    const v = req.headers[name]
    return (Array.isArray(v) ? v[0] : v) || ""
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // 1. Enable CORS for Framer
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // 2. Fetch your position (Fallback to UCSD Geisel Library coordinates)
        const myLocation: any = await redis.get('current_pos') || {
            city: "San Diego",
            state: "CA",
            lat: 32.8811,
            lng: -117.2374
        };

        // 3. Get Visitor coordinates (Safety: Fallback to your coordinates if Vercel can't find them)
        const vLat = parseFloat(header(req, 'x-vercel-ip-latitude')) || myLocation.lat;
        const vLng = parseFloat(header(req, 'x-vercel-ip-longitude')) || myLocation.lng;

        // 4. Distance Math (Haversine Formula)
        const R = 3958.8; // Miles
        const dLat = (myLocation.lat - vLat) * (Math.PI / 180);
        const dLon = (myLocation.lng - vLng) * (Math.PI / 180);

        const a =
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(vLat * (Math.PI / 180)) * Math.cos(myLocation.lat * (Math.PI / 180)) * Math.sin(dLon/2) * Math.sin(dLon/2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = Math.round(R * c);

        // 5. Visitor's approximate city (used only if they opt in to the postmark)
        let visitorCity = header(req, 'x-vercel-ip-city')
        try { visitorCity = decodeURIComponent(visitorCity) } catch {}
        const visitorRegion = header(req, 'x-vercel-ip-country-region')
        const visitorCountry = header(req, 'x-vercel-ip-country')

        // 6. Send clean JSON back
        return res.status(200).json({
            myCity: myLocation.city || "San Diego",
            myState: myLocation.state || myLocation.myState || "CA",
            distance: isNaN(distance) ? 0 : distance,
            visitorCity,
            visitorRegion,
            visitorCountry
        });

    } catch (error: any) {
        return res.status(500).json({
            error: "Function Error",
            message: error.message
        })
    }
}
