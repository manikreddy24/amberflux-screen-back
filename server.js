// backend/server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json()); // Allow the server to parse JSON data

// Ensure the 'uploads' directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // Save files here
  },
  filename: function (req, file, cb) {
    // Create a unique filename to avoid overwrites
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'recording-' + uniqueSuffix + '.webm');
  }
});
const upload = multer({ storage: storage });

// Initialize SQLite Database
const db = new sqlite3.Database('recordings.db'); // File is created automatically

// Create the 'recordings' table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('Error creating table:', err);
    } else {
      console.log('Table "recordings" is ready.');
    }
  });
});

// API Endpoints

// 1. GET /api/recordings - Fetch all recordings from the database
app.get('/api/recordings', (req, res) => {
  const sql = `SELECT * FROM recordings ORDER BY created_at DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // --- ADDITION: Check if each file exists on disk ---
    const rowsWithExists = rows.map(row => {
      const filePath = path.join(__dirname, row.file_path);
      return {
        ...row,
        // Add a new property to the object indicating if the file exists
        file_exists: fs.existsSync(filePath)
      };
    });
    res.json(rowsWithExists);
    // --- END ADDITION ---
  });
});

// 2. GET /api/recordings/:id - Stream a specific recording file
app.get('/api/recordings/:id', (req, res) => {
  const sql = `SELECT * FROM recordings WHERE id = ?`;
  db.get(sql, [req.params.id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    const filePath = path.join(__dirname, row.file_path);

    // --- CRITICAL FIX: Check if the file actually exists ---
    if (!fs.existsSync(filePath)) {
      console.error(`File not found, deleting database record for ID: ${row.id}`);
      // Delete the database record since the file is gone
      db.run(`DELETE FROM recordings WHERE id = ?`, [row.id], (delErr) => {
        if (delErr) {
          console.error("Error deleting stale record:", delErr);
        }
      });
      return res.status(404).json({ error: 'Recording file not found. It may have been deleted.' });
    }
    // --- END FIX ---

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/webm',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/webm',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

// 3. POST /api/recordings - Upload a new recording
// 'file' is the name of the field expected in the form-data
app.post('/api/recordings', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const { originalname, filename, path: file_path, size } = req.file;
  const sql = `INSERT INTO recordings (filename, original_name, file_path, file_size) VALUES (?, ?, ?, ?)`;
  const params = [filename, originalname, file_path, size];

  db.run(sql, params, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.status(201).json({
      message: 'File uploaded successfully',
      data: {
        id: this.lastID,
        filename,
        original_name: originalname,
        file_path,
        file_size: size
      }
    });
  });
});
// 4. DELETE /api/recordings/:id - Delete a specific recording and its file
app.delete('/api/recordings/:id', (req, res) => {
  const recordingId = req.params.id;
  const sqlSelect = `SELECT * FROM recordings WHERE id = ?`;
  
  // First, get the file path from the database
  db.get(sqlSelect, [recordingId], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Recording not found in database.' });
    }

    const filePath = path.join(__dirname, row.file_path);

    // 1. Delete the physical file from the filesystem
    fs.unlink(filePath, (unlinkErr) => {
      // Even if file doesn't exist, we still want to delete the DB record.
      // We'll handle the error after attempting DB deletion.

      // 2. Delete the record from the database
      const sqlDelete = `DELETE FROM recordings WHERE id = ?`;
      db.run(sqlDelete, [recordingId], function (deleteErr) {
        if (deleteErr) {
          return res.status(500).json({ error: deleteErr.message });
        }

        // Check if the file deletion had an error (other than file not found)
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          // File deletion failed for a reason other than "file not found"
          console.error("Error deleting file:", unlinkErr);
          return res.status(500).json({ 
            message: 'Database record deleted but file could not be removed.',
            error: unlinkErr.message 
          });
        }

        // Success! Both file and record were deleted.
        res.json({ 
          message: 'Recording deleted successfully.',
          deletedId: recordingId 
        });
      });
    });
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});