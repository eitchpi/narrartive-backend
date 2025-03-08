import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

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

import fetch from 'node-fetch';

async function sendEmail(to, subject, link, password, name) {
    console.log(`📧 Attempting to send email to: ${to}`);

    // Ensure environment variables are loaded
    if (!process.env.BREVO_SMTP_KEY || !process.env.SENDER_EMAIL) {
        console.error("❌ Missing Brevo SMTP Key or Sender Email in env variables.");
        return;
    }

    const emailData = {
        sender: { email: process.env.SENDER_EMAIL, name: "narrARTive" },
        to: [{ email: to, name: name }],
        subject: subject,
        htmlContent: `<p>Hello ${name},</p>
                      <p>Your download link is ready: <a href="${link}">${link}</a></p>
                      <p>Password: <b>${password}</b></p>`
    };

    try {
        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'api-key': process.env.BREVO_SMTP_KEY, // ✅ Using SMTP Key (No Changes to Other Files)
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(emailData)
        });

        const result = await response.json();

        if (response.ok) {
            console.log(`✅ 📧 Email sent successfully to ${to}:`, result);
        } else {
            console.error(`❌ Email sending failed for ${to}:`, result);

            // Retry once if failed
            if (response.status === 401) {
                console.log("🔄 Retrying email send...");
                return sendEmail(to, subject, link, password, name);
            }
        }
    } catch (error) {
        console.error(`❌ Email sending error for ${to}:`, error);
    }
}

function deleteLocalFiles(files) {
    files.forEach(file => {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    });
}

export { createZip, uploadFile, sendEmail, deleteLocalFiles };
