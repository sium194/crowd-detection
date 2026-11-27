const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(cors());
app.use(express.json({ limit: '25mb' }));

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '1234';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_ids_json TEXT,
      total_ids_seen INTEGER DEFAULT 0,
      targeted_percentage NUMERIC(5,2) DEFAULT 0,
      untargeted_percentage NUMERIC(5,2) DEFAULT 0,
      targeted_ids_text TEXT,
      untargeted_ids_text TEXT,
      all_total_salary NUMERIC(18,2) DEFAULT 0,
      all_given_salary NUMERIC(18,2) DEFAULT 0,
      all_remaining_salary NUMERIC(18,2) DEFAULT 0,
      individuals_details_json TEXT,
      gone_events_json TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS locked_faces (
      id VARCHAR(100) PRIMARY KEY,
      descriptor_json TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-user'] === ADMIN_USER && req.headers['x-admin-pass'] === ADMIN_PASS) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) return res.json({ ok: true });
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const body = req.body || {};
    const s = body.summary || {};
    const sal = s.salaryTotals || {};

    const result = await pool.query(
      `INSERT INTO sessions (
        submitted_at, locked_ids_json, total_ids_seen,
        targeted_percentage, untargeted_percentage,
        targeted_ids_text, untargeted_ids_text,
        all_total_salary, all_given_salary, all_remaining_salary,
        individuals_details_json, gone_events_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id`,
      [
        body.submittedAt ? new Date(body.submittedAt) : new Date(),
        JSON.stringify(body.lockedIds || []),
        Number(s.totalIdsSeen) || 0,
        Number(s.targetedPercentage) || 0,
        Number(s.untargetedPercentage) || 0,
        (s.targetedIdsOrdered || []).join(', '),
        (s.untargetedIdsOrdered || []).join(', '),
        Number(sal.allTotal) || 0,
        Number(sal.allGiven) || 0,
        Number(sal.allRem) || 0,
        JSON.stringify(body.individualsDetails || {}),
        JSON.stringify(body.goneFromScreenEvents || [])
      ]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('DB Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sessions ORDER BY id DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/faces', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, descriptor_json FROM locked_faces');
    res.json(result.rows.map(r => ({ id: r.id, descriptor: JSON.parse(r.descriptor_json) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/faces', async (req, res) => {
  try {
    const { id, descriptor } = req.body || {};
    await pool.query(
      `INSERT INTO locked_faces (id, descriptor_json, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id)
       DO UPDATE SET descriptor_json = EXCLUDED.descriptor_json, updated_at = NOW()`,
      [String(id), JSON.stringify(descriptor)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/faces', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM locked_faces');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`PostgreSQL API running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Startup DB init failed:', err);
    process.exit(1);
  });