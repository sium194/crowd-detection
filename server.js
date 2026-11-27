const express = require('express');
const cors = require('cors');
const sql = require('mssql/msnodesqlv8');

const app = express();
const path = require("path");
app.use(express.static(__dirname));
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const dbConfig = {
  connectionString: 'Driver={ODBC Driver 17 for SQL Server};Server=localhost\\SQLEXPRESS;Database=PersonAnalyticsDB;Trusted_Connection=yes;'
};

const ADMIN_USER = 'admin';
const ADMIN_PASS = '1234';
let poolPromise = sql.connect(dbConfig);

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-user'] === ADMIN_USER && req.headers['x-admin-pass'] === ADMIN_PASS) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

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
    const pool = await poolPromise;

    const result = await pool.request()
      .input('submitted_at', sql.DateTime2, body.submittedAt ? new Date(body.submittedAt) : new Date())
      .input('locked_ids_json', sql.NVarChar(sql.MAX), JSON.stringify(body.lockedIds || []))
      .input('total_ids_seen', sql.Int, Number(s.totalIdsSeen) || 0)
      .input('targeted_percentage', sql.Decimal(5, 2), Number(s.targetedPercentage) || 0)
      .input('untargeted_percentage', sql.Decimal(5, 2), Number(s.untargetedPercentage) || 0)
      .input('targeted_ids_text', sql.NVarChar(sql.MAX), (s.targetedIdsOrdered || []).join(', '))
      .input('untargeted_ids_text', sql.NVarChar(sql.MAX), (s.untargetedIdsOrdered || []).join(', '))
      .input('all_total_salary', sql.Decimal(18, 2), Number(sal.allTotal) || 0)
      .input('all_given_salary', sql.Decimal(18, 2), Number(sal.allGiven) || 0)
      .input('all_remaining_salary', sql.Decimal(18, 2), Number(sal.allRem) || 0)
      .input('individuals_details_json', sql.NVarChar(sql.MAX), JSON.stringify(body.individualsDetails || {}))
      .input('gone_events_json', sql.NVarChar(sql.MAX), JSON.stringify(body.goneFromScreenEvents || []))
      .query(`
        INSERT INTO dbo.sessions (
          submitted_at, locked_ids_json, total_ids_seen,
          targeted_percentage, untargeted_percentage,
          targeted_ids_text, untargeted_ids_text,
          all_total_salary, all_given_salary, all_remaining_salary,
          individuals_details_json, gone_events_json
        )
        OUTPUT INSERTED.id
        VALUES (
          @submitted_at, @locked_ids_json, @total_ids_seen,
          @targeted_percentage, @untargeted_percentage,
          @targeted_ids_text, @untargeted_ids_text,
          @all_total_salary, @all_given_salary, @all_remaining_salary,
          @individuals_details_json, @gone_events_json
        )
      `);

    res.json({ ok: true, id: result.recordset[0].id });
  } catch (err) {
    console.error('SQL Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', requireAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query('SELECT TOP 50 * FROM dbo.sessions ORDER BY id DESC');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/faces', async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query('SELECT id, descriptor_json FROM dbo.locked_faces');
    res.json(result.recordset.map(r => ({ id: r.id, descriptor: JSON.parse(r.descriptor_json) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/faces', async (req, res) => {
  try {
    const { id, descriptor } = req.body;
    const pool = await poolPromise;
    await pool.request()
      .input('id', sql.NVarChar(100), String(id))
      .input('descriptor_json', sql.NVarChar(sql.MAX), JSON.stringify(descriptor))
      .query(`
        MERGE dbo.locked_faces AS target
        USING (SELECT @id AS id) AS src
        ON target.id = src.id
        WHEN MATCHED THEN UPDATE SET descriptor_json = @descriptor_json, updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (id, descriptor_json) VALUES (@id, @descriptor_json);
      `);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/faces', requireAdmin, async (req, res) => {
  try {
    const pool = await poolPromise;
    await pool.request().query('DELETE FROM dbo.locked_faces');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('MS SQL API running on http://localhost:3000'));