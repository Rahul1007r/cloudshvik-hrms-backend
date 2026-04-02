const db = require('../config/db');

// ── Helper ────────────────────────────────────────────────
const getEmpId = async (userId) => {
  const [[row]] = await db.execute(
    'SELECT id FROM employees WHERE user_id = ? AND is_active = 1', [userId]
  );
  return row?.id || null;
};

// Calculate working days between two dates (exclude weekends)
const workingDays = (start, end) => {
  let count = 0;
  const cur = new Date(start);
  const fin = new Date(end);
  while (cur <= fin) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
};

// ── GET /api/leave/types ───────────────────────────────────
const getLeaveTypes = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT lt.*, lp.min_notice_days, lp.max_consecutive,
             lp.allow_half_day, lp.gender_specific
      FROM leave_types lt
      LEFT JOIN leave_policies lp ON lp.leave_type_id = lt.id
      WHERE lt.is_active = 1
      ORDER BY lt.name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch leave types' });
  }
};

// ── GET /api/leave/balance ─────────────────────────────────
const getBalance = async (req, res) => {
  try {
    const empId = req.query.employee_id || await getEmpId(req.user.id);
    const year  = req.query.year || new Date().getFullYear();

    const [rows] = await db.execute(`
      SELECT lb.*, lt.name AS type_name, lt.code, lt.color,
             lt.is_paid, lt.carry_forward,
             (lb.total_days + lb.carried_days - lb.used_days - lb.pending_days) AS available
      FROM leave_balance lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id = ? AND lb.year = ?
      ORDER BY lt.name`, [empId, year]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch balance' });
  }
};

// ── GET /api/leave/requests ────────────────────────────────
const getRequests = async (req, res) => {
  try {
    const {
      status, employee_id, leave_type_id,
      month, year, page = 1, limit = 15,
    } = req.query;

    const isAdminHR = ['Admin','HR','Manager'].includes(req.user.role_name);
    const conditions = ['1=1'];
    const params     = [];

    if (!isAdminHR) {
      const empId = await getEmpId(req.user.id);
      conditions.push('lr.employee_id = ?'); params.push(empId);
    } else if (employee_id) {
      conditions.push('lr.employee_id = ?'); params.push(employee_id);
    }

    if (status)        { conditions.push('lr.status = ?');          params.push(status); }
    if (leave_type_id) { conditions.push('lr.leave_type_id = ?');   params.push(leave_type_id); }
    if (month)         { conditions.push('MONTH(lr.start_date) = ?'); params.push(month); }
    if (year)          { conditions.push('YEAR(lr.start_date) = ?');  params.push(year); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM leave_requests lr WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT lr.*,
             lt.name AS leave_type_name, lt.code AS leave_code, lt.color,
             e.full_name, e.employee_id AS emp_code, e.avatar_url,
             d.name AS department,
             u.full_name AS approved_by_name
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN employees  e  ON e.id  = lr.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u ON u.id = lr.approved_by
      WHERE ${where}
      ORDER BY lr.created_at DESC
      LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), limit: Number(limit), pages: Math.ceil(Number(total)/Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch requests' });
  }
};

// ── POST /api/leave/apply ──────────────────────────────────
const apply = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const empId = await getEmpId(req.user.id);
    if (!empId) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Employee profile not found' }); }

    const { leave_type_id, start_date, end_date, reason, half_day, half_day_period } = req.body;

    // Validate dates
    if (new Date(start_date) > new Date(end_date)) {
      await conn.rollback();
      return res.status(422).json({ success: false, message: 'Start date must be before end date' });
    }

    const days = half_day ? 0.5 : workingDays(start_date, end_date);
    if (days === 0) { await conn.rollback(); return res.status(422).json({ success: false, message: 'No working days in selected range' }); }

    // Check for overlapping leave
    const [overlap] = await conn.execute(`
      SELECT id FROM leave_requests
      WHERE employee_id = ? AND status != 'Cancelled' AND status != 'Rejected'
        AND NOT (end_date < ? OR start_date > ?)`,
      [empId, start_date, end_date]
    );
    if (overlap.length) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'You already have a leave request overlapping these dates' });
    }

    // Check balance
    const year = new Date(start_date).getFullYear();
    const [[bal]] = await conn.execute(
      `SELECT total_days + carried_days - used_days - pending_days AS available
       FROM leave_balance WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
      [empId, leave_type_id, year]
    );

    const [[lt]] = await conn.execute('SELECT * FROM leave_types WHERE id = ?', [leave_type_id]);
    if (lt?.max_days > 0 && bal && Number(bal.available) < days) {
      await conn.rollback();
      return res.status(422).json({ success: false, message: `Insufficient leave balance. Available: ${bal.available} days` });
    }

    // Insert request
    const [result] = await conn.execute(`
      INSERT INTO leave_requests
        (employee_id, leave_type_id, start_date, end_date, total_days, reason, half_day, half_day_period)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [empId, leave_type_id, start_date, end_date, days, reason || null, half_day || false, half_day_period || null]
    );

    // Update pending balance
    await conn.execute(`
      UPDATE leave_balance SET pending_days = pending_days + ?
      WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
      [days, empId, leave_type_id, year]
    ).catch(() => {}); // balance row may not exist for LOP

    await conn.commit();
    res.status(201).json({ success: true, message: 'Leave request submitted', data: { id: result.insertId } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to apply for leave' });
  } finally {
    conn.release();
  }
};

// ── POST /api/leave/:id/approve ────────────────────────────
const approve = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const [[req_row]] = await conn.execute('SELECT * FROM leave_requests WHERE id = ?', [id]);
    if (!req_row) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Request not found' }); }
    if (req_row.status !== 'Pending') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Only pending requests can be approved' }); }

    await conn.execute(
      'UPDATE leave_requests SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?',
      ['Approved', req.user.id, id]
    );

    // Move pending → used in balance
    const year = new Date(req_row.start_date).getFullYear();
    await conn.execute(`
      UPDATE leave_balance
      SET used_days = used_days + ?, pending_days = GREATEST(pending_days - ?, 0)
      WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
      [req_row.total_days, req_row.total_days, req_row.employee_id, req_row.leave_type_id, year]
    ).catch(() => {});

    // Mark those days in attendance as Leave
    await conn.execute(`
      INSERT INTO attendance (employee_id, date, status)
      SELECT ?, d.date, 'Leave'
      FROM (
        SELECT DATE_ADD(?, INTERVAL seq.n DAY) AS date
        FROM (SELECT 0 AS n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3
              UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7
              UNION SELECT 8 UNION SELECT 9 UNION SELECT 10) seq
        WHERE DATE_ADD(?, INTERVAL seq.n DAY) <= ?
          AND DAYOFWEEK(DATE_ADD(?, INTERVAL seq.n DAY)) NOT IN (1,7)
      ) d
      ON DUPLICATE KEY UPDATE status = 'Leave'`,
      [req_row.employee_id, req_row.start_date, req_row.start_date, req_row.end_date, req_row.start_date]
    ).catch(() => {});

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `APPROVE_LEAVE:${id}`, 'leave', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: 'Leave approved' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Approval failed' });
  } finally {
    conn.release();
  }
};

// ── POST /api/leave/:id/reject ─────────────────────────────
const reject = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { rejection_reason } = req.body;
    const [[req_row]] = await conn.execute('SELECT * FROM leave_requests WHERE id = ?', [id]);
    if (!req_row) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Request not found' }); }
    if (req_row.status !== 'Pending') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Only pending requests can be rejected' }); }

    await conn.execute(
      'UPDATE leave_requests SET status = ?, approved_by = ?, approved_at = NOW(), rejection_reason = ? WHERE id = ?',
      ['Rejected', req.user.id, rejection_reason || null, id]
    );

    // Restore pending balance
    const year = new Date(req_row.start_date).getFullYear();
    await conn.execute(
      'UPDATE leave_balance SET pending_days = GREATEST(pending_days - ?, 0) WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
      [req_row.total_days, req_row.employee_id, req_row.leave_type_id, year]
    ).catch(() => {});

    await conn.commit();
    res.json({ success: true, message: 'Leave rejected' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Rejection failed' });
  } finally {
    conn.release();
  }
};

// ── PATCH /api/leave/:id/cancel ────────────────────────────
const cancel = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const empId = await getEmpId(req.user.id);
    const { id } = req.params;
    const [[req_row]] = await conn.execute(
      'SELECT * FROM leave_requests WHERE id = ? AND employee_id = ?', [id, empId]
    );
    if (!req_row) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Request not found' }); }
    if (!['Pending','Approved'].includes(req_row.status)) {
      await conn.rollback(); return res.status(400).json({ success: false, message: 'Cannot cancel this request' });
    }

    await conn.execute('UPDATE leave_requests SET status = ? WHERE id = ?', ['Cancelled', id]);

    const year = new Date(req_row.start_date).getFullYear();
    if (req_row.status === 'Pending') {
      await conn.execute(
        'UPDATE leave_balance SET pending_days = GREATEST(pending_days - ?, 0) WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
        [req_row.total_days, empId, req_row.leave_type_id, year]
      ).catch(() => {});
    } else {
      await conn.execute(
        'UPDATE leave_balance SET used_days = GREATEST(used_days - ?, 0) WHERE employee_id = ? AND leave_type_id = ? AND year = ?',
        [req_row.total_days, empId, req_row.leave_type_id, year]
      ).catch(() => {});
    }

    await conn.commit();
    res.json({ success: true, message: 'Leave cancelled' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Cancel failed' });
  } finally {
    conn.release();
  }
};

// ── GET /api/leave/calendar ────────────────────────────────
// Who is on leave this month — for team calendar
const getCalendar = async (req, res) => {
  try {
    const { month = new Date().getMonth()+1, year = new Date().getFullYear() } = req.query;
    const [rows] = await db.execute(`
      SELECT lr.start_date, lr.end_date, lr.total_days, lr.half_day,
             lt.name AS leave_type, lt.color, lt.code,
             e.full_name, e.employee_id AS emp_code, e.avatar_url,
             d.name AS department
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN employees  e  ON e.id  = lr.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE lr.status = 'Approved'
        AND YEAR(lr.start_date)  = ? AND MONTH(lr.start_date) = ?
      ORDER BY lr.start_date`, [year, month]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch calendar' });
  }
};

// ── GET /api/leave/stats ───────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[counts]] = await db.execute(`
      SELECT
        SUM(status='Pending')  AS pending,
        SUM(status='Approved') AS approved,
        SUM(status='Rejected') AS rejected,
        COUNT(*)               AS total
      FROM leave_requests
      WHERE YEAR(created_at) = YEAR(NOW())`
    );
    const [byType] = await db.execute(`
      SELECT lt.name, lt.color, COUNT(lr.id) AS count
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.status='Approved' AND YEAR(lr.start_date)=YEAR(NOW())
      GROUP BY lt.id ORDER BY count DESC LIMIT 5`
    );
    res.json({ success: true, data: { counts, byType } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

// ── CRUD leave types (Admin only) ─────────────────────────
const createLeaveType = async (req, res) => {
  try {
    const { name, code, max_days, is_paid, carry_forward, max_carry_days, requires_doc, color } = req.body;
    const [result] = await db.execute(
      'INSERT INTO leave_types (name, code, max_days, is_paid, carry_forward, max_carry_days, requires_doc, color) VALUES (?,?,?,?,?,?,?,?)',
      [name, code.toUpperCase(), max_days||0, is_paid??true, carry_forward??false, max_carry_days||0, requires_doc??false, color||'#006bb7']
    );
    res.status(201).json({ success: true, message: 'Leave type created', data: { id: result.insertId } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Leave type or code already exists' });
    res.status(500).json({ success: false, message: 'Failed to create leave type' });
  }
};

const updateLeaveType = async (req, res) => {
  try {
    const { name, max_days, is_paid, carry_forward, max_carry_days, requires_doc, color } = req.body;
    await db.execute(
      'UPDATE leave_types SET name=?,max_days=?,is_paid=?,carry_forward=?,max_carry_days=?,requires_doc=?,color=? WHERE id=?',
      [name, max_days||0, is_paid??true, carry_forward??false, max_carry_days||0, requires_doc??false, color||'#006bb7', req.params.id]
    );
    res.json({ success: true, message: 'Leave type updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

module.exports = {
  getLeaveTypes, getBalance, getRequests,
  apply, approve, reject, cancel,
  getCalendar, getStats,
  createLeaveType, updateLeaveType,
};