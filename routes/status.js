export async function getStatus(req, res, trackerCache) {
    const fileCount = Object.keys(trackerCache).length;
    const latestFile = fileCount > 0 ? Object.keys(trackerCache).sort().pop() : 'None';
    res.json({ status: 'ok', trackedFiles: fileCount, lastOrderProcessed: latestFile });
}

