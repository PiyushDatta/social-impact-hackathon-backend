export type IntakeSessionDoc = {
    userId?: string;
    sessionId?: string;
    extractedData?: IntakeFormData;
    extractedFields?: string[];
    missingFields?: string[];
    completeness?: number;
    confidence?: number;
    lastUpdate?: number;
};

export interface IntakeFormData {
    // Personal Info
    firstName?: string;
    lastName?: string;
    nickName?: string;
    pronouns?: "she/her" | "he/him" | "they/them" | "other" | "";
    dateOfBirth?: string;
    currentAge?: string;
    phoneNumber?: string;
    email?: string;
    bestContact?: "call" | "text" | "email" | "";
    voicemail?: "yes" | "no" | "";
    language?: "english" | "spanish" | "other" | "";
    // Living Situation
    currentLivingSituation?: string;
    sleepingLocation?: string;
    partOfTown?: string[];
    // Services
    interestedServices?: string[];
    // Metadata
    extractedAt?: number;
    conversationId?: string;
    sessionId?: string;
    completeness?: number; // 0-100 percentage
}

export interface FormExtractionResponse {
    success: boolean;
    formData: IntakeFormData;
    extractedFields: string[];
    missingFields: string[];
    confidence: number;
}
