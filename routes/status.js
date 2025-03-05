import { loadTracker } from '../services/tracker.js';

let lastError = null;

export function recordError(errorMessage) {
    lastError = errorMessage;
}

export async function getStatus(req, res) {
    try {
        const tracker = await loadTracker();
        const files = Object.keys(tracker);
        const lastFile = files[files.length - 1] || 'None';

        const totalOrdersProcessed = Object.values(tracker).reduce((sum, orders) => sum + orders.length, 0);

        res.json({
            status: 'ok',
            lastProcessedFile: lastFile,
            totalOrdersProcessed,
            lastError
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
}
