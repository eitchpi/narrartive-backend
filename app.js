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

// Global tracker cache — refreshed every 5 minutes by your existing logic
let trackerCache = {};  

// ✅ Health Check (for Render) — Now uses trackerCache (no spam)
app.get('/health', (req, res) => {
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
});

// Example of how trackerCache should be refreshed (this already exists in your app.js):
setInterval(async () => {
    trackerCache = await loadTracker();  // refresh the cache every 5 minutes
    await processAllOrders(trackerCache);
    await migrateOldOrders();
    console.log('✅ Recurring order processing and migration complete.');
}, 5 * 60 * 1000);

// ✅ Status Check (for Admin Monitoring)
app.get('/status', getStatus);

// Setup Google Drive Auth
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

// 🧹 Cleanup old completed files (older than 24h)
async function cleanupOldCompletedOrders() {
    const folderId = process.env.COMPLETED_ORDERS_FOLDER_ID;
    const res = await drive.files.list({
        q: `'${folderId}' in parents`,
        fields: 'files(id, createdTime)'
    });

    const threshold = Date.now() - 24 * 60 * 60 * 1000;
    for (const file of res.data.files) {
        const createdTime = new Date(file.createdTime).getTime();
        if (createdTime < threshold) {
            await drive.files.delete({ fileId: file.id });
            console.log(`🧹 Deleted old completed order file: ${file.id}`);
        }
    }
}


// ⏱️ Recurring Tracker Load (every 5 minutes)
async function refreshTracker() {
    trackerCache = await loadTracker();
    console.log(`♻️ Tracker refreshed from Google Drive at ${new Date().toISOString()}`);
}

// 🚀 Initial Processing & Cleanup at Startup
async function startup() {
    console.log('🚀 Running initial processing & cleanup at startup...');
    try {
        await refreshTracker(); // Load tracker once at startup
        await processAllOrders(trackerCache);
        await migrateOldOrders();
        await cleanupOldCompletedOrders();
        console.log('✅ Initial processing, migration & cleanup complete.');
    } catch (err) {
        console.error('❌ Initial processing failed:', err);
        await sendAdminAlert('🚨 Initial Processing Failed', `Error: ${err.message}\n\n${err.stack}`);
    }
}

// ⏱️ Recurring Order Processing (Every 5 minutes)
setInterval(async () => {
    try {
        await refreshTracker();
        await processAllOrders(trackerCache);
        await migrateOldOrders();
        console.log('✅ Recurring order processing and migration complete.');
    } catch (err) {
        console.error('❌ Recurring order processing failed:', err);
        await sendAdminAlert('🚨 Recurring Processing Failed', `Error: ${err.message}\n\n${err.stack}`);
    }
}, 5 * 60 * 1000);

// ⏱️ Recurring Cleanup (Every 60 minutes)
setInterval(async () => {
    try {
        await cleanupOldCompletedOrders();
        console.log('✅ Recurring cleanup complete.');
    } catch (err) {
        console.error('❌ Recurring cleanup failed:', err);
        await sendAdminAlert('🚨 Recurring Cleanup Failed', `Error: ${err.message}\n\n${err.stack}`);
    }
}, 60 * 60 * 1000);

// 🌅 Daily Reset for Error Notifications (At midnight)
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

// 🚀 Start Server + Initial Processing
app.listen(3000, async () => {
    console.log('✅ narrARTive Automation Service is running...');
    scheduleDailyReset();
    await startup();
    console.log('✅ Health & Status API running on port 3000');
});
