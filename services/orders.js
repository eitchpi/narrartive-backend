import fs from "fs";
import path from "path";
import { loadTracker, saveTracker, processEtsyOrderFile, loadFailedOrdersTracker, saveFailedOrdersTracker } from "./tracker.js";
import { 
    downloadAllFilesInFolder, 
    findProductFolder, 
    findSizeFolder, 
    downloadFileFromDrive, 
    uploadFileToDrive, 
    getThankYouCardId,
    getSubfolderId,
    listFilesInFolder,
    moveFileToFolder
} from "./driveUtils.js";
import { sendEmail } from "./emailHandler.js";
import { sendDailySummary } from "./notifier.js";
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import { ensureTempOrderFolder, createZipFile, deleteTempFolder, readJsonFromFile, writeJsonToFile } from "./fileUtils.js";
import { google } from 'googleapis';
import { parse } from 'csv-parse/sync';

dotenv.config();

// ✅ Define __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({ version: 'v3', auth });

const COMPLETED_ORDERS_FOLDER_ID = process.env.COMPLETED_ORDERS_FOLDER_ID;
const ROOT_COLLECTION_ID = process.env.NARRARTIVE_FOLDER_ID;
const THANK_YOU_FOLDER_ID = process.env.THANK_YOU_FOLDER_ID;

// Function to track skipped files in failed orders tracker
async function trackSkippedFile(fileName, orderNumber) {
    console.log(`🔄 Starting to track skipped file: ${fileName}`);
    const failedOrders = await loadFailedOrdersTracker();
    
    if (!failedOrders.skippedFiles) {
        failedOrders.skippedFiles = {};
    }
    
    // Early return if file is already tracked
    if (failedOrders.skippedFiles[fileName]) {
        console.log(`ℹ️ File ${fileName} is already tracked - no notification needed`);
        return;
    }

    const now = new Date();
    
    // Add new file to tracker
    console.log(`📝 Adding ${fileName} to failed orders tracker...`);
    failedOrders.skippedFiles[fileName] = {
        orderNumber,
        dateSkipped: now.toISOString(),
        lastNotified: now.toISOString(), // Set initial notification time
        reason: 'Already processed, needs _fix suffix'
    };

    // Send immediate email alert
    try {
        console.log(`📧 Preparing to send alert email for ${fileName}...`);
        const emailContent = `
            <h1>⚠️ Order File Requires Attention</h1>
            <p>A file has been skipped and requires manual intervention:</p>
            <ul>
                <li><strong>File:</strong> ${fileName}</li>
                <li><strong>Order Number:</strong> ${orderNumber}</li>
                <li><strong>Time:</strong> ${now.toLocaleString()}</li>
                <li><strong>Reason:</strong> File has already been processed</li>
            </ul>
            <p><strong>Required Action:</strong> Please process this file with the _fix suffix to handle any necessary corrections.</p>
            <p>For example, rename the file to: ${fileName.replace('.csv', '_fix.csv')}</p>
        `;

        await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: `🚨 Immediate Alert: Order File ${fileName} Needs Attention`,
            html: emailContent
        });
        
        // Save to tracker after successful email
        await saveFailedOrdersTracker(failedOrders);
        console.log(`✅ Alert email sent to Admin`);
    } catch (error) {
        console.error(`❌ Error sending alert email: ${error.message}`);
        throw error;
    }
}

// Function to list all order files in the Etsy Orders folder
async function listOrderFiles() {
    const folderId = process.env.ETSY_ORDERS_FOLDER_ID;
    if (!folderId) {
        throw new Error("❌ ETSY_ORDERS_FOLDER_ID is not defined");
    }

    const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false and mimeType='text/csv'`,
        fields: 'files(id, name)',
    });

    return response.data.files;
}

// Function to download and parse CSV file
async function processFile(fileId, fileName) {
    const tempFolder = ensureTempOrderFolder('csv_temp');
    const filePath = path.join(tempFolder, fileName);
    
    try {
        await downloadFileFromDrive(fileId, filePath);
        return filePath;
    } catch (error) {
        console.error(`❌ Error downloading CSV file: ${error.message}`);
        throw error;
    }
}

// Parse CSV content
function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });
}

// Process new orders only
async function processNewOrders() {
    console.log("🚀 Processing new orders...");
    
    try {
        // Simply call processAllOrders since it now handles consolidation
        // and checks for already processed files
        await processAllOrders();
    } catch (error) {
        console.error(`❌ Error processing new orders: ${error.message}`);
        throw error;
    }
}

// Helper function to generate zip password
function generateZipPassword(orderNumber, email) {
    // Get last 6 characters of email (excluding potential whitespace)
    const emailSuffix = email.trim().slice(-6);
    // Combine order number and email suffix
    return `${orderNumber}${emailSuffix}`;
}

// Process all orders with complete workflow
async function processAllOrders() {
    console.log('🚀 Processing all orders...');

    try {
        const orderFiles = await listOrderFiles();

        if (!orderFiles || orderFiles.length === 0) {
            console.log('📭 No Etsy order files found.');
            return;
        }

        // Group orders by order number
        const orderGroups = new Map();

        for (const { id: fileId, name: fileName } of orderFiles) {
            console.log(`🔍 Processing file: ${fileName} (File ID: ${fileId})`);

            try {
                // Check if file has already been processed
                const tracker = await loadTracker();
                if (!tracker.processedOrders) {
                    tracker.processedOrders = {};
                }
                
                const baseFileName = fileName.replace(/_fix\d*\.csv$/, '.csv');
                const isFixAttempt = fileName.includes('_fix');
                
                if (!isFixAttempt && tracker.processedOrders[baseFileName]) {
                    console.log(`⚠️ File ${baseFileName} has already been processed. Use _fix suffix to reprocess.`);
                    await trackSkippedFile(baseFileName, tracker.processedOrders[baseFileName][0] || 'Unknown');
                    continue;
                }

                // Download and parse file
                const localFilePath = await processFile(fileId, fileName);
                const parsedOrders = parseCSV(localFilePath);

                if (!parsedOrders || parsedOrders.length === 0) {
                    console.error(`❌ No valid orders found in ${fileName}`);
                    continue;
                }

                // Group orders by order number
                for (const order of parsedOrders) {
                    const orderNumber = order["Order Number"];
                    if (!orderGroups.has(orderNumber)) {
                        orderGroups.set(orderNumber, {
                            orders: [],
                            files: new Set(),
                            buyerEmail: order["Buyer Email"],
                            buyerName: order["Buyer Name"]
                        });
                    }
                    orderGroups.get(orderNumber).orders.push(order);
                    orderGroups.get(orderNumber).files.add(fileName);
                }

            } catch (err) {
                console.error(`❌ Error processing file ${fileName}: ${err.message}`);
            }
        }

        // Process each group of orders
        for (const [orderNumber, orderGroup] of orderGroups.entries()) {
            console.log(`🛠️ Processing consolidated order: ${orderNumber}`);
            const tempOrderFolder = await ensureTempOrderFolder(orderNumber);
            const csvTempFolder = ensureTempOrderFolder('csv_temp');
            
            try {
                let allProductsSucceeded = true;

                // Process each product in the order
                for (const order of orderGroup.orders) {
                    try {
                        const success = await processOrderProduct(order, tempOrderFolder);
                        if (!success) {
                            allProductsSucceeded = false;
                        }
                    } catch (err) {
                        console.error(`❌ Processing failed for product in order ${orderNumber}: ${err.message}`);
                        allProductsSucceeded = false;
                    }
                }

                if (allProductsSucceeded) {
                    // Create zip file with password protection
                    const zipPath = path.join(tempOrderFolder, `Order_${orderNumber}.zip`);
                    const zipPassword = generateZipPassword(orderNumber, orderGroup.buyerEmail);
                    await createZipFile(tempOrderFolder, zipPath, zipPassword, ['Order_*.zip', '.DS_Store']);

                    // Upload zip to Google Drive first
                    const zipFileId = await uploadFileToDrive(zipPath, process.env.COMPLETED_ORDERS_FOLDER_ID);
                    if (!zipFileId) {
                        throw new Error('❌ Failed to upload ZIP file to Drive');
                    }

                    // Send email with download link
                    const emailTemplate = `
                        <h1>Thank you for your purchase!</h1>
                        <p>Dear ${orderGroup.buyerName},</p>
                        <p>Thank you for purchasing from narrARTive. Your files are ready for download:</p>
                        
                        <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
                            <h2>📥 Download Your Files</h2>
                            <p><a href="https://drive.google.com/file/d/${zipFileId}/view?usp=sharing" style="display: inline-block; background-color: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 10px 0;">Download ZIP File</a></p>
                            
                            <p style="margin-top: 15px;"><strong>Password:</strong> ${zipPassword}</p>
                            
                            <p style="color: #e65100; margin-top: 15px;">
                                ⚠️ Important: This download link will expire in 24 hours
                            </p>
                        </div>

                        <p>Best regards,<br>narrARTive Team</p>

                        <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;">
                        <p style="font-size: 12px; color: #666; margin-top: 20px;">
                            Having trouble or questions? Contact us at: info@narrartive.de
                        </p>
                    `;

                    await sendEmail({
                        to: orderGroup.buyerEmail,
                        subject: `Your narrARTive Purchase: Order #${orderNumber}`,
                        html: emailTemplate
                    });

                    // Update tracker for all files in this order
                    const tracker = await loadTracker();
                    for (const fileName of orderGroup.files) {
                        // For fix files, we need to track all orders in the file
                        const baseFileName = fileName.replace(/_fix\d*\.csv$/, '.csv');
                        const isFixAttempt = fileName.includes('_fix');
                        
                        if (isFixAttempt) {
                            // For fix files, get all orders from the original file
                            const originalOrders = tracker.processedOrders[baseFileName] || [];
                            tracker.processedOrders[fileName] = [...new Set([...originalOrders, orderNumber])];
                        } else {
                            // For regular files, just track this order
                            tracker.processedOrders[fileName] = tracker.processedOrders[fileName] || [];
                            if (!tracker.processedOrders[fileName].includes(orderNumber)) {
                                tracker.processedOrders[fileName].push(orderNumber);
                            }
                        }
                    }
                    await saveTracker(tracker);

                    // Move processed files
                    for (const fileName of orderGroup.files) {
                        const file = orderFiles.find(f => f.name === fileName);
                        if (file) {
                            await moveFileToFolder(
                                file.id,
                                process.env.PROCESSED_ORDERS_FOLDER_ID,
                                process.env.ETSY_ORDERS_FOLDER_ID
                            );
                        }
                    }
                    console.log(`✅ Processed consolidated order ${orderNumber}`);
                }

            } catch (err) {
                console.error(`❌ Error processing consolidated order ${orderNumber}: ${err.message}`);
            } finally {
                // Cleanup all temp folders
                deleteTempFolder(tempOrderFolder);
                deleteTempFolder(csvTempFolder);
                deleteTempFolder(path.join(__dirname, 'temp_orders'));
            }
        }

        console.log('✅ Order processing completed.');
    } catch (error) {
        console.error('❌ Critical error in order processing:', error.message);
    }
}

// Function to sanitize product name to match folder structure
function extractCoreProductName(fullName) {
    if (fullName && typeof fullName === 'string') {
        const dashIndex = fullName.indexOf(' - ');
        if (dashIndex !== -1) {
            return fullName.slice(0, dashIndex); // Return name before the first hyphen
        } else {
            return fullName; // Return full name if no hyphen exists
        }
    } else {
        throw new Error(`Invalid product name: ${fullName}`);
    }
}

// Process a single product within an order
async function processOrderProduct(orderData, tempOrderFolder) {
    try {
        let productName = extractCoreProductName(orderData['Product Name']);

        // Find product folder and size folder
        const productFolderId = await findProductFolder(productName);
        if (!productFolderId) {
            throw new Error(`❌ Product folder not found for "${productName}"`);
        }

        const sizeFolderId = await findSizeFolder(productFolderId);
        if (!sizeFolderId) {
            throw new Error(`❌ Size folder not found inside ${productName}`);
        }

        // Download product files
        const downloadedFiles = await downloadAllFilesInFolder(sizeFolderId, tempOrderFolder);
        if (downloadedFiles.length === 0) {
            throw new Error(`❌ No files downloaded for product: ${productName}`);
        }

        // Download thank you card (only if not already in the folder)
        const thankYouPath = path.join(tempOrderFolder, 'Thank_You_Card.png');
        if (!fs.existsSync(thankYouPath)) {
            const thankYouCardId = await getThankYouCardId();
            await downloadFileFromDrive(thankYouCardId, thankYouPath);
        }

        return true;
    } catch (error) {
        console.error(`❌ Error processing product: ${error.message}`);
        return false;
    }
}

function logError(orderData, errorMessage) {
    const logFilePath = path.resolve(__dirname, 'errorLogs.txt');

    const errorLog = `
        Order Number: ${orderData['Order Number']}
        Product Name: ${orderData['Product Name']}
        Error Message: ${errorMessage}
        Timestamp: ${new Date().toISOString()}
    `;

    fs.appendFileSync(logFilePath, errorLog, 'utf8');
    console.log(`❌ Error logged for order ${orderData['Order Number']} in errorLogs.txt`);
}

export { processNewOrders, processAllOrders };
