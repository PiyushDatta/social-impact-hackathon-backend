import { Firestore } from "@google-cloud/firestore";
import dotenv from "dotenv";

dotenv.config();

// Environment variables validation
const requiredEnvVars = Object.keys(process.env).filter(
    (key) =>
        key.startsWith("TWILIO_") ||
        key.startsWith("ELEVENLABS_") ||
        key === "BASE_URL"
);
const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingVars.length > 0) {
    console.warn(
        `Warning: Missing environment variables: ${missingVars.join(", ")}`
    );
}

async function testFirestore() {
    const db = new Firestore();
    const docRef = db.collection("test").doc("ping");
    await docRef.set({ time: new Date().toISOString() });
    console.log("Firestore write successful");
}

testFirestore().catch(console.error);
