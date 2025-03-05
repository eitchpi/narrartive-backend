import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

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

// Generates the ZIP password based on Order Number + Email
function generatePassword(order) {
    return `${order['Order Number']}${(order['Buyer Email'] || 'xxxx').slice(-4)}`;
}

export { sendAdminAlert, generatePassword };
