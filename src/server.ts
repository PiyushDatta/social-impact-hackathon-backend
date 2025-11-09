import express, { Request, Response } from "express";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import dotenv from "dotenv";
import cors from "cors";
import { LlmAgent, InMemoryRunner, GOOGLE_SEARCH } from "@google/adk";
import { CHYP_INTAKE_PROMPT } from "./intakePrompts";
import { v4 as uuidv4 } from "uuid";
import { Firestore } from "@google-cloud/firestore";
import { IntakeSessionDoc, IntakeFormData } from "./intakeFormData";
import { OAuth2Client } from "google-auth-library";

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

interface GetSessionRequest {
    sessionId: string;
    userId?: string;
    appName?: string;
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

// Enable CORS (allow localhost & Expo testing)
app.use(
    cors({
        origin: "*", // allow all origins during development
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

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

// Initialize Firestore
const db = new Firestore();

// Initialize google auth client
const googleClient = new OAuth2Client(process.env.GOOGLE_WEB_CLIENT_ID);

// Initialize ElevenLabs client
const elevenLabsClient = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
});

// Initialize Google llm agent (adk)
const llmAgent = new LlmAgent({
    name: "chyp_intake_agent",
    description: "A compassionate intake assistant for homeless youth.",
    model: "gemini-2.0-flash-exp",
    tools: [GOOGLE_SEARCH],
    instruction: CHYP_INTAKE_PROMPT,
});

const llmAgentRunner = new InMemoryRunner({
    agent: llmAgent,
    appName: llmAgent.name,
});

// Store active sessions in memory
const llmAgentSessions: Record<string, string> = {}; // userId -> sessionId

async function extractAndStoreFormDataInBackground({
    userId,
    sessionId,
    message,
    llmAgentRunner,
}: {
    userId: string;
    sessionId: string;
    message: string;
    llmAgentRunner: any;
}) {
    try {
        const extractionPrompt = `
                Extract any structured intake form data from this message...

                Message: "${message}"

                Return strict JSON only.
                `;
        let result = "";
        for await (const event of llmAgentRunner.runAsync({
            userId,
            sessionId,
            newMessage: { role: "user", parts: [{ text: extractionPrompt }] },
        })) {
            if (event.content?.parts?.[0]?.text) {
                result += event.content.parts[0].text;
            }
        }
        let newData: IntakeFormData | null = null;
        try {
            newData = JSON.parse(result);
        } catch (err) {
            // skip background update
            console.warn("Extraction returned invalid JSON:", result);
            return;
        }
        const docRef = db.collection("intake_sessions").doc(sessionId);
        const snap = await docRef.get();
        // Safe init
        let existing: IntakeSessionDoc = {};
        if (snap.exists) {
            const data = snap.data() as IntakeSessionDoc | undefined;
            if (data) {
                existing = data as any;
            }
        }
        // Merge incoming extracted data with existing data
        const merged: IntakeFormData = {
            ...(existing.extractedData || {}),
            ...(newData || {}),
            extractedAt: Date.now(),
            sessionId,
        };
        // Compute fields & completeness
        const fields = Object.keys(merged);
        const extractedFields = fields.filter(
            (f) => merged[f as keyof IntakeFormData]
        );
        const missingFields = fields.filter(
            (f) => !merged[f as keyof IntakeFormData]
        );
        const completeness = Math.floor(
            (extractedFields.length / fields.length) * 100
        );
        const confidence = completeness;
        await docRef.set(
            {
                userId,
                sessionId,
                extractedData: merged,
                extractedFields,
                missingFields,
                completeness,
                confidence,
                lastUpdate: Date.now(),
            },
            { merge: true }
        );
        console.log("Background extraction completed");
    } catch (err) {
        console.error("Background extraction error:", err);
    }
}

// Google authentication endpoint
app.post("/auth/google", async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ error: "Missing idToken" });
        }
        // Verify Google token
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_WEB_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload || !payload.sub || !payload.email) {
            return res.status(401).json({ error: "Invalid Google token" });
        }
        // Unique user id from google
        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name || "";
        const photo = payload.picture || "";
        // Check if user exists in Firestore
        const userRef = db.collection("users").doc(googleId);
        const userDoc = await userRef.get();
        let isNewUser = false;
        let profile;
        if (!userDoc.exists) {
            // Create profile for new user
            isNewUser = true;
            profile = {
                uid: googleId,
                email,
                name,
                photo,
                createdAt: Date.now(),
            };
            await userRef.set(profile);
        } else {
            profile = userDoc.data();
        }
        return res.json({
            success: true,
            isNewUser,
            profile,
        });
    } catch (err: any) {
        console.error("Google auth error:", err.message || err);
        return res.status(500).json({ error: "Google authentication failed" });
    }
});

// Create a session for new users
app.post("/chat/session", async (req: Request, res: Response) => {
    try {
        const userId = req.body.userId || uuidv4();
        const appName = llmAgent.name;
        // Create a session in the runner
        const session = await llmAgentRunner.sessionService.createSession({
            appName,
            userId,
        });
        // Store it in the in-memory map
        llmAgentSessions[userId] = session.id;
        res.status(200).json({ sessionId: session.id, userId });
    } catch (err: any) {
        console.error("Error creating chat session:", err);
        res.status(500).json({
            error: "Failed to create session",
            details: err.message,
        });
    }
});

// Handle a message exchange
app.post("/chat/message", async (req: Request, res: Response) => {
    try {
        const { userId, sessionId, message } = req.body;
        if (!userId || !sessionId || !message) {
            return res.status(400).json({
                error: "userId, sessionId, and message are required",
            });
        }
        // Validate that the sessionId matches what we stored
        const storedSessionId = llmAgentSessions[userId];
        if (!storedSessionId || storedSessionId !== sessionId) {
            return res.status(400).json({
                error: "Invalid session ID",
            });
        }
        // Run the AI reply
        const content = { role: "user", parts: [{ text: message }] };
        let fullText = "";
        for await (const event of llmAgentRunner.runAsync({
            userId,
            sessionId,
            newMessage: content,
        })) {
            if (event.content?.parts?.[0]?.text) {
                fullText += event.content.parts[0].text;
            }
        }
        // Immediately return the response to avoid delay
        res.status(200).json({
            reply: fullText || "I'm sorry, I couldn't process your message.",
        });
        // Kick off async extraction task (does not block)
        extractAndStoreFormDataInBackground({
            userId,
            sessionId,
            message,
            llmAgentRunner,
        }).catch((err: any) =>
            console.error("Background extraction failed:", err)
        );
    } catch (err: any) {
        console.error("Error in chat message:", err);
        res.status(500).json({
            error: "Failed to process chat message",
            details: err.message,
        });
    }
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
