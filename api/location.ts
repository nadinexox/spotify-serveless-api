import { Redis } from '@upstash/redis'
import { VercelRequest, VercelResponse } from '@vercel/node';

// This automatically finds your UPSTASH_REDIS_REST_URL 
// and TOKEN from the .env file you just pulled!
const redis = Redis.fromEnv()

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // 1. Get the visitor's location from Vercel's Edge headers
    const visitorCity = req.headers['x-vercel-ip-city'] || "a mystery location";
    const visitorLat = parseFloat(req.headers['x-vercel-ip-latitude'] as string);
    const visitorLng = parseFloat(req.headers['x-vercel-ip-longitude'] as string);

    try {
        // 2. Fetch YOUR current location from your new Upstash database
        // We set a fallback (Geisel Library) in case the database is empty
        const myLocation: any = await redis.get('current_pos') || { 
            lat: 32.8811, 
            lng: -117.2374, 
            city: "San Diego" 
        };

        // 3. The Math: Calculate miles between you and the visitor
        const R = 3958.8; // Earth's radius in miles
        const dLat = (myLocation.lat - visitorLat) * (Math.PI / 180);
        const dLon = (myLocation.lng - visitorLng) * (Math.PI / 180);
        
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(visitorLat * (Math.PI / 180)) * Math.cos(myLocation.lat * (Math.PI / 180)) * Math.sin(dLon/2) * Math.sin(dLon/2);
            
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = Math.round(R * c);

        // 4. Send the data back to your Framer site
        return res.status(200).json({
            visitorCity,
            myCity: myLocation.city,
            distance: distance,
            display: `currently in ${myLocation.city} • ${distance} miles from you`
        });

    } catch (error) {
        return res.status(500).json({ error: "Failed to connect to database" });
    }
}
