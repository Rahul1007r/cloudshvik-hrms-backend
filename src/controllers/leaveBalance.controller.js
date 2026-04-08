const db = require('../config/db');

// ── Helper: log adjustment ────────────────────────────────
const logAdjustment = async (conn, { employee_id, leave_type_id, year, type, before, delta, after, reason, userId }) => {
  await conn.execute(
    `INSERT INTO leave_balance_adjustments
       (employee_id, leave_type_id, year, adjustment_type, days_before, adjustment_days, days_after, reason, adjusted_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [employee_id, leave_type_id, year, type, before, delta, after, reason || null, userId]
  );
};

// ── GET /api/leave-balance/overview ───────────────────────
// Full balance table: all employees × all leave types for a year
const getOverview = async (req, res) => {
  try {
    const { year = new Date().getFullYear(), department_id, search = '' } = req.query;

    const conditions = ['e.is_active = 1'];
    const params     = [Number(year)];
    if (department_id) { conditions.push('e.department_id = ?'); params.push(department_id); }
    if (search.trim()) { conditions.push('(e.full_name LIKE ? OR e.employee_id LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

    const where = conditions.join(' AND ');

    const [employees] = await db.execute(`
      SELECT e.id, e.full_name, e.employee_id AS emp_code, e.joining_date,
             d.name AS department, des.name AS designation
      FROM employees e
      LEFT JOIN departments  d   ON d.id  = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      WHERE ${where}
      ORDER BY d.name, e.full_name`, params
    );

    const [leaveTypes] = await db.execute(
      'SELECT id, name, code, color, max_days, carry_forward, max_carry_days FROM leave_types WHERE is_active = 1 ORDER BY name'
    );

    // Fetch all balances for this year in one shot
    const empIds = employees.map(e => e.id);
    let balances = [];
    if (empIds.length > 0) {
      const placeholders = empIds.map(() => '?').join(',');
      [balances] = await db.execute(
        `SELECT * FROM leave_balance WHERE employee_id IN (${placeholders}) AND year = ?`,
        [...empIds, Number(year)]
      );
    }

    // Build lookup: empId → typeId → balance
    const balMap = {};
    balances.forEach(b => {
      if (!balMap[b.employee_id]) balMap[b.employee_id] = {};
      balMap[b.employee_id][b.leave_type_id] = b;
    });

    // Summary stats
    let totalAllocated = 0, totalUsed = 0, totalPending = 0;
    balances.forEach(b => {
      totalAllocated += Number(b.total_days || 0);
      totalUsed      += Number(b.used_days  || 0);
      totalPending   += Number(b.pending_days || 0);
    });

    res.json({
      success: true,
      data: {
        employees,
        leaveTypes,
        balanceMap: balMap,
        summary: { totalAllocated, totalUsed, totalPending, totalAvailable: totalAllocated - totalUsed - totalPending },
        year: Number(year),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch overview' });
  }
};

// ── GET /api/leave-balance/employee/:empId ────────────────
// Full balance + adjustment history for one employee
const getEmployeeBalance = async (req, res) => {
  try {
    const { empId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    const [balances] = await db.execute(`
      SELECT lb.*,
             lt.name AS type_name, lt.code, lt.color, lt.is_paid,
             lt.carry_forward, lt.max_carry_days, lt.max_days AS default_days,
             (lb.total_days + COALESCE(lb.carried_days,0) - lb.used_days - lb.pending_days) AS available
      FROM leave_balance lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id = ? AND lb.year = ?
      ORDER BY lt.name`, [empId, Number(year)]
    );

    const [adjustments] = await db.execute(`
      SELECT lba.*,
             lt.name AS type_name, lt.color,
             u.full_name AS adjusted_by_name
      FROM leave_balance_adjustments lba
      JOIN leave_types lt ON lt.id = lba.leave_type_id
      JOIN users u ON u.id = lba.adjusted_by
      WHERE lba.employee_id = ? AND lba.year = ?
      ORDER BY lba.created_at DESC`, [empId, Number(year)]
    );

    const [[emp]] = await db.execute(`
      SELECT e.*, d.name AS department, des.name AS designation
      FROM employees e
      LEFT JOIN departments  d   ON d.id  = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      WHERE e.id = ?`, [empId]
    );

    res.json({ success: true, data: { employee: emp, balances, adjustments } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch employee balance' });
  }
};

// ── POST /api/leave-balance/adjust ────────────────────────
// HR manually adds or deducts days for one employee × one type
const adjustBalance = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { employee_id, leave_type_id, year, adjustment_type, days, reason } = req.body;
    const yr = Number(year) || new Date().getFullYear();

    // Ensure row exists
    await conn.execute(
      `INSERT IGNORE INTO leave_balance (employee_id, leave_type_id, year, total_days)
       VALUES (?,?,?,0)`, [employee_id, leave_type_id, yr]
    );

    const [[cur]] = await conn.execute(
      'SELECT * FROM leave_balance WHERE employee_id=? AND leave_type_id=? AND year=?',
      [employee_id, leave_type_id, yr]
    );

    const before = Number(cur.total_days || 0);
    let   after  = before;
    const d      = Math.abs(Number(days));

    if (adjustment_type === 'Add' || adjustment_type === 'Allocate') {
      after = before + d;
      await conn.execute(
        'UPDATE leave_balance SET total_days = total_days + ? WHERE employee_id=? AND leave_type_id=? AND year=?',
        [d, employee_id, leave_type_id, yr]
      );
    } else if (adjustment_type === 'Deduct') {
      after = Math.max(0, before - d);
      await conn.execute(
        'UPDATE leave_balance SET total_days = GREATEST(0, total_days - ?) WHERE employee_id=? AND leave_type_id=? AND year=?',
        [d, employee_id, leave_type_id, yr]
      );
    } else if (adjustment_type === 'Reset') {
      // Reset to leave type default
      const [[lt]] = await conn.execute('SELECT max_days FROM leave_types WHERE id=?', [leave_type_id]);
      after = lt?.max_days || 0;
      await conn.execute(
        'UPDATE leave_balance SET total_days=?, used_days=0, pending_days=0, carried_days=0 WHERE employee_id=? AND leave_type_id=? AND year=?',
        [after, employee_id, leave_type_id, yr]
      );
    } else if (adjustment_type === 'Correction') {
      // Set to exact value
      after = d;
      await conn.execute(
        'UPDATE leave_balance SET total_days=? WHERE employee_id=? AND leave_type_id=? AND year=?',
        [after, employee_id, leave_type_id, yr]
      );
    }

    await logAdjustment(conn, {
      employee_id, leave_type_id, year: yr,
      type: adjustment_type, before, delta: days, after, reason,
      userId: req.user.id,
    });

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `ADJUST_LEAVE_BAL:emp${employee_id}:type${leave_type_id}:${adjustment_type}:${days}d`, 'leave', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: `Balance ${adjustment_type.toLowerCase()}ed successfully`, data: { before, after } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Adjustment failed' });
  } finally {
    conn.release();
  }
};

// ── POST /api/leave-balance/bulk-allocate ─────────────────
// Allocate leave for all active employees for a year
// (Run once at year start, or for new joiners)
const bulkAllocate = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { year, overwrite = false } = req.body;
    const yr = Number(year) || new Date().getFullYear();

    const [employees]  = await conn.execute('SELECT id FROM employees WHERE is_active = 1');
    const [leaveTypes] = await conn.execute('SELECT id, max_days FROM leave_types WHERE is_active = 1 AND max_days > 0');

    let created = 0, skipped = 0;

    for (const emp of employees) {
      for (const lt of leaveTypes) {
        if (overwrite) {
          await conn.execute(
            `INSERT INTO leave_balance (employee_id, leave_type_id, year, total_days, used_days, pending_days, carried_days)
             VALUES (?,?,?,?,0,0,0)
             ON DUPLICATE KEY UPDATE total_days=VALUES(total_days), used_days=0, pending_days=0`,
            [emp.id, lt.id, yr, lt.max_days]
          );
          await logAdjustment(conn, {
            employee_id: emp.id, leave_type_id: lt.id, year: yr,
            type: 'Allocate', before: 0, delta: lt.max_days, after: lt.max_days,
            reason: `Bulk allocation for ${yr}`, userId: req.user.id,
          });
          created++;
        } else {
          const [res2] = await conn.execute(
            'INSERT IGNORE INTO leave_balance (employee_id, leave_type_id, year, total_days) VALUES (?,?,?,?)',
            [emp.id, lt.id, yr, lt.max_days]
          );
          if (res2.affectedRows > 0) { created++; } else { skipped++; }
        }
      }
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `BULK_ALLOCATE:year=${yr}:created=${created}:skipped=${skipped}`, 'leave', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: `Allocation complete: ${created} records created, ${skipped} skipped (already exist)`, data: { created, skipped } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Bulk allocation failed' });
  } finally {
    conn.release();
  }
};

// ── POST /api/leave-balance/carry-forward ─────────────────
// End-of-year: carry unused days from fromYear → toYear (respects max_carry_days)
const carryForward = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { from_year, to_year } = req.body;
    const fromYr = Number(from_year);
    const toYr   = Number(to_year);
    if (!fromYr || !toYr || toYr <= fromYr) {
      await conn.rollback();
      return res.status(422).json({ success: false, message: 'Invalid year range' });
    }

    // Get all carry-forward-eligible leave types
    const [types] = await conn.execute(
      'SELECT id, max_carry_days FROM leave_types WHERE carry_forward = 1 AND is_active = 1'
    );

    // Get all employee balances for fromYear
    const [balances] = await conn.execute(
      `SELECT lb.*, lt.max_carry_days
       FROM leave_balance lb
       JOIN leave_types lt ON lt.id = lb.leave_type_id
       WHERE lb.year = ? AND lt.carry_forward = 1`, [fromYr]
    );

    let processed = 0, totalDaysCarried = 0;

    for (const bal of balances) {
      const unused    = Math.max(0, Number(bal.total_days||0) - Number(bal.used_days||0) - Number(bal.pending_days||0));
      const maxCarry  = Number(bal.max_carry_days || 0);
      const carryDays = Math.min(unused, maxCarry);

      if (carryDays <= 0) continue;

      // Ensure toYear row exists
      await conn.execute(
        `INSERT INTO leave_balance (employee_id, leave_type_id, year, total_days, carried_days)
         VALUES (?,?,?,0,0)
         ON DUPLICATE KEY UPDATE id=id`,
        [bal.employee_id, bal.leave_type_id, toYr]
      );

      const [[toRow]] = await conn.execute(
        'SELECT total_days FROM leave_balance WHERE employee_id=? AND leave_type_id=? AND year=?',
        [bal.employee_id, bal.leave_type_id, toYr]
      );

      await conn.execute(
        'UPDATE leave_balance SET carried_days = carried_days + ? WHERE employee_id=? AND leave_type_id=? AND year=?',
        [carryDays, bal.employee_id, bal.leave_type_id, toYr]
      );

      await logAdjustment(conn, {
        employee_id: bal.employee_id, leave_type_id: bal.leave_type_id, year: toYr,
        type: 'Carry Forward', before: Number(toRow?.total_days||0),
        delta: carryDays, after: Number(toRow?.total_days||0) + carryDays,
        reason: `Carried forward from ${fromYr}`, userId: req.user.id,
      });

      processed++;
      totalDaysCarried += carryDays;
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CARRY_FORWARD:${fromYr}→${toYr}:${processed}records:${totalDaysCarried}days`, 'leave', req.ip]
    );

    await conn.commit();
    res.json({
      success: true,
      message: `Carry-forward complete: ${processed} balances updated, ${totalDaysCarried} total days carried`,
      data: { processed, totalDaysCarried },
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Carry-forward failed' });
  } finally {
    conn.release();
  }
};

// ── GET /api/leave-balance/adjustment-log ─────────────────
const getAdjustmentLog = async (req, res) => {
  try {
    const { year = new Date().getFullYear(), employee_id, page = 1, limit = 20 } = req.query;
    const conditions = ['lba.year = ?'];
    const params     = [Number(year)];
    if (employee_id) { conditions.push('lba.employee_id = ?'); params.push(employee_id); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);
    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM leave_balance_adjustments lba WHERE ${where}`, params
    );
    const [rows] = await db.execute(`
      SELECT lba.*,
             lt.name AS type_name, lt.color,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department,
             u.full_name AS adjusted_by_name
      FROM leave_balance_adjustments lba
      JOIN leave_types lt ON lt.id = lba.leave_type_id
      JOIN employees  e  ON e.id  = lba.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN users u ON u.id = lba.adjusted_by
      WHERE ${where}
      ORDER BY lba.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]
    );
    res.json({ success: true, data: rows, meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch log' });
  }
};

// ── GET /api/leave-balance/stats ──────────────────────────
const getStats = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const yr = Number(year);

    const [[totals]] = await db.execute(`
      SELECT
        COUNT(DISTINCT employee_id)                          AS employees_with_balance,
        SUM(total_days)                                      AS total_allocated,
        SUM(used_days)                                       AS total_used,
        SUM(pending_days)                                    AS total_pending,
        SUM(total_days - used_days - pending_days)           AS total_available,
        SUM(carried_days)                                    AS total_carried
      FROM leave_balance WHERE year = ?`, [yr]
    );

    const [byType] = await db.execute(`
      SELECT lt.name, lt.color, lt.code,
             SUM(lb.total_days)   AS allocated,
             SUM(lb.used_days)    AS used,
             SUM(lb.pending_days) AS pending
      FROM leave_balance lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.year = ?
      GROUP BY lt.id ORDER BY allocated DESC`, [yr]
    );

    const [[adjCount]] = await db.execute(
      'SELECT COUNT(*) AS total FROM leave_balance_adjustments WHERE year = ?', [yr]
    );

    res.json({ success: true, data: { totals, byType, adjustmentCount: adjCount.total } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

module.exports = {
  getOverview, getEmployeeBalance,
  adjustBalance, bulkAllocate, carryForward,
  getAdjustmentLog, getStats,
};