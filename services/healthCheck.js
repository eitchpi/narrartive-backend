import express from 'express';
import { loadTracker } from './tracker.js';

const app = express();

app.get('/health', async (req, res) => {
    try {
        const tracker = await loadTracker();
        const fileCount = Object.keys(tracker).length;
        const latestFile = fileCount > 0 ? Object.keys(tracker).sort().pop() : 'None';

        res.json({
            status: 'ok',
            trackedFiles: fileCount,
            lastOrderProcessed: latestFile
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default app;
