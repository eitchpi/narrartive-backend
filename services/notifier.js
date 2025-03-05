import transporter from './emailClient.js';

export async function sendErrorNotification(orderNumber, message) {
    const recipient = process.env.NOTIFY_EMAIL_RECIPIENT;

    if (!recipient) {
        console.error('❌ Notification failed: NO NOTIFY_EMAIL_RECIPIENT configured.');
        return;
    }

    console.log(`📧 Debug: Sending error notification for Order ${orderNumber} to ${recipient}`);

    const subject = `⚠️ Order Processing Failed: Order ${orderNumber}`;

    const html = `
        <h3>Order Processing Failed</h3>
        <p><strong>Order Number:</strong> ${orderNumber}</p>
        <p><strong>Details:</strong><br>${message.replaceAll('\n', '<br>')}</p>
        <p>Please check Render logs or Google Drive for further investigation.</p>
    `;

    try {
        await transporter.sendMail({
            from: 'noreply@narrartive.de',
            to: recipient,  // <- Log confirms this
            subject,
            html
        });

        console.log(`✅ Email successfully sent to ${recipient}`);
    } catch (err) {
        console.error(`❌ Failed to send error notification for Order ${orderNumber}:`, err.message);
    }
}
