import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import csvParser from 'csv-parser';
import { createZip, uploadFile, sendEmail, deleteLocalFiles } from './fileHandler.js';
import { generatePassword, sendAdminAlert } from './utils.js';
import { sendErrorNotification } from './notifier.js';
import { recordError } from './errorTracker.js';
import { loadTracker, saveTracker } from './tracker.js';


dotenv.config();

function sanitizeProductName(rawName) {
    return rawName.split(' - ')[0].trim();
}

function extractProductName(rawName) {
    // Remove anything after the first " - " (hyphen with spaces)
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

async function processAllOrders() {
    const latestOrderFile = await loadLatestEtsyOrder();
    if (!latestOrderFile) return;

    const { fileId, fileName, orders } = latestOrderFile;
    const tracker = await loadTracker();
    tracker[fileName] ??= [];

    const groupedOrders = orders.reduce((map, order) => {
        const orderNumber = order['Order Number'].trim();
        map[orderNumber] ??= [];
        map[orderNumber].push(order);
        return map;
    }, {});

    for (const [orderNumber, orderItems] of Object.entries(groupedOrders)) {
        if (tracker[fileName].includes(orderNumber)) {
            console.log(`⏭️ Skipping already processed order: ${orderNumber}`);
            continue;
        }

        try {
            await processSingleOrder(orderNumber, orderItems);
            tracker[fileName].push(orderNumber);
            await saveTracker(tracker);
        } catch (err) {
            console.error(`❌ Failed to process order ${orderNumber}:`, err);
            await sendAdminAlert(`🚨 Order Processing Failed: ${orderNumber}`, `File: ${fileName}\nError: ${err.message}\nStack: ${err.stack}`);
        }
    }

    if (tracker[fileName].length === Object.keys(groupedOrders).length) {
        await moveFileToProcessed(fileId);
    }
}

async function getProductFolderId(productName) {
    const narrARTiveFolderId = process.env.NARRARTIVE_FOLDER_ID;
    
    // Get a list of all top-level folders in Google Drive
    const parentFolders = await listSubfolders(narrARTiveFolderId);
    
    for (const parentFolder of parentFolders) {
        console.log(`🔍 Searching in: ${parentFolder.name}`);

        // Look inside each folder to find the product
        const productFolderId = await getSubfolderId(parentFolder.id, productName);
        if (productFolderId) {
            return productFolderId;
        }
    }

    console.error(`❌ Product folder not found: "${productName}"`);
    return null; // Return null if the product folder is not found
}

async function processSingleOrder(orderNumber, orderItems) {
    console.log(`🔍 Processing order: ${orderNumber}`);

    const tempFolder = `./temp_${orderNumber}`;
    if (fs.existsSync(tempFolder)) fs.rmSync(tempFolder, { recursive: true, force: true });
    fs.mkdirSync(tempFolder, { recursive: true });

    const productFolders = await listSubfolders(process.env.NARRARTIVE_FOLDER_ID);
    for (const order of orderItems) {
        const productName = extractProductName(order['Product Name'].trim());
        console.log(`🔍 Looking for product folder: "${productName}"`);

        const productFolder = productFolders.find(p => p.name === productName);
        if (!productFolder) {
            console.error(`❌ Product folder not found: "${productName}"`);
            throw new Error(`Product folder missing: "${productName}"`);
        }

        const formatFolder = await findFormatFolder(productFolder.id);
        if (!formatFolder) {
            console.error(`❌ Format folder (A2 or 40x40) not found for: ${productName}`);
            throw new Error(`Format folder missing: "${productName}" (A2 or 40x40 required)`);
        }

        await downloadAllFilesInFolder(formatFolder, tempFolder);
    }

    const thankYouFolderId = await getSubfolderId(process.env.NARRARTIVE_FOLDER_ID, 'Thank You Card');
    await downloadAllFilesInFolder(thankYouFolderId, tempFolder);

    const zipPath = `./Order_${orderNumber}.zip`;
    const filesToZip = fs.readdirSync(tempFolder).map(f => path.join(tempFolder, f));
    const password = generatePassword(orderItems[0]);

    await createZip(zipPath, filesToZip, password);
    const uploadedFileId = await uploadFile(zipPath);
    const downloadLink = `https://drive.google.com/file/d/${uploadedFileId}/view?usp=sharing`;

    await sendEmail(
        orderItems[0]['Buyer Email'],
        'Your Artwork is Ready!',
        downloadLink,
        password,
        orderItems[0]['Buyer Name']
    );

    deleteLocalFiles([...filesToZip, zipPath]);
    fs.rmSync(tempFolder, { recursive: true, force: true });

    console.log(`✅ Order ${orderNumber} processed successfully.`);
}

async function findFormatFolder(productFolderId) {
    const subfolders = await listSubfolders(productFolderId);
    const folderNames = subfolders.map(f => f.name); // Extract folder names

    if (folderNames.includes('A2')) {
        return await getSubfolderId(productFolderId, 'A2');
    } else if (folderNames.includes('40x40')) {
        return await getSubfolderId(productFolderId, '40x40');
    }

    console.error(`❌ Format folder (A2 or 40x40) not found for: ${productFolderId}`);
    return null;  // Neither found
}

async function listSubfolders(parentFolderId) {
    const res = await drive.files.list({
        q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
        fields: 'files(id, name)'
    });

    return res.data.files || [];
}


async function getSubfolderId(parentFolderId, targetName) {
    const res = await drive.files.list({
        q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
        fields: 'files(id, name)'
    });

    const folders = res.data.files || [];
    
    // Case-insensitive comparison
    const matchingFolder = folders.find(folder => 
        folder.name.trim().toLowerCase() === targetName.trim().toLowerCase()
    );

    return matchingFolder ? matchingFolder.id : null;
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
