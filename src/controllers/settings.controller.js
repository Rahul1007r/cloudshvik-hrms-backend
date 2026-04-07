const db = require('../config/db');

// ── GET /api/settings ──────────────────────────────────────
// Return all settings grouped
const getAll = async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT setting_key, setting_value, setting_group, data_type, label FROM company_settings ORDER BY setting_group, id'
    );

    // Group by setting_group
    const grouped = {};
    const flat    = {};
    for (const row of rows) {
      if (!grouped[row.setting_group]) grouped[row.setting_group] = [];
      let val = row.setting_value;
      if (row.data_type === 'boolean') val = val === 'true';
      if (row.data_type === 'number')  val = Number(val);
      if (row.data_type === 'json') { try { val = JSON.parse(val); } catch {} }
      grouped[row.setting_group].push({ ...row, setting_value: val });
      flat[row.setting_key] = val;
    }

    res.json({ success: true, data: { grouped, flat } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch settings' });
  }
};

// ── GET /api/settings/:group ───────────────────────────────
const getGroup = async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT setting_key, setting_value, setting_group, data_type, label FROM company_settings WHERE setting_group = ? ORDER BY id',
      [req.params.group]
    );
    const flat = {};
    for (const row of rows) {
      let val = row.setting_value;
      if (row.data_type === 'boolean') val = val === 'true';
      if (row.data_type === 'number')  val = Number(val);
      if (row.data_type === 'json') { try { val = JSON.parse(val); } catch {} }
      flat[row.setting_key] = val;
    }
    res.json({ success: true, data: { settings: rows, flat } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch group settings' });
  }
};

// ── PUT /api/settings ──────────────────────────────────────
// Bulk upsert: { key: value, ... }
const updateAll = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const updates = req.body; // { setting_key: value }

    for (const [key, value] of Object.entries(updates)) {
      let stored = String(value ?? '');
      if (typeof value === 'boolean') stored = value ? 'true' : 'false';
      if (Array.isArray(value))       stored = JSON.stringify(value);

      await conn.execute(
        `UPDATE company_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?`,
        [stored, req.user.id, key]
      );
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `UPDATE_SETTINGS:${Object.keys(updates).join(',')}`, 'settings', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to save settings' });
  } finally {
    conn.release();
  }
};

// ── GET /api/settings/holidays ─────────────────────────────
const getHolidays = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const [rows] = await db.execute(
      'SELECT * FROM holidays WHERE YEAR(date) = ? ORDER BY date ASC',
      [Number(year)]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch holidays' });
  }
};

// ── POST /api/settings/holidays ────────────────────────────
const createHoliday = async (req, res) => {
  try {
    const { name, date, type } = req.body;
    if (!name || !date) {
      return res.status(422).json({ success: false, message: 'Name and date are required' });
    }
    const [result] = await db.execute(
      'INSERT INTO holidays (name, date, type) VALUES (?, ?, ?)',
      [name.trim(), date, type || 'Public']
    );
    res.status(201).json({ success: true, message: 'Holiday added', data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A holiday already exists on this date' });
    }
    res.status(500).json({ success: false, message: 'Failed to add holiday' });
  }
};

// ── PUT /api/settings/holidays/:id ────────────────────────
const updateHoliday = async (req, res) => {
  try {
    const { name, date, type } = req.body;
    await db.execute(
      'UPDATE holidays SET name = ?, date = ?, type = ? WHERE id = ?',
      [name.trim(), date, type || 'Public', req.params.id]
    );
    res.json({ success: true, message: 'Holiday updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A holiday already exists on this date' });
    }
    res.status(500).json({ success: false, message: 'Failed to update holiday' });
  }
};

// ── DELETE /api/settings/holidays/:id ─────────────────────
const deleteHoliday = async (req, res) => {
  try {
    await db.execute('DELETE FROM holidays WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Holiday removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete holiday' });
  }
};

// ── POST /api/settings/holidays/bulk ──────────────────────
// Import multiple holidays at once
const bulkCreateHolidays = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { holidays, year } = req.body;
    let inserted = 0, skipped = 0;

    for (const h of holidays) {
      try {
        await conn.execute(
          'INSERT IGNORE INTO holidays (name, date, type) VALUES (?,?,?)',
          [h.name.trim(), h.date, h.type || 'National']
        );
        inserted++;
      } catch { skipped++; }
    }

    await conn.commit();
    res.json({ success: true, message: `${inserted} holidays imported, ${skipped} skipped` });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Bulk import failed' });
  } finally {
    conn.release();
  }
};

module.exports = {
  getAll, getGroup, updateAll,
  getHolidays, createHoliday, updateHoliday, deleteHoliday, bulkCreateHolidays,
};