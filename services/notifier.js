import transporter, { sendEmail } from "./emailHandler.js";
import { loadFailedOrdersTracker, saveFailedOrdersTracker } from "./tracker.js";
import fs from "fs";

const failedOrdersToday = new Set(); // In-memory tracker for duplicate prevention

// ✅ Logs a failed order once per day
export async function logDailyError(orderNumber, errorMessage) {
    const failedOrders = await loadFailedOrdersTracker();

    // Prevent duplicate logging
    if (failedOrders[orderNumber]) return;

    failedOrders[orderNumber] = errorMessage;
    await saveFailedOrdersTracker(failedOrders);

    console.log(`🚨 Logged failed order ${orderNumber} for daily summary.`);
}

// ✅ Send a daily summary email
export async function sendDailySummary() {
    console.log("📧 Preparing daily summary...");

    const failedOrders = await loadFailedOrdersTracker();

    if (!failedOrders || Object.keys(failedOrders).length === 0) {
        console.log("✅ No issues to report in daily summary.");
        return;
    }

    let emailBody = `<h2>🚨 Daily Failed Order Summary</h2>`;
    emailBody += `<p>The following orders encountered issues today:</p><ul>`;

    for (const [orderNumber, reason] of Object.entries(failedOrders)) {
        emailBody += `<li>❌ Order #${orderNumber}: ${reason}</li>`;
    }

    emailBody += `</ul><p>📌 Please review the orders in Google Drive.</p>`;

    try {
        await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject: "🚨 Daily Summary: Orders with Issues",
            html: emailBody,
        });

        console.log("✅ Daily summary sent");
    } catch (err) {
        console.error("❌ Failed to send daily summary:", err.message);
    }
}

// ✅ Resets daily failed orders (runs at midnight)
export function resetDailyFailures() {
    failedOrdersToday.clear();
    console.log("🔄 Daily tracker reset completed");
}

// ✅ Send immediate error notification for failed orders
export async function sendErrorNotification(orderNumber, message) {
    if (!process.env.ADMIN_EMAIL) {
        console.error("❌ Notification failed: NO_ADMIN_EMAIL_CONFIGURED");
        return;
    }

    const cacheKey = `${orderNumber}-${new Date().toISOString().split("T")[0]}`;
    if (failedOrdersToday.has(cacheKey)) {
        console.log(`ℹ️ Order ${orderNumber}: Notification skipped (already sent today)`);
        return;
    }

    failedOrdersToday.add(cacheKey);

    const subject = `⚠️ Order Processing Failed: Order ${orderNumber}`;
    const html = `
        <h3>Order Processing Failed</h3>
        <p><strong>Order Number:</strong> ${orderNumber}</p>
        <p><strong>Details:</strong><br>${message.replaceAll("\n", "<br>")}</p>
        <p>Please check logs or Google Drive for further investigation.</p>
    `;

    try {
        await sendEmail({
            to: process.env.ADMIN_EMAIL,
            subject,
            html,
        });

        console.log(`✅ Alert sent for Order ${orderNumber}`);
    } catch (err) {
        console.error(`❌ Failed to send alert for Order ${orderNumber}:`, err.message);
    }
}
