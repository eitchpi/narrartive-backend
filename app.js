import dotenv from 'dotenv';
import express from 'express';
import { google } from 'googleapis';
import { sendAdminAlert } from './services/utils.js';
import { processAllOrders } from './services/orders.js';
import { migrateOldOrders } from './services/migrateOldOrders.js';
import { loadTracker } from './services/tracker.js';
import { getStatus } from './routes/status.js';
import { resetDailyFailures } from './services/notifier.js';

// Load environment variables
dotenv.config();

// Setup Express app
const app = express();

// Global tracker cache — lives only here
let trackerCache = {};  

// ✅ Health Check (no spam)
app.get('/health', (req, res) => {
    const fileCount = Object.keys(trackerCache).length;
    const latestFile = fileCount > 0 ? Object.keys(trackerCache).sort().pop() : 'None';
    res.json({ status: 'ok', trackedFiles: fileCount, lastOrderProcessed: latestFile });
});

// ✅ Status Check — passes cache directly
app.get('/status', (req, res) => getStatus(req, res, trackerCache));

// Setup Google Drive Auth (unchanged)
const credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    project_id: process.env.GOOGLE_PROJECT_ID,
};

const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

async function cleanupOldCompletedOrders() {
    const folderId = process.env.COMPLETED_ORDERS_FOLDER_ID;
    const res = await drive.files.list({
        q: `'${folderId}' in parents`,
        fields: 'files(id, createdTime)'
    });

    const threshold = Date.now() - 24 * 60 * 60 * 1000;
    for (const file of res.data.files) {
        if (new Date(file.createdTime).getTime() < threshold) {
            await drive.files.delete({ fileId: file.id });
            console.log(`🧹 Deleted old completed order file: ${file.id}`);
        }
    }
}

// Refresh tracker every 5 minutes
async function refreshTracker() {
    trackerCache = await loadTracker();
    console.log(`♻️ Tracker refreshed from Google Drive at ${new Date().toISOString()}`);
}

// Initial Processing
async function startup() {
    console.log('🚀 Running initial processing & cleanup at startup...');
    await refreshTracker();
    await processAllOrders(trackerCache);
    await migrateOldOrders(trackerCache);  // Pass the cached tracker
    await cleanupOldCompletedOrders();
    console.log('✅ Initial processing complete.');
}

// Recurring jobs
setInterval(async () => {
    await refreshTracker();
    await processAllOrders(trackerCache);
    await migrateOldOrders(trackerCache);  // Pass the cached tracker
    console.log('✅ Recurring processing complete.');
}, 5 * 60 * 1000);

setInterval(cleanupOldCompletedOrders, 60 * 60 * 1000);

// Daily Reset
function scheduleDailyReset() {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(now.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);

    setTimeout(() => {
        resetDailyFailures();
        scheduleDailyReset();
    }, nextMidnight - now);

    console.log('🕛 Scheduled daily error notification reset.');
}

// Start Server
app.listen(3000, async () => {
    console.log('✅ narrARTive Automation Service is running...');
    scheduleDailyReset();
    await startup();
    console.log('✅ Health & Status API running on port 3000');
});
