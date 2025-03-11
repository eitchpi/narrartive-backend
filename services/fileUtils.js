import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { fileURLToPath } from 'url';
import ArchiverZipEncrypted from 'archiver-zip-encrypted';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Register the encrypted zip format
archiver.registerFormat('zip-encrypted', ArchiverZipEncrypted);

export function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`📁 Created directory: ${dirPath}`);
    }
    return dirPath;
}

export function deleteTempFolder(folderPath) {
    try {
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`✅ Deleted temp folder: ${folderPath}`);
        }
    } catch (error) {
        console.error(`❌ Error deleting temp folder: ${error.message}`);
    }
}

export function ensureTempOrderFolder(orderNumber) {
    const tempOrderFolder = path.resolve(__dirname, 'temp_orders', orderNumber.toString());
    return ensureDirectoryExists(tempOrderFolder);
}

export async function createZipFile(sourceFolder, zipPath, password = null, excludePatterns = []) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        
        // Use encrypted zip if password is provided, otherwise use regular zip
        const archive = password 
            ? archiver.create('zip-encrypted', { 
                zlib: { level: 9 },
                encryptionMethod: 'zip20',
                password: password
              })
            : archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', err => reject(err));

        archive.pipe(output);

        // Add files to the zip while excluding specified patterns
        archive.glob('**/*', {
            cwd: sourceFolder,
            ignore: excludePatterns,
            dot: false // Don't include dotfiles
        });

        archive.finalize();
    });
}

export function writeJsonToFile(filePath, data) {
    ensureDirectoryExists(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function readJsonFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
} 