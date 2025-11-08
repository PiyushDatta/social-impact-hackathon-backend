import express, { Request, Response } from "express";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import dotenv from "dotenv";

interface ElevenLabsConversation {
    conversation_id: string;
    transcript?: Array<{
        role: string;
        message: string;
        timestamp?: string;
    }>;
    start_time_unix_secs?: number;
    end_time_unix_secs?: number;
    call_duration_secs?: number;
    agent_id?: string;
}

interface ElevenLabsConversationsResponse {
    conversations: Array<{
        conversation_id: string;
        agent_id: string;
        start_time_unix_secs: number;
    }>;
}

const app = express();
const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || 8080;
const portNumber = typeof port === "string" ? parseInt(port, 10) : port;

// Load .env file only in non-production environments
if (process.env.NODE_ENV !== "production") {
    dotenv.config();
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Initialize ElevenLabs client
const elevenLabsClient = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
});

// Root route for base URL access
app.get("/", (req: Request, res: Response) => {
    res.status(200).json({
        status: "ok",
        message: "Server is running",
        environment: process.env.NODE_ENV || "development",
    });
});

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

// Endpoint to initiate a call using ElevenLabs
app.post("/call", async (req: Request, res: Response) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ error: "Phone number is required" });
        }
        // Validate phone number format (basic validation)
        const phoneRegex = /^\+?[1-9]\d{1,14}$/;
        if (!phoneRegex.test(phoneNumber.replace(/\s|-/g, ""))) {
            return res
                .status(400)
                .json({ error: "Invalid phone number format" });
        }
        console.log(`Initiating ElevenLabs call to given number...`);
        // ElevenLabs initiates the call directly
        const response =
            await elevenLabsClient.conversationalAi.twilio.outboundCall({
                agentId: process.env.ELEVENLABS_AGENT_ID!,
                agentPhoneNumberId:
                    process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID!,
                toNumber: phoneNumber,
            });
        console.log("ElevenLabs call response:", response);
        res.status(200).json({
            success: true,
            callId: response.callSid,
            conversationId: response.conversationId,
            to: phoneNumber,
        });
    } catch (error: any) {
        console.error("Error initiating call:", error);
        res.status(500).json({
            error: "Failed to initiate call",
            details: error.message,
        });
    }
});

// Get transcript from ElevenLabs
app.get(
    "/conversation/:conversationId/transcript",
    async (req: Request, res: Response) => {
        try {
            const { conversationId } = req.params;
            const response = await fetch(
                `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
                {
                    method: "GET",
                    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
                }
            );
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(
                    `ElevenLabs API error: ${response.status} - ${errorText}`
                );
            }
            const conversation =
                (await response.json()) as ElevenLabsConversation;
            res.status(200).json({
                conversationId,
                transcript: conversation.transcript || [],
                metadata: {
                    startTime: conversation.start_time_unix_secs,
                    endTime: conversation.end_time_unix_secs,
                    duration: conversation.call_duration_secs,
                    agentId: conversation.agent_id,
                },
            });
        } catch (error: any) {
            console.error("Error fetching transcript:", error);
            res.status(500).json({
                error: "Failed to fetch transcript",
                details: error.message,
            });
        }
    }
);

// List recent conversations from ElevenLabs
app.get("/conversations", async (req: Request, res: Response) => {
    try {
        const agentId = req.query.agent_id || process.env.ELEVENLABS_AGENT_ID;
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}`,
            {
                method: "GET",
                headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
            }
        );
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `ElevenLabs API error: ${response.status} - ${errorText}`
            );
        }
        const data = (await response.json()) as ElevenLabsConversationsResponse;
        res.status(200).json({
            conversations: data.conversations || [],
            total: data.conversations?.length || 0,
        });
    } catch (error: any) {
        console.error("Error fetching conversations:", error);
        res.status(500).json({
            error: "Failed to fetch conversations",
            details: error.message,
        });
    }
});

// Start server
app.listen(portNumber, host, () => {
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`BASE_URL: ${process.env.BASE_URL || "not set"}`);
    console.log(`Server listening on ${host}:${portNumber}`);
    console.log(`Server running on port ${portNumber}`);
    console.log("\n==================== Debugging ====================");
    // Debugging: Print all process.env with masking
    const maskedEnv = Object.fromEntries(
        Object.entries(process.env).map(([key, value]) => {
            // Mask sensitive values
            const shouldMask =
                key.includes("KEY") ||
                key.includes("SECRET") ||
                key.includes("ID") ||
                key.includes("TOKEN") ||
                key.includes("PHONE_NUMBER") ||
                key.includes("PASSWORD") ||
                key.includes("AUTH");

            return [key, shouldMask ? "****" : value];
        })
    );
    console.log("All process.env variables:");
    console.log(JSON.stringify(maskedEnv, null, 2));
    console.log("==================== Debugging ====================\n");
});
