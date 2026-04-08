const db = require('../config/db');

// ── Helpers ────────────────────────────────────────────────
const getEmpId = async (userId) => {
  const [[r]] = await db.execute(
    'SELECT id FROM employees WHERE user_id = ? AND is_active = 1', [userId]
  );
  return r?.id || null;
};

// ── GET /api/leave-approval/stats ─────────────────────────
const getStats = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    let empCondition = '1=1';
    const empParams  = [];

    if (!isAdminHR) {
      const empId = await getEmpId(req.user.id);
      if (empId) { empCondition = 'e.manager_id = ?'; empParams.push(empId); }
    }

    const [[counts]] = await db.execute(`
      SELECT
        SUM(lr.status = 'Pending')  AS pending,
        SUM(lr.status = 'Approved') AS approved,
        SUM(lr.status = 'Rejected') AS rejected,
        COUNT(*)                    AS total,
        SUM(lr.status = 'Pending' AND DATEDIFF(lr.start_date, CURDATE()) <= 3) AS urgent
      FROM leave_requests lr
      JOIN employees e ON e.id = lr.employee_id
      WHERE ${empCondition}
        AND YEAR(lr.created_at) = YEAR(NOW())`, empParams
    );

    const [[thisWeek]] = await db.execute(`
      SELECT COUNT(*) AS on_leave
      FROM leave_requests lr
      JOIN employees e ON e.id = lr.employee_id
      WHERE ${empCondition}
        AND lr.status = 'Approved'
        AND lr.start_date <= CURDATE()
        AND lr.end_date   >= CURDATE()`, empParams
    );

    res.json({
      success: true,
      data: {
        pending:   Number(counts.pending   || 0),
        approved:  Number(counts.approved  || 0),
        rejected:  Number(counts.rejected  || 0),
        total:     Number(counts.total     || 0),
        urgent:    Number(counts.urgent    || 0),
        onLeaveNow:Number(thisWeek.on_leave|| 0),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

// ── GET /api/leave-approval/pending ───────────────────────
const getPending = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    const { page = 1, limit = 15, leave_type_id, sort = 'urgent' } = req.query;

    let empCondition = '1=1';
    const params     = [];

    if (!isAdminHR) {
      const empId = await getEmpId(req.user.id);
      if (empId) { empCondition = 'e.manager_id = ?'; params.push(empId); }
    }

    const conditions = [empCondition, "lr.status = 'Pending'"];
    if (leave_type_id) { conditions.push('lr.leave_type_id = ?'); params.push(leave_type_id); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const orderMap = {
      urgent:  'DATEDIFF(lr.start_date, CURDATE()) ASC, lr.created_at ASC',
      newest:  'lr.created_at DESC',
      oldest:  'lr.created_at ASC',
      longest: 'lr.total_days DESC',
    };
    const orderBy = orderMap[sort] || orderMap.urgent;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE ${where}`,
      params
    );

    const [rows] = await db.execute(`
      SELECT
        lr.id, lr.start_date, lr.end_date, lr.total_days,
        lr.half_day, lr.half_day_period, lr.reason,
        lr.created_at, lr.status,
        lt.name AS leave_type, lt.code AS leave_code, lt.color, lt.is_paid,
        e.id AS employee_id, e.full_name, e.employee_id AS emp_code, e.avatar_url,
        e.joining_date,
        d.name  AS department,
        des.name AS designation,
        lb.total_days    AS balance_total,
        lb.used_days     AS balance_used,
        lb.pending_days  AS balance_pending,
        (lb.total_days + COALESCE(lb.carried_days,0) - lb.used_days - lb.pending_days) AS balance_available,
        DATEDIFF(lr.start_date, CURDATE()) AS days_until_start,
        (SELECT COUNT(*) FROM leave_requests lr2
         WHERE lr2.employee_id = e.id
           AND lr2.status = 'Approved'
           AND YEAR(lr2.start_date) = YEAR(NOW())) AS approved_count_ytd
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN employees  e  ON e.id  = lr.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN leave_balance lb ON lb.employee_id = e.id
        AND lb.leave_type_id = lr.leave_type_id
        AND lb.year = YEAR(NOW())
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total) / Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch pending requests' });
  }
};

// ── GET /api/leave-approval/history ───────────────────────
const getHistory = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    const { page = 1, limit = 15, status, employee_id, month, year } = req.query;

    let empCondition = '1=1';
    const params     = [];

    if (!isAdminHR) {
      const empId = await getEmpId(req.user.id);
      if (empId) { empCondition = 'e.manager_id = ?'; params.push(empId); }
    }

    const conditions = [empCondition, "lr.status != 'Pending'"];
    if (status)      { conditions.push('lr.status = ?');         params.push(status); }
    if (employee_id) { conditions.push('e.id = ?');              params.push(employee_id); }
    if (month)       { conditions.push('MONTH(lr.start_date)=?');params.push(month); }
    if (year)        { conditions.push('YEAR(lr.start_date)=?'); params.push(year || new Date().getFullYear()); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE ${where}`,
      params
    );

    const [rows] = await db.execute(`
      SELECT lr.*,
             lt.name AS leave_type, lt.color, lt.code AS leave_code,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department,
             u.full_name AS approved_by_name
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN employees  e  ON e.id  = lr.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u ON u.id = lr.approved_by
      WHERE ${where}
      ORDER BY lr.updated_at DESC
      LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total) / Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
};

// ── GET /api/leave-approval/team-balance ──────────────────
const getTeamBalance = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    let empCondition = '1=1';
    const params     = [];

    if (!isAdminHR) {
      const empId = await getEmpId(req.user.id);
      if (empId) { empCondition = 'e.manager_id = ?'; params.push(empId); }
    }

    const [rows] = await db.execute(`
      SELECT
        e.id, e.full_name, e.employee_id AS emp_code, e.avatar_url,
        d.name AS department,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'type', lt.name,
            'code', lt.code,
            'color', lt.color,
            'total', lb.total_days,
            'used',  lb.used_days,
            'pending', lb.pending_days,
            'available', (lb.total_days + COALESCE(lb.carried_days,0) - lb.used_days - lb.pending_days)
          )
        ) AS balances,
        (SELECT COUNT(*) FROM leave_requests lr2
         WHERE lr2.employee_id = e.id AND lr2.status='Pending') AS pending_requests
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN leave_balance lb ON lb.employee_id = e.id AND lb.year = YEAR(NOW())
      LEFT JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE ${empCondition} AND e.is_active = 1
      GROUP BY e.id
      ORDER BY e.full_name`, params
    );

    // Parse JSON balances
    const data = rows.map(r => ({
      ...r,
      balances: typeof r.balances === 'string' ? JSON.parse(r.balances) : (r.balances || []),
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch team balance' });
  }
};

// ── GET /api/leave-approval/calendar ──────────────────────
const getTeamCalendar = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;

    let empCondition = '1=1';
    const params     = [Number(year), Number(month)];

    if (!isAdminHR) {
      const empId = await getEmpId(req.user.id);
      if (empId) { empCondition = 'e.manager_id = ?'; params.push(empId); }
    }

    const [rows] = await db.execute(`
      SELECT
        lr.start_date, lr.end_date, lr.total_days, lr.half_day, lr.status,
        lt.name AS leave_type, lt.color,
        e.full_name, e.employee_id AS emp_code
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN employees  e  ON e.id  = lr.employee_id
      WHERE ${empCondition}
        AND lr.status IN ('Approved', 'Pending')
        AND YEAR(lr.start_date) = ?
        AND MONTH(lr.start_date) = ?
      ORDER BY lr.start_date`, params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch calendar' });
  }
};

// ── POST /api/leave-approval/:id/approve ─────────────────
const approve = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const [[lr]] = await conn.execute('SELECT * FROM leave_requests WHERE id = ?', [id]);
    if (!lr) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Request not found' }); }
    if (lr.status !== 'Pending') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Only pending requests can be approved' }); }

    await conn.execute(
      'UPDATE leave_requests SET status=?, approved_by=?, approved_at=NOW() WHERE id=?',
      ['Approved', req.user.id, id]
    );

    const year = new Date(lr.start_date).getFullYear();
    await conn.execute(`
      UPDATE leave_balance
      SET used_days = used_days + ?, pending_days = GREATEST(pending_days - ?, 0)
      WHERE employee_id=? AND leave_type_id=? AND year=?`,
      [lr.total_days, lr.total_days, lr.employee_id, lr.leave_type_id, year]
    ).catch(() => {});

    // Mark attendance as Leave
    await conn.execute(`
      INSERT INTO attendance (employee_id, date, status)
      SELECT ?, DATE_ADD(?, INTERVAL seq.n DAY), 'Leave'
      FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
            UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9
            UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13 UNION SELECT 14) seq
      WHERE DATE_ADD(?, INTERVAL seq.n DAY) <= ?
        AND DAYOFWEEK(DATE_ADD(?, INTERVAL seq.n DAY)) NOT IN (1,7)
      ON DUPLICATE KEY UPDATE status='Leave'`,
      [lr.employee_id, lr.start_date, lr.start_date, lr.end_date, lr.start_date]
    ).catch(() => {});

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `APPROVE_LEAVE:${id}`, 'leave', req.ip]
    );
    await conn.commit();
    res.json({ success: true, message: 'Leave approved' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Approval failed' });
  } finally { conn.release(); }
};

// ── POST /api/leave-approval/:id/reject ──────────────────
const reject = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { rejection_reason } = req.body;
    if (!rejection_reason?.trim()) { await conn.rollback(); return res.status(422).json({ success: false, message: 'Rejection reason required' }); }

    const [[lr]] = await conn.execute('SELECT * FROM leave_requests WHERE id = ?', [id]);
    if (!lr) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Not found' }); }
    if (lr.status !== 'Pending') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Only pending requests can be rejected' }); }

    await conn.execute(
      'UPDATE leave_requests SET status=?, approved_by=?, approved_at=NOW(), rejection_reason=? WHERE id=?',
      ['Rejected', req.user.id, rejection_reason, id]
    );

    const year = new Date(lr.start_date).getFullYear();
    await conn.execute(
      'UPDATE leave_balance SET pending_days = GREATEST(pending_days - ?, 0) WHERE employee_id=? AND leave_type_id=? AND year=?',
      [lr.total_days, lr.employee_id, lr.leave_type_id, year]
    ).catch(() => {});

    await conn.commit();
    res.json({ success: true, message: 'Leave rejected' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Rejection failed' });
  } finally { conn.release(); }
};

// ── POST /api/leave-approval/bulk-approve ────────────────
const bulkApprove = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { ids } = req.body;
    if (!ids?.length) { await conn.rollback(); return res.status(422).json({ success: false, message: 'No IDs provided' }); }

    let approved = 0;
    for (const id of ids) {
      const [[lr]] = await conn.execute('SELECT * FROM leave_requests WHERE id=? AND status=?', [id, 'Pending']);
      if (!lr) continue;

      await conn.execute(
        'UPDATE leave_requests SET status=?,approved_by=?,approved_at=NOW() WHERE id=?',
        ['Approved', req.user.id, id]
      );
      const year = new Date(lr.start_date).getFullYear();
      await conn.execute(
        'UPDATE leave_balance SET used_days=used_days+?,pending_days=GREATEST(pending_days-?,0) WHERE employee_id=? AND leave_type_id=? AND year=?',
        [lr.total_days, lr.total_days, lr.employee_id, lr.leave_type_id, year]
      ).catch(() => {});
      approved++;
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id,action,module,ip_address) VALUES (?,?,?,?)',
      [req.user.id, `BULK_APPROVE_LEAVE:${approved}`, 'leave', req.ip]
    );
    await conn.commit();
    res.json({ success: true, message: `${approved} leave request${approved !== 1 ? 's' : ''} approved` });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Bulk approval failed' });
  } finally { conn.release(); }
};

module.exports = { getStats, getPending, getHistory, getTeamBalance, getTeamCalendar, approve, reject, bulkApprove };