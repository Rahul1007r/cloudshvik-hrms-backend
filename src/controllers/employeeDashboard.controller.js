const db = require('../config/db');

// ── Helper: get employee record from user id ───────────────
const getEmployee = async (userId) => {
  const [rows] = await db.execute(
    `SELECT e.*, d.name AS department_name, des.name AS designation_name
     FROM employees e
     LEFT JOIN departments  d   ON d.id  = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id
     WHERE e.user_id = ? AND e.is_active = 1`,
    [userId]
  );
  return rows[0] || null;
};

// ── GET /api/employee-dashboard/profile ───────────────────
const getProfile = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee profile not found' });

    // Manager info
    let manager = null;
    if (emp.manager_id) {
      const [mgr] = await db.execute(
        'SELECT id, full_name, avatar_url, employee_id FROM employees WHERE id = ?',
        [emp.manager_id]
      );
      manager = mgr[0] || null;
    }

    res.json({ success: true, data: { ...emp, manager } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
};

// ── GET /api/employee-dashboard/attendance-summary ────────
// Current month attendance breakdown
const getAttendanceSummary = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const [rows] = await db.execute(
      `SELECT
         SUM(status = 'Present')  AS present,
         SUM(status = 'Absent')   AS absent,
         SUM(status = 'Late')     AS late,
         SUM(status = 'Leave')    AS on_leave,
         COUNT(*)                 AS total_days,
         SUM(TIMESTAMPDIFF(MINUTE, check_in, check_out)) AS total_minutes
       FROM attendance
       WHERE employee_id = ?
         AND MONTH(date) = MONTH(NOW())
         AND YEAR(date)  = YEAR(NOW())`,
      [emp.id]
    );

    // Today's attendance
    const [today] = await db.execute(
      `SELECT * FROM attendance
       WHERE employee_id = ? AND DATE(date) = CURDATE()
       LIMIT 1`,
      [emp.id]
    );

    // Last 10 days
    const [recent] = await db.execute(
      `SELECT date, status, check_in, check_out,
              TIMESTAMPDIFF(MINUTE, check_in, check_out) AS worked_minutes
       FROM attendance
       WHERE employee_id = ?
       ORDER BY date DESC
       LIMIT 10`,
      [emp.id]
    );

    const s = rows[0];
    res.json({
      success: true,
      data: {
        present:      Number(s.present   || 0),
        absent:       Number(s.absent    || 0),
        late:         Number(s.late      || 0),
        on_leave:     Number(s.on_leave  || 0),
        total_days:   Number(s.total_days || 0),
        total_hours:  Math.round((s.total_minutes || 0) / 60),
        today:        today[0] || null,
        recent,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch attendance' });
  }
};

// ── GET /api/employee-dashboard/leave-balance ─────────────
const getLeaveBalance = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const [balance] = await db.execute(
      `SELECT lb.*, lt.name AS leave_type_name
       FROM leave_balance lb
       JOIN leave_types lt ON lt.id = lb.leave_type_id
       WHERE lb.employee_id = ? AND lb.year = YEAR(NOW())`,
      [emp.id]
    ).catch(() => [[]]);

    // Pending leave requests
    const [pending] = await db.execute(
      `SELECT * FROM leave_requests
       WHERE employee_id = ? AND status = 'Pending'
       ORDER BY created_at DESC`,
      [emp.id]
    );

    // Recent leave history
    const [history] = await db.execute(
      `SELECT lr.*, lt.name AS leave_type_name
       FROM leave_requests lr
       LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.employee_id = ?
       ORDER BY lr.created_at DESC
       LIMIT 5`,
      [emp.id]
    ).catch(() => [[]]);

    res.json({ success: true, data: { balance, pending, history } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch leave data' });
  }
};

// ── GET /api/employee-dashboard/payslips ──────────────────
const getPayslips = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const [rows] = await db.execute(
      `SELECT id, month, year, basic_salary, gross_salary,
              total_deductions, net_salary, status, created_at
       FROM payslips
       WHERE employee_id = ?
       ORDER BY year DESC, month DESC
       LIMIT 6`,
      [emp.id]
    ).catch(() => [[]]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch payslips' });
  }
};

// ── GET /api/employee-dashboard/announcements ─────────────
const getAnnouncements = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT n.id, n.title, n.message, n.created_at, u.full_name AS posted_by
       FROM notifications n
       LEFT JOIN users u ON u.id = n.created_by
       WHERE n.type = 'Announcement' OR n.type IS NULL
       ORDER BY n.created_at DESC
       LIMIT 5`
    ).catch(() => [[]]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch announcements' });
  }
};

// ── GET /api/employee-dashboard/upcoming-holidays ────────
const getUpcomingHolidays = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT id, name, date, type
       FROM holidays
       WHERE date >= CURDATE()
       ORDER BY date ASC
       LIMIT 5`
    ).catch(() => [[]]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch holidays' });
  }
};

// ── POST /api/employee-dashboard/punch ────────────────────
// Mark punch-in or punch-out
const punch = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const [existing] = await db.execute(
      'SELECT * FROM attendance WHERE employee_id = ? AND DATE(date) = CURDATE()',
      [emp.id]
    );

    if (!existing.length) {
      // Punch in
      await db.execute(
        `INSERT INTO attendance (employee_id, date, check_in, status)
         VALUES (?, CURDATE(), NOW(), 'Present')`,
        [emp.id]
      );
      return res.json({ success: true, message: 'Punched in successfully', action: 'punch_in' });
    }

    if (!existing[0].check_out) {
      // Punch out
      await db.execute(
        'UPDATE attendance SET check_out = NOW() WHERE id = ?',
        [existing[0].id]
      );
      return res.json({ success: true, message: 'Punched out successfully', action: 'punch_out' });
    }

    return res.json({ success: false, message: 'Already punched in and out today' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Punch failed' });
  }
};

module.exports = {
  getProfile,
  getAttendanceSummary,
  getLeaveBalance,
  getPayslips,
  getAnnouncements,
  getUpcomingHolidays,
  punch,
};