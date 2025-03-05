import transporter from './emailClient.js';

export async function sendErrorNotification(orderNumber, message) {
    await transporter.sendMail({
        from: 'noreply@narrartive.de',
        to: process.env.NOTIFY_EMAIL_RECIPIENT,  // <-- this is now automatic
        subject: `⚠️ Order Processing Failed: ${orderNumber}`,
        html: `<p>${message.replaceAll('\n', '<br>')}</p>`
    });

    console.log(`📧 Error notification sent for order ${orderNumber}`);
}
