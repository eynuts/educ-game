require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("cloudinary").v2;
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// --- Cloudinary configuration ---
cloudinary.config({
  cloud_name: "dqvl8guoh",
  api_key: "771493849868655",
  api_secret: "FzVif_uce4B7CaYfjTBSpge_6t4",
});

// --- Multer memory storage ---
const uploadMemory = multer({ storage: multer.memoryStorage() });

// --- MongoDB setup ---
const client = new MongoClient(process.env.MONGO_URI);
let noteverseDb, collabDb;

client.connect()
  .then(() => {
    noteverseDb = client.db("noteverseDB");
    collabDb = client.db("collabeduDB");

    app.locals.db = noteverseDb;
    app.locals.collabDb = collabDb;

    console.log("✅ Noteverse MongoDB connected");
    console.log("✅ CollabEDU MongoDB connected");
  })
  .catch(err => console.error("MongoDB connection error:", err));

// --- Noteverse Routes ---

// Upload a note
app.post("/api/notes", uploadMemory.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const { title, description, uploader } = req.body;
    if (!title || !description || !uploader)
      return res.status(400).json({ message: "Missing fields" });

    const ext = path.extname(req.file.originalname); // .pdf, .docx, .png, etc.
    const publicId = `${Date.now()}-${req.file.originalname.split('.')[0]}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "noteverse_files",
        resource_type: "auto",
        public_id: publicId,
        format: ext.replace(".", ""),
      },
      async (err, uploadedFile) => {
        if (err) {
          console.error("Cloudinary upload error:", err);
          return res.status(500).json({ error: "Upload failed" });
        }

        const newNote = {
          title,
          description,
          uploader,
          fileName: req.file.originalname,
          fileUrl: uploadedFile.secure_url,
          likes: 0,
          createdAt: new Date(),
        };

        const result = await noteverseDb.collection("notes").insertOne(newNote);
        newNote._id = result.insertedId;

        res.json(newNote);
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Get all notes
app.get("/api/notes", async (req, res) => {
  try {
    const notes = await noteverseDb.collection("notes").find().sort({ createdAt: -1 }).toArray();
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch notes" });
  }
});

// Like a note
app.post("/api/notes/:id/like", async (req, res) => {
  try {
    const id = req.params.id;
    const result = await noteverseDb
      .collection("notes")
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $inc: { likes: 1 } },
        { returnDocument: "after" }
      );
    res.json(result.value);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to like note" });
  }
});

// DELETE a note (also remove from Cloudinary)
app.delete("/api/notes/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const note = await noteverseDb.collection("notes").findOne({ _id: new ObjectId(id) });
    if (!note) return res.status(404).json({ message: "Note not found" });

    // Remove from Cloudinary
    const publicIdMatch = note.fileUrl.match(/\/([^/]+)\.[^/.]+$/);
    if (publicIdMatch) {
      const publicId = `noteverse_files/${publicIdMatch[1]}`;
      await cloudinary.uploader.destroy(publicId);
    }

    await noteverseDb.collection("notes").deleteOne({ _id: new ObjectId(id) });
    res.json({ message: "Note deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// Download a note via Cloudinary redirect
app.get("/api/notes/:id/download", async (req, res) => {
  const id = req.params.id;
  try {
    const note = await noteverseDb.collection("notes").findOne({ _id: new ObjectId(id) });
    if (!note) return res.status(404).send('Note not found in database.');
    res.redirect(note.fileUrl);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error or invalid ID." });
  }
});

// Placeholder for AI quiz/flashcard generation
app.post("/api/generate", async (req, res) => {
  const { noteId, type } = req.body;
  try {
    const note = await noteverseDb.collection("notes").findOne({ _id: new ObjectId(noteId) });
    if (!note) return res.status(404).json({ message: "Note not found" });
    res.json({ content: `Generated ${type} from "${note.title}"` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate content" });
  }
});

// --- Add quiz/flashcard routes ---
const quizRoutes = require('./quizRoutes');
app.use('/api/quiz', quizRoutes);

// --- Add CollabEDU routes ---
const collabRoutes = require('./collabRoutes');
app.use('/api/collab', collabRoutes);

// ReviewHub routes
const reviewHubAPI = require("./reviewHubAPI");
app.use("/api/reviewhub", reviewHubAPI);

// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
