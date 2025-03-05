import { trackerCache } from '../app.js';

export async function getStatus(req, res, trackerCache) {
    try {
        const fileCount = Object.keys(trackerCache).length;
        const latestFile = fileCount > 0 ? Object.keys(trackerCache).sort().pop() : 'None';

        res.json({
            status: 'ok',
            trackedFiles: fileCount,
            lastOrderProcessed: latestFile
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
}
