const db = require('../config/db');

// ── Helper ────────────────────────────────────────────────
const getEmpId = async (userId) => {
  const [[r]] = await db.execute(
    'SELECT id, manager_id FROM employees WHERE user_id = ? AND is_active = 1', [userId]
  );
  return r || null;
};

// ── GET /api/attendance-approval/team ─────────────────────
// Manager sees their direct reports' attendance for a date range
const getTeamAttendance = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    const {
      date = new Date().toISOString().slice(0, 10),
      month, year,
      employee_id, status,
      page = 1, limit = 20,
    } = req.query;

    const conditions = ['e.is_active = 1'];
    const params     = [];

    // Managers see their direct reports only; Admin/HR see all
    if (!isAdminHR) {
      const self = await getEmpId(req.user.id);
      if (!self) return res.status(404).json({ success: false, message: 'Employee not found' });
      conditions.push('e.manager_id = ?');
      params.push(self.id);
    }

    if (employee_id) { conditions.push('e.id = ?');            params.push(employee_id); }

    const empWhere = conditions.join(' AND ');

    // Date filter
    const attConditions = [];
    const attParams     = [];
    if (month && year) {
      attConditions.push('MONTH(a.date) = ? AND YEAR(a.date) = ?');
      attParams.push(Number(month), Number(year));
    } else {
      attConditions.push('DATE(a.date) = ?');
      attParams.push(date);
    }
    if (status) { attConditions.push('a.status = ?'); attParams.push(status); }

    const attWhere = attConditions.length ? 'AND ' + attConditions.join(' AND ') : '';
    const offset   = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(DISTINCT e.id) AS total FROM employees e WHERE ${empWhere}`, params
    );

    const [rows] = await db.execute(
      `SELECT e.id AS employee_id, e.full_name, e.employee_id AS emp_code,
              d.name AS department, des.name AS designation,
              a.id AS attendance_id, a.date, a.check_in, a.check_out,
              a.status, a.work_mode, a.notes, a.approved_by, a.approved_at,
              TIMESTAMPDIFF(MINUTE, a.check_in, a.check_out) AS worked_minutes,
              u.full_name AS approved_by_name,
              r.id AS reg_id, r.status AS reg_status
       FROM employees e
       LEFT JOIN departments  d   ON d.id   = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN attendance   a   ON a.employee_id = e.id ${attWhere}
       LEFT JOIN users        u   ON u.id   = a.approved_by
       LEFT JOIN attendance_regularization r
              ON r.employee_id = e.id AND r.request_date = a.date AND r.status = 'Pending'
       WHERE ${empWhere}
       ORDER BY e.full_name, a.date DESC
       LIMIT ? OFFSET ?`,
      [...params, ...attParams, ...params, ...attParams, Number(limit), offset]
    ).catch(async () => {
      // Fallback without join alias issue
      const [r2] = await db.execute(
        `SELECT e.id AS employee_id, e.full_name, e.employee_id AS emp_code,
                d.name AS department, des.name AS designation,
                a.id AS attendance_id, a.date, a.check_in, a.check_out,
                a.status, a.work_mode, a.notes,
                TIMESTAMPDIFF(MINUTE, a.check_in, a.check_out) AS worked_minutes
         FROM employees e
         LEFT JOIN departments  d   ON d.id  = e.department_id
         LEFT JOIN designations des ON des.id = e.designation_id
         LEFT JOIN attendance   a   ON a.employee_id = e.id ${attWhere}
         WHERE ${empWhere}
         ORDER BY e.full_name, a.date DESC
         LIMIT ? OFFSET ?`,
        [...params, ...attParams, Number(limit), offset]
      );
      return r2;
    });

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total) / Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch team attendance' });
  }
};

// ── POST /api/attendance-approval/approve/:attendanceId ───
const approveAttendance = async (req, res) => {
  try {
    const { attendanceId } = req.params;
    const [[att]] = await db.execute('SELECT * FROM attendance WHERE id = ?', [attendanceId]);
    if (!att) return res.status(404).json({ success: false, message: 'Attendance record not found' });

    await db.execute(
      'UPDATE attendance SET approved_by = ?, approved_at = NOW() WHERE id = ?',
      [req.user.id, attendanceId]
    );
    res.json({ success: true, message: 'Attendance approved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Approval failed' });
  }
};

// ── POST /api/attendance-approval/bulk-approve ────────────
const bulkApprove = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { attendance_ids } = req.body;
    if (!attendance_ids?.length) {
      await conn.rollback();
      return res.status(422).json({ success: false, message: 'No records provided' });
    }

    const placeholders = attendance_ids.map(() => '?').join(',');
    await conn.execute(
      `UPDATE attendance SET approved_by = ?, approved_at = NOW()
       WHERE id IN (${placeholders})`,
      [req.user.id, ...attendance_ids]
    );

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `BULK_APPROVE_ATT:${attendance_ids.length}`, 'attendance', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: `${attendance_ids.length} records approved` });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Bulk approval failed' });
  } finally {
    conn.release();
  }
};

// ── GET /api/attendance-approval/regularizations ──────────
const getRegularizations = async (req, res) => {
  try {
    const isAdminMgr = ['Admin', 'HR', 'Manager'].includes(req.user.role_name);
    const { status, page = 1, limit = 15 } = req.query;

    const conditions = ['1=1'];
    const params     = [];

    if (!isAdminMgr) {
      const emp = await getEmpId(req.user.id);
      if (emp) { conditions.push('r.employee_id = ?'); params.push(emp.id); }
    } else if (!['Admin', 'HR'].includes(req.user.role_name)) {
      // Manager sees their team
      const emp = await getEmpId(req.user.id);
      if (emp) {
        conditions.push('e.manager_id = ?'); params.push(emp.id);
      }
    }

    if (status) { conditions.push('r.status = ?'); params.push(status); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM attendance_regularization r
       JOIN employees e ON e.id = r.employee_id WHERE ${where}`, params
    );

    const [rows] = await db.execute(
      `SELECT r.*,
              e.full_name, e.employee_id AS emp_code, e.avatar_url,
              d.name AS department,
              u.full_name AS approved_by_name,
              a.check_in AS orig_check_in, a.check_out AS orig_check_out, a.status AS orig_status
       FROM attendance_regularization r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users u ON u.id = r.approved_by
       LEFT JOIN attendance a ON a.id = r.attendance_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total) / Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch regularizations' });
  }
};

// ── POST /api/attendance-approval/regularizations ─────────
// Employee submits a regularization request
const createRegularization = async (req, res) => {
  try {
    const emp = await getEmpId(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const {
      request_date, requested_check_in, requested_check_out,
      requested_status, requested_work_mode, reason,
    } = req.body;

    // Check if request already exists
    const [[existing]] = await db.execute(
      'SELECT id FROM attendance_regularization WHERE employee_id = ? AND request_date = ?',
      [emp.id, request_date]
    );
    if (existing) {
      return res.status(409).json({ success: false, message: 'A request for this date already exists' });
    }

    // Get attendance record if exists
    const [[att]] = await db.execute(
      'SELECT id FROM attendance WHERE employee_id = ? AND DATE(date) = ?',
      [emp.id, request_date]
    );

    const [result] = await db.execute(
      `INSERT INTO attendance_regularization
         (employee_id, attendance_id, request_date,
          requested_check_in, requested_check_out,
          requested_status, requested_work_mode, reason)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        emp.id, att?.id || null, request_date,
        requested_check_in || null, requested_check_out || null,
        requested_status || 'Present', requested_work_mode || 'Office',
        reason,
      ]
    );

    res.status(201).json({ success: true, message: 'Regularization request submitted', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to submit request' });
  }
};

// ── POST /api/attendance-approval/regularizations/:id/approve
const approveRegularization = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;

    const [[reg]] = await conn.execute(
      'SELECT * FROM attendance_regularization WHERE id = ?', [id]
    );
    if (!reg) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Request not found' }); }
    if (reg.status !== 'Pending') {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Only pending requests can be approved' });
    }

    // Upsert attendance record with requested values
    await conn.execute(
      `INSERT INTO attendance (employee_id, date, check_in, check_out, status, work_mode, approved_by, approved_at)
       VALUES (?,?,?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE
         check_in=VALUES(check_in), check_out=VALUES(check_out),
         status=VALUES(status), work_mode=VALUES(work_mode),
         approved_by=VALUES(approved_by), approved_at=NOW()`,
      [
        reg.employee_id, reg.request_date,
        reg.requested_check_in, reg.requested_check_out,
        reg.requested_status, reg.requested_work_mode,
        req.user.id,
      ]
    );

    await conn.execute(
      'UPDATE attendance_regularization SET status=?, approved_by=?, approved_at=NOW() WHERE id=?',
      ['Approved', req.user.id, id]
    );

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `APPROVE_REG:${id}`, 'attendance', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: 'Regularization approved and attendance updated' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Approval failed' });
  } finally {
    conn.release();
  }
};

// ── POST /api/attendance-approval/regularizations/:id/reject
const rejectRegularization = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejection_reason } = req.body;

    if (!rejection_reason?.trim()) {
      return res.status(422).json({ success: false, message: 'Rejection reason is required' });
    }

    const [[reg]] = await db.execute(
      'SELECT * FROM attendance_regularization WHERE id = ?', [id]
    );
    if (!reg) return res.status(404).json({ success: false, message: 'Request not found' });
    if (reg.status !== 'Pending') {
      return res.status(400).json({ success: false, message: 'Only pending requests can be rejected' });
    }

    await db.execute(
      'UPDATE attendance_regularization SET status=?, approved_by=?, approved_at=NOW(), rejection_reason=? WHERE id=?',
      ['Rejected', req.user.id, rejection_reason, id]
    );

    res.json({ success: true, message: 'Request rejected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Rejection failed' });
  }
};

// ── GET /api/attendance-approval/stats ────────────────────
const getApprovalStats = async (req, res) => {
  try {
    const [[reg]] = await db.execute(`
      SELECT
        SUM(status='Pending')  AS pending_reg,
        SUM(status='Approved') AS approved_reg,
        SUM(status='Rejected') AS rejected_reg,
        COUNT(*)               AS total_reg
      FROM attendance_regularization
      WHERE MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())`
    );

    const [[att]] = await db.execute(`
      SELECT
        SUM(approved_by IS NULL AND status IN ('Present','Late')) AS pending_att,
        SUM(approved_by IS NOT NULL) AS approved_att,
        COUNT(*) AS total_att
      FROM attendance
      WHERE DATE(date) = CURDATE()`
    );

    res.json({ success: true, data: { regularizations: reg, attendance: att } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

module.exports = {
  getTeamAttendance,
  approveAttendance,
  bulkApprove,
  getRegularizations,
  createRegularization,
  approveRegularization,
  rejectRegularization,
  getApprovalStats,
};