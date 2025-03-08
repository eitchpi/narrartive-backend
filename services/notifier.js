import transporter from './emailClient.js';

const failedOrdersToday = new Set();   // New tracker

function isSameDay(timestamp) {
    const now = new Date();
    const date = new Date(timestamp);
    return now.toDateString() === date.toDateString();
}

const dailyErrors = [];

function logDailyError(message) {
    dailyErrors.push(message);
}

// Send a daily summary email with all logged errors (called at midnight)
async function sendDailySummary() {
    if (dailyErrors.length === 0) return;

    const errorReport = dailyErrors.join("\n");
    await sendAdminAlert("📌 Daily Processing Summary", errorReport);
    dailyErrors.length = 0; // Reset errors after sending
}

export { logDailyError, sendDailySummary };


export function resetDailyFailures() {
    failedOrdersToday.clear();  // Clear at midnight to allow fresh alerts
}

export async function sendErrorNotification(orderNumber, message) {
    const recipient = process.env.NOTIFY_EMAIL_RECIPIENT;

    if (!recipient) {
        console.error('❌ Notification failed: NO NOTIFY_EMAIL_RECIPIENT configured.');
        return;
    }

    const cacheKey = `${orderNumber}-${new Date().toISOString().split('T')[0]}`;
    
    if (failedOrdersToday.has(cacheKey)) {
        console.log(`⏸️ Skipping duplicate error notification for Order ${orderNumber} (already notified today)`);
        return;
    }

    failedOrdersToday.add(cacheKey);

    const subject = `⚠️ Order Processing Failed: Order ${orderNumber}`;

    const html = `
        <h3>Order Processing Failed</h3>
        <p><strong>Order Number:</strong> ${orderNumber}</p>
        <p><strong>Details:</strong><br>${message.replaceAll('\n', '<br>')}</p>
        <p>Please check Render logs or Google Drive for further investigation.</p>
    `;

    try {
        await transporter.sendEmail({
            from: 'noreply@narrartive.de',
            to: recipient,
            subject,
            html
        });

        console.log(`📧 Error notification sent for Order ${orderNumber}`);
    } catch (err) {
        console.error(`❌ Failed to send error notification for Order ${orderNumber}:`, err.message);
    }
}
