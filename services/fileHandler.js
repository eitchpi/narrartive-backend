import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import fetch from 'node-fetch';


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

function createZip(output, files, password) {
    return new Promise((resolve, reject) => {
        exec(`zip -P "${password}" "${output}" ${files.map(f => `"${f}"`).join(' ')}`, (err) => {
            if (err) reject(err);
            else resolve(output);
        });
    });
}

async function uploadFile(filePath) {
    const fileMetadata = {
        name: path.basename(filePath),
        parents: [process.env.COMPLETED_ORDERS_FOLDER_ID]
    };

    const media = {
        mimeType: 'application/zip',
        body: fs.createReadStream(filePath)
    };

    const file = await drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id'
    });

    return file.data.id;
}

async function sendEmail(to, subject, link, password, name) {
    console.log(`📧 Attempting to send email to client`);

    if (!process.env.BREVO_API_KEY || !process.env.SENDER_EMAIL) {
        console.error("❌ Missing Brevo API Key or Sender Email in env variables.");
        return;
    }

    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': process.env.BREVO_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sender: { email: process.env.SENDER_EMAIL, name: "narrARTive" },
                to: [{ email: to, name: name }],
                subject: subject,
                htmlContent: `
                    <p><strong>Hi ${name}, Your Artwork is Ready! 🎨</strong></p>

                    <p><strong>Download Link:</strong> 
                        <a href="${link}" target="_blank" style="color: #007BFF;">Click Here</a>
                    </p>

                    <p><strong>Password:</strong> ${password}</p>

                    <p>⚠️ <strong>Please download your files within 24 hours</strong> — the link will expire after that.</p>

                    <p><em>This email was automatically generated. If you have any questions, contact us at 
                        <a href="mailto:info@narrartive.de">info@narrartive.de</a>.</em>
                    </p>
                `
            })
        });

        const result = await response.json();

        if (response.ok) {
            console.log(`✅ 📧 Email sent successfully to client!`);
        } else {
            console.error(`❌ Email sending failed for client`, result);
        }
    } catch (error) {
        console.error(`❌ Email sending error for client`, error);
    }
}

function deleteLocalFiles(files) {
    files.forEach(file => {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });
}

async function moveFileToProcessed(fileId) {
    const processedFolderId = process.env.PROCESSED_ORDERS_FOLDER_ID;
    
    if (!processedFolderId) {
        console.error("❌ Missing 'Processed Orders' folder ID.");
        return;
    }

    try {
        await drive.files.update({
            fileId,
            addParents: processedFolderId,
            removeParents: process.env.ETSY_ORDERS_FOLDER_ID,
            fields: "id, parents",
        });

        console.log(`✅ Moved file ${fileId} to Processed Orders.`);
    } catch (err) {
        console.error(`❌ Failed to move file ${fileId} to Processed Orders:`, err);
        logDailyError(`❌ Failed to move file ${fileId}: ${err.message}`);
    }
}


export { createZip, uploadFile, sendEmail, deleteLocalFiles, moveFileToProcessed };
