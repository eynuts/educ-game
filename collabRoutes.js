
const express = require("express");
const router = express.Router();
const multer = require("multer");
const streamifier = require("streamifier");
const path = require("path");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");

// ---------------------------------------------
// CONNECT TO SEPARATE MONGODB FOR COLLABEDU
// ---------------------------------------------
// --- Hardcoded CollabEDU MongoDB ---
const COLL_MONGO_URI = "mongodb+srv://candariarvin_db_user:AO20gbszBcVo4zTe@cluster0.l0itzpe.mongodb.net/?appName=Cluster0";
const COLL_DB = "collabedu_data";

const collabClient = new MongoClient(COLL_MONGO_URI);

(async () => {
    try {
        await collabClient.connect();
        console.log("✅ CollabEDU database connected");
        router.db = collabClient.db(COLL_DB);
    } catch (err) {
        console.error("❌ Failed to connect CollabEDU database:", err);
    }
})();

const cloudinary = require("cloudinary").v2;
// Configure Cloudinary directly
cloudinary.config({
    cloud_name: "dqvl8guoh",
    api_key: "771493849868655",
    api_secret: "FzVif_uce4B7CaYfjTBSpge_6t4",
});

// Check Cloudinary connection on server start
try {
  const config = cloudinary.config();
  if (config.cloud_name && config.api_key && config.api_secret) {
    console.log("✅ Cloudinary is configured and ready");
  } else {
    console.warn("⚠ Cloudinary is not fully configured");
  }
} catch (err) {
  console.error("❌ Cloudinary connection failed:", err);
}


// ========================================================
// FUNCTIONS
// ========================================================

// Generate unique invite code
function generateInviteCode() {
    return crypto.randomBytes(4).toString("hex").toUpperCase(); // Example: "A3F91B20"
}

/**
 * Helper function to fetch user details by UID
 * @param {string} uid - Firebase User ID
 * @returns {object|null} - User object with uid, displayName, email
 */
async function getUserDetails(uid) {
    if (!router.db) return null;
    return await router.db.collection("users").findOne({ uid }, { projection: { uid: 1, displayName: 1, email: 1, _id: 0 } });
}

/**
 * Helper function to fetch a group, replacing member UIDs with full user objects
 * @param {string|ObjectId} groupId - The ID of the group
 * @returns {object|null} - Group object with populated members
 */
 async function fetchGroupWithMembers(groupId) {
    const group = await router.db.collection("groups").findOne({ _id: new ObjectId(groupId) });
    if (!group) return null;

    if (!Array.isArray(group.members)) group.members = [];

    const memberUids = [...new Set(group.members)]; // remove duplicates
    const memberDetails = await router.db.collection("users")
        .find({ uid: { $in: memberUids } })
        .project({ uid: 1, displayName: 1, email: 1, _id: 0 })
        .toArray();

    group.members = memberDetails;
    return group;
}



// ========================================================
// USERS (Firebase UID)
// ========================================================

// Create or sync a user
// ... (No change to /users POST route)

// Create or sync a user
router.post("/users", async (req, res) => {
    const { uid, displayName, email } = req.body;

    if (!uid || !displayName || !email)
        return res.status(400).json({ error: "Missing uid, displayName, or email" });

    try {
        const userCol = router.db.collection("users");

        let user = await userCol.findOne({ uid });

        if (!user) {
            let inviteCode;
            while (true) {
                inviteCode = generateInviteCode();
                const exists = await userCol.findOne({ inviteCode });
                if (!exists) break;
            }

            await userCol.insertOne({
                uid,
                displayName,
                email,
                inviteCode,
                createdAt: new Date(),
            });
        }

        user = await userCol.findOne({ uid });
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create/find user" });
    }
});

// ========================================================
// GROUPS
// ========================================================

// Create a group
// Create a group
router.post("/groups", async (req, res) => {
    const { name, leaderUid } = req.body;

    if (!name || !leaderUid)
        return res.status(400).json({ error: "Missing group name or leaderUid" });

    try {
        // Store only UIDs in the DB
        const group = {
            name,
            leaderUid,
            members: [leaderUid], // ✅ only store UID
            createdAt: new Date(),
        };

        const result = await router.db.collection("groups").insertOne(group);
        group._id = result.insertedId;

        // Populate members for response (frontend display)
        const leaderDetails = await getUserDetails(leaderUid);
        const populatedGroup = { ...group, members: leaderDetails ? [leaderDetails] : [] };

        res.json(populatedGroup);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create group" });
    }
});

// Get all groups for a user
router.get("/users/:uid/groups", async (req, res) => {
    const { uid } = req.params;

    try {
        // 1. Fetch raw group documents
        const rawGroups = await router.db
            .collection("groups")
            .find({ members: uid })
            .toArray();

        // 2. Map and populate members for each group
        const populatedGroups = await Promise.all(
            rawGroups.map(async (group) => {
                const memberUids = group.members;
                const memberDetails = await router.db.collection("users")
                    .find({ uid: { $in: memberUids } })
                    .project({ uid: 1, displayName: 1, _id: 0 })
                    .toArray();
                
                // Return group with populated member objects
                return { ...group, members: memberDetails };
            })
        );

        res.json(populatedGroups);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch groups" });
    }
});
// GET a single group by ID (NEW ROUTE)
router.get("/groups/:groupId", async (req, res) => {
    const { groupId } = req.params;
    try {
        // Fetch group with members already populated
        const group = await fetchGroupWithMembers(groupId);

        if (!group) {
            return res.status(404).json({ error: "Group not found" });
        }

        // Already fully populated by fetchGroupWithMembers
        res.json(group);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch group details" });
    }
});

// DELETE a group (only leader can delete)
router.delete("/groups/:groupId", async (req, res) => {
    const { groupId } = req.params;
    const { uid } = req.body; // the user attempting the deletion

    if (!uid) return res.status(400).json({ error: "Missing UID" });

    try {
        const group = await router.db.collection("groups").findOne({ _id: new ObjectId(groupId) });
        if (!group) return res.status(404).json({ error: "Group not found" });

        if (group.leaderUid !== uid) {
            return res.status(403).json({ error: "Only the group leader can delete this group" });
        }

        // Delete the group
        await router.db.collection("groups").deleteOne({ _id: new ObjectId(groupId) });

        // Optional: delete related tasks, chat, files
        await router.db.collection("tasks").deleteMany({ groupId });
        await router.db.collection("chat").deleteMany({ groupId });
        await router.db.collection("groupFiles").deleteMany({ groupId });

        res.json({ success: true, message: "Group deleted successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete group" });
    }
});

// ========================================================
// INVITE USERS
// ========================================================

// Generic function to invite user (by UID/email/inviteCode)
// ❗ MODIFIED: This function now uses the new fetchGroupWithMembers to return a populated group
async function inviteUserToGroup(groupId, user) {
    const group = await router.db.collection("groups").findOne({ _id: new ObjectId(groupId) });
    if (!group) throw new Error("Group not found");

    if (!Array.isArray(group.members)) group.members = [];

    // Add UID if not already present
    if (!group.members.includes(user.uid)) {
        await router.db.collection("groups").updateOne(
            { _id: new ObjectId(groupId) },
            { $addToSet: { members: user.uid } } // ✅ prevents duplicates in DB
        );
    }

    // Fetch group with full user objects for response
    const populatedGroup = await fetchGroupWithMembers(groupId);
    return populatedGroup;
}


// Invite by email or inviteCode
router.post("/groups/:groupId/invite", async (req, res) => {
    const { groupId } = req.params;
    const { email, inviteCode } = req.body;

    try {
        let user = null;

        if (email) user = await router.db.collection("users").findOne({ email });
        if (!user && inviteCode)
            user = await router.db.collection("users").findOne({ inviteCode });

        if (!user)
            return res.status(404).json({ error: "User not found" });

        const updatedGroup = await inviteUserToGroup(groupId, user);
        res.json({ success: true, group: updatedGroup });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to invite user" });
    }
});

// Invite by UID
router.post("/groups/:groupId/invite-uid", async (req, res) => {
    const { groupId } = req.params;
    const { uid } = req.body;

    if (!uid) return res.status(400).json({ error: "Missing UID" });

    try {
        const user = await router.db.collection("users").findOne({ uid });
        if (!user) return res.status(404).json({ error: "User not found" });

        const updatedGroup = await inviteUserToGroup(groupId, user);
        res.json({ success: true, group: updatedGroup });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to invite user by UID" });
    }
});

// ========================================================
// TASKS
// ... (No change)
// ========================================================

// Get tasks for a group
router.get("/groups/:groupId/tasks", async (req, res) => {
    try {
        const tasks = await router.db
            .collection("tasks")
            .find({ groupId: req.params.groupId })
            .toArray();

        res.json(tasks);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch tasks" });
    }
});

// Add a task
router.post("/groups/:groupId/tasks", async (req, res) => {
    const { title, dueDate, assignedUid } = req.body;

    if (!title || !dueDate || !assignedUid)
        return res.status(400).json({ error: "Missing fields" });

    try {
        const task = {
            title,
            dueDate,
            assignedUid,
            groupId: req.params.groupId,
            completed: false,
            createdAt: new Date(),
        };

        const result = await router.db.collection("tasks").insertOne(task);
        task._id = result.insertedId;

        res.json(task);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add task" });
    }
});

// Update task completion
router.patch("/groups/:groupId/tasks/:taskId", async (req, res) => {
    const { completed } = req.body;

    try {
        const result = await router.db
            .collection("tasks")
            .findOneAndUpdate(
                { _id: new ObjectId(req.params.taskId) },
                { $set: { completed } },
                { returnDocument: "after" }
            );

        res.json(result.value);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update task" });
    }
});

// ========================================================
// CHAT
// ... (No change)
// ========================================================

router.get("/groups/:groupId/chat", async (req, res) => {
    try {
        const messages = await router.db
            .collection("chat")
            .find({ groupId: req.params.groupId })
            .sort({ createdAt: 1 })
            .toArray();

        res.json(messages);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch chat" });
    }
});

router.post("/groups/:groupId/chat", async (req, res) => {
    const { uid, content } = req.body;

    if (!uid || !content)
        return res.status(400).json({ error: "Missing uid or content" });

    try {
        const user = await router.db.collection("users").findOne({ uid });

        if (!user)
            return res.status(404).json({ error: "User not found" });

        const message = {
            uid,
            userName: user.displayName,
            content,
            groupId: req.params.groupId,
            createdAt: new Date(),
        };

        const result = await router.db.collection("chat").insertOne(message);
        message._id = result.insertedId;

        res.json(message);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to send message" });
    }
});
// ========================================================
// FILE UPLOAD → Cloudinary integration
// ========================================================

const uploadMemory = multer({ storage: multer.memoryStorage() });

// ⬇️⬇️ UPDATED POST ROUTE + FIXED EXTENSIONS ⬇️⬇️
router.post("/groups/:groupId/files", uploadMemory.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!router.db) return res.status(500).json({ error: "Database not ready" });

    try {
        const ext = path.extname(req.file.originalname); // .png, .jpg, .pdf, etc.
        const baseName = Date.now().toString();

        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: `groups/${req.params.groupId}`,
                resource_type: "auto",
                public_id: baseName,
                format: ext.replace(".", ""),  // << VERY IMPORTANT: prevents RAW downloads
            },
            async (err, uploadedFile) => {
                if (err) {
                    console.error("Cloudinary upload error:", err);
                    return res.status(500).json({ error: "Cloud upload failed" });
                }

                console.log("File uploaded to Cloudinary:", uploadedFile.secure_url);

                const fileDoc = {
                    fileName: uploadedFile.public_id + ext,
                    url: uploadedFile.secure_url,
                    originalName: req.file.originalname,
                    groupId: req.params.groupId,
                    uploadedAt: new Date(),
                };

                const dbResult = await router.db.collection("groupFiles").insertOne(fileDoc);
                fileDoc._id = dbResult.insertedId;

                res.json(fileDoc);
            }
        );

        streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to upload file" });
    }
});


// ⬇️⬇️ NEW ROUTE — THIS FIXES FILES DISAPPEARING AFTER RESTART ⬇️⬇️
router.get("/groups/:groupId/files", async (req, res) => {
    try {
        const files = await router.db
            .collection("groupFiles")
            .find({ groupId: req.params.groupId })
            .sort({ uploadedAt: 1 })
            .toArray();

        res.json(files);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch files" });
    }
});

  


module.exports = router;