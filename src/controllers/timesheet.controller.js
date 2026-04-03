const db = require('../config/db');

// ── Helpers ───────────────────────────────────────────────
const getEmpId = async (userId) => {
  const [[r]] = await db.execute(
    'SELECT id FROM employees WHERE user_id = ? AND is_active = 1', [userId]
  );
  return r?.id || null;
};

// Get Monday of a given date's week
const weekStart = (dateStr) => {
  const d   = new Date(dateStr);
  const day = d.getDay();
  const diff= (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
};

const weekEnd = (startStr) => {
  const d = new Date(startStr);
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
};

// ── GET /api/timesheets ────────────────────────────────────
// List timesheets — employee sees own, admin/manager sees all
const getAll = async (req, res) => {
  try {
    const isAdminMgr = ['Admin','HR','Manager'].includes(req.user.role_name);
    const { status, employee_id, page = 1, limit = 12 } = req.query;

    const conditions = ['1=1'];
    const params     = [];

    if (!isAdminMgr) {
      const empId = await getEmpId(req.user.id);
      conditions.push('t.employee_id = ?'); params.push(empId);
    } else if (employee_id) {
      conditions.push('t.employee_id = ?'); params.push(employee_id);
    }
    if (status) { conditions.push('t.status = ?'); params.push(status); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM timesheets t WHERE ${where}`, params
    );

    const [rows] = await db.execute(
      `SELECT t.*,
              e.full_name, e.employee_id AS emp_code, e.avatar_url,
              d.name AS department,
              u.full_name AS approved_by_name
       FROM timesheets t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = t.approved_by
       WHERE ${where}
       ORDER BY t.week_start DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), limit: Number(limit), pages: Math.ceil(Number(total)/Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch timesheets' });
  }
};

// ── GET /api/timesheets/current ────────────────────────────
// Get or create current week's timesheet for the logged-in employee
const getCurrent = async (req, res) => {
  try {
    const empId = await getEmpId(req.user.id);
    if (!empId) return res.status(404).json({ success: false, message: 'Employee not found' });

    const today  = new Date().toISOString().slice(0, 10);
    const wStart = weekStart(today);
    const wEnd   = weekEnd(wStart);

    // Upsert timesheet
    await db.execute(
      `INSERT IGNORE INTO timesheets (employee_id, week_start, week_end, status)
       VALUES (?, ?, ?, 'Draft')`,
      [empId, wStart, wEnd]
    );

    const [[ts]] = await db.execute(
      `SELECT t.*, u.full_name AS approved_by_name
       FROM timesheets t
       LEFT JOIN users u ON u.id = t.approved_by
       WHERE t.employee_id = ? AND t.week_start = ?`,
      [empId, wStart]
    );

    const [entries] = await db.execute(
      'SELECT * FROM timesheet_entries WHERE timesheet_id = ? ORDER BY entry_date',
      [ts.id]
    );

    res.json({ success: true, data: { ...ts, entries } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch current timesheet' });
  }
};

// ── GET /api/timesheets/:id ────────────────────────────────
const getById = async (req, res) => {
  try {
    const [[ts]] = await db.execute(
      `SELECT t.*, e.full_name, e.employee_id AS emp_code,
              d.name AS department, des.name AS designation,
              u.full_name AS approved_by_name
       FROM timesheets t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN departments  d   ON d.id = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN users u ON u.id = t.approved_by
       WHERE t.id = ?`, [req.params.id]
    );
    if (!ts) return res.status(404).json({ success: false, message: 'Timesheet not found' });

    const [entries] = await db.execute(
      'SELECT * FROM timesheet_entries WHERE timesheet_id = ? ORDER BY entry_date',
      [ts.id]
    );

    res.json({ success: true, data: { ...ts, entries } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch timesheet' });
  }
};

// ── GET /api/timesheets/week ───────────────────────────────
// Get timesheet for any specific week
const getByWeek = async (req, res) => {
  try {
    const empId  = await getEmpId(req.user.id);
    const { date } = req.query;
    const wStart = weekStart(date || new Date().toISOString().slice(0,10));
    const wEnd   = weekEnd(wStart);

    await db.execute(
      `INSERT IGNORE INTO timesheets (employee_id, week_start, week_end, status) VALUES (?,?,?,'Draft')`,
      [empId, wStart, wEnd]
    );

    const [[ts]] = await db.execute(
      `SELECT t.*, u.full_name AS approved_by_name
       FROM timesheets t LEFT JOIN users u ON u.id = t.approved_by
       WHERE t.employee_id = ? AND t.week_start = ?`, [empId, wStart]
    );

    const [entries] = await db.execute(
      'SELECT * FROM timesheet_entries WHERE timesheet_id = ? ORDER BY entry_date', [ts.id]
    );

    res.json({ success: true, data: { ...ts, entries } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch week timesheet' });
  }
};

// ── PUT /api/timesheets/:id/entries ───────────────────────
// Save all entries for a timesheet (upsert per day)
const saveEntries = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { entries } = req.body; // [{entry_date, project, task_category, hours_worked, task_notes}]

    const [[ts]] = await conn.execute('SELECT * FROM timesheets WHERE id = ?', [id]);
    if (!ts) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Timesheet not found' }); }
    if (ts.status === 'Approved') {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Cannot edit an approved timesheet' });
    }

    // Delete existing entries and re-insert
    await conn.execute('DELETE FROM timesheet_entries WHERE timesheet_id = ?', [id]);

    let totalHours = 0;
    for (const e of entries) {
      const h = Math.min(24, Math.max(0, Number(e.hours_worked) || 0));
      if (h > 0) {
        await conn.execute(
          `INSERT INTO timesheet_entries (timesheet_id, entry_date, project, task_category, hours_worked, task_notes)
           VALUES (?,?,?,?,?,?)`,
          [id, e.entry_date, e.project||null, e.task_category||'Development', h, e.task_notes||null]
        );
        totalHours += h;
      }
    }

    await conn.execute(
      'UPDATE timesheets SET total_hours = ?, status = ? WHERE id = ?',
      [totalHours.toFixed(2), ts.status === 'Rejected' ? 'Draft' : ts.status, id]
    );

    await conn.commit();
    res.json({ success: true, message: 'Timesheet saved', data: { total_hours: totalHours.toFixed(2) } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Save failed' });
  } finally {
    conn.release();
  }
};

// ── POST /api/timesheets/:id/submit ───────────────────────
const submit = async (req, res) => {
  try {
    const [[ts]] = await db.execute('SELECT * FROM timesheets WHERE id = ?', [req.params.id]);
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (!['Draft','Rejected'].includes(ts.status)) {
      return res.status(400).json({ success: false, message: 'Only Draft/Rejected timesheets can be submitted' });
    }
    if (Number(ts.total_hours) === 0) {
      return res.status(422).json({ success: false, message: 'Cannot submit a timesheet with 0 hours' });
    }
    await db.execute(
      'UPDATE timesheets SET status = ?, submitted_at = NOW() WHERE id = ?',
      ['Submitted', req.params.id]
    );
    res.json({ success: true, message: 'Timesheet submitted for approval' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Submit failed' });
  }
};

// ── POST /api/timesheets/:id/approve ──────────────────────
const approve = async (req, res) => {
  try {
    const [[ts]] = await db.execute('SELECT * FROM timesheets WHERE id = ?', [req.params.id]);
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status !== 'Submitted') {
      return res.status(400).json({ success: false, message: 'Only submitted timesheets can be approved' });
    }
    await db.execute(
      'UPDATE timesheets SET status=?, approved_by=?, approved_at=NOW(), remarks=? WHERE id=?',
      ['Approved', req.user.id, req.body.remarks||null, req.params.id]
    );
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `APPROVE_TIMESHEET:${req.params.id}`, 'timesheets', req.ip]
    );
    res.json({ success: true, message: 'Timesheet approved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Approve failed' });
  }
};

// ── POST /api/timesheets/:id/reject ───────────────────────
const reject = async (req, res) => {
  try {
    const [[ts]] = await db.execute('SELECT * FROM timesheets WHERE id = ?', [req.params.id]);
    if (!ts) return res.status(404).json({ success: false, message: 'Not found' });
    if (ts.status !== 'Submitted') {
      return res.status(400).json({ success: false, message: 'Only submitted timesheets can be rejected' });
    }
    if (!req.body.remarks) {
      return res.status(422).json({ success: false, message: 'Rejection reason is required' });
    }
    await db.execute(
      'UPDATE timesheets SET status=?, approved_by=?, approved_at=NOW(), remarks=? WHERE id=?',
      ['Rejected', req.user.id, req.body.remarks, req.params.id]
    );
    res.json({ success: true, message: 'Timesheet rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Reject failed' });
  }
};

// ── GET /api/timesheets/stats ──────────────────────────────
const getStats = async (req, res) => {
  try {
    const isAdminMgr = ['Admin','HR','Manager'].includes(req.user.role_name);
    if (!isAdminMgr) return res.json({ success: true, data: {} });

    const [[counts]] = await db.execute(`
      SELECT
        SUM(status='Submitted') AS pending,
        SUM(status='Approved')  AS approved,
        SUM(status='Rejected')  AS rejected,
        SUM(status='Draft')     AS drafts,
        COUNT(*)                AS total,
        ROUND(AVG(total_hours),1) AS avg_hours
      FROM timesheets
      WHERE week_start >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`
    );

    const [topEmployees] = await db.execute(`
      SELECT e.full_name, e.employee_id AS emp_code,
             SUM(t.total_hours) AS hours,
             COUNT(t.id) AS weeks
      FROM timesheets t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.status = 'Approved' AND t.week_start >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      GROUP BY e.id ORDER BY hours DESC LIMIT 5`
    );

    res.json({ success: true, data: { counts, topEmployees } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

module.exports = { getAll, getCurrent, getById, getByWeek, saveEntries, submit, approve, reject, getStats };