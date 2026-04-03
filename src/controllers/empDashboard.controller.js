const db = require('../config/db');

// ── Helper ────────────────────────────────────────────────
const getEmployee = async (userId) => {
  const [rows] = await db.execute(
    `SELECT e.*, d.name AS department_name, des.name AS designation_name,
            m.full_name AS manager_name, m.employee_id AS manager_emp_id,
            m.avatar_url AS manager_avatar
     FROM employees e
     LEFT JOIN departments  d   ON d.id  = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id
     LEFT JOIN employees    m   ON m.id  = e.manager_id
     WHERE e.user_id = ? AND e.is_active = 1`,
    [userId]
  );
  return rows[0] || null;
};

// ── GET /api/emp-dashboard/summary ────────────────────────
// Everything needed for the dashboard in one call
const getSummary = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee profile not found' });

    const year  = new Date().getFullYear();
    const month = new Date().getMonth() + 1;

    // Attendance this month
    const [[att]] = await db.execute(`
      SELECT
        SUM(status IN ('Present','Late')) AS present,
        SUM(status = 'Absent')  AS absent,
        SUM(status = 'Late')    AS late,
        SUM(status = 'Leave')   AS on_leave,
        COUNT(*)                AS total,
        ROUND(SUM(TIMESTAMPDIFF(MINUTE, check_in, check_out))/60, 1) AS total_hours
      FROM attendance
      WHERE employee_id = ? AND MONTH(date) = ? AND YEAR(date) = ?`,
      [emp.id, month, year]
    );

    // Today's attendance
    const [[today]] = await db.execute(
      `SELECT *, TIMESTAMPDIFF(MINUTE, check_in, NOW()) AS elapsed_minutes
       FROM attendance WHERE employee_id = ? AND DATE(date) = CURDATE()`,
      [emp.id]
    );

    // Leave balance
    const [leaveBalance] = await db.execute(`
      SELECT lb.*, lt.name AS type_name, lt.color,
             (lb.total_days + lb.carried_days - lb.used_days - lb.pending_days) AS available
      FROM leave_balance lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id = ? AND lb.year = ?
      ORDER BY lt.name`, [emp.id, year]
    ).catch(() => [[]]);

    // Recent leave requests (last 3)
    const [recentLeaves] = await db.execute(`
      SELECT lr.*, lt.name AS type_name, lt.color
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.employee_id = ?
      ORDER BY lr.created_at DESC LIMIT 3`, [emp.id]
    ).catch(() => [[]]);

    // Recent payslips (last 3)
    const [payslips] = await db.execute(`
      SELECT id, month, year, gross_salary, net_salary, total_deductions, status
      FROM payslips WHERE employee_id = ?
      ORDER BY year DESC, month DESC LIMIT 3`, [emp.id]
    ).catch(() => [[]]);

    // Team members (same dept, excluding self)
    const [team] = await db.execute(`
      SELECT e.id, e.full_name, e.avatar_url, des.name AS designation_name,
             a.status AS today_status
      FROM employees e
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN attendance    a  ON a.employee_id = e.id AND DATE(a.date) = CURDATE()
      WHERE e.department_id = ? AND e.id != ? AND e.is_active = 1
      ORDER BY e.full_name LIMIT 8`, [emp.department_id, emp.id]
    ).catch(() => [[]]);

    // Upcoming holidays (next 3)
    const [holidays] = await db.execute(`
      SELECT name, date, type FROM holidays
      WHERE date >= CURDATE() ORDER BY date ASC LIMIT 3`
    ).catch(() => [[]]);

    // Announcements (last 4)
    const [announcements] = await db.execute(`
      SELECT n.id, n.title, n.message, n.created_at, u.full_name AS posted_by
      FROM notifications n
      LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.created_at DESC LIMIT 4`
    ).catch(() => [[]]);

    // YTD payroll summary
    const [[ytd]] = await db.execute(`
      SELECT SUM(gross_salary) AS gross, SUM(net_salary) AS net,
             SUM(total_deductions) AS deductions, COUNT(*) AS months
      FROM payslips WHERE employee_id = ? AND year = ?`, [emp.id, year]
    ).catch(() => [[{ gross:0, net:0, deductions:0, months:0 }]]);

    res.json({
      success: true,
      data: {
        employee:     emp,
        attendance:   { ...att, today },
        leaveBalance,
        recentLeaves,
        payslips,
        team,
        holidays,
        announcements,
        ytd,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard data' });
  }
};

// ── GET /api/emp-dashboard/profile ────────────────────────
const getProfile = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data: emp });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
};

// ── PUT /api/emp-dashboard/profile ────────────────────────
// Employees can update personal-only fields
const updateProfile = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const {
      phone, address, city, state, pincode, blood_group,
      emergency_contact_name, emergency_contact_phone,
    } = req.body;

    await db.execute(`
      UPDATE employees SET
        phone=?, address=?, city=?, state=?, pincode=?,
        blood_group=?, emergency_contact_name=?, emergency_contact_phone=?
      WHERE id=?`,
      [
        phone||null, address||null, city||null, state||null, pincode||null,
        blood_group||null, emergency_contact_name||null, emergency_contact_phone||null,
        emp.id,
      ]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, 'UPDATE_OWN_PROFILE', 'employees', req.ip]
    );

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Profile update failed' });
  }
};

// ── POST /api/emp-dashboard/punch ─────────────────────────
const punch = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const { work_mode = 'Office', notes = '' } = req.body;
    const [[existing]] = await db.execute(
      'SELECT * FROM attendance WHERE employee_id = ? AND DATE(date) = CURDATE()', [emp.id]
    );

    const now  = new Date();
    const isLate = now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() > 30);

    if (!existing) {
      await db.execute(
        `INSERT INTO attendance (employee_id, date, check_in, status, work_mode, notes)
         VALUES (?, CURDATE(), NOW(), ?, ?, ?)`,
        [emp.id, isLate ? 'Late' : 'Present', work_mode, notes]
      );
      return res.json({ success:true, action:'punch_in', message:`Punched in${isLate?' (Late)':''}`, isLate });
    }

    if (existing.check_in && !existing.check_out) {
      await db.execute('UPDATE attendance SET check_out = NOW() WHERE id = ?', [existing.id]);
      const worked = Math.round((now - new Date(existing.check_in)) / 60000);
      return res.json({ success:true, action:'punch_out', message:'Punched out', worked_minutes: worked });
    }

    return res.json({ success:false, message:'Attendance already completed for today' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Punch failed' });
  }
};

// ── GET /api/emp-dashboard/attendance-history ─────────────
const getAttendanceHistory = async (req, res) => {
  try {
    const emp = await getEmployee(req.user.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const { month = new Date().getMonth()+1, year = new Date().getFullYear() } = req.query;

    const [rows] = await db.execute(`
      SELECT date, check_in, check_out, status, work_mode,
             TIMESTAMPDIFF(MINUTE, check_in, check_out) AS worked_minutes
      FROM attendance
      WHERE employee_id = ? AND MONTH(date)=? AND YEAR(date)=?
      ORDER BY date DESC`, [emp.id, month, year]
    );

    const [holidays] = await db.execute(
      'SELECT date, name FROM holidays WHERE MONTH(date)=? AND YEAR(date)=?', [month, year]
    ).catch(() => [[]]);

    res.json({ success: true, data: { records: rows, holidays } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
};

module.exports = { getSummary, getProfile, updateProfile, punch, getAttendanceHistory };