import dotenv from 'dotenv';
import { sendAdminAlert } from './services/utils.js';
import { processAllOrders } from './services/orders.js';
import { migrateOldOrders } from './services/migrateOldOrders.js';
import { google } from 'googleapis';
import healthCheckApp from './services/healthCheck.js';

dotenv.config();

healthCheckApp.listen(3000, () => {
    console.log('✅ Health Check Endpoint Running on Port 3000');
});

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

async function cleanupOldCompletedOrders() {
    const folderId = process.env.COMPLETED_ORDERS_FOLDER_ID;

    const res = await drive.files.list({
        q: `'${folderId}' in parents`,
        fields: 'files(id, createdTime)'
    });

    const threshold = Date.now() - 24 * 60 * 60 * 1000; // 24 hours

    for (const file of res.data.files) {
        const createdTime = new Date(file.createdTime).getTime();
        if (createdTime < threshold) {
            await drive.files.delete({ fileId: file.id });
            console.log(`🧹 Deleted old completed order file: ${file.id}`);
        }
    }
}

async function startup() {
    console.log('🚀 Running initial processing & cleanup at startup...');

    try {
        await processAllOrders();
        await migrateOldOrders();
        console.log('✅ Initial order processing and migration complete.');
    } catch (err) {
        console.error('❌ Initial order processing failed:', err);
        await sendAdminAlert('🚨 Initial Processing Failed', `Error: ${err.message}\n\n${err.stack}`);
    }

    try {
        await cleanupOldCompletedOrders();
        console.log('✅ Initial cleanup complete.');
    } catch (err) {
        console.error('❌ Initial cleanup failed:', err);
        await sendAdminAlert('🚨 Initial Cleanup Failed', `Error: ${err.message}\n\n${err.stack}`);
    }
}

startup();

// Every 5 minutes: process new orders and run migration
setInterval(async () => {
    try {
        await processAllOrders();
        await migrateOldOrders();
        console.log('✅ Recurring order processing and migration complete.');
    } catch (err) {
        console.error('❌ Recurring order processing failed:', err);
        await sendAdminAlert('🚨 Recurring Processing Failed', `Error: ${err.message}\n\n${err.stack}`);
    }
}, 5 * 60 * 1000);

// Every hour: clean up old completed files
setInterval(async () => {
    try {
        await cleanupOldCompletedOrders();
        console.log('✅ Recurring cleanup complete.');
    } catch (err) {
        console.error('❌ Recurring cleanup failed:', err);
        await sendAdminAlert('🚨 Recurring Cleanup Failed', `Error: ${err.message}\n\n${err.stack}`);
    }
}, 60 * 60 * 1000);

console.log('✅ narrARTive Automation Service is running...');
