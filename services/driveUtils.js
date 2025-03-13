import fs from "fs";
import path from "path"; // ✅ Also import path for handling file paths
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

// ✅ Ensure Google Auth uses your service account credentials
const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), // ✅ Fix \n issue
    scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

export async function getSubfolderId(parentFolderId, subfolderName) {
    const response = await drive.files.list({
        q: `'${parentFolderId}' in parents and name='${subfolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)'
    });

    return response.data.files.length ? response.data.files[0].id : null;
}

export async function findProductFolder(productName) {
    const rootFolderId = process.env.NARRARTIVE_FOLDER_ID;
    const collections = ["Digital Art", "Bonus Collection"];

    for (const collection of collections) {
        const collectionId = await getSubfolderId(rootFolderId, collection);
        if (!collectionId) continue;

        const productFolderId = await getSubfolderId(collectionId, productName);
        if (productFolderId) return productFolderId;
    }

    return null;
}

export async function findSizeFolder(productFolderId) {
    const sizeFolders = ["40x40", "A2"];
    
    for (const size of sizeFolders) {
        const folderId = await getSubfolderId(productFolderId, size);
        if (folderId) {
            return folderId;
        }
    }

    console.error(`❌ No valid size folder found inside product folder`);
    return null;
}

export async function listFilesInFolder(folderId) {
    try {
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'files(id, name)',
        });

        const files = response.data.files;
        if (!files || files.length === 0) {
            console.log(`❌ No files found in folder ID: ${folderId}`);
            return [];
        }

        return files;
    } catch (error) {
        console.error(`❌ Error listing files in folder ID: ${folderId}: ${error.message}`);
        throw error;
    }
}

export async function downloadFileFromDrive(fileId, destinationPath) {
    try {
        const response = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        // Remove existing file if it exists
        if (fs.existsSync(destinationPath)) {
            fs.unlinkSync(destinationPath);
        }

        const dest = fs.createWriteStream(destinationPath);
        response.data.pipe(dest);

        return new Promise((resolve, reject) => {
            dest.on('finish', () => {
                console.log(`✅ Downloaded file: ${path.basename(destinationPath)}`);
                resolve();
            });
            dest.on('error', reject);
        });
    } catch (error) {
        console.error(`❌ Error downloading file: ${error.message}`);
        throw error;
    }
}

export async function downloadAllFilesInFolder(folderId, destinationFolder) {
    const files = await listFilesInFolder(folderId);
    const downloadedFiles = [];

    for (const file of files) {
        const filePath = path.join(destinationFolder, file.name);
        await downloadFileFromDrive(file.id, filePath);
        downloadedFiles.push(filePath);
    }

    return downloadedFiles;
}

export async function uploadFileToDrive(filePath, parentFolderId) {
    try {
        const response = await drive.files.create({
            requestBody: {
                name: path.basename(filePath),
                parents: [parentFolderId]
            },
            media: {
                mimeType: 'application/octet-stream',
                body: fs.createReadStream(filePath)
            }
        });

        return response.data.id;
    } catch (error) {
        console.error(`❌ Error uploading file: ${error.message}`);
        throw error;
    }
}

export async function moveFileToFolder(fileId, newParentId, oldParentId) {
    try {
        await drive.files.update({
            fileId,
            addParents: newParentId,
            removeParents: oldParentId,
            fields: "id, parents",
        });
        console.log(`✅ Moved file ${fileId} to new folder`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to move file: ${error.message}`);
        return false;
    }
}

export async function getThankYouCardId() {
    const thankYouFolderId = process.env.THANK_YOU_FOLDER_ID;
    console.log(`🔍 Looking for Thank You image in folder: ${thankYouFolderId}`);

    try {
        // First verify the folder exists
        await drive.files.get({
            fileId: thankYouFolderId,
            fields: 'name'
        });

        // Search for Thank You image with strict criteria
        const response = await drive.files.list({
            q: `'${thankYouFolderId}' in parents and name = 'Thank You.png' and mimeType contains 'image/' and trashed = false`,
            orderBy: 'modifiedTime desc',
            fields: 'files(id, name, modifiedTime, trashed)',
            pageSize: 1 // Get only the most recent one
        });

        if (!response.data.files || response.data.files.length === 0) {
            throw new Error('No Thank You image found in the specified folder');
        }

        const thankYouCard = response.data.files[0];

        // Double check the file still exists and isn't trashed
        try {
            const fileCheck = await drive.files.get({
                fileId: thankYouCard.id,
                fields: 'trashed'
            });
            
            if (fileCheck.data.trashed) {
                throw new Error('Most recent Thank You image is in trash');
            }
        } catch (error) {
            throw new Error(`Failed to verify Thank You image: ${error.message}`);
        }

        console.log(`✅ Found Thank You image: ${thankYouCard.name}`);
        return thankYouCard.id;
    } catch (error) {
        console.error(`❌ Error finding Thank You image: ${error.message}`);
        throw error;
    }
}

