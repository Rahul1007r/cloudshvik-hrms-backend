const db = require('../config/db');

// ── Helper: get employee id from user id ───────────────────
const getEmpId = async (userId) => {
  const [[row]] = await db.execute(
    'SELECT id FROM employees WHERE user_id = ? AND is_active = 1', [userId]
  );
  return row?.id || null;
};

// ── GET /api/attendance ────────────────────────────────────
// Admin/Manager: all employees | Employee: own only
const getAll = async (req, res) => {
  try {
    const {
      month = new Date().getMonth() + 1,
      year  = new Date().getFullYear(),
      employee_id, department_id, status,
      page = 1, limit = 20,
    } = req.query;

    const offset     = (Number(page) - 1) * Number(limit);
    const conditions = [`MONTH(a.date) = ?`, `YEAR(a.date) = ?`];
    const params     = [Number(month), Number(year)];

    // Employees can only view their own
    if (req.user.role_name === 'Employee') {
      const empId = await getEmpId(req.user.id);
      if (empId) { conditions.push('a.employee_id = ?'); params.push(empId); }
    } else {
      if (employee_id)  { conditions.push('a.employee_id = ?');    params.push(employee_id); }
      if (department_id){ conditions.push('e.department_id = ?');  params.push(department_id); }
    }
    if (status) { conditions.push('a.status = ?'); params.push(status); }

    const where = conditions.join(' AND ');
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM attendance a
       JOIN employees e ON e.id = a.employee_id WHERE ${where}`, params
    );

    const [rows] = await db.execute(
      `SELECT a.*,
              e.full_name, e.employee_id AS emp_code, e.avatar_url,
              d.name AS department,
              TIMESTAMPDIFF(MINUTE, a.check_in, a.check_out) AS worked_minutes,
              u.full_name AS approved_by_name
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = a.approved_by
       WHERE ${where}
       ORDER BY a.date DESC, e.full_name ASC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({ success: true, data: rows, meta: { total: Number(total), page: Number(page), limit: Number(limit), pages: Math.ceil(Number(total) / Number(limit)) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch attendance' });
  }
};

// ── GET /api/attendance/my-calendar ───────────────────────
// Employee's monthly calendar view
const getMyCalendar = async (req, res) => {
  try {
    const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
    const empId = await getEmpId(req.user.id);

    const [rows] = await db.execute(
      `SELECT date, check_in, check_out, status, work_mode, notes,
              TIMESTAMPDIFF(MINUTE, check_in, check_out) AS worked_minutes
       FROM attendance
       WHERE employee_id = ? AND MONTH(date) = ? AND YEAR(date) = ?
       ORDER BY date ASC`,
      [empId, Number(month), Number(year)]
    );

    const [holidays] = await db.execute(
      `SELECT date, name, type FROM holidays
       WHERE MONTH(date) = ? AND YEAR(date) = ?`,
      [Number(month), Number(year)]
    );

    // Summary
    const summary = rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      acc.totalMinutes += Number(r.worked_minutes || 0);
      return acc;
    }, { Present: 0, Absent: 0, Late: 0, 'Half-Day': 0, Leave: 0, totalMinutes: 0 });

    res.json({ success: true, data: { attendance: rows, holidays, summary } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch calendar' });
  }
};

// ── GET /api/attendance/today-overview ────────────────────
// Admin: today's attendance summary across all employees
const getTodayOverview = async (req, res) => {
  try {
    const [[totals]] = await db.execute(`
      SELECT
        COUNT(DISTINCT e.id)                                       AS total_employees,
        COUNT(DISTINCT CASE WHEN a.status IN ('Present','Late','Half-Day') THEN a.employee_id END) AS present,
        COUNT(DISTINCT CASE WHEN a.status = 'Absent'  THEN a.employee_id END) AS absent,
        COUNT(DISTINCT CASE WHEN a.status = 'Late'    THEN a.employee_id END) AS late,
        COUNT(DISTINCT CASE WHEN a.status = 'Leave'   THEN a.employee_id END) AS on_leave,
        COUNT(DISTINCT CASE WHEN a.status = 'Remote' OR a.work_mode='Remote' THEN a.employee_id END) AS remote
      FROM employees e
      LEFT JOIN attendance a ON a.employee_id = e.id AND DATE(a.date) = CURDATE()
      WHERE e.is_active = 1
    `);

    const [absentList] = await db.execute(`
      SELECT e.id, e.full_name, e.employee_id AS emp_code, e.avatar_url, d.name AS department
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN attendance a ON a.employee_id = e.id AND DATE(a.date) = CURDATE()
      WHERE e.is_active = 1 AND (a.id IS NULL OR a.status = 'Absent')
      ORDER BY e.full_name
      LIMIT 10
    `);

    const [recentPunches] = await db.execute(`
      SELECT a.check_in, a.check_out, a.status, a.work_mode,
             e.full_name, e.employee_id AS emp_code, e.avatar_url
      FROM attendance a
      JOIN employees e ON e.id = a.employee_id
      WHERE DATE(a.date) = CURDATE() AND a.check_in IS NOT NULL
      ORDER BY a.check_in DESC
      LIMIT 8
    `);

    res.json({ success: true, data: { totals, absentList, recentPunches } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch today overview' });
  }
};

// ── POST /api/attendance/punch ─────────────────────────────
const punch = async (req, res) => {
  try {
    const empId = await getEmpId(req.user.id);
    if (!empId) return res.status(404).json({ success: false, message: 'Employee profile not found' });

    const { work_mode = 'Office', notes = '' } = req.body;

    const [[existing]] = await db.execute(
      'SELECT * FROM attendance WHERE employee_id = ? AND DATE(date) = CURDATE()', [empId]
    );

    const now = new Date();
    const hour = now.getHours();
    const isLate = hour >= 9 && (hour > 9 || now.getMinutes() > 30); // Late after 9:30

    if (!existing) {
      await db.execute(
        `INSERT INTO attendance (employee_id, date, check_in, status, work_mode, notes)
         VALUES (?, CURDATE(), NOW(), ?, ?, ?)`,
        [empId, isLate ? 'Late' : 'Present', work_mode, notes]
      );
      return res.json({ success: true, action: 'punch_in', message: `Punched in${isLate ? ' (Late)' : ''}`, time: now });
    }

    if (existing.check_in && !existing.check_out) {
      await db.execute(
        'UPDATE attendance SET check_out = NOW(), notes = ? WHERE id = ?',
        [notes || existing.notes, existing.id]
      );
      const worked = Math.round((now - new Date(existing.check_in)) / 60000);
      return res.json({ success: true, action: 'punch_out', message: 'Punched out successfully', worked_minutes: worked, time: now });
    }

    return res.json({ success: false, message: 'Already completed attendance for today' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Punch failed' });
  }
};

// ── POST /api/attendance/mark ──────────────────────────────
// Admin/Manager: bulk mark attendance
const mark = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { records } = req.body; // [{employee_id, date, status, check_in, check_out, work_mode}]

    for (const r of records) {
      await conn.execute(
        `INSERT INTO attendance (employee_id, date, check_in, check_out, status, work_mode)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           check_in=VALUES(check_in), check_out=VALUES(check_out),
           status=VALUES(status), work_mode=VALUES(work_mode)`,
        [r.employee_id, r.date, r.check_in || null, r.check_out || null, r.status || 'Present', r.work_mode || 'Office']
      );
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `MARK_ATTENDANCE:${records.length} records`, 'attendance', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: `${records.length} attendance record(s) marked` });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to mark attendance' });
  } finally {
    conn.release();
  }
};

// ── PUT /api/attendance/:id ────────────────────────────────
const update = async (req, res) => {
  try {
    const { check_in, check_out, status, work_mode, notes } = req.body;
    await db.execute(
      `UPDATE attendance SET check_in=?, check_out=?, status=?, work_mode=?, notes=? WHERE id=?`,
      [check_in || null, check_out || null, status, work_mode || 'Office', notes || null, req.params.id]
    );
    res.json({ success: true, message: 'Attendance updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// ── POST /api/attendance/:id/approve ──────────────────────
const approve = async (req, res) => {
  try {
    await db.execute(
      'UPDATE attendance SET approved_by = ?, approved_at = NOW() WHERE id = ?',
      [req.user.id, req.params.id]
    );
    res.json({ success: true, message: 'Attendance approved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Approval failed' });
  }
};

// ── GET /api/attendance/report ─────────────────────────────
const getReport = async (req, res) => {
  try {
    const { month = new Date().getMonth() + 1, year = new Date().getFullYear(), department_id } = req.query;
    const conditions = ['MONTH(a.date) = ?', 'YEAR(a.date) = ?', 'e.is_active = 1'];
    const params     = [Number(month), Number(year)];
    if (department_id) { conditions.push('e.department_id = ?'); params.push(department_id); }

    const [rows] = await db.execute(
      `SELECT e.employee_id AS emp_code, e.full_name, d.name AS department,
              SUM(a.status = 'Present')  AS present,
              SUM(a.status = 'Absent')   AS absent,
              SUM(a.status = 'Late')     AS late,
              SUM(a.status = 'Leave')    AS on_leave,
              SUM(a.status = 'Half-Day') AS half_day,
              ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.check_in, a.check_out)) / 60, 1) AS total_hours,
              COUNT(a.id)                AS total_days
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id = e.id AND MONTH(a.date) = ? AND YEAR(a.date) = ?
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY e.id
       ORDER BY e.full_name`,
      [...params, ...params]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
};

module.exports = { getAll, getMyCalendar, getTodayOverview, punch, mark, update, approve, getReport };