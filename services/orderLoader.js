import { google } from "googleapis";
import fs from "fs";
import csvParser from "csv-parser";
import dotenv from "dotenv";

dotenv.config();

const ETSY_ORDERS_FOLDER_ID = process.env.ETSY_ORDERS_FOLDER_ID;

// ✅ Google Drive Authentication
const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });

/** ===============================
 * ✅ Load Latest Etsy Order (Find & Parse CSV)
 * =============================== */
export async function loadLatestEtsyOrder() {
    try {
        console.log("📂 Searching for latest Etsy order file...");

        // ✅ Get list of CSV files in Etsy Orders folder
        const res = await drive.files.list({
            q: `'${ETSY_ORDERS_FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
            orderBy: "createdTime desc", // Get the latest file
            fields: "files(id, name, createdTime)",
        });

        const files = res.data.files;
        if (!files.length) {
            console.log("📭 No Etsy order files found.");
            return null;
        }

        const latestFile = files[0]; // The newest CSV file
        console.log(`📄 Latest order file: ${latestFile.name}`);

        // ✅ Download file
        const filePath = `./temp/${latestFile.name}`;
        if (!fs.existsSync("./temp")) fs.mkdirSync("./temp"); // Ensure temp folder exists
        const dest = fs.createWriteStream(filePath);

        await new Promise((resolve, reject) => {
            drive.files.get({ fileId: latestFile.id, alt: "media" }, { responseType: "stream" })
                .then(res => {
                    res.data
                        .on("end", resolve)
                        .on("error", reject)
                        .pipe(dest);
                })
                .catch(reject);
        });

        console.log("✅ File downloaded. Parsing CSV...");

        // ✅ Parse CSV
        const orders = [];
        await new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .pipe(csvParser())
                .on("data", (row) => orders.push(row))
                .on("end", resolve)
                .on("error", reject);
        });

        console.log(`📦 Found ${orders.length} orders in ${latestFile.name}`);

        return {
            fileId: latestFile.id,
            fileName: latestFile.name,
            orders,
        };
    } catch (error) {
        console.error("❌ Failed to load latest Etsy order:", error);
        return null;
    }
}
