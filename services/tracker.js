import { google } from 'googleapis';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { sendAdminAlert } from './utils.js';

dotenv.config();

const credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\n/g, '\n'),
    project_id: process.env.GOOGLE_PROJECT_ID,
};

const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({ version: 'v3', auth });
const TRACKER_FILE_NAME = 'processed_tracker.json';

async function loadTracker() {
    const trackerFileId = await findTrackerFileId();
    if (!trackerFileId) {
        console.log('📭 No tracker found in Google Drive — starting fresh.');
        return {};
    }

    const res = await drive.files.get({
        fileId: trackerFileId,
        alt: 'media'    
    });

    try {
        const tracker = typeof res.data === 'string'
            ? JSON.parse(res.data)
            : res.data;  // Already a valid object - use as is

        const fileCount = Object.keys(tracker).length;
        const latestFile = fileCount > 0 ? Object.keys(tracker).sort().pop() : 'None';
        console.log(`✅ Tracker loaded: ${fileCount} files currently tracked, latest file: ${latestFile}`);
        return tracker;
    } catch (err) {
        console.error('⚠️ Tracker file is corrupted or invalid JSON — resetting to empty tracker.', err);
        await sendAdminAlert('🚨 Tracker File Corrupted', `Tracker file in Google Drive is invalid JSON. Resetting to empty.\nError: ${err.message}`);
        return {};
    }
}

async function saveTracker(tracker) {
    const trackerFileId = await findTrackerFileId();
    const content = JSON.stringify(tracker, null, 2);

    if (trackerFileId) {
        await drive.files.update({
            fileId: trackerFileId,
            media: {
                mimeType: 'application/json',
                body: content
            }
        });
        console.log('✅ Tracker updated successfully in Google Drive.');
    } else {
        await drive.files.create({
            resource: {
                name: TRACKER_FILE_NAME,
                parents: [process.env.TRACKER_FOLDER_ID],
            },
            media: {
                mimeType: 'application/json',
                body: content
            }
        });
        console.log('✅ Tracker created successfully in Google Drive.');
    }
}

async function findTrackerFileId() {
    const res = await drive.files.list({
        q: `name='${TRACKER_FILE_NAME}' and '${process.env.TRACKER_FOLDER_ID}' in parents`,
        fields: 'files(id)'
    });

    return res.data.files.length > 0 ? res.data.files[0].id : null;
}

const FAILED_ORDERS_TRACKER = 'failed_orders_tracker.json';

/**
 * Loads the failed orders tracker from Google Drive.
 */
export async function loadFailedOrdersTracker() {
    try {
        const content = await fs.promises.readFile('./failed_orders.json', 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error(`⚠️ Failed Orders Tracker is corrupted — resetting.`, error);

        // Notify admin via email
        await sendAdminAlert(
            "🚨 Failed Orders Tracker Reset",
            `The failed orders tracker was corrupted and has been reset. Previous failed order data may be lost.<br>Error: ${error.message}`
        );

        // Reset the tracker and return empty
        await saveFailedOrdersTracker({});
        return {};
    }
}

/**
 * Saves the failed orders tracker to Google Drive.
 */
async function saveFailedOrdersTracker(tracker) {
    const trackerFileId = await findTrackerFileId(FAILED_ORDERS_TRACKER);
    const content = JSON.stringify(tracker, null, 2);

    if (trackerFileId) {
        await drive.files.update({
            fileId: trackerFileId,
            media: {
                mimeType: 'application/json',
                body: content
            }
        });
    } else {
        await drive.files.create({
            resource: {
                name: FAILED_ORDERS_TRACKER,
                parents: [process.env.TRACKER_FOLDER_ID],
            },
            media: {
                mimeType: 'application/json',
                body: content
            }
        });
    }
}

export { loadTracker, saveTracker, saveFailedOrdersTracker };
