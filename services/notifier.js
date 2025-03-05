import transporter from './emailClient.js';

export async function sendErrorNotification(orderId, errorMessage) {
    const subject = `⚠️ narrARTive Automation - Order Processing Failed (Order ${orderId})`;

    const html = `
        <h3>Order Processing Failed</h3>
        <p><strong>Order ID:</strong> ${orderId}</p>
        <p><strong>Reason:</strong> ${errorMessage}</p>
        <p>Please check the logs or Google Drive folder for further investigation.</p>
    `;

    await transporter.sendMail({
        from: 'noreply@narrartive.de',
        to: process.env.NOTIFY_EMAIL_RECIPIENT,
        subject,
        html
    });

    console.log(`📧 Error notification sent for order ${orderId}`);
}
