import { google } from 'googleapis';
import dotenv from 'dotenv';
import csvParser from 'csv-parser';
import { sendAdminAlert } from './utils.js';
import { loadTracker } from './tracker.js'; // ✅ Ensure we import loadTracker

dotenv.config();

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

async function migrateOldOrders() {
    console.log('🔍 Starting migration scan for old Etsy order files...');

    const tracker = await loadTracker(); // ✅ Ensure tracker is loaded
    if (!tracker) {
        console.error("❌ Tracker could not be loaded.");
        return;
    }

    const folderId = process.env.ETSY_ORDERS_FOLDER_ID;
    const processedFolderId = process.env.PROCESSED_ORDERS_FOLDER_ID;

    const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'files(id, name)',
    });

    const files = res.data.files || [];
    if (files.length === 0) {
        console.log('📭 No old Etsy order files found.');
        return;
    }

    for (const file of files) {
        const fileName = file.name;
        const fileId = file.id;

        const processedOrders = tracker[fileName] || [];
        const totalOrders = await countOrdersInFile(fileId);

        if (processedOrders.length === totalOrders) {
            await moveFileToProcessed(fileId, processedFolderId, folderId);
            console.log(`✅ Migrated ${fileName} to Processed folder.`);
        } else {
            console.log(`⏳ Skipping ${fileName} — not fully processed.`);
        }
    }

    console.log('✅ Migration scan complete.');
}

async function countOrdersInFile(fileId) {
    const orders = [];
    const fileStream = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    await new Promise((resolve, reject) => {
        fileStream.data.pipe(csvParser())
            .on('data', () => orders.push(1))
            .on('end', resolve)
            .on('error', reject);
    });
    
    return orders.length;
}

async function moveFileToProcessed(fileId, processedFolderId, ordersFolderId) {
    await drive.files.update({
        fileId,
        addParents: processedFolderId,
        removeParents: ordersFolderId,
        fields: 'id, parents'
    });
}

export { migrateOldOrders };
