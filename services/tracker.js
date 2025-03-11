import fs from "fs";
import { google } from "googleapis";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import { parse as csvParse } from 'csv-parse';
import nodemailer from 'nodemailer';
import archiver from 'archiver';
import { promisify } from 'util';
import { sendEmail } from './emailHandler.js';
import { downloadAllFilesInFolder, findProductFolder, findSizeFolder, downloadFileFromDrive, uploadFileToDrive, moveFileToFolder } from './driveUtils.js';
import { processAllOrders } from './orders.js';
import { readJsonFromFile, writeJsonToFile, ensureDirectoryExists, deleteTempFolder } from './fileUtils.js';

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const TRACKER_FILE = "./data/processed_tracker.json";
const FAILED_ORDERS_FILE = "./data/failed_orders.json";
const TRACKER_FOLDER_ID = process.env.TRACKER_FOLDER_ID;
const FAILED_ORDERS_TRACKER = process.env.FAILED_ORDERS_TRACKER;
const PRODUCTS_FOLDER_ID = process.env.NARRARTIVE_FOLDER_ID;
const EMAIL_USER = process.env.BREVO_USER;
const EMAIL_PASS = process.env.BREVO_SMTP_KEY;
const EMAIL_HOST = process.env.SMTP_HOST;
const EMAIL_PORT = process.env.SMTP_PORT;

// ✅ Google Drive Authentication
const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? 
        process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n') : 
        undefined,
    scopes: ["https://www.googleapis.com/auth/drive"],
});

// Verify auth configuration
if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    console.error("⚠️ Missing Google Drive credentials in environment variables");
}

const drive = google.drive({ version: "v3", auth });

const FAILED_ORDERS_TRACKER_ID = process.env.FAILED_ORDERS_TRACKER;

export async function readJsonFromDrive(fileId) {
    if (!fileId) {
        console.error("❌ No file ID provided for Google Drive operation");
        return {};
    }

    try {
        // First get the file metadata to check its type
        const metadata = await drive.files.get({
            fileId,
            fields: 'mimeType'
        });

        let content;
        if (metadata.data.mimeType === 'application/vnd.google-apps.document') {
            // If it's a Google Doc, export it as plain text
            const response = await drive.files.export({
                fileId,
                mimeType: 'text/plain'
            });
            content = response.data;
        } else if (metadata.data.mimeType === 'application/json' || metadata.data.mimeType === 'text/plain') {
            // For JSON or text files, download directly
            const response = await drive.files.get({
                fileId,
                alt: 'media'
            });
            content = response.data;
        } else {
            console.error(`❌ Unsupported file type: ${metadata.data.mimeType}`);
            return {};
        }

        // Handle both string and object responses
        if (typeof content === 'string') {
            try {
                return JSON.parse(content);
            } catch (e) {
                console.error('❌ Failed to parse JSON content:', e.message);
                return {};
            }
        } else if (typeof content === 'object') {
            return content;
        }

        console.error('❌ Invalid JSON data format from Google Drive');
        return {};
    } catch (error) {
        console.error(`❌ Failed to read JSON from Google Drive: ${error.message}`);
        return {}; // Return an empty object to prevent crashes
    }
}

/** ===============================
 * ✅ Load Processed Orders Tracker
 * =============================== */
export async function loadTracker() {
    try {
        // Ensure data directory exists
        if (!fs.existsSync("./data")) {
            fs.mkdirSync("./data", { recursive: true });
            console.log("📁 Created directory: ./data");
        }

        // Try to read from local file first
        let data = readJsonFromFile(TRACKER_FILE);
        if (data) {
            console.log("✅ Loaded tracker from local file");
            return convertToNewFormat(data);
        }

        // If not found locally, try Google Drive with better error handling
        try {
            console.log("🔄 Attempting to load tracker from Google Drive...");
            data = await readJsonFromDrive(process.env.TRACKER_FOLDER_ID);
            if (data && Object.keys(data).length > 0) {
                console.log("✅ Loaded tracker from Google Drive");
                writeJsonToFile(TRACKER_FILE, data);
                return convertToNewFormat(data);
            }
        } catch (driveError) {
            console.error("⚠️ Failed to load from Google Drive:", driveError.message);
        }

        // If no tracker exists or failed to load, create a new one
        console.log("📝 Creating new tracker...");
        const emptyTracker = {
            processedOrders: {}
        };
        writeJsonToFile(TRACKER_FILE, emptyTracker);
        return emptyTracker;
    } catch (error) {
        console.error("❌ Failed to load tracker:", error);
        return { processedOrders: {} };
    }
}

/** ================================
 * ✅ Save Processed Orders Tracker
 * ================================ */
export async function saveTracker(tracker) {
    try {
        // Delete any existing file before saving
        if (fs.existsSync(TRACKER_FILE)) {
            fs.unlinkSync(TRACKER_FILE);
        }
        
        // Write new file
        writeJsonToFile(TRACKER_FILE, tracker);
        
        // Check for existing tracker files in Drive
        const response = await drive.files.list({
            q: `name = 'processed_tracker.json' and '${TRACKER_FOLDER_ID}' in parents and trashed=false`,
            fields: 'files(id)'
        });

        // Delete any existing tracker files
        for (const file of response.data.files) {
            await drive.files.delete({ fileId: file.id });
        }

        // Upload the new tracker file
        await uploadFileToDrive(TRACKER_FILE, TRACKER_FOLDER_ID);
        console.log("✅ Tracker updated");
    } catch (error) {
        console.error("❌ Failed to save tracker:", error);
    }
}

/** ===============================
 * ✅ Load Failed Orders Tracker
 * =============================== */
export async function loadFailedOrdersTracker() {
    try {
        // Ensure data directory exists
        if (!fs.existsSync("./data")) {
            fs.mkdirSync("./data", { recursive: true });
            console.log("📁 Created directory: ./data");
        }

        // Try to read from local file first
        let data = readJsonFromFile(FAILED_ORDERS_FILE);
        if (data) {
            console.log("✅ Loaded failed orders tracker from local file");
            return data;
        }

        // If not found locally, try Google Drive with better error handling
        try {
            console.log("🔄 Attempting to load failed orders tracker from Google Drive...");
            data = await readJsonFromDrive(process.env.FAILED_ORDERS_TRACKER);
            if (data && Object.keys(data).length > 0) {
                console.log("✅ Loaded failed orders tracker from Google Drive");
                writeJsonToFile(FAILED_ORDERS_FILE, data);
                return data;
            }
        } catch (driveError) {
            console.error("⚠️ Failed to load from Google Drive:", driveError.message);
        }

        // If no tracker exists or failed to load, create a new one
        console.log("📝 Creating new failed orders tracker...");
        const emptyTracker = { skippedFiles: {} };
        writeJsonToFile(FAILED_ORDERS_FILE, emptyTracker);
        return emptyTracker;
    } catch (error) {
        console.error("❌ Failed to load failed orders tracker:", error);
        return { skippedFiles: {} };
    }
}

/** ================================
 * ✅ Save Failed Orders Tracker
 * ================================ */
export async function saveFailedOrdersTracker(tracker) {
    try {
        // Delete any existing file before saving
        if (fs.existsSync(FAILED_ORDERS_FILE)) {
            fs.unlinkSync(FAILED_ORDERS_FILE);
        }
        
        // Write new file
        writeJsonToFile(FAILED_ORDERS_FILE, tracker);
        
        // Upload to Drive, replacing any existing file
        const existingFiles = await drive.files.list({
            q: `'${process.env.FAILED_ORDERS_TRACKER}' in parents and name='failed_orders.json' and trashed=false`,
            fields: 'files(id)'
        });
        
        // Delete existing files in Drive
        for (const file of existingFiles.data.files) {
            await drive.files.delete({ fileId: file.id });
        }
        
        // Upload new file
        await uploadFileToDrive(FAILED_ORDERS_FILE, process.env.FAILED_ORDERS_TRACKER);
        console.log("✅ Tracker updated");
    } catch (error) {
        console.error("❌ Failed to save tracker:", error);
    }
}

/** ==========================================
 * ✅ Process Etsy Order CSV File
 * ========================================== */
export async function processEtsyOrderFile(fileId, fileName) {
    console.log(`📄 Processing Etsy order file: ${fileName}`);
    
    try {
        // Load tracker
        const tracker = await loadTracker();
        const baseFileName = fileName.replace(/_fix\d*\.csv$/, '.csv');
        const isFixAttempt = fileName.includes('_fix');

        // Check if already processed (unless it's a fix attempt)
        if (!isFixAttempt && tracker.processedOrders[baseFileName]) {
            console.log(`⚠️ File ${baseFileName} has already been processed. Use _fix suffix to reprocess.`);
            return;
        }

        // Process the file using the consolidated approach
        await processAllOrders();
        
        console.log(`✅ Completed processing file: ${fileName}`);
    } catch (error) {
        console.error(`❌ Failed to process file ${fileName}:`, error.message);
        throw error;
    }
}

// Helper function to convert old tracker format to new format
function convertToNewFormat(data) {
    if (Array.isArray(data.processedFiles) || Array.isArray(data.processedOrders)) {
        return {
            processedOrders: {}  // New format: { "filename.csv": ["order1", "order2"] }
        };
    }
    return data;
}

// Helper function to download and parse CSV file
async function downloadAndParseCSV(fileId, filePath) {
    try {
        await downloadFileFromDrive(fileId, filePath);
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        
        return new Promise((resolve, reject) => {
            const results = [];
            const parser = csvParse({ 
                columns: true,
                skip_empty_lines: true,
                trim: true
            });
            
            parser.on('readable', function() {
                let record;
                while ((record = parser.read()) !== null) {
                    results.push(record);
                }
            });

            parser.on('error', reject);
            parser.on('end', () => resolve(results));

            parser.write(fileContent);
            parser.end();
        });
    } catch (error) {
        console.error('❌ Error downloading or parsing CSV:', error);
        throw error;
    }
}

// Add the getSubfolderId helper function
async function getSubfolderId(parentFolderId, subfolderName) {
    const response = await drive.files.list({
        q: `'${parentFolderId}' in parents and name='${subfolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)'
    });

    return response.data.files.length ? response.data.files[0].id : null;
}

async function downloadProductFiles(productName, tempFolder) {
    try {
        // Extract the folder name (everything before the first dash)
        const folderName = productName.split('-')[0].trim();
        console.log(`🔍 Searching for folder: "${folderName}"`);

        // Use the existing findProductFolder function
        const productFolderId = await findProductFolder(folderName);
        if (!productFolderId) {
            throw new Error(`Product folder not found for: ${folderName}. Please check the folder name in Google Drive.`);
        }

        // Use the existing findSizeFolder function
        const sizeFolderId = await findSizeFolder(productFolderId);
        if (!sizeFolderId) {
            throw new Error(`Size folder not found inside product folder: ${folderName}`);
        }

        console.log(`📂 Found product folder: ${folderName} (${productFolderId})`);
        
        // Use the existing downloadAllFilesInFolder function
        const downloadedFiles = await downloadAllFilesInFolder(sizeFolderId, tempFolder);
        
        if (downloadedFiles.length === 0) {
            throw new Error(`No files downloaded for product: ${folderName}`);
        }

        return tempFolder;
    } catch (error) {
        console.error(`❌ Error downloading product files: ${error.message}`);
        throw error;
    }
}

async function createZipFile(sourceFolder, zipPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', err => reject(err));

        archive.pipe(output);
        archive.directory(sourceFolder, false);
        archive.finalize();
    });
}

async function sendOrderEmail(buyerEmail, buyerName, productName, zipFilePath) {
    const emailTemplate = `
        <h1>Thank you for your purchase!</h1>
        <p>Dear ${buyerName},</p>
        <p>Thank you for purchasing ${productName}. Your files are attached to this email.</p>
        <p>If you have any questions, please don't hesitate to contact us.</p>
        <p>Best regards,<br>narrARTive Team</p>
    `;

    await sendEmail({
        to: buyerEmail,
        subject: `Your narrARTive Purchase: ${productName}`,
        html: emailTemplate,
        attachments: [{
            filename: path.basename(zipFilePath),
            path: zipFilePath
        }]
    });
}