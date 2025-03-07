import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import csvParser from 'csv-parser';
import { saveTracker } from './tracker.js';
import { createZip, uploadFile, sendEmail, deleteLocalFiles } from './fileHandler.js';
import { generatePassword, sendAdminAlert } from './utils.js';
import { sendErrorNotification } from './notifier.js';
import { recordError } from './errorTracker.js';

dotenv.config();

function sanitizeProductName(rawName) {
    return rawName.split(' - ')[0].trim();
}

function extractProductName(rawName) {
    const dashIndex = rawName.indexOf(' - ');
    return dashIndex !== -1 ? rawName.substring(0, dashIndex).trim() : rawName.trim();
}

function extractVariationValue(rawSize) {
    if (!rawSize) return '';  // Handle empty values gracefully
    const parts = rawSize.split(':');
    return parts.length > 1 ? parts[1].trim() : rawSize.trim();  // Works for both "Size: A4" and just "A4"
}

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

async function loadLatestEtsyOrder() {
    const folderId = process.env.ETSY_ORDERS_FOLDER_ID;
    const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'files(id, name, mimeType)',
        orderBy: 'createdTime desc',
        pageSize: 1
    });

    if (res.data.files.length === 0) {
        console.log('📭 No new Etsy orders found — checking again in 5 minutes...');
        return null;
    }

    const file = res.data.files[0];
    const orders = [];

    const fileStream = file.mimeType === 'application/vnd.google-apps.spreadsheet'
        ? await drive.files.export({ fileId: file.id, mimeType: 'text/csv' }, { responseType: 'stream' })
        : await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });

    await parseCsvStream(fileStream.data, orders);
    return { fileId: file.id, fileName: file.name, orders };
}

function parseCsvStream(stream, orders) {
    return new Promise((resolve, reject) => {
        stream.pipe(csvParser())
            .on('data', row => orders.push(row))
            .on('end', resolve)
            .on('error', reject);
    });
}

async function loadProductList() {
    const folderId = process.env.DOCUMENTS_FOLDER_ID;
    const res = await drive.files.list({
        q: `name contains 'Product_List' and '${folderId}' in parents`,
        fields: 'files(id)',
        orderBy: 'createdTime desc',
        pageSize: 1
    });

    if (res.data.files.length === 0) {
        throw new Error('❌ No Product_List file found in Documents folder');
    }

    const productList = [];
    const fileStream = await drive.files.export({
        fileId: res.data.files[0].id,
        mimeType: 'text/csv'
    }, { responseType: 'stream' });

    await parseCsvStream(fileStream.data, productList);
    return productList;
}

async function processAllOrders(tracker) {
    const latestOrderFile = await loadLatestEtsyOrder();
    if (!latestOrderFile) {
        console.log('📭 No new Etsy orders found.');
        return;
    }

    const { fileId, fileName, orders } = latestOrderFile;
    tracker[fileName] ??= [];  // Initialize tracking entry if missing

    const groupedOrders = orders.reduce((map, order) => {
        map[order['Order Number']] ??= [];
        map[order['Order Number']].push(order);
        return map;
    }, {});

    for (const [orderNumber, orderItems] of Object.entries(groupedOrders)) {
        if (tracker[fileName].includes(orderNumber)) {
            continue;  // Skip already processed orders
        }

        try {
            await processSingleOrder(orderNumber, orderItems);
            tracker[fileName].push(orderNumber);
            await saveTracker(tracker);
        } catch (err) {
            console.error(`❌ Failed to process order ${orderNumber}:`, err);

            recordError(`Failed to process order ${orderNumber}: ${err.message}`);

            await sendAdminAlert(
                `🚨 Order Processing Failed: ${orderNumber}`,
                `File: ${fileName}\nError: ${err.message}\nStack: ${err.stack}`
            );

            await sendErrorNotification(
                orderNumber,
                `File: ${fileName}\nError: ${err.message}\nStack: ${err.stack}`
            );
        }
    }

    // If every order in this file is processed, move it to "Processed Orders"
    if (tracker[fileName].length === Object.keys(groupedOrders).length) {
        await moveFileToProcessed(fileId);
    }
}

async function processSingleOrder(orderNumber, orderItems) {
    const tempFolder = `./temp_${orderNumber}`;
    if (fs.existsSync(tempFolder)) {
        fs.rmSync(tempFolder, { recursive: true, force: true });
    }
    fs.mkdirSync(tempFolder, { recursive: true });

    const narrARTiveFolderId = process.env.NARRARTIVE_FOLDER_ID;
    const thankYouFolderId = await getSubfolderId(narrARTiveFolderId, 'Thank You Card');

    const order = orderItems[0];  // First item defines product
    const rawProductName = order['Product Name'].trim();
    const productName = extractProductName(rawProductName);

    // 🕵️‍♂️ Search inside all collections for the product folder
    const productFolderId = await findProductFolder(narrARTiveFolderId, productName);
    if (!productFolderId) {
        throw new Error(`Product folder "${productName}" not found in any collection folder inside narrARTive.`);
    }

    // 🔍 Look for A2 or 40x40 directly inside the product folder
    let sizeFolderId = await getSubfolderId(productFolderId, 'A2');
    if (!sizeFolderId) {
        sizeFolderId = await getSubfolderId(productFolderId, '40x40');
    }
    if (!sizeFolderId) {
        throw new Error(`Neither A2 nor 40x40 found inside product folder: ${productName}`);
    }

    // 📥 Download all files from size folder
    await downloadAllFilesInFolder(sizeFolderId, tempFolder);

    // 📥 Download Thank You Card
    const thankYouFiles = await downloadAllFilesInFolder(thankYouFolderId, tempFolder);
    if (thankYouFiles.length === 0) {
        throw new Error('Thank You Card folder is empty or failed to download.');
    }

    // 📦 Create Zip
    const zipPath = `./Order_${orderNumber}.zip`;
    const filesToZip = fs.readdirSync(tempFolder).map(f => path.join(tempFolder, f));
    const password = generatePassword(order);

    await createZip(zipPath, filesToZip, password);

    // ☁️ Upload to Google Drive & Send Email
    const uploadedFileId = await uploadFile(zipPath);
    const downloadLink = `https://drive.google.com/file/d/${uploadedFileId}/view?usp=sharing`;

    await sendEmail(
        order['Buyer Email'],
        'Your Artwork is Ready!',
        downloadLink,
        password,
        order['Buyer Name']
    );

    // 🧹 Cleanup
    deleteLocalFiles([...filesToZip, zipPath]);
    fs.rmdirSync(tempFolder, { recursive: true });
}

/**
 * Find a product folder by searching all collections inside narrARTive.
 */
async function findProductFolder(parentFolderId, productName) {
    const collections = await listSubfolders(parentFolderId);

    for (const collection of collections) {
        const productFolderId = await getSubfolderId(collection.id, productName);
        if (productFolderId) {
            console.log(`✅ Found product "${productName}" inside collection: ${collection.name}`);
            return productFolderId;
        }
    }

    console.warn(`⚠️ Product "${productName}" not found in any collection inside narrARTive.`);
    return null;
}

/**
 * List all subfolders directly inside a folder.
 */
async function listSubfolders(parentFolderId) {
    const res = await drive.files.list({
        q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
        fields: 'files(id, name)'
    });

    return res.data.files || [];
}

async function getSubfolderId(parentFolderId, subfolderName) {
    const res = await drive.files.list({
        q: `name='${subfolderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
        fields: 'files(id, name)'
    });

    if (res.data.files.length === 0) {
        throw new Error(`Subfolder not found: ${subfolderName} inside parent folder ID ${parentFolderId}`);
    }

    return res.data.files[0].id;
}

async function downloadAllFilesInFolder(folderId, destFolder) {
    console.log(`📂 Downloading files from folder: ${folderId}`);

    const res = await drive.files.list({
        q: `'${folderId}' in parents`,
        fields: 'files(id, name)'
    });

    const downloadedFiles = [];

    for (const file of res.data.files) {
        console.log(`⬇️ Found file in folder: ${file.name}`);

        const filePath = path.join(destFolder, file.name);
        const dest = fs.createWriteStream(filePath);
        const fileStream = await drive.files.get({
            fileId: file.id,
            alt: 'media'
        }, { responseType: 'stream' });

        await new Promise((resolve, reject) => {
            fileStream.data.pipe(dest)
                .on('finish', () => {
                    console.log(`✅ Saved file: ${filePath}`);
                    downloadedFiles.push(filePath);
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`❌ Failed to save file: ${filePath}`, err);
                    sendAdminAlert(`🚨 File Download Failed`, `Failed to save file: ${filePath}\\nError: ${err.message}`);
                    reject(err);
                });
        });
    }

    return downloadedFiles;
}

async function moveFileToProcessed(fileId) {
    await drive.files.update({
        fileId,
        addParents: process.env.PROCESSED_ORDERS_FOLDER_ID,
        removeParents: process.env.ETSY_ORDERS_FOLDER_ID,
        fields: 'id, parents'
    });
    console.log(`✅ Moved file ${fileId} to Processed Orders.`);
}

export { processAllOrders };
