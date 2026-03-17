import { Redis } from '@upstash/redis'
import { VercelRequest, VercelResponse } from '@vercel/node';

// Connect using your specific environment variable names
const redis = new Redis({
  url: process.env.KV_REST_API_URL || "",
  token: process.env.KV_REST_API_TOKEN || "",
})

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
            lat: 32.8811, 
            lng: -117.2374 
        };

        // 3. Get Visitor coordinates (Safety: Fallback to your coordinates if Vercel can't find them)
        const vLat = parseFloat(req.headers['x-vercel-ip-latitude'] as string) || myLocation.lat;
        const vLng = parseFloat(req.headers['x-vercel-ip-longitude'] as string) || myLocation.lng;

        // 4. Distance Math (Haversine Formula)
        const R = 3958.8; // Miles
        const dLat = (myLocation.lat - vLat) * (Math.PI / 180);
        const dLon = (myLocation.lng - vLng) * (Math.PI / 180);
        
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(vLat * (Math.PI / 180)) * Math.cos(myLocation.lat * (Math.PI / 180)) * Math.sin(dLon/2) * Math.sin(dLon/2);
            
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = Math.round(R * c);

        // 5. Send clean JSON back
        return res.status(200).json({
            myCity: myLocation.city || "San Diego",
            distance: isNaN(distance) ? 0 : distance
        });

    } catch (error: any) {
        // If it still crashes, this tells us WHY in the browser
        return res.status(500).json({ 
            error: "Function Error", 
            message: error.message 
        });
    }
}
