const db = require('../config/db');

const MONTHS_F = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

// ── GET /api/holidays ──────────────────────────────────────
const getAll = async (req, res) => {
  try {
    const { year = new Date().getFullYear(), type, department_id } = req.query;

    const conditions = ['YEAR(h.date) = ?'];
    const params = [Number(year)];

    if (type) {
      conditions.push('h.type = ?');
      params.push(type);
    }
    if (department_id) {
      conditions.push('(h.applicable_to = "All" OR (h.applicable_to = "Department" AND h.department_id = ?))');
      params.push(department_id);
    }

    const [rows] = await db.execute(`
      SELECT h.*,
             d.name AS dept_name,
             u.full_name AS created_by_name,
             DAYNAME(h.date) AS day_name,
             (SELECT COUNT(*) FROM holiday_employee_opt WHERE holiday_id = h.id) AS opt_count
      FROM holidays h
      LEFT JOIN departments d ON d.id = h.department_id
      LEFT JOIN users u ON u.id = h.created_by
      WHERE ${conditions.join(' AND ')}
      ORDER BY h.date ASC`, params);

    // Group by month for calendar view
    const byMonth = {};
    rows.forEach(h => {
      const m = new Date(h.date).getMonth();
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(h);
    });

    res.json({ success: true, data: rows, byMonth });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch holidays' });
  }
};

// ── GET /api/holidays/stats ────────────────────────────────
const getStats = async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();

    const [[counts]] = await db.execute(`
      SELECT
        COUNT(*)                                AS total,
        SUM(type = 'National')                  AS national,
        SUM(type = 'Public')                    AS public_h,
        SUM(type = 'Optional')                  AS optional_h,
        SUM(type = 'Company')                   AS company,
        SUM(type = 'Regional')                  AS regional,
        SUM(YEAR(date) = YEAR(CURDATE()) AND date >= CURDATE()) AS remaining
      FROM holidays WHERE YEAR(date) = ?`, [year]);

    const [upcoming] = await db.execute(`
      SELECT h.name, h.date, h.type, h.description,
             DAYNAME(h.date) AS day_name,
             DATEDIFF(h.date, CURDATE()) AS days_away
      FROM holidays h
      WHERE h.date >= CURDATE() AND YEAR(h.date) = YEAR(CURDATE())
      ORDER BY h.date ASC LIMIT 5`);

    const [byMonth] = await db.execute(`
      SELECT MONTH(date) AS month, COUNT(*) AS count
      FROM holidays WHERE YEAR(date) = ?
      GROUP BY MONTH(date) ORDER BY month`, [year]);

    res.json({ success: true, data: { counts, upcoming, byMonth } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

// ── POST /api/holidays ─────────────────────────────────────
const create = async (req, res) => {
  try {
    const { name, date, type, description, is_restricted, applicable_to, department_id, location } = req.body;

    if (!name?.trim() || !date) {
      return res.status(422).json({ success: false, message: 'Name and date are required' });
    }

    const [[dup]] = await db.execute(
      'SELECT id FROM holidays WHERE date = ? AND name = ?',
      [date, name.trim()]
    );
    if (dup) {
      return res.status(409).json({ success: false, message: 'A holiday with this name already exists on this date' });
    }

    const [result] = await db.execute(`
      INSERT INTO holidays
        (name, date, type, description, is_restricted, applicable_to, department_id, location, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), date, type || 'National', description || null,
       is_restricted ? 1 : 0, applicable_to || 'All',
       department_id || null, location || null, req.user.id]);

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_HOLIDAY:${name}:${date}`, 'holidays', req.ip]
    ).catch(() => {});

    res.status(201).json({ success: true, message: 'Holiday added', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create holiday' });
  }
};

// ── PUT /api/holidays/:id ──────────────────────────────────
const update = async (req, res) => {
  try {
    const { name, date, type, description, is_restricted, applicable_to, department_id, location } = req.body;

    await db.execute(`
      UPDATE holidays SET
        name=?, date=?, type=?, description=?,
        is_restricted=?, applicable_to=?, department_id=?, location=?
      WHERE id=?`,
      [name.trim(), date, type || 'National', description || null,
       is_restricted ? 1 : 0, applicable_to || 'All',
       department_id || null, location || null, req.params.id]);

    res.json({ success: true, message: 'Holiday updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A holiday already exists on this date' });
    }
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// ── DELETE /api/holidays/:id ───────────────────────────────
const remove = async (req, res) => {
  try {
    const [[h]] = await db.execute('SELECT name FROM holidays WHERE id=?', [req.params.id]);
    if (!h) return res.status(404).json({ success: false, message: 'Holiday not found' });
    await db.execute('DELETE FROM holidays WHERE id=?', [req.params.id]);
    res.json({ success: true, message: 'Holiday removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Delete failed' });
  }
};

// ── POST /api/holidays/bulk ────────────────────────────────
const bulkImport = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { holidays, overwrite = false } = req.body;

    if (!Array.isArray(holidays) || holidays.length === 0) {
      await conn.rollback();
      return res.status(422).json({ success: false, message: 'No holidays provided' });
    }

    let inserted = 0, skipped = 0, updated = 0;

    for (const h of holidays) {
      if (!h.name?.trim() || !h.date) { skipped++; continue; }

      const [[existing]] = await conn.execute(
        'SELECT id FROM holidays WHERE date=? AND name=?', [h.date, h.name.trim()]
      );

      if (existing && !overwrite) { skipped++; continue; }

      if (existing && overwrite) {
        await conn.execute(
          'UPDATE holidays SET type=?, description=?, is_restricted=? WHERE id=?',
          [h.type || 'National', h.description || null, h.is_restricted ? 1 : 0, existing.id]
        );
        updated++;
      } else {
        await conn.execute(
          'INSERT IGNORE INTO holidays (name, date, type, description, is_restricted, created_by) VALUES (?,?,?,?,?,?)',
          [h.name.trim(), h.date, h.type || 'National', h.description || null, h.is_restricted ? 1 : 0, req.user.id]
        );
        inserted++;
      }
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `BULK_IMPORT_HOLIDAYS:${inserted}added:${updated}updated`, 'holidays', req.ip]
    ).catch(() => {});

    await conn.commit();
    res.json({
      success: true,
      message: `Import complete — ${inserted} added, ${updated} updated, ${skipped} skipped`,
      data: { inserted, updated, skipped }
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Bulk import failed' });
  } finally {
    conn.release();
  }
};

// ── POST /api/holidays/:id/opt ─────────────────────────────
const optIn = async (req, res) => {
  try {
    const [[hol]] = await db.execute('SELECT * FROM holidays WHERE id=?', [req.params.id]);
    if (!hol) return res.status(404).json({ success: false, message: 'Holiday not found' });

    const [[emp]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    await db.execute(
      'INSERT IGNORE INTO holiday_employee_opt (holiday_id, employee_id) VALUES (?,?)',
      [req.params.id, emp.id]
    );
    res.json({ success: true, message: 'Opted in to holiday' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Opt-in failed' });
  }
};

// ── DELETE /api/holidays/:id/opt ──────────────────────────
const optOut = async (req, res) => {
  try {
    const [[emp]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    await db.execute(
      'DELETE FROM holiday_employee_opt WHERE holiday_id=? AND employee_id=?',
      [req.params.id, emp.id]
    );
    res.json({ success: true, message: 'Opted out of holiday' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Opt-out failed' });
  }
};

// ── GET /api/holidays/working-days ────────────────────────
const getWorkingDays = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(422).json({ success: false, message: 'from and to dates are required' });
    }
    if (from > to) {
      return res.status(422).json({ success: false, message: '"from" must be before "to"' });
    }

    const [holidays] = await db.execute(
      `SELECT date FROM holidays
       WHERE date BETWEEN ? AND ?
         AND applicable_to = 'All'
         AND type != 'Optional'`,
      [from, to]
    );

    const holidaySet = new Set(
      holidays.map(h => (h.date instanceof Date ? h.date : new Date(h.date)).toISOString().slice(0, 10))
    );

    let workingDays = 0;
    const cur = new Date(from);
    const end = new Date(to);
    while (cur <= end) {
      const dow = cur.getDay();
      const ds  = cur.toISOString().slice(0, 10);
      if (dow !== 0 && dow !== 6 && !holidaySet.has(ds)) workingDays++;
      cur.setDate(cur.getDate() + 1);
    }

    res.json({
      success: true,
      data: {
        from,
        to,
        working_days: workingDays,
        holidays_in_range: holidays.length,
        total_calendar_days: Math.round((new Date(to) - new Date(from)) / 86400000) + 1
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Calculation failed' });
  }
};

module.exports = { getAll, getStats, create, update, remove, bulkImport, optIn, optOut, getWorkingDays };