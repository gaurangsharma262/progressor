const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Database connection (Turso in production, local SQLite file for development)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Helper functions mapping to libSQL client execute syntax
const dbRun = async (sql, params = []) => {
  return await db.execute({ sql, args: params });
};

const dbAll = async (sql, params = []) => {
  const res = await db.execute({ sql, args: params });
  return res.rows;
};

// Fixed templates for 6 study blocks
const TEMPLATE = [
  { id: "basic-maths",   subject: "Basic Maths",     duration: 3600 },
  { id: "reasoning",     subject: "Reasoning",       duration: 4500 },
  { id: "adv-maths-1",   subject: "Advanced Maths",  duration: 3900 },
  { id: "adv-maths-2",   subject: "Advanced Maths",  duration: 3600 },
  { id: "gk",            subject: "GK",              duration: 5400 },
  { id: "english-vocab", subject: "English Vocab",   duration: 1800 }
];

// Initialize Database Table
async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS study_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      block_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      topic TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      remaining_seconds INTEGER NOT NULL,
      running BOOLEAN DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, block_id)
    )
  `);
  console.log("Database initialized successfully.");
}

initDb().catch(err => {
  console.error("Failed to initialize database:", err);
});

// Ensure a date is populated with the 6 default template blocks
async function ensureDayInitialized(date) {
  const rows = await dbAll('SELECT * FROM study_sessions WHERE date = ?', [date]);
  if (rows.length < 6) {
    for (const t of TEMPLATE) {
      await dbRun(`
        INSERT OR IGNORE INTO study_sessions (date, block_id, subject, topic, status, remaining_seconds, running)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [date, t.id, t.subject, '', 'pending', t.duration, 0]);
    }
  }
}

// Generate an array of dates in YYYY-MM-DD format going back N calendar days (excluding Saturdays and Sundays)
function getDatesInRange(range, todayStr) {
  const dates = [];
  const today = new Date(todayStr + 'T00:00:00');
  let n = range === 'week' ? 7 : range === 'month' ? 30 : 365;
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip Saturday (6) and Sunday (0)
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${day}`);
    }
  }
  return dates;
}

// Serve the frontend page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'study-tracker-v2.html'));
});

// GET /api/day/:date - Returns blocks for a date (initialized if needed)
app.get('/api/day/:date', async (req, res) => {
  const { date } = req.params;
  // Basic YYYY-MM-DD pattern validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format. Expected YYYY-MM-DD" });
  }

  try {
    await ensureDayInitialized(date);
    const rows = await dbAll('SELECT * FROM study_sessions WHERE date = ?', [date]);
    
    // Map database rows to the keyed JSON object the frontend expects
    const response = {};
    rows.forEach(row => {
      response[row.block_id] = {
        topic: row.topic || "",
        status: row.status,
        remaining: row.remaining_seconds,
        running: row.running === 1 || row.running === true
      };
    });
    
    res.json(response);
  } catch (err) {
    console.error("GET /api/day error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/day/:date/:blockId - Update one study block
app.patch('/api/day/:date/:blockId', async (req, res) => {
  const { date, blockId } = req.params;
  const { topic, status, remaining, remaining_seconds, running } = req.body;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  try {
    await ensureDayInitialized(date);

    // Resolve remaining duration (support both 'remaining' and 'remaining_seconds')
    let finalRemaining = remaining !== undefined ? remaining : remaining_seconds;
    let finalStatus = status;
    let finalRunning = running;

    // Enforce logic rule: If remaining hits 0, auto-complete
    if (finalRemaining !== undefined && finalRemaining <= 0) {
      finalRemaining = 0;
      finalStatus = 'done';
      finalRunning = false;
    }

    // If status is updated to done, stop running
    if (finalStatus === 'done') {
      finalRunning = false;
    }

    // Enforce logic rule: Only one block runs at a time for a date
    if (finalRunning === true || finalRunning === 1) {
      await dbRun('UPDATE study_sessions SET running = 0 WHERE date = ? AND block_id != ?', [date, blockId]);
    }

    // Build dynamic UPDATE query
    const updates = [];
    const params = [];

    if (topic !== undefined) {
      updates.push('topic = ?');
      params.push(topic);
    }
    if (finalStatus !== undefined) {
      updates.push('status = ?');
      params.push(finalStatus);
    }
    if (finalRemaining !== undefined) {
      updates.push('remaining_seconds = ?');
      params.push(finalRemaining);
    }
    if (finalRunning !== undefined) {
      updates.push('running = ?');
      params.push(finalRunning ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(date, blockId);
      await dbRun(`UPDATE study_sessions SET ${updates.join(', ')} WHERE date = ? AND block_id = ?`, params);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /api/day error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/stats - Aggregated stats for the progress page
app.get('/api/stats', async (req, res) => {
  const range = req.query.range || 'week'; // 'week' | 'month' | 'all'

  // Get server local time as YYYY-MM-DD
  const todayDate = new Date();
  const y = todayDate.getFullYear();
  const m = String(todayDate.getMonth() + 1).padStart(2, '0');
  const d = String(todayDate.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;

  try {
    let rows;
    if (range === 'all') {
      rows = await dbAll('SELECT * FROM study_sessions');
      // Filter out weekends from 'all' range
      rows = rows.filter(row => {
        const d = new Date(row.date + 'T00:00:00');
        const day = d.getDay();
        return day !== 0 && day !== 6;
      });
    } else {
      const dates = getDatesInRange(range, todayStr);
      if (dates.length === 0) {
        rows = [];
      } else {
        const placeholders = dates.map(() => '?').join(',');
        rows = await dbAll(`SELECT * FROM study_sessions WHERE date IN (${placeholders})`, dates);
      }
    }

    // Calculate aggregated percentages and values
    let total = 0;
    let done = 0;
    const bySubject = {};

    // Prepopulate all known template subjects
    const ALL_SUBJECTS = ["Basic Maths", "Advanced Maths", "Reasoning", "GK", "English Vocab"];
    ALL_SUBJECTS.forEach(s => {
      bySubject[s] = { total: 0, done: 0, pct: 0 };
    });

    rows.forEach(row => {
      total++;
      if (row.status === 'done') {
        done++;
      }

      if (bySubject[row.subject] !== undefined) {
        bySubject[row.subject].total++;
        if (row.status === 'done') {
          bySubject[row.subject].done++;
        }
      }
    });

    const pct = total ? Math.round((done / total) * 100) : 0;
    Object.keys(bySubject).forEach(s => {
      const sb = bySubject[s];
      sb.pct = sb.total ? Math.round((sb.done / sb.total) * 100) : 0;
    });

    // Heatmap - always the last 30 calendar days (weekends are displayed as rest days with total = 0)
    const heatDates = [];
    const today = new Date(todayStr + 'T00:00:00');
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      heatDates.push(`${y}-${m}-${day}`);
    }
    heatDates.reverse();

    const placeholders = heatDates.map(() => '?').join(',');
    const heatRows = await dbAll(`SELECT * FROM study_sessions WHERE date IN (${placeholders})`, heatDates);

    const heatMapByDate = {};
    heatRows.forEach(row => {
      // Exclude weekend records from being counted in heatmap values
      const d = new Date(row.date + 'T00:00:00');
      const dayOfWeek = d.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return;

      if (!heatMapByDate[row.date]) {
        heatMapByDate[row.date] = { done: 0, total: 0 };
      }
      heatMapByDate[row.date].total++;
      if (row.status === 'done') {
        heatMapByDate[row.date].done++;
      }
    });

    const heatmap = heatDates.map(date => {
      const d = new Date(date + 'T00:00:00');
      const dayOfWeek = d.getDay();
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      
      const dayData = (!isWeekend && heatMapByDate[date]) || { done: 0, total: 0 };
      return {
        date,
        done: dayData.done,
        total: dayData.total
      };
    });

    res.json({
      total,
      done,
      pct,
      bySubject,
      heatmap
    });
  } catch (err) {
    console.error("GET /api/stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

module.exports = app;
