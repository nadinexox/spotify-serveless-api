import { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // 1. Get VISITOR'S location from Vercel headers
    const visitorCity = req.headers['x-vercel-ip-city'] || "a mystery location";
    const visitorLat = parseFloat(req.headers['x-vercel-ip-latitude'] as string);
    const visitorLng = parseFloat(req.headers['x-vercel-ip-longitude'] as string);

    // 2. Get YOUR current location from your Vercel KV database
    // Default to San Diego (UCSD) if the database is empty
    const myLocation = await kv.get('current_pos') || { lat: 32.8801, lng: -117.2340, city: "San Diego" };

    // 3. Haversine Formula (Miles)
    const R = 3958.8; 
    const dLat = (myLocation.lat - visitorLat) * Math.PI / 180;
    const dLon = (myLocation.lng - visitorLng) * Math.PI / 180;
    
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(visitorLat * Math.PI / 180) * Math.cos(myLocation.lat * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = Math.round(R * c);

    res.status(200).json({
        visitorCity,
        myCity: myLocation.city,
        distance: distance,
        display: `currently in ${myLocation.city} • ${distance} miles from you`
