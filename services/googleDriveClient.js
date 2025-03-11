import fs from 'fs';
import path from 'path';
import { google } from 'googleapis'; // ✅ Import Google Drive API
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync'; // ✅ Correct import

// ✅ Define __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export async function listOrderFiles() {
    try {
        console.log("📂 Fetching Etsy order files from Google Drive...");

        const folderId = process.env.ETSY_ORDERS_FOLDER_ID;
        if (!folderId) throw new Error("❌ ERROR: ETSY_ORDERS_FOLDER_ID is missing from .env file!");

        const response = await drive.files.list({
            q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name, createdTime)',
            orderBy: 'createdTime desc'
        });

        const files = response.data.files || [];
        console.log(`✅ Found ${files.length} Etsy order file(s).`);
        return files;
    } catch (error) {
        console.error(`❌ ERROR: Failed to list Etsy order files: ${error.message}`);
        return [];
    }
}

export async function processFile(fileId, fileName) {
    console.log(`📂 Fetching file from Google Drive: ${fileId}`);

    // ✅ Ensure temp_orders/ directory exists
    const tempDir = './temp_orders';
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
        console.log(`📁 Created missing folder: ${tempDir}`);
    }

    const localFilePath = path.join(tempDir, fileName);

    try {
        const response = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'arraybuffer' }
        );

        const fileContent = Buffer.from(response.data);
        fs.writeFileSync(localFilePath, fileContent);
    } catch (error) {
        console.error(`❌ Error saving file ${fileName}: ${error.message}`);
        throw error;
    }

    if (!fs.existsSync(localFilePath)) {
        throw new Error(`❌ File not found after download: ${localFilePath}`);
    }

    return localFilePath;
}

export function parseCSV(filePath) {
    try {
        console.log(`📥 Parsing CSV file: ${filePath}`);

        // ✅ Read file contents
        const fileContent = fs.readFileSync(filePath, 'utf-8');

        // ✅ Parse CSV data into an array of objects
        const records = parse(fileContent, {
            columns: true, // Automatically maps column names to object keys
            skip_empty_lines: true // Ignores empty lines
        });

        return records;
    } catch (error) {
        console.error(`❌ CSV Parsing Error: ${error.message}`);
        throw new Error(`CSV Parsing Failed: ${error.message}`);
    }
}

// Function to download files from Google Drive
async function downloadFileFromDrive(fileId, destinationPath) {
    try {
        console.log(`📥 Downloading file ID: ${fileId} to ${destinationPath}`);
        const drive = google.drive({ version: 'v3', auth });
        const dest = fs.createWriteStream(destinationPath);

        await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' },
            (err, res) => {
                if (err) {
                    console.error(`❌ Error downloading file ID: ${fileId}: ${err.message}`);
                    throw err;
                }

                res.data
                    .on('end', () => {
                        console.log(`✅ Successfully downloaded file ID: ${fileId} to ${destinationPath}`);
                    })
                    .on('error', err => {
                        console.error(`❌ Error downloading file ID: ${fileId}: ${err.message}`);
                        throw err;
                    })
                    .pipe(dest);
            }
        );

        // Wait for the file to be fully written
        await new Promise((resolve, reject) => {
            dest.on('finish', resolve);
            dest.on('error', reject);
        });

        if (!fs.existsSync(destinationPath)) {
            throw new Error(`❌ File not found after download: ${destinationPath}`);
        }
    } catch (error) {
        console.error(`❌ Error downloading file ID: ${fileId} to ${destinationPath}: ${error.message}`);
        throw error;
    }
}

async function getThankYouCardFolderId() {
    try {
        console.log(`🔍 Searching for 'Thank You Card' folder inside Google Drive...`);

        // Ensure we are searching inside the correct parent folder (narrARTive root)
        const rootFolderId = process.env.NARRARTIVE_FOLDER_ID; // Ensure this is set
        if (!rootFolderId) {
            throw new Error(`❌ NARRARTIVE_FOLDER_ID is not defined in environment variables.`);
        }

        // Query to search inside the correct root folder
        const response = await drive.files.list({
            q: `'${rootFolderId}' in parents and name = 'Thank You Card' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)',
        });

        // ✅ Handle response
        if (response.data.files.length > 0) {
            const folderId = response.data.files[0].id;
            console.log(`✅ Found 'Thank You Card' folder with ID: ${folderId}`);
            return folderId;
        } else {
            console.error(`❌ No 'Thank You Card' folder found inside Google Drive.`);
            return null;
        }
    } catch (error) {
        console.error(`❌ Failed to fetch 'Thank You Card' folder: ${error.message}`);
        return null;
    }
}

export { getThankYouCardFolderId , downloadFileFromDrive }; // Export the function
