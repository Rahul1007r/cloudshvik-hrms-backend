const db = require('../config/db');

// ── GET /api/dashboard/stats ───────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[empRow]]        = await db.execute('SELECT COUNT(*) AS total FROM employees WHERE is_active = 1');
    const [[newEmpRow]]     = await db.execute(`SELECT COUNT(*) AS total FROM employees WHERE is_active = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    const [[deptRow]]       = await db.execute('SELECT COUNT(*) AS total FROM departments WHERE is_active = 1');
    const [[pendLeaveRow]]  = await db.execute(`SELECT COUNT(*) AS total FROM leave_requests WHERE status = 'Pending'`);
    const [[todayAttRow]]   = await db.execute(`SELECT COUNT(*) AS total FROM attendance WHERE DATE(date) = CURDATE() AND status = 'Present'`);
    const [[payrollRow]]    = await db.execute(`SELECT COALESCE(SUM(net_salary),0) AS total FROM payslips WHERE MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW())`);
    const [[openTicketRow]] = await db.execute(`SELECT COUNT(*) AS total FROM helpdesk_tickets WHERE status = 'Open'`).catch(() => [[{ total: 0 }]]);

    res.json({
      success: true,
      data: {
        totalEmployees:   Number(empRow.total),
        newThisMonth:     Number(newEmpRow.total),
        totalDepartments: Number(deptRow.total),
        pendingLeaves:    Number(pendLeaveRow.total),
        todayAttendance:  Number(todayAttRow.total),
        monthlyPayroll:   Number(payrollRow.total),
        openTickets:      Number(openTicketRow.total),
      },
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

// ── GET /api/dashboard/attendance-chart ────────────────────
// Last 7 days attendance breakdown
const getAttendanceChart = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        DATE_FORMAT(date, '%a') AS day,
        DATE(date)              AS full_date,
        SUM(status = 'Present') AS present,
        SUM(status = 'Absent')  AS absent,
        SUM(status = 'Late')    AS late,
        SUM(status = 'Leave')   AS on_leave
      FROM attendance
      WHERE date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY DATE(date)
      ORDER BY DATE(date) ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Attendance chart error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch chart data' });
  }
};

// ── GET /api/dashboard/dept-distribution ──────────────────
const getDeptDistribution = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT d.name, COUNT(e.id) AS count
      FROM departments d
      LEFT JOIN employees e ON e.department_id = d.id AND e.is_active = 1
      WHERE d.is_active = 1
      GROUP BY d.id
      ORDER BY count DESC
      LIMIT 8
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Dept distribution error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch department data' });
  }
};

// ── GET /api/dashboard/recent-activity ────────────────────
const getRecentActivity = async (req, res) => {
  try {
    const [logs] = await db.execute(`
      SELECT al.action, al.module, al.created_at,
             u.full_name, u.employee_id
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT 10
    `);
    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Activity error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch activity' });
  }
};

// ── GET /api/dashboard/pending-leaves ─────────────────────
const getPendingLeaves = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT lr.id, lr.leave_type, lr.start_date, lr.end_date,
             lr.reason, lr.created_at,
             e.full_name, e.employee_id, e.avatar_url,
             d.name AS department
      FROM leave_requests lr
      JOIN employees e ON e.id = lr.employee_id
      JOIN departments d ON d.id = e.department_id
      WHERE lr.status = 'Pending'
      ORDER BY lr.created_at DESC
      LIMIT 5
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Pending leaves error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch pending leaves' });
  }
};

// ── GET /api/dashboard/monthly-headcount ──────────────────
// Employee count per month for the last 6 months
const getMonthlyHeadcount = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT DATE_FORMAT(created_at, '%b %Y') AS month,
             DATE_FORMAT(created_at, '%Y-%m') AS sort_key,
             COUNT(*) AS count
      FROM employees
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY sort_key
      ORDER BY sort_key ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Headcount error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch headcount' });
  }
};

module.exports = {
  getStats,
  getAttendanceChart,
  getDeptDistribution,
  getRecentActivity,
  getPendingLeaves,
  getMonthlyHeadcount,
};