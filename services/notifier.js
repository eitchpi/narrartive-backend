import transporter from './emailClient.js';

export async function sendErrorNotification(orderNumber, message) {
    const recipient = process.env.NOTIFY_EMAIL_RECIPIENT;  // This comes directly from Render environment variables

    if (!recipient) {
        console.error('❌ Notification failed: NO NOTIFY_EMAIL_RECIPIENT configured.');
        return;  // Fail silently if no recipient (but log so we know)
    }

    const subject = `⚠️ Order Processing Failed: Order ${orderNumber}`;

    const html = `
        <h3>Order Processing Failed</h3>
        <p><strong>Order Number:</strong> ${orderNumber}</p>
        <p><strong>Details:</strong><br>${message.replaceAll('\n', '<br>')}</p>
        <p>Please check Render logs or Google Drive for further investigation.</p>
    `;

    try {
        await transporter.sendMail({
            from: 'noreply@narrartive.de',  // Use your existing sender email here
            to: recipient,
            subject,
            html
        });

        console.log(`📧 Error notification sent for Order ${orderNumber}`);
    } catch (err) {
        console.error(`❌ Failed to send error notification for Order ${orderNumber}:`, err.message);
    }
}
