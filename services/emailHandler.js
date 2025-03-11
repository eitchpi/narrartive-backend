import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['SMTP_HOST', 'SMTP_PORT', 'BREVO_USER', 'BREVO_SMTP_KEY', 'BREVO_SENDER'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`❌ Missing required environment variable: ${envVar}`);
    }
}

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: true,
    auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_SMTP_KEY,
    },
});

/**
 * ✅ Sends an email
 * @param {Object} options - Email options (to, subject, html)
 */
export async function sendEmail({ to, subject, html }) {
    let emailSent = false;
    const maxRetries = 3;

    // Create a masked version of the email for logging
    const maskedEmail = to === process.env.ADMIN_EMAIL ? 'Admin' : 'Customer';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`📧 Attempt ${attempt}: Sending email to ${maskedEmail}...`);
            
            await transporter.sendMail({
                from: process.env.BREVO_SENDER,
                to,
                subject,
                html,
            });
    
            console.log(`✅ Email successfully sent to ${maskedEmail}`);
            emailSent = true;
            break;
        } catch (error) {
            console.error(`❌ Email sending failed (Attempt ${attempt}):`, error.message);
            if (attempt === maxRetries) {
                console.error(`🚨 Final email attempt failed. Giving up.`);
                throw new Error(`Failed to send email after ${maxRetries} attempts: ${error.message}`);
            }
            // Wait 1 second before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// ✅ Export transporter for notifier.js
export default transporter;
