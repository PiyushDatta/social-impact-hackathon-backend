import express, { Request, Response } from "express";
import twilio from "twilio";
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
const port = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables validation
// Load .env file
dotenv.config();
// Automatically get all keys from process.env that match your naming convention
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

// Initialize Twilio client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Initialize ElevenLabs client
const elevenLabsClient = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
});

// Store conversation IDs for tracking
const callConversationMap = new Map<string, string>();

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
                    headers: {
                        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
                    },
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
                headers: {
                    "xi-api-key": process.env.ELEVENLABS_API_KEY!,
                },
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
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`BASE_URL: ${process.env.BASE_URL || "not set"}`);
});

export default app;
