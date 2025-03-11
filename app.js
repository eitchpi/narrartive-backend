import dotenv from "dotenv";
import express from "express";
import { google } from "googleapis";
import { migrateOldOrders } from "./services/migrateOldOrders.js";
import { loadTracker } from "./services/tracker.js";
import { sendDailySummary, resetDailyFailures } from "./services/notifier.js";
import { processAllOrders } from './services/orders.js';

dotenv.config();

const app = express();
let trackerCache = {}; // Global cache for order tracking

// ✅ Health Check
app.get("/health", (req, res) => {
    const fileCount = Object.keys(trackerCache).length;
    const latestFile = fileCount > 0 ? Object.keys(trackerCache).sort().pop() : "None";

    res.json({
        status: "ok",
        trackedFiles: fileCount,
        lastOrderProcessed: latestFile,
    });
});

// ✅ Status Check
app.get("/status", async (req, res) => {
    try {
        trackerCache = await loadTracker();
        res.json({ status: "ok", trackerCache });
    } catch (error) {
        res.status(500).json({ status: "error", error: error.message });
    }
});

// 🌐 Google Drive Authentication Setup
const credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"), // Fix escape issues
    project_id: process.env.GOOGLE_PROJECT_ID,
};

const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

// 🧹 Cleanup old completed files (older than 24h)
async function cleanupOldCompletedOrders() {
    try {
        const folderId = process.env.COMPLETED_ORDERS_FOLDER_ID;
        if (!folderId) throw new Error("COMPLETED_ORDERS_FOLDER_ID is missing in .env");

        const res = await drive.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            fields: "files(id, name, createdTime)",
        });

        const threshold = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
        for (const file of res.data.files) {
            const createdTime = new Date(file.createdTime).getTime();
            if (createdTime < threshold) {
                await drive.files.delete({ fileId: file.id });
                console.log(`🧹 Deleted old completed order file: ${file.name} (${file.id})`);
            }
        }
    } catch (err) {
        console.error("❌ Cleanup failed:", err);
    }
}

// 🚀 Initial Processing
async function startup() {
    console.log("🚀 Starting initial processing & cleanup...");

    try {
        trackerCache = await loadTracker();
        await processAllOrders();
        await migrateOldOrders();
        await cleanupOldCompletedOrders();
        console.log("✅ Initial processing complete.");
    } catch (err) {
        console.error("❌ Initial processing failed:", err);
    }
}

// ⏱️ Recurring Processing (Every 5 mins)
setInterval(async () => {
    try {
        await processAllOrders();
    } catch (err) {
        console.error("❌ Recurring processing failed:", err);
    }
}, 5 * 60 * 1000);

// ⏱️ Recurring Cleanup (Every 60 mins)
setInterval(async () => {
    try {
        await cleanupOldCompletedOrders();
        console.log("✅ Recurring cleanup complete.");
    } catch (err) {
        console.error("❌ Recurring cleanup failed:", err);
    }
}, 60 * 60 * 1000);

// 🌅 Schedule Daily Reset & Summary (Runs at Midnight)
function scheduleDailyReset() {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(now.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);

    const msUntilMidnight = nextMidnight - now;

    setTimeout(async () => {
        console.log("🕛 Running daily reset & summary email...");
        resetDailyFailures();
        await sendDailySummary();
        scheduleDailyReset();
    }, msUntilMidnight);

    console.log("🕛 Scheduled daily reset & summary email.");
}

// Start the Express Server
app.listen(3000, async () => {
    console.log("✅ narrARTive Automation Service is running...");
    scheduleDailyReset();
    await startup();
    console.log("✅ Health & Status API running on port 3000");
});
