const express = require("express");
const router = express.Router();
const { MongoClient } = require("mongodb");
require("dotenv").config();

// --- GEMINI Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!GEMINI_API_KEY) {
  console.error("❌ ERROR: Missing GEMINI_API_KEY in .env");
}

// --- MongoDB Setup (Serverless-friendly) ---
const client = new MongoClient(process.env.MONGO_URI);
let collabDb;

async function getDb() {
  if (!collabDb) {
    await client.connect();
    collabDb = client.db("collabedu"); // replace with your DB name
  }
  return collabDb;
}

// --- POST /api/reviewhub/generate ---
router.post("/generate", async (req, res) => {
  const { subject, count } = req.body;

  if (!subject) return res.status(400).json({ error: "Missing subject" });

  const questionCount = count || 10;

  const prompt = `
You are a professional question generator for the **${subject} Board Exam**.

Generate EXACTLY **${questionCount} multiple-choice questions** for the subject:

**${subject}**

For EACH question return this structure:

{
  "question": "string",
  "choices": {
    "A": "string",
    "B": "string",
    "C": "string",
    "D": "string"
  },
  "answer": "A",
  "explanation": "string"
}

Return STRICT JSON ONLY — NO MARKDOWN, NO COMMENTS, NO EXTRA TEXT.
The final output must be a JSON array of objects.
`;

  try {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const requestBody = { contents: [{ parts: [{ text: prompt }] }] };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errTxt = await response.text();
      console.error("Gemini API Error:", errTxt);
      return res.status(500).json({ error: "Gemini API request failed" });
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    let text = candidate?.content?.parts
      ? candidate.content.parts.map((p) => p.text).join("")
      : JSON.stringify(candidate);

    // Cleanup code blocks
    const cleaned = text.trim().replace(/```json/gi, "").replace(/```/g, "");

    // --- SAFE JSON PARSER ---
    let parsed = [];
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.warn("Normal JSON parse failed. Trying fallback...");
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch (err2) {
          console.error("Fallback parse failed:", err2);
        }
      }
    }

    return res.json({ questions: parsed });
  } catch (err) {
    console.error("❌ ReviewHub Generation Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// --- POST /api/reviewhub/save-score ---
router.post("/save-score", async (req, res) => {
  const { exam, topicId, score, maxScore } = req.body;
  if (!exam || topicId == null || score == null || maxScore == null) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const db = await getDb();
    const history = db.collection("quizHistory");

    const topicKey = `${exam}-${topicId}`;
    await history.updateOne(
      { topicKey },
      {
        $push: {
          scores: {
            score,
            maxScore,
            date: new Date(),
            questions: maxScore
          }
        }
      },
      { upsert: true }
    );

    res.json({ message: "Score saved successfully" });
  } catch (err) {
    console.error("❌ Save Score Error:", err);
    res.status(500).json({ error: "Failed to save score" });
  }
});

// --- GET /api/reviewhub/average-score ---
router.get("/average-score", async (req, res) => {
  const { exam, topicId } = req.query;
  if (!exam || topicId == null) {
    return res.status(400).json({ error: "Missing required query parameters" });
  }

  try {
    const db = await getDb();
    const history = db.collection("quizHistory");

    const topicKey = `${exam}-${topicId}`;
    const doc = await history.findOne({ topicKey });

    if (!doc || !doc.scores?.length) return res.json({ average: 0 });

    const last10 = doc.scores.slice(-10);
    const totalScore = last10.reduce((a, s) => a + s.score, 0);
    const totalMax = last10.reduce((a, s) => a + s.maxScore, 0);
    const average = Math.round((totalScore / totalMax) * 100);

    res.json({ average });
  } catch (err) {
    console.error("❌ Get Average Score Error:", err);
    res.status(500).json({ error: "Failed to get average score" });
  }
});

// --- GET /api/reviewhub/dashboard-stats ---
router.get("/dashboard-stats", async (req, res) => {
  const { exam } = req.query;
  if (!exam) return res.status(400).json({ error: "Missing exam parameter" });

  try {
    const db = await getDb();
    const history = db.collection("quizHistory");

    const docs = await history
      .find({ topicKey: { $regex: `^${exam}-` } })
      .toArray();

    let topicsCompleted = 0;
    let totalTopics = docs.length;
    let questionsAnswered = 0;

    docs.forEach((doc) => {
      if (doc.scores?.length) {
        topicsCompleted++;
        doc.scores.forEach((s) => {
          questionsAnswered += s?.questions || 0;
        });
      }
    });

    res.json({ topicsCompleted, totalTopics, questionsAnswered });
  } catch (err) {
    console.error("❌ Dashboard Stats Error:", err);
    res.status(500).json({ error: "Failed to get dashboard stats" });
  }
});

module.exports = router;
