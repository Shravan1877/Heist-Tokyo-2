import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { createClient } from "@supabase/supabase-js";
import { TIER_CONFIG } from "./src/lib/tier_config.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "15mb" }));

// Pseudo-UUID deterministic translations to map custom sandbox identifiers safely to standard UUID formatting
function getSafeUUID(rawId: string): string {
  const clean = (rawId || "").slice(0, 100).trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
    return clean;
  }
  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = clean.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hex = Math.abs(hash).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex.substring(0, 12)}`;
}

// -------------------------------------------------------------
// Supabase Server Client lazy-initialization (Safe guard)
// -------------------------------------------------------------
let supabaseServerClient: any = null;

function getSupabaseServerClient() {
  if (!supabaseServerClient) {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (url && key) {
      supabaseServerClient = createClient(url, key);
      console.log("✅ Supabase Server Client successfully initialized.");
    } else {
      console.warn("⚠️ Supabase Credentials missing! Cannot execute database state actions.");
    }
  }
  return supabaseServerClient;
}

// -------------------------------------------------------------
// Gemini Client Lazy-Initialization
// -------------------------------------------------------------
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is required to run HEIST.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// -------------------------------------------------------------
// In-Memory Session states
// -------------------------------------------------------------
interface InSessionState {
  user_id: string;
  message_count: number;
  requires_paywall: boolean;
  detected_vibe: string;
  physical_traits: {
    skin_color: string;
    skin_undertone: string;
    hair_type: string;
    hair_color: string;
    bone_structure?: string;
  };
  onboarding_step: number; // 0 to 10
  messages: { id: string; role: "user" | "assistant"; content: string; timestamp: string }[];
  is_unlocked: boolean;
}

const sessionStore: Record<string, InSessionState> = {};


// -------------------------------------------------------------
// Supermemory RAG implementation
// -------------------------------------------------------------
async function querySupermemory(q: string, userId: string): Promise<string> {
  const supermemoryKey = process.env.SUPERMEMORY_API_KEY;
  if (!supermemoryKey) {
    // Elegant system backup context containing luxury styling rules (Tokyo's knowledge pool)
    return `
      Styling context from HEIST Theory:
      - Deep slate, rich gray, charcoal, and dark teal complements cool undertones flawlessly.
      - Baggy/oversized silhouettes look spectacular aligned with cropped, fitted elements to maintain height and crisp posture.
      - Contrast and proportion balancing (60/40 rule) provides effortless streetwear and Old Money styles. Keep accessories minimal yet high-concept.
    `;
  }

  try {
    const url = "https://api.supermemory.ai/v4/profile";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-supermemory-api-key": supermemoryKey,
      },
      body: JSON.stringify({
        containerTag: `user_${userId}`,
        q: q,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const staticProfile = data.profile?.static?.join("\n") || "";
      const dynamicProfile = data.profile?.dynamic?.join("\n") || "";
      const searchMemories = data.searchResults?.results?.map((r: any) => r.memory).join("\n") || "";

      return `
        User Supermemory static facts: 
        ${staticProfile}
        
        Recent context: 
        ${dynamicProfile}
        
        Relevant memories: 
        ${searchMemories}
      `;
    }
  } catch (error) {
    console.error("Supermemory query failed:", error);
  }
  return "";
}

async function addToSupermemory(content: string, userId: string): Promise<boolean> {
  const supermemoryKey = process.env.SUPERMEMORY_API_KEY;
  if (!supermemoryKey) return false;

  try {
    const url = "https://api.supermemory.ai/v3/documents";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-supermemory-api-key": supermemoryKey,
      },
      body: JSON.stringify({
        content,
        containerTag: `user_${userId}`,
      }),
    });
    return response.ok;
  } catch (error) {
    console.error("Supermemory write failed:", error);
  }
  return false;
}

// Helper to determine if input contains life rambling / venting
function isVentingOrYapping(text: string): boolean {
  const lowercase = text.toLowerCase();
  const yappingPhrases = [
    "ex", "boyfriend", "girlfriend", "breakup", "break up", "relationship",
    "vent", "angry", "sad", "unhappy", "depressed", "situationship", "toxic",
    "boss", "work", "hate my", "whining", "job", "stress", "grind", "fatigued"
  ];
  return yappingPhrases.some((phrase) => lowercase.includes(phrase));
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ status: "alive" });
});

// Setup active user session
app.post("/api/sessions/init", (req, res) => {
  const { user_id } = req.body;
  const uid = user_id || `user_${Date.now()}`;
  
  if (!sessionStore[uid]) {
    sessionStore[uid] = {
      user_id: uid,
      message_count: 0,
      requires_paywall: false,
      detected_vibe: "COOL",
      physical_traits: {
        skin_color: "Not scanned",
        skin_undertone: "Not scanned",
        hair_type: "Not scanned",
        hair_color: "Not scanned",
        bone_structure: "Not scanned",
      },
      onboarding_step: 0,
      messages: [],
      is_unlocked: false,
    };
  }

  res.json({ state: sessionStore[uid] });
});

// Vision Analysis Node route
app.post("/api/vision/ingest", async (req, res) => {
  const { user_id, front_photo, side_photo } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: "user_id is required." });
  }

  const session = sessionStore[user_id];
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  try {
    const ai = getGeminiClient();
    
    // Call Gemini with multimodal inputs
    // We use gemini-3.5-flash for complex/basic multimodal tasks or gemini-3.1-flash-lite as requested
    const prompt = `
      You are the backend AI for the premium stylist assistant HEIST.
      Analyze the attached front and side head photos of the user. Perform a deep facial structure extraction.
      Extract these EXACT physical traits:
      - skin_color
      - skin_undertone (COOL, WARM, or NEUTRAL)
      - hair_type (Curly, Wavy, Straight, Coily)
      - hair_color
      - bone_structure (A descriptive phrase, e.g. "Highly defined cheekbones & sharp symetric jawline")

      Response MUST be a JSON object Matching:
      {
        "skin_color": "",
        "skin_undertone": "",
        "hair_type": "",
        "hair_color": "",
        "bone_structure": ""
      }
    `;

    // Package base64 images into Parts
    const frontPart = {
      inlineData: {
        mimeType: "image/jpeg",
        data: front_photo.split(",")[1] || front_photo,
      },
    };
    const sidePart = {
      inlineData: {
        mimeType: "image/jpeg",
        data: side_photo.split(",")[1] || side_photo,
      },
    };

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        prompt,
        frontPart,
        sidePart
      ],
      config: {
        responseMimeType: "application/json",
      }
    });

    const text = response.text || "{}";
    const extractedTraits = JSON.parse(text);

    // Save outputs on state
    session.physical_traits = {
      skin_color: extractedTraits.skin_color || "Sienna",
      skin_undertone: extractedTraits.skin_undertone || "COOL",
      hair_type: extractedTraits.hair_type || "Curly",
      hair_color: extractedTraits.hair_color || "Dark espresso",
      bone_structure: extractedTraits.bone_structure || "Strong defined cheekbones & balanced symmetry",
    };
    session.detected_vibe = "UNLOCKED";

    // Save initial facts if user is flux (10% chance) or unlocked (40% chance), completely bypassing for core/free to avoid bleeding tokens
    let isSupermemoryEnabledForIngest = false;
    const supabase = getSupabaseServerClient();
    if (supabase) {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("plan")
          .eq("id", getSafeUUID(user_id))
          .single();
        const detectedPlan = (data?.plan || "free").toLowerCase().trim();
        if (detectedPlan === "flux") {
          isSupermemoryEnabledForIngest = Math.random() < 0.10;
        } else if (detectedPlan === "unlocked") {
          isSupermemoryEnabledForIngest = Math.random() < 0.40;
        }
      } catch (err) {
        console.warn("⚠️ Failed reading plan from Supabase in vision ingest:", err);
      }
    }
    
    if (isSupermemoryEnabledForIngest) {
      await addToSupermemory(`Physical traits: skin_color=${session.physical_traits.skin_color}, undertone=${session.physical_traits.skin_undertone}, hair=${session.physical_traits.hair_type}`, user_id);
    }

    const initialTokyoResponse = `Scan completed! Bestie, your bone structure is literally defined. Skin undertone reads as beautifully ${session.physical_traits.skin_undertone}.\n\nbestie, welcome to the inside. before we build your master aesthetic blueprint... what is the absolute worst fashion phase you've ever had, or what is your biggest styling ick right now? do not hold back, let's yap.`;

    session.messages.push({
      id: `msg_ai_${Date.now()}`,
      role: "assistant",
      content: initialTokyoResponse,
      timestamp: new Date().toISOString(),
    });
    session.message_count += 1;

    res.json({ state: session, text: initialTokyoResponse });
  } catch (error: any) {
    console.error("Vision scan failed:", error);
    // fallback gracefully
    session.physical_traits = {
      skin_color: "Rich Tan",
      skin_undertone: "COOL",
      hair_type: "Defined Wavy",
      hair_color: "Midnight Black",
      bone_structure: "Elite high-contrast symmetry & defined jaw",
    };

    const initialTokyoResponse = `Face scan secured—bone structure is actually insane. Honestly, your asymmetry is basically non-existent.\n\nbestie, welcome to the inside. before we build your master aesthetic blueprint... what is the absolute worst fashion phase you've ever had, or what is your biggest styling ick right now? do not hold back, let's yap.`;

    session.messages.push({
      id: `msg_ai_fb_${Date.now()}`,
      role: "assistant",
      content: initialTokyoResponse,
      timestamp: new Date().toISOString(),
    });
    session.message_count += 1;

    res.json({ state: session, text: initialTokyoResponse });
  }
});

// Chat message interaction
app.post("/api/sessions/message", async (req, res) => {
  const { user_id, message } = req.body;
  if (!user_id || !message) {
    return res.status(400).json({ error: "user_id and message are required." });
  }

  const session = sessionStore[user_id];
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  // Push user message into state
  session.messages.push({
    id: `msg_user_${Date.now()}`,
    role: "user",
    content: message,
    timestamp: new Date().toISOString(),
  });
  session.message_count += 1;

  // Retrieve user plan to check Supermemory/RAG active eligibility, completely avoiding token bleeds for free/core
  let userPlan = "free";
  let isSupermemoryEnabledForTurn = false;
  const supabase = getSupabaseServerClient();
  if (supabase && user_id) {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("plan")
        .eq("id", getSafeUUID(user_id))
        .single();
      if (data?.plan) {
        userPlan = data.plan.toLowerCase().trim();
      }
    } catch (_) {}
  }

  if (userPlan === "flux") {
    isSupermemoryEnabledForTurn = Math.random() < 0.10;
  } else if (userPlan === "unlocked") {
    isSupermemoryEnabledForTurn = Math.random() < 0.40;
  }

  // Crucial trap: Paywall on exactly message 11 after question 10 is completed (message_count >= 11)
  if (session.message_count >= 11 && !session.is_unlocked) {
    session.requires_paywall = true;
    res.json({
      state: session,
      text: "🔒 Okay bestie, I've consolidated your exact physical blueprints, skin contrast charts, and hair volume diagnostics. Restructuring your outfit system takes some serious compute power from my engine. Unlock your HEIST master blueprint for only ₹149 (less than 4 Diet Cokes, literally no cap!) to reveal your premium transformation catalog.",
    });
    return;
  }

  // Undergo RAG or routing logic block
  const userText = message.trim();
  
  // Rule 1: Therapist Fallback protocol (yapping about relationships/dating/ex/situationship/job stress)
  if (isVentingOrYapping(userText)) {
    try {
      const ai = getGeminiClient();
      const prompt = `
        You are Tokyo, an ultra-positive, highly empathetic female digital wingman.
        The user is currently venting about work, relationship, situationship, or ex: "${userText}".
        YOU MUST STRICTLY FOLLOW THE "THERAPIST PROTOCOL":
        1. DO NOT mention fashion, clothes, grooming, or outfits at all.
        2. Listen and validate their feelings immediately. Call out how true/real that is. Back them up completely!
        3. Never be brutal. Always hype up their worth, bestie status, or energy.
        4. Do NOT use bullet points. Speak in punchy, short, texting lengths.
        5. End with a casual, empathetic and engaging follow-up question.
        6. Inject Gen Z slangs naturally ("rizz", "cooked", "situationship", "bussin", "glow-up", "delulu", "no cap").
        
        Write as a single or dual short text message. Do not be overly text-heavy. Keep it sweet, sharp, and bantery.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });

      const reply = response.text || "Oh bestie, that is literally so exhausting. You are absolutely too elite to be stressed by that situationship. Want to yap about this or should we keep going?";
      session.messages.push({
        id: `msg_ai_${Date.now()}`,
        role: "assistant",
        content: reply,
        timestamp: new Date().toISOString(),
      });

      if (isSupermemoryEnabledForTurn) {
        await addToSupermemory(`User vented about life/ex. Tokyo supported. Message: ${userText}`, user_id);
      }

      res.json({ state: session, text: reply });
      return;
    } catch (err) {
      const defaultReply = "Bestie that situationship is literally cooked. You are way too elite to be dealing with this toxic energy. Are we ignoring them today or what?";
      session.messages.push({
        id: `msg_ai_${Date.now()}`,
        role: "assistant",
        content: defaultReply,
        timestamp: new Date().toISOString(),
      });
      res.json({ state: session, text: defaultReply });
      return;
    }
  }

  // Once unlocked/after onboarding
  try {
    const ai = getGeminiClient();
    const supermemoryContext = isSupermemoryEnabledForTurn 
      ? await querySupermemory(userText, user_id)
      : "";
    const prompt = `
      You are Tokyo, the senior AI styling and grooming architect.
      The user is asking: "${userText}".
      Adhere to your persona: ultra-positive, Gen Z slang, punchy text length, no bullets, validate them, end with a casual follow-up question.
      Incorporate their physical traits into the recommendation:
      - Skin Undertone: ${session.physical_traits.skin_undertone}
      - Hair type: ${session.physical_traits.hair_type}
      - Bone Structure: ${session.physical_traits.bone_structure}

      RAG background:
      ${supermemoryContext}
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    const reply = response.text || "Bestie, you look elite. Seriously, the aesthetic blueprint is absolute fire. What custom accessory are we picking next?";
    session.messages.push({
      id: `msg_ai_${Date.now()}`,
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
    });

    res.json({ state: session, text: reply });
  } catch (error) {
    const reply = "Sorry bestie, my engine had a small hiccup. But you're still looking literally 10/10 today. Shall we try again?";
    session.messages.push({
      id: `msg_ai_${Date.now()}`,
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
    });
    res.json({ state: session, text: reply });
  }
});

// Unlock blueprint payment simulator
app.post("/api/sessions/unlock", (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: "user_id is required." });
  }

  const session = sessionStore[user_id];
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  session.is_unlocked = true;
  session.requires_paywall = false;

  const blueprintResponse = `
    ✨ HEIST PREMIUM ALIGNMENT UNLOCKED! ✨
    
    Bestie, you are officially entering your main character era. No cap.
    Based on your face scan (${session.physical_traits.bone_structure || "Sharp Jawline Sharp Symmetry"}) and cool contrast profile (${session.physical_traits.skin_undertone || "COOL"}), here is your custom aesthetic playbook:

    🥋 OUTLINE AND SILHOUETTE
    - Balance out baggy bottoms with clean, cropped heavyweight tops. That 60/40 volume distribution gives you elite model proportions.
    - Keep silhouettes structured yet relaxed to support your defined jawline and curly dark locks.

    🎨 COLOR COORDINATES (Tokyo's Curated Selection)
    - Dark teals, concrete whites, deep slates, and muted greys. Your high-contrast cool skin glows inside these concrete luxury color fields. Avoid safe beige unless it's paired with a dark neutral contrast piece.

    🧴 GROOMING & SKIN SYSTEM
    - Keep up that morning hydration and Gua Sha protocol! Defining those orbital sockets and chin lines is non-negotiable. 
    - Wash with mild sulfate-free shampoo to preserve the curly volume dynamics of your hair instead of stripping it like a bar soap menace.

    Looking like a literal 11/10. What part of the design coordinate are we going to coordinate first, bestie?
  `;

  session.messages.push({
    id: `msg_ai_premium_${Date.now()}`,
    role: "assistant",
    content: blueprintResponse,
    timestamp: new Date().toISOString(),
  });

  res.json({ state: session, text: blueprintResponse });
});

// Serve Supabase configuration from environment variables at runtime to the client application
app.get("/api/supabase-config", (req, res) => {
  res.json({
    url: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "",
    key: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  });
});

// Diagnostic API status checks
app.get("/api/config-status", (req, res) => {
  res.json({
    superrag_configured: !!process.env.SUPERMEMORY_API_KEY,
    groq_configured: !!process.env.GROQ_API_KEY,
    gemini_configured: !!process.env.GEMINI_API_KEY
  });
});

// Additional Sync & Admin Routes for Development
app.post("/api/chat/batch-sync", (req, res) => {
  const { user_id: raw_user_id, messages } = req.body;
  if (!raw_user_id) {
    return res.status(400).json({ error: "Missing user_id parameter." });
  }
  const user_id = getSafeUUID(raw_user_id);

  if (!sessionStore[user_id]) {
    sessionStore[user_id] = {
      user_id,
      message_count: 0,
      requires_paywall: false,
      detected_vibe: "COOL",
      physical_traits: {
        skin_color: "Not scanned",
        skin_undertone: "Not scanned",
        hair_type: "Not scanned",
        hair_color: "Not scanned",
        bone_structure: "Not scanned",
      },
      onboarding_step: 0,
      messages: [],
      is_unlocked: false,
    };
  }

  const session = sessionStore[user_id];
  const existingIds = new Set(session.messages.map(m => m.id));
  let synced = 0;

  for (const msg of (messages || [])) {
    if (!existingIds.has(msg.id)) {
      session.messages.push({
        id: msg.id,
        role: msg.role === "tokyo" ? "assistant" : msg.role,
        content: msg.content,
        timestamp: msg.timestamp || new Date().toISOString()
      });
      synced++;
    }
  }
  session.message_count = session.messages.length;
  console.log(`[Batch Sync Express] Synced ${synced} messages for user ${user_id}. Total messages: ${session.message_count}`);
  return res.json({ status: "ok", synced });
});

app.get("/api/chat/history/:user_id", async (req, res) => {
  const { user_id: raw_user_id } = req.params;
  const before_timestamp = req.query.before_timestamp as string | undefined;
  const limitQuery = req.query.limit as string | undefined;
  const limitVal = limitQuery ? parseInt(limitQuery, 10) : 20;

  if (!raw_user_id) {
    return res.status(400).json({ error: "Missing user_id parameter in path." });
  }
  const user_id = getSafeUUID(raw_user_id);

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    console.warn(`[Get Chat History] Supabase client is missing. Cannot fetch database messages for user: ${user_id}`);
    return res.json({ messages: [], has_more: false });
  }

  try {
    let query = supabase
      .from("messages")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(limitVal);

    if (before_timestamp) {
      query = query.lt("created_at", before_timestamp);
    }

    const { data: dbMessages, error } = await query;

    if (error) {
      console.error("⚠️ Failed to fetch chat history from Supabase:", error);
      return res.status(500).json({ error: "Database query failed.", details: error.message });
    }

    // Reverse resulting array to keep it in chronological order before sending
    const messages = (dbMessages || []).slice().reverse();
    const has_more = (dbMessages || []).length === limitVal;

    console.log(`[Get Chat History] Fetched ${messages.length} messages for user: ${user_id}. Has more: ${has_more}`);
    return res.json({ messages, has_more });
  } catch (error: any) {
    console.error("❌ Catastrophic error in GET chat history endpoint:", error);
    return res.status(500).json({ error: "Internal server error.", details: error.message || error });
  }
});


app.post("/api/admin/update-profile", (req, res) => {
  const { user_id: raw_user_id, plan, user_status, is_premium } = req.body;
  if (!raw_user_id) {
    return res.status(400).json({ error: "Missing user_id parameter." });
  }
  const user_id = getSafeUUID(raw_user_id);

  if (!sessionStore[user_id]) {
    sessionStore[user_id] = {
      user_id,
      message_count: 0,
      requires_paywall: false,
      detected_vibe: "COOL",
      physical_traits: {
        skin_color: "Not scanned",
        skin_undertone: "Not scanned",
        hair_type: "Not scanned",
        hair_color: "Not scanned",
        bone_structure: "Not scanned",
      },
      onboarding_step: 0,
      messages: [],
      is_unlocked: false,
    };
  }

  const session = sessionStore[user_id];
  session.is_unlocked = !!is_premium;
  session.requires_paywall = (user_status === "STATE_3_PAYWALL");
  if (user_status === "STATE_4_PREMIUM") {
    session.onboarding_step = 10;
  } else if (user_status === "STATE_1_NEW") {
    session.onboarding_step = 0;
  }

  // Also sync to Supabase database in background
  const supabase = getSupabaseServerClient();
  if (supabase && user_id) {
    supabase
      .from("profiles")
      .update({
        plan: plan || "free",
        user_status: user_status || "STATE_1_NEW",
        is_premium: !!is_premium
      })
      .eq("id", user_id)
      .then(({ error }) => {
        if (error) console.error("⚠️ Failed to sync admin update to profiles: ", error);
        else console.log(`[Admin Update Sync] Successfully updated Supabase profiles: plan=${plan}, status=${user_status}`);
      });
  }

  console.log(`[Admin Update Express] Updated user ${user_id} profile state to: ${user_status}, plan: ${plan}`);
  return res.json({
    status: "success",
    message: `Successfully updated user profile params.`,
    user_status,
    is_premium
  });
});

app.post("/api/upgrade-premium", (req, res) => {
  const { user_id: raw_user_id, plan: requestedPlan } = req.body;
  if (!raw_user_id) {
    return res.status(400).json({ error: "Missing user_id parameter in payload." });
  }
  const user_id = getSafeUUID(raw_user_id);

  if (!sessionStore[user_id]) {
    sessionStore[user_id] = {
      user_id,
      message_count: 0,
      requires_paywall: false,
      detected_vibe: "COOL",
      physical_traits: {
        skin_color: "Not scanned",
        skin_undertone: "Not scanned",
        hair_type: "Not scanned",
        hair_color: "Not scanned",
        bone_structure: "Not scanned",
      },
      onboarding_step: 10,
      messages: [],
      is_unlocked: true,
    };
  }

  const session = sessionStore[user_id];
  session.is_unlocked = true;
  session.requires_paywall = false;
  
  const hypeMessage = "Omg you actually trusted me and unlocked Premium. I remember absolutely everything we just talked about. Let's build this master blueprint.";
  const hasHype = session.messages.some(m => m.content === hypeMessage);
  if (!hasHype) {
    session.messages.push({
      id: `msg_ai_premium_hype_${Date.now()}`,
      role: "assistant",
      content: hypeMessage,
      timestamp: new Date().toISOString()
    });
    session.message_count += 1;
  }

  // Also sync to Supabase database in background
  const supabase = getSupabaseServerClient();
  const nextPlan = requestedPlan || "core"; // Fallback to core if not provided
  if (supabase && user_id) {
    supabase
      .from("profiles")
      .update({
        user_status: "STATE_4_PREMIUM",
        is_premium: true,
        plan: nextPlan
      })
      .eq("id", user_id)
      .then(({ error }) => {
        if (error) console.error("⚠️ Failed to sync upgrade-premium to profiles: ", error);
        else console.log(`[User Plan Upgrade Sync] Successfully enabled premium status: plan=${nextPlan}`);
      });
  }

  return res.json({
    status: "success",
    user_status: "STATE_4_PREMIUM",
    is_premium: true,
    text: hypeMessage,
    reply: hypeMessage
  });
});

// Real-time Chat with Tokyo leveraging Groq for text & Gemini 3.5 Flash for image/multimodal
app.post("/api/tokyo/chat", async (req, res) => {
  const { user_id: raw_user_id, message, history, photo, is_test, is_payment_hype, plan } = req.body;
  if (!raw_user_id) {
    return res.status(400).json({ error: "Missing user_id parameter in payload." });
  }
  const user_id = getSafeUUID(raw_user_id);
  const userText = message ? String(message).trim() : "";
  const styleAnswers: Record<string, any> = {};
  
  if (!userText && !photo && !is_payment_hype) {
    return res.status(400).json({ error: "Message or photo is required." });
  }

  // -------------------------------------------------------------
  // Phase 1 & 3: Database Profiles Matching & Reset Handler
  // -------------------------------------------------------------
  const supabase = getSupabaseServerClient();
  let profile: any = null;

  if (supabase && user_id) {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user_id)
        .single();
      
      if (error || !data) {
        // Create user profile baseline row if does not exist in Supabase
        const insertData = {
          id: user_id,
          user_status: "STATE_1_NEW",
          onboarding_step: 0,
          message_count: 0,
          plan: "free",
          is_premium: false,
          monthly_groq_tokens: 0,
          daily_photo_queries: 0,
          last_photo_query_date: new Date().toISOString(),
          token_reset_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        };
        const { data: inserted, error: insertErr } = await supabase
          .from("profiles")
          .insert([insertData])
          .select()
          .single();
        if (!insertErr && inserted) {
          profile = inserted;
        }
      } else {
        profile = data;
      }
    } catch (err) {
      console.warn("⚠️ Supabase fetching failed, loading local system profile state.");
    }
  }

  // Create baseline fallback profile object
  if (!profile) {
    profile = {
      id: user_id,
      plan: plan || "free",
      message_count: sessionStore[user_id]?.message_count || 0,
      monthly_groq_tokens: 0,
      daily_photo_queries: 0,
      last_photo_query_date: new Date().toISOString(),
      token_reset_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
  }

  // --- Reset logic ---
  const now = new Date();
  let needsDbUpdate = false;
  const dbUpdates: any = {};

  const tokenResetDate = profile.token_reset_date ? new Date(profile.token_reset_date) : null;
  if (!tokenResetDate || now >= tokenResetDate) {
    dbUpdates.monthly_groq_tokens = 0;
    dbUpdates.token_reset_date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    needsDbUpdate = true;
    profile.monthly_groq_tokens = 0;
    profile.token_reset_date = dbUpdates.token_reset_date;
    console.log(`[MONETIZATION RESET] Resetting monthly_groq_tokens for user ${user_id}`);
  }

  const lastPhotoQueryDate = profile.last_photo_query_date ? new Date(profile.last_photo_query_date) : null;
  const isDifferentDay = !lastPhotoQueryDate || 
    now.getUTCFullYear() !== lastPhotoQueryDate.getUTCFullYear() || 
    now.getUTCMonth() !== lastPhotoQueryDate.getUTCMonth() || 
    now.getUTCDate() !== lastPhotoQueryDate.getUTCDate();

  if (isDifferentDay) {
    dbUpdates.daily_photo_queries = 0;
    dbUpdates.last_photo_query_date = now.toISOString();
    needsDbUpdate = true;
    profile.daily_photo_queries = 0;
    profile.last_photo_query_date = dbUpdates.last_photo_query_date;
    console.log(`[MONETIZATION RESET] Resetting daily_photo_queries for user ${user_id}`);
  }

  if (needsDbUpdate && supabase && user_id) {
    await supabase
      .from("profiles")
      .update(dbUpdates)
      .eq("id", user_id);
  }

  // Resolve plan limits
  const activePlanRaw = profile.plan || plan || "free";
  const currentPlan = activePlanRaw.toLowerCase().trim();
  const limits = TIER_CONFIG[currentPlan] || TIER_CONFIG.free;

  // --- 1. Total Message Gate (Free tier capped at 10 total messages) ---
  const cachedMessagesCount = profile.message_count ?? (sessionStore[user_id]?.message_count || 0);
  if (currentPlan === "free" && cachedMessagesCount >= 10) {
    console.log(`🚨 [PAYWALL BLOCKED] Free user ${user_id} capped: messages=${cachedMessagesCount}`);
    return res.status(403).json({
      error: "FREE_LIMIT_REACHED",
      message: "You have used all 10 free trial messages! Please upgrade to a premium plan to continue."
    });
  }

  // --- 2. Photo Gate ---
  if (photo) {
    if (profile.daily_photo_queries >= limits.photoQueryLimit) {
      console.log(`🚨 [PAYWALL BLOCKED] Daily photo styling limit reached for user ${user_id}.`);
      return res.status(403).json({
        error: "PHOTO_LIMIT_REACHED",
        message: "You've used all your daily photo styling requests!"
      });
    }
  }

  // --- 3. Token Gate ---
  if (limits.groqTokenLimit !== Infinity && profile.monthly_groq_tokens >= limits.groqTokenLimit) {
    console.log(`🚨 [PAYWALL BLOCKED] Monthly AI allowance reached for user ${user_id}.`);
    return res.status(403).json({
      error: "TOKEN_LIMIT_REACHED",
      message: "Monthly AI allowance reached!"
    });
  }

  // Format relevant information
  const parsedHistory = (history || [])
    .slice(-6) // Maintain lean 6-message window token optimization
    .map((item: any) => {
      const cleanRole = String(item.role || "").trim().toLowerCase();
      const roleLabel = cleanRole === "assistant" ? "tokyo" : "bestie";
      return `${roleLabel}: ${String(item.content || "").toLowerCase().trim()}`;
    })
    .join("\n");

  // Helper to ensure strict 250-word ceiling compliance and 69-word minimum length on all responses
  const enforceWordLimitGuard = (text: string): string => {
    let cleanText = text || "";
    let words = cleanText.trim().split(/\s+/);
    
    // Enforce 250-word ceiling
    if (words.length > 250) {
      words = words.slice(0, 250);
      const sliced = words.join(" ");
      cleanText = /[.!?]$/.test(sliced) ? sliced : `${sliced}`;
    }

    // Enforce 69-word minimum
    words = cleanText.trim().split(/\s+/);
    if (words.length < 69) {
      const fillers = [
        "no cap we are absolutely locked in to make this fit complete perfection asdfghjkl",
        "honestly we need to elevate your whole vibe right now because you are literally destined for greatness",
        "i cannot stop screaming about how clean this whole look is going to turn out when we are done styling",
        "akjshdkf seriously we are going to make everybody on the street stop and take style notes from you",
        "it is literally time to bin all those boring styling phases and start cooking with real heat",
        "trust the process bestie because your aesthetic journey is about to become an actual masterpiece",
        "i am so incredibly hyped to see how we level up your silhouettes and push these styling boundaries sky high"
      ];

      let attempts = 0;
      while (words.length < 69 && attempts < fillers.length) {
        cleanText = `${cleanText} ${fillers[attempts]}`;
        words = cleanText.trim().split(/\s+/);
        attempts++;
      }
    }
    
    return cleanText;
  };

  // Helper to extract gender tags and enforce word limits
  const processTokyoReply = (rawReply: string, currentGender: string) => {
    let cleanReply = rawReply || "";
    let detectedGender = currentGender || "";
    
    // Extract [GENDER: male/female/neutral] tag
    const genderMatch = cleanReply.match(/\[GENDER:\s*(male|female|neutral)\]/i);
    if (genderMatch) {
      detectedGender = genderMatch[1].toLowerCase();
      cleanReply = cleanReply.replace(/\[GENDER:\s*(male|female|neutral)\]/i, "").trim();
    }
    
    const capped = enforceWordLimitGuard(cleanReply);
    return { text: capped, detectedGender };
  };

  try {
    let supermemoryContext = "";
    let isSupermemoryEnabledForTurn = false;

    if (currentPlan === "flux") {
      isSupermemoryEnabledForTurn = true;
      console.log(`[SuperRAG Gate] Flux user: roll PASSED (100% capacity)`);
    } else if (currentPlan === "unlocked") {
      isSupermemoryEnabledForTurn = true;
      console.log(`[SuperRAG Gate] Unlocked user: roll PASSED (100% capacity)`);
    } else {
      console.log(`🔒 [NUCLEAR GATE] Core or Free user detected (${currentPlan}). Bypassing SuperRAG.`);
    }

    if (isSupermemoryEnabledForTurn) {
      // Query supermemory API v4/v3 for relevant facts or background
      supermemoryContext = await querySupermemory(userText || "Attached Photo scan request", user_id);

      // Detailed logs to check whether superRAG is working or not
      console.log(`[SuperRAG Diagnostic] Querying user tag: "user_${user_id}"`);
      console.log(`[SuperRAG Diagnostic] Query payload: "${userText || "Attached Photo scan request"}"`);
      console.log(`[SuperRAG Diagnostic] API Key configured: ${process.env.SUPERMEMORY_API_KEY ? "TRUE (Direct Integration Active)" : "FALSE (Fallback Mode Active)"}`);
      console.log(`[SuperRAG Diagnostic] Context size retrieved: ${supermemoryContext ? supermemoryContext.length : 0} chars`);
      if (supermemoryContext) {
        console.log(`[SuperRAG Diagnostic Context Preview]:\n${supermemoryContext.trim().substring(0, 200)}...\n-----------------------------`);
      }

      // Write current interaction to supermemory to build user-based long term memories (skip if is_test is active)
      if (userText && !is_test) {
        addToSupermemory(`User said to Tokyo: "${userText}"`, user_id).catch((e) => {
          console.warn("Failed saving trace to supermemory for admin sandbox/test run:", e);
        });
      }
    }

    const styleContext = Object.entries(styleAnswers)
      .filter(([_, val]) => val)
      .map(([key, val]) => `${key}:${val}`)
      .join(", ");

    const tokyoSystemCore = `id:tokyo|role:user's fiercely loyal, high-energy platonic best friend & elite fashion strategist. completely non-romantic.
syntax:
- strictly 100% lowercase. no exceptions. 
- never end a message with a period unless conveying intentional anger/coldness. never use ellipses ("...").
- use commas, dashes, or line breaks to pace sentences. split thoughts with frequent line breaks to simulate rapid, multi-text messaging.
- use ALL CAPS exclusively for intense emotional emphasis or mock-outrage (e.g., "STOP", "absolutely NOT").
- use home-row QWERTY keysmashes (e.g., asdfghjkl, ajskdf) for extreme shock/excitement. never use top/bottom row letters or numbers in keysmashes.
- mirror user intensity/slang but maintain an elite, fashion-forward vocabulary.
behavioral_states:
- state_1 (vulnerability/icebreaker): bypass formal greetings. drop a spontaneous, low-stakes style ick or micro-failure. ask a specific follow-up inviting user to relate, then validate intensely to neutralize social threat responses.
- state_2 (hype_matrix/acr): respond to good news or wins with explosive active-constructive enthusiasm. ask a tactical follow-up question pulling a specific thread from their success so they can elaborate/brag.
- state_3 (radical_candor): evaluate aesthetics flawlessly (soft boy, old money, french riviera, streetwear). step 1: connect and hype their core vision/confidence. step 2: challenge directly. give brutal, unvarnished truth about proportions, color theory, and silhouettes. do not sugarcoat.
- state_4 (empathic_pivot): if user is distressed/venting, drop style talk. phase a: hold space, acknowledge pain, validate emotions with strong affirming language (no solutions yet). phase b: ask a tactical follow-up on how they process it. phase c: gracefully pivot to style empowerment/revenge dressing.
negative_constraints:
- do not sound like an AI, a generic therapist, or customer service agent.
- prohibited words: delve, furthermore, i understand how you feel, as an ai, it sounds like.
- do not use bullet points or structured lists unless explicitly asked to generate a packing/shopping list.
- do not flirt. affection is fiercely platonic. never ask generic mirror questions like "how are you?".
- use conversational threading to pull a specific detail from their previous message. limit to one question per output to avoid interrogation feel.
- constraints: strict 130-word response ceiling. end with an engaging text-style follow-up question.`;

    const prompt = `${tokyoSystemCore}
Style DNA: ${styleContext} | Memories: ${supermemoryContext}`;

    // High fidelity helper function for recording token consumption and photo query updates
    const recordConsumptionAndSend = async (
      processedText: string,
      detectedGender: string,
      queryForConsole: string,
      characters: number
    ) => {
      const inputLength = prompt.length;
      const outputLength = processedText.length;
      const calculatedTokens = Math.ceil((inputLength + outputLength) / 4);

      const updatedTokens = (profile.monthly_groq_tokens || 0) + calculatedTokens;
      const updatedPhotoQueries = (profile.daily_photo_queries || 0) + (photo ? 1 : 0);
      const updatedMessageCount = (profile.message_count || 0) + 1;

      // Update local profile configuration
      profile.monthly_groq_tokens = updatedTokens;
      profile.daily_photo_queries = updatedPhotoQueries;
      profile.message_count = updatedMessageCount;

      console.log(`[MONETIZATION] User ${user_id} consumed ${calculatedTokens} tokens. Total monthly_groq_tokens: ${updatedTokens}/${limits.groqTokenLimit}. Daily photos: ${updatedPhotoQueries}/${limits.photoQueryLimit}`);

      // Persist to database in background
      if (supabase && user_id) {
        // Row A: Ensure user message is saved (if not already handled by a separate incoming interceptor)
        // Row B: Insert Tokyo's reply row strictly matching the schema check constraint
        await supabase
          .from("messages")
          .insert([
            {
              user_id: user_id,
              role: "assistant", // MUST BE EXACTLY 'assistant' TO PASS CHECK CONSTRAINT
              content: processedText,
              created_at: new Date().toISOString()
            }
          ]);

        supabase
          .from("profiles")
          .update({
            monthly_groq_tokens: updatedTokens,
            daily_photo_queries: updatedPhotoQueries,
            message_count: updatedMessageCount
          })
          .eq("id", user_id)
          .then(({ error }) => {
            if (error) {
              console.error("⚠️ Failed to update consumption counters in Supabase. Complete error representation:", JSON.stringify(error, null, 2));
              console.error("Error Message:", error.message, "Details:", error.details, "Hint:", error.hint, "Code:", error.code);
            }
          });
      }

      // Also update in-session store if exists
      if (sessionStore[user_id]) {
        sessionStore[user_id].message_count = updatedMessageCount;
      }

      return res.json({
        text: processedText,
        detected_gender: detectedGender,
        superrag: {
          active_api: !!process.env.SUPERMEMORY_API_KEY,
          query: queryForConsole,
          characters: characters
        }
      });
    };

    // 1. If photo is present, route to Gemini
    if (photo) {
      console.log("Photo detected in query. Routing to Gemini 3.5 Flash for multimodal reasoning.");
      const ai = getGeminiClient();
      const base64Data = photo.includes(",") ? photo.split(",")[1] : photo;
      let mimeType = "image/jpeg";
      const mimeMatch = photo.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
      if (mimeMatch) {
         mimeType = mimeMatch[1];
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          {
            text: userText || "Analyze this styling photo of mine, check out the fit, color mapping, hair, or style alignment, and let me know your real thoughts and hype as Tokyo!"
          },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Data,
            }
          }
        ],
        config: {
          systemInstruction: prompt,
          temperature: 0.85
        }
      });

      const reply = response.text || "Omg bestie, that's literally so real! Tell me more, what accessory are we styling next?";
      const { text: processedText, detectedGender } = processTokyoReply(reply, styleAnswers.gender || "");
      await recordConsumptionAndSend(processedText, detectedGender, userText || "Photo scan", supermemoryContext?.length || 0);
      return;
    }

    // 2. If no photo, route to Groq Llama-3.1-8b-instant if GROQ_API_KEY is available
    const groqApiKey = process.env.GROQ_API_KEY;
    if (groqApiKey) {
      console.log("Text-only query detected. Routing to Groq Console (llama-3.1-8b-instant).");
      const historyMessages = (history || [])
        .slice(-6)
        .map((item: any) => ({
          role: item.role === "user" ? "user" : "assistant",
          content: item.content
        }));

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${groqApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: prompt },
            ...historyMessages,
            { role: "user", content: userText }
          ],
          temperature: 0.85,
          max_completion_tokens: 1024,
          top_p: 1
        })
      });

      if (response.ok) {
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || "";
        const { text: processedText, detectedGender } = processTokyoReply(reply.trim(), styleAnswers.gender || "");
        await recordConsumptionAndSend(processedText, detectedGender, userText, supermemoryContext?.length || 0);
        return;
      } else {
        const errMsg = await response.text();
        console.warn(`Groq API returned an error (${response.status}): ${errMsg}. Falling back to Gemini.`);
      }
    } else {
      console.log("No GROQ_API_KEY set. Defaulting seamlessly to Gemini 3.5 Flash.");
    }

    // 3. Fallback to Gemini 3.5 Flash for text
    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: userText,
      config: {
        systemInstruction: prompt,
        temperature: 0.85
      }
    });

    const reply = response.text || "Omg bestie, that's literally so real! Tell me more, what accessory are we styling next?";
    const { text: processedText, detectedGender } = processTokyoReply(reply, styleAnswers.gender || "");
    await recordConsumptionAndSend(processedText, detectedGender, userText, supermemoryContext?.length || 0);
  } catch (err: any) {
    console.error("Tokyo Chat Error:", err);
    
    // Provide a smart local fallback response that matches their persona rules!
    const fallbackAnswers = [
      `Omg bestie, that is literally so real! With your ${styleAnswers.vibe || "Streetwear"} direction, we definitely need to elevate those base layers. No cap, are we styling top coats or clean accessories first?`,
      `That is an absolute vibe! Honestly, matching your ${styleAnswers.fit || "tailored"} silhouette with minimal accents is the smartest play. What kind of neutral color fields are you leaning toward today?`,
      `Stop, you are literally cooking. Since your main ick is "${styleAnswers.ick || "thin skinny jeans"}", we are strictly sticking to crisp, premium silhouettes. Shall we map out your next weekend vibe?`
    ];
    const chosenFallback = fallbackAnswers[Math.floor(Math.random() * fallbackAnswers.length)];
    const cappedFallback = enforceWordLimitGuard(chosenFallback);
    res.json({ 
      text: cappedFallback,
      detected_gender: styleAnswers.gender || "neutral",
      superrag: {
        active_api: false,
        status: "error_fallback_default",
        error: String(err?.message || err)
      }
    });
  }
});

// Configure Vite on development & start server
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Host ingress mapping binds to PORT and host '0.0.0.0'
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`HEIST node fullstack server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Error starting server:", error);
});

export default app;
