import { VercelRequest, VercelResponse } from "@vercel/node"
import { Redis } from "@upstash/redis"

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const { city, state, lat, lng, password } = req.query

    // password
    if (password !== "ucsd_design") {
        return res.status(401).json({ error: "Unauthorized" })
    }

    const redis = new Redis({
        url: process.env.KV_REST_API_URL!,
        token: process.env.KV_REST_API_TOKEN!,
    })

    try {
        const newLocation = {
            city: city || "Westminster",
            state: (state as string || "CA").toUpperCase(),
            lat: parseFloat(lat as string),
            lng: parseFloat(lng as string),
            updatedAt: new Date().toISOString()
        }
        await redis.set("current_pos", newLocation)

        return res.status(200).json({ 
            success: true, 
            message: `Updated to ${newLocation.city}`,
            data: newLocation 
        })
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message })
    }
}
