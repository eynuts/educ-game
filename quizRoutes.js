const express = require('express');
const router = express.Router();
const { ObjectId, MongoClient } = require('mongodb');
require('dotenv').config();

// MongoDB setup
const client = new MongoClient(process.env.MONGO_URI);
let db;

client.connect()
  .then(() => {
    db = client.db("noteverseDB");
    console.log("QuizRoutes: connected to MongoDB");
  })
  .catch(err => {
    console.error("QuizRoutes MongoDB connection error:", err);
  });

// POST /api/quiz/generate
router.post('/generate', async (req, res) => {
  const { noteId, type } = req.body;

  if (!noteId || !type) {
    return res.status(400).json({ error: "Missing noteId or type" });
  }

  try {
    const note = await db.collection("notes").findOne({ _id: new ObjectId(noteId) });
    if (!note) {
      return res.status(404).json({ error: "Note not found" });
    }

    const prompt = `
You are an AI tutor.

Create a ${type} based ONLY on this text:

"${note.description}"

FORMAT RULES (MUST FOLLOW):
-----------------------------------
If Quiz:
Return ONLY this JSON format:
{
  "content": [
    {
      "question": "string",
      "options": ["A","B","C","D"],
      "correct_answer": "string"
    }
  ]
}

If Flashcards:
Return ONLY:
{
  "content": [
    {
      "term": "string",
      "definition": "string"
    }
  ]
}

Generate exactly 5 items.
NO markdown.
NO explanations.
JSON ONLY.
-----------------------------------
`;

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const apiRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!apiRes.ok) {
      const errTxt = await apiRes.text();
      console.error("Gemini error:", errTxt);
      return res.status(500).json({ error: "Gemini API failed" });
    }

    const data = await apiRes.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const cleaned = raw
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error("JSON parse failed:", err);
      return res.status(500).json({ error: "Invalid JSON from AI", raw });
    }

    // Auto-fix for array-only responses
    if (!parsed.content) {
      if (Array.isArray(parsed)) {
        parsed = { content: parsed };
      } else {
        return res.status(500).json({ error: "AI response missing content", raw });
      }
    }

    return res.json(parsed);

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
