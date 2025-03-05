import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import csvParser from 'csv-parser';
import { loadTracker, saveTracker } from './tracker.js';
import { createZip, uploadFile, sendEmail, deleteLocalFiles } from './fileHandler.js';

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

async function loadLatestEtsyOrder() {
    const folderId = process.env.ETSY_ORDERS_FOLDER_ID;
    const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'files(id, name, mimeType)',
        orderBy: 'createdTime desc',
        pageSize: 1
    });

    if (res.data.files.length === 0) return null;
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

async function processAllOrders() {
    const latestOrderFile = await loadLatestEtsyOrder();
    if (!latestOrderFile) {
        console.log('📭 No new Etsy orders found — checking again in 5 minutes...');
        return;
    }

    const { fileId, fileName, orders } = latestOrderFile;
    const tracker = await loadTracker();
    tracker[fileName] ??= [];

    const groupedOrders = orders.reduce((map, order) => {
        map[order['Order Number']] ??= [];
        map[order['Order Number']].push(order);
        return map;
    }, {});

    for (const [orderNumber, orderItems] of Object.entries(groupedOrders)) {
        if (tracker[fileName].includes(orderNumber)) continue;

        try {
            await processSingleOrder(orderNumber, orderItems);
            tracker[fileName].push(orderNumber);
            await saveTracker(tracker);
        } catch (err) {
            console.error(`❌ Failed to process order ${orderNumber}:`, err);
            await sendAdminAlert(`🚨 Order Processing Failed: ${orderNumber}`, `Error: ${err.message}\nStack: ${err.stack}`);
        }
    }

    if (tracker[fileName].length === Object.keys(groupedOrders).length) {
        await moveFileToProcessed(fileId);
    }
}

async function processSingleOrder(orderNumber, orderItems) {
    const tempFolder = `./temp_${orderNumber}`;
    fs.mkdirSync(tempFolder, { recursive: true });

    const products = await loadProductList();
    const narrARTiveFolderId = process.env.NARRARTIVE_FOLDER_ID;
    const thankYouFolderId = await getSubfolderId(narrARTiveFolderId, 'Thank You Card');

    for (const order of orderItems) {
        const product = products.find(p => p['Product Name'].trim() === order['Product Name'].trim());
        if (!product) throw new Error(`Product not found in list: ${order['Product Name']}`);

        const collectionId = await getSubfolderId(narrARTiveFolderId, product['Collection']);
        const productFolderId = await getSubfolderId(collectionId, order['Product Name'].trim());
        const sizeFolderId = await getSubfolderId(productFolderId, order['Size'].trim());

        await downloadAllFilesInFolder(sizeFolderId, tempFolder);
    }

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
    fs.rmdirSync(tempFolder);
}

async function loadProductList() {
    const folderId = process.env.DOCUMENTS_FOLDER_ID;
    const res = await drive.files.list({
        q: `name contains 'Product_List' and '${folderId}' in parents`,
        fields: 'files(id)',
        orderBy: 'createdTime desc',
        pageSize: 1
    });

    const productList = [];
    const fileStream = await drive.files.export({
        fileId: res.data.files[0].id,
        mimeType: 'text/csv'
    }, { responseType: 'stream' });

    await parseCsvStream(fileStream.data, productList);
    return productList;
}

async function getSubfolderId(parentFolderId, subfolderName) {
    const res = await drive.files.list({
        q: `name='${subfolderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
        fields: 'files(id)'
    });
    if (res.data.files.length === 0) throw new Error(`Missing folder: ${subfolderName}`);
    return res.data.files[0].id;
}

async function downloadAllFilesInFolder(folderId, destFolder) {
    const res = await drive.files.list({ q: `'${folderId}' in parents`, fields: 'files(id, name)' });
    for (const file of res.data.files) {
        const filePath = path.join(destFolder, file.name);
        const dest = fs.createWriteStream(filePath);
        const fileStream = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
        await new Promise((resolve, reject) => fileStream.data.pipe(dest).on('finish', resolve).on('error', reject));
    }
}

async function moveFileToProcessed(fileId) {
    await drive.files.update({
        fileId,
        addParents: process.env.PROCESSED_ORDERS_FOLDER_ID,
        removeParents: process.env.ETSY_ORDERS_FOLDER_ID,
        fields: 'id, parents'
    });
}

function generatePassword(order) {
    return `${order['Order Number']}${(order['Buyer Email'] || 'xxxx').slice(-4)}`;
}

async function sendAdminAlert(subject, message) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: true,
        auth: {
            user: process.env.BREVO_USER,
            pass: process.env.BREVO_SMTP_KEY
        }
    });

    await transporter.sendMail({
        from: 'noreply@narrartive.de',
        to: process.env.ADMIN_EMAIL,
        subject,
        text: message
    });
}

export { processAllOrders };
