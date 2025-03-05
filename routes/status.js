import { getLastError } from '../services/errorTracker.js';

export async function getStatus(req, res, trackerCache) {
    const fileCount = Object.keys(trackerCache).length;
    const latestFile = fileCount > 0 ? Object.keys(trackerCache).sort().pop() : 'None';

    const lastError = getLastError();

    res.json({
        status: 'ok',
        trackedFiles: fileCount,
        lastOrderProcessed: latestFile,
        lastError,
    });
}
