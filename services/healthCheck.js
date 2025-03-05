import express from 'express';
import { loadTracker } from './tracker.js';

const app = express();

// Cache Setup
let trackerCache = null;
let lastTrackerUpdate = 0;
const CACHE_LIFETIME = 5 * 60 * 1000;  // 5 minutes in milliseconds (same as your order scan interval)

async function getCachedTracker() {
    const now = Date.now();

    // Reload the tracker if cache is expired or never loaded
    if (!trackerCache || now - lastTrackerUpdate > CACHE_LIFETIME) {
        console.log(`♻️ Reloading tracker data into cache at ${new Date().toISOString()}`);
        trackerCache = await loadTracker();
        lastTrackerUpdate = now;
    }

    return trackerCache;
}

app.get('/health', async (req, res) => {
    try {
        const tracker = await getCachedTracker();  // Use the cached version

        const fileCount = Object.keys(tracker).length;
        const latestFile = fileCount > 0 ? Object.keys(tracker).sort().pop() : 'None';

        res.json({
            status: 'ok',
            trackedFiles: fileCount,
            lastOrderProcessed: latestFile
        });
    } catch (err) {
        console.error(`❌ Health check failed: ${err.message}`);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default app;
