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
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";

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

interface UserProfile {
    uid: string;
    email: string;
    name: string;
    photo?: string;
    createdAt?: number;
}

const app = express();
const host = process.env.HOST || "0.0.0.0";
const port = process.env.PORT || 8080;
const portNumber = typeof port === "string" ? parseInt(port, 10) : port;
const isProd = process.env.NODE_ENV === "production";

// Load .env file only in non-production environments
if (!isProd) {
    dotenv.config();
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Update CORS configuration to support credentials
app.use(
    cors({
        origin: true, // Allow all origins in development
        methods: ["GET", "POST", "OPTIONS", "DELETE"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

// Update session config for mobile OAuth
const sessionConfig: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || "dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: "lax",
    },
    proxy: true,
    name: "sid",
};

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

let db: Firestore;
if (!isProd) {
    console.log("Running in development – using local service account key");
    const serviceAccountPath = path.resolve("serviceAccountKey.json");
    if (!fs.existsSync(serviceAccountPath)) {
        console.error("Missing serviceAccountKey.json in development!");
        process.exit(1);
    }
    const creds = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
    db = new Firestore({
        projectId: creds.project_id,
        credentials: {
            client_email: creds.client_email,
            private_key: creds.private_key,
        },
    });
} else {
    console.log(
        "Running in production – using Google Cloud default credentials"
    );
    // Cloud Run/GCE/GKE automatically inject credentials
    db = new Firestore();
}

app.use(session(sessionConfig));
// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());
// Passport Google OAuth configuration
passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_WEB_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_WEB_CLIENT_SECRET!,
            callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                // Just verify and return profile - NO Firestore here
                const userProfile: UserProfile = {
                    uid: profile.id,
                    email: profile.emails?.[0]?.value || "",
                    name: profile.displayName || "",
                    photo: profile.photos?.[0]?.value,
                };
                return done(null, userProfile);
            } catch (err: any) {
                console.error("GoogleStrategy error:", err);
                return done(err, null);
            }
        }
    )
);

// Serialize user to session
passport.serializeUser((user: any, done: any) => {
    done(null, user.uid);
});

passport.deserializeUser(async (uid: string, done) => {
    try {
        const userDoc = await db.collection("users").doc(uid).get();
        if (userDoc.exists) {
            done(null, userDoc.data());
        } else {
            done(new Error("User not found"), null);
        }
    } catch (error) {
        console.error(`[Passport] Deserialize error for ${uid}:`, error);
        done(error, null);
    }
});

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
    model: "gemini-2.5-flash",
    tools: [GOOGLE_SEARCH],
    instruction: CHYP_INTAKE_PROMPT,
});

const llmAgentRunner = new InMemoryRunner({
    agent: llmAgent,
    appName: llmAgent.name,
});

// Store active sessions in memory
const llmAgentSessions: Record<string, string> = {}; // userId -> sessionId

// In-memory storage for session state
const llmAgentStates: Record<string, any> = {}; // userId -> state

async function extractAndStoreFormDataInBackground({
    userId,
    sessionId,
    contentText,
    llmAgentRunner,
}: {
    userId: string;
    sessionId: string;
    contentText: string;
    llmAgentRunner: any;
}) {
    try {
        const extractionPrompt = `
                Extract any structured intake form data from this message...

                Message: "${contentText}"

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

async function addOrGetUser(profile: UserProfile): Promise<{
    isNewUser: boolean;
    profile: UserProfile;
    profileData?: any;
}> {
    const { uid } = profile;

    console.log(`[addOrGetUser] START – uid: ${uid}`);

    try {
        const userRef = db.collection("users").doc(uid);
        const profileRef = db.collection("profiles").doc(uid);

        console.log("[addOrGetUser] Fetching documents...");
        const [userDoc, profileDoc] = await Promise.all([
            userRef.get(),
            profileRef.get(),
        ]);

        console.log(
            `[addOrGetUser] userDoc.exists: ${userDoc.exists}, profileDoc.exists: ${profileDoc.exists}`
        );

        let isNewUser = false;
        let userProfile: UserProfile;
        let profileData: any = null;

        if (!userDoc.exists) {
            isNewUser = true;
            userProfile = {
                ...profile,
                createdAt: profile.createdAt || Date.now(),
            };

            console.log("[addOrGetUser] Creating new user...");
            await userRef.set(userProfile);

            const defaultProfileData = {
                userId: uid,
                onboardingComplete: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            console.log("[addOrGetUser] Creating default profile...");
            await profileRef.set(defaultProfileData);
            profileData = defaultProfileData;

            console.log(`[addOrGetUser] Created new user: ${uid}`);
        } else {
            userProfile = userDoc.data() as UserProfile;
            console.log(`[addOrGetUser] Found existing user: ${uid}`);
            if (profileDoc.exists) {
                profileData = profileDoc.data();
                console.log("[addOrGetUser] Found existing profile");
            } else {
                console.log("[addOrGetUser] No profile, creating default...");
                const defaultProfileData = {
                    userId: uid,
                    onboardingComplete: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                await profileRef.set(defaultProfileData);
                profileData = defaultProfileData;
            }
        }
        console.log(
            `[addOrGetUser] COMPLETE – uid: ${uid}, isNewUser: ${isNewUser}`
        );
        return { isNewUser, profile: userProfile, profileData };
    } catch (error) {
        console.error(`[addOrGetUser] ERROR for uid ${uid}:`, error);
        throw error;
    }
}

// Google OAuth verification endpoint
app.post("/auth/google", async (req: Request, res: Response) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({
                error: "idToken is required",
            });
        }
        // Verify the ID token with Google
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_WEB_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload) {
            return res.status(401).json({
                error: "Invalid token",
            });
        }
        // Extract user info from the verified token
        const profile: UserProfile = {
            uid: payload.sub,
            email: payload.email!,
            name: payload.name!,
            photo: payload.picture,
        };
        // Add or get user from database
        const {
            isNewUser,
            profile: userProfile,
            profileData,
        } = await addOrGetUser(profile);
        return res.json({
            success: true,
            isNewUser,
            profile: userProfile,
            profileData,
        });
    } catch (err: any) {
        console.error("Google auth error:", err.message || err);
        return res.status(401).json({
            error: "Authentication failed",
            details: err.message,
        });
    }
});

// Add user endpoint
app.post("/auth/add_user", async (req, res) => {
    try {
        const { uid, email, name, photo } = req.body;
        // Validate required fields
        if (!uid || !email || !name) {
            return res.status(400).json({
                error: "Missing required fields: uid, email, and name are required",
            });
        }
        // Create profile
        const profile: UserProfile = {
            uid,
            email,
            name,
            photo: photo || undefined,
        };
        // Add or get user from database
        const {
            isNewUser,
            profile: userProfile,
            profileData,
        } = await addOrGetUser(profile);
        return res.json({
            success: true,
            isNewUser,
            profile: userProfile,
            profileData,
        });
    } catch (err: any) {
        console.error("Add user error:", err.message || err);
        return res.status(500).json({ error: "Failed to add user" });
    }
});

// Create or update user profile data
app.post("/profile", async (req: Request, res: Response) => {
    try {
        const { userId, profileData } = req.body;
        // Validate required fields
        if (!userId) {
            return res.status(400).json({
                error: "userId is required",
            });
        }
        if (!profileData || typeof profileData !== "object") {
            return res.status(400).json({
                error: "profileData object is required",
            });
        }
        // Reference to the profile document
        const profileRef = db.collection("profiles").doc(userId);
        // Add metadata
        const profileWithMetadata = {
            ...profileData,
            userId,
            updatedAt: Date.now(),
            createdAt: profileData.createdAt || Date.now(),
        };
        // Save to Firestore (merge with existing data)
        await profileRef.set(profileWithMetadata, { merge: true });
        res.status(200).json({
            success: true,
            message: "Profile data saved successfully",
            profileData: profileWithMetadata,
        });
    } catch (err: any) {
        console.error("Error saving profile data:", err);
        res.status(500).json({
            error: "Failed to save profile data",
            details: err.message,
        });
    }
});

// Get user profile data
app.get("/profile/:userId", async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;

        // Validate userId
        if (!userId) {
            return res.status(400).json({
                error: "userId is required",
            });
        }
        // Reference to the profile document
        const profileRef = db.collection("profiles").doc(userId);
        const profileDoc = await profileRef.get();
        // Check if profile exists
        if (!profileDoc.exists) {
            return res.status(404).json({
                error: "Profile not found",
                userId,
            });
        }
        const profileData = profileDoc.data();
        res.status(200).json({
            success: true,
            profileData,
        });
    } catch (err: any) {
        console.error("Error fetching profile data:", err);
        res.status(500).json({
            error: "Failed to fetch profile data",
            details: err.message,
        });
    }
});

// Create a session for new users
app.post("/chat/session", async (req: Request, res: Response) => {
    try {
        const userId = req.body.userId || uuidv4();
        const appName = llmAgent.name;
        // Get profile from Firestore
        const profileRef = db.collection("profiles").doc(userId);
        const profileDoc = await profileRef.get();
        let profileData: Record<string, any> = {};
        if (profileDoc.exists) {
            profileData = profileDoc.data() || {};
        }
        // Prepare initial session state with user profile
        const initialState = {
            userProfile: {
                name: profileData.name || null,
                age: profileData.age || null,
                background: profileData.background || null,
                history: profileData.history || null,
                ...profileData,
            },
            promptContext: `This is the user's profile data: ${JSON.stringify(
                profileData
            )}. They can ask for this information, feel free to share it with them. Use this information to respond kindly and thoughtfully.`,
        };
        // Create a session in the runner
        const session = await llmAgentRunner.sessionService.createSession({
            appName,
            userId,
            state: initialState,
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
        // Only fetch profile on first message
        let sessionState = llmAgentStates[userId];
        let contentText: string;
        let debugInfo: any = {};
        if (!sessionState) {
            const profileRef = db.collection("profiles").doc(userId);
            const profileDoc = await profileRef.get();
            const profileData = profileDoc.exists ? profileDoc.data() : {};
            sessionState = {
                userProfile: profileData,
                promptContext: `This is the user's profile data: ${JSON.stringify(
                    profileData
                )}. They can ask for this information, feel free to share it with them. Use this information to respond kindly and thoughtfully.`,
            };
            // Save state in memory
            llmAgentStates[userId] = sessionState;
            // Prepend the profile prompt to the first message
            contentText = `${sessionState.promptContext}\n\nUser message: ${message}`;
            debugInfo.profileData = profileData;
        } else {
            // Just send the message without profile data
            contentText = message;
        }
        // Run the AI reply
        const content = { role: "user", parts: [{ text: contentText }] };
        let fullText = "";
        debugInfo.events = [];
        try {
            for await (const event of llmAgentRunner.runAsync({
                userId,
                sessionId,
                newMessage: content,
            })) {
                debugInfo.events.push(event); // store each event
                if (event.content?.parts?.[0]?.text) {
                    fullText += event.content.parts[0].text;
                }
            }
        } catch (err: any) {
            debugInfo.error = err.toString();
        }
        // Immediately return the response to avoid delay
        res.status(200).json({
            reply: fullText || "I'm sorry, I couldn't process your message.",
            debug: debugInfo,
        });
        // Kick off async extraction task (does not block)
        extractAndStoreFormDataInBackground({
            userId,
            sessionId,
            contentText,
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
        const { phoneNumber, userId } = req.body;
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
        // Save conversation ID to Firestore if userId is provided
        if (userId && response.conversationId) {
            try {
                const conversationRef = db
                    .collection("conversation_ids")
                    .doc(response.conversationId);
                await conversationRef.set({
                    conversationId: response.conversationId,
                    userId,
                    phoneNumber,
                    callSid: response.callSid,
                    createdAt: Date.now(),
                });
                console.log(
                    `Saved conversation ${response.conversationId} for user ${userId}`
                );
            } catch (dbError) {
                console.error(
                    "Failed to save conversation to Firestore:",
                    dbError
                );
                // Continue even if DB save fails
            }
        }
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

// Get user's conversation IDs from Firestore
app.get("/conversations/user/:userId", async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        if (!userId) {
            return res.status(400).json({
                error: "userId is required",
            });
        }
        const conversationsRef = db.collection("conversation_ids");
        const snapshot = await conversationsRef
            .where("userId", "==", userId)
            .orderBy("createdAt", "desc")
            .get();
        const conversations = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
        }));
        res.status(200).json({
            success: true,
            conversations,
            total: conversations.length,
        });
    } catch (error: any) {
        console.error("Error fetching user conversations:", error);
        res.status(500).json({
            error: "Failed to fetch user conversations",
            details: error.message,
        });
    }
});

// Save conversation ID for a user
app.post("/conversations/save", async (req: Request, res: Response) => {
    try {
        const { conversationId, userId } = req.body;
        if (!conversationId || !userId) {
            return res.status(400).json({
                error: "conversationId and userId are required",
            });
        }
        // Save to Firestore
        const conversationRef = db
            .collection("conversation_ids")
            .doc(conversationId);
        await conversationRef.set({
            conversationId,
            userId,
            createdAt: Date.now(),
        });
        // console.log(`Saved conversation ${conversationId} for user ${userId}`);
        res.status(200).json({
            success: true,
            message: "Conversation saved successfully",
            conversationId,
        });
    } catch (error: any) {
        console.error("Error saving conversation:", error);
        res.status(500).json({
            error: "Failed to save conversation",
            details: error.message,
        });
    }
});

// Delete a conversation ID from Firestore
app.delete(
    "/conversations/:conversationId",
    async (req: Request, res: Response) => {
        try {
            const { conversationId } = req.params;
            const { userId } = req.body;
            if (!conversationId) {
                return res.status(400).json({
                    error: "conversationId is required",
                });
            }
            const conversationRef = db
                .collection("conversation_ids")
                .doc(conversationId);
            const doc = await conversationRef.get();
            // Verify the conversation belongs to the user
            if (doc.exists && userId) {
                const data = doc.data();
                if (data?.userId !== userId) {
                    return res.status(403).json({
                        error: "Unauthorized to delete this conversation",
                    });
                }
            }
            await conversationRef.delete();
            res.status(200).json({
                success: true,
                message: "Conversation deleted successfully",
                conversationId,
            });
        } catch (error: any) {
            console.error("Error deleting conversation:", error);
            res.status(500).json({
                error: "Failed to delete conversation",
                details: error.message,
            });
        }
    }
);

// --- OAuth Routes for Web Browser Flow ---

// Returns the Google OAuth URL (for test script)
app.get("/auth/google/url", (req, res) => {
    const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    const options = {
        client_id: process.env.GOOGLE_WEB_CLIENT_ID,
        redirect_uri: `${process.env.BASE_URL}/auth/google/callback`,
        access_type: "offline",
        response_type: "code",
        prompt: "consent",
        scope: ["profile", "email"].join(" "),
    };
    const qs = new URLSearchParams(options).toString();
    const authUrl = `${rootUrl}?${qs}`;
    res.json({ authUrl });
});

// Initiates Google OAuth flow (redirects to Google)
app.get(
    "/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
);

// Google OAuth callback
app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/auth/failure" }),
    async (req, res) => {
        try {
            const profile = req.user as UserProfile;
            console.log(`[OAuth Callback] Processing user: ${profile.uid}`);

            // Handle Firestore user creation
            const {
                isNewUser,
                profile: userProfile,
                profileData,
            } = await addOrGetUser(profile);

            // Update session with full user data
            req.user = userProfile;

            // Encode user data in URL for mobile apps
            const userParam = encodeURIComponent(JSON.stringify(userProfile));
            const profileParam = encodeURIComponent(
                JSON.stringify(profileData)
            );

            res.redirect(
                `${process.env.BASE_URL}/?auth=success&user=${userParam}&profile=${profileParam}`
            );
        } catch (error: any) {
            console.error("[OAuth Callback] Error:", error);
            res.redirect(
                `${
                    process.env.BASE_URL
                }/?auth=error&message=${encodeURIComponent(error.message)}`
            );
        }
    }
);

// Get current user session
app.get("/auth/me", (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ authenticated: true, user: req.user });
    } else {
        res.status(401).json({
            authenticated: false,
            error: "Not authenticated",
        });
    }
});

// OAuth failure handler
app.get("/auth/failure", (req, res) => {
    res.status(401).json({ error: "Authentication failed" });
});

// Logout
app.post("/auth/logout", (req, res) => {
    req.logout((err) => {
        if (err) return res.status(500).json({ error: "Logout failed" });
        res.json({ success: true, message: "Logged out" });
    });
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
