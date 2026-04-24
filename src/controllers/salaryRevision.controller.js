const db = require('../config/db');

// ── GET /api/salary-revisions/stats ──────────────────────
const getStats = async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const [[counts]] = await db.execute(`
      SELECT
        COUNT(*)                                  AS total,
        SUM(status='Draft')                       AS drafts,
        SUM(status='Pending Approval')            AS pending,
        SUM(status='Approved')                    AS approved,
        SUM(status='Implemented')                 AS implemented,
        ROUND(AVG(NULLIF(increment_pct,0)),1)     AS avg_pct,
        SUM(increment_amount)                     AS total_increment
      FROM salary_revisions
      WHERE YEAR(effective_date) = ?`, [year]);

    const [byType] = await db.execute(`
      SELECT revision_type,
             COUNT(*)                            AS count,
             ROUND(AVG(NULLIF(increment_pct,0)),1) AS avg_pct,
             SUM(increment_amount)               AS total_amount
      FROM salary_revisions
      WHERE YEAR(effective_date) = ?
      GROUP BY revision_type ORDER BY count DESC`, [year]);

    res.json({ success: true, data: { counts, byType } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

// ── GET /api/salary-revisions ─────────────────────────────
const getAll = async (req, res) => {
  try {
    const { status, department_id, year, employee_id, page = 1, limit = 12 } = req.query;
    const conditions = ['1=1']; const params = [];

    if (status)        { conditions.push('sr.status = ?');              params.push(status); }
    if (department_id) { conditions.push('e.department_id = ?');        params.push(department_id); }
    if (year)          { conditions.push('YEAR(sr.effective_date) = ?'); params.push(year); }
    if (employee_id)   { conditions.push('sr.employee_id = ?');         params.push(employee_id); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total
       FROM salary_revisions sr
       JOIN employees e ON e.id = sr.employee_id
       WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT sr.*,
             e.full_name,  e.employee_id AS emp_code,
             d.name        AS department,
             des.name      AS designation,
             u1.full_name  AS prepared_by_name,
             u2.full_name  AS approved_by_name
      FROM salary_revisions sr
      JOIN employees  e   ON e.id   = sr.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN users u1 ON u1.id = sr.prepared_by
      LEFT JOIN users u2 ON u2.id = sr.approved_by
      WHERE ${where}
      ORDER BY sr.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({
      success: true,
      data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total) / Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch revisions' });
  }
};

// ── GET /api/salary-revisions/:id ────────────────────────
const getOne = async (req, res) => {
  try {
    const [[row]] = await db.execute(`
      SELECT sr.*,
             e.full_name, e.employee_id AS emp_code, e.joining_date, e.email,
             d.name       AS department,
             des.name     AS designation,
             u1.full_name AS prepared_by_name,
             u2.full_name AS approved_by_name
      FROM salary_revisions sr
      JOIN employees  e   ON e.id   = sr.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN users u1 ON u1.id = sr.prepared_by
      LEFT JOIN users u2 ON u2.id = sr.approved_by
      WHERE sr.id = ?`, [req.params.id]);

    if (!row) return res.status(404).json({ success: false, message: 'Revision not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Fetch failed' });
  }
};

// ── GET /api/salary-revisions/employee/:empId ─────────────
const getByEmployee = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT sr.*, u1.full_name AS prepared_by_name, u2.full_name AS approved_by_name
      FROM salary_revisions sr
      LEFT JOIN users u1 ON u1.id = sr.prepared_by
      LEFT JOIN users u2 ON u2.id = sr.approved_by
      WHERE sr.employee_id = ?
      ORDER BY sr.effective_date DESC`, [req.params.empId]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

// ── GET /api/salary-revisions/employee-structure/:empId ───
const getEmployeeStructure = async (req, res) => {
  try {
    const [[ss]] = await db.execute(`
      SELECT ss.*,
             e.full_name, e.employee_id AS emp_code,
             d.name   AS department,
             des.name AS designation,
             e.joining_date
      FROM salary_structures ss
      JOIN employees  e   ON e.id   = ss.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      WHERE ss.employee_id = ?`, [req.params.empId]);

    if (!ss) return res.status(404).json({ success: false, message: 'No salary structure found for this employee' });
    res.json({ success: true, data: ss });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

// ── POST /api/salary-revisions ────────────────────────────
const create = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      employee_id, revision_type, effective_date, reason,
      new_basic, new_hra, new_da, new_special_allow, new_other_allow,
    } = req.body;

    // Fetch current salary structure
    const [[cur]] = await conn.execute(
      'SELECT * FROM salary_structures WHERE employee_id = ?', [employee_id]
    );

    const old_basic = Number(cur?.basic_salary    || 0);
    const old_hra   = Number(cur?.hra             || 0);
    const old_da    = Number(cur?.da              || 0);
    const old_spec  = Number(cur?.special_allow   || 0);
    const old_other = Number(cur?.other_allow     || 0);
    const old_gross = Number(cur?.gross_salary    || 0);
    const old_ctc   = Number(cur?.ctc             || 0);

    const n_basic  = Number(new_basic         || 0);
    const n_hra    = Number(new_hra           || 0);
    const n_da     = Number(new_da            || 0);
    const n_spec   = Number(new_special_allow || 0);
    const n_other  = Number(new_other_allow   || 0);
    const n_med    = Number(cur?.medical_allow || 1500);
    const n_travel = Number(cur?.travel_allow  || 2000);

    const n_gross  = n_basic + n_hra + n_da + n_med + n_travel + n_spec + n_other;
    const n_pfEr   = Math.round(n_basic * 0.12);
    const n_esiEr  = n_gross <= 21000 ? Math.round(n_gross * 0.0325) : 0;
    const n_ctc    = n_gross + n_pfEr + n_esiEr;

    const inc_amount = n_gross - old_gross;
    const inc_pct    = old_gross > 0
      ? parseFloat(((inc_amount / old_gross) * 100).toFixed(2))
      : 0;

    const [result] = await conn.execute(`
      INSERT INTO salary_revisions
        (employee_id, revision_type, effective_date, reason,
         old_basic, old_hra, old_da, old_special_allow, old_other_allow, old_gross, old_ctc,
         new_basic, new_hra, new_da, new_special_allow, new_other_allow, new_gross, new_ctc,
         increment_amount, increment_pct, status, prepared_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [employee_id, revision_type, effective_date, reason || null,
       old_basic, old_hra, old_da, old_spec, old_other, old_gross, old_ctc,
       n_basic, n_hra, n_da, n_spec, n_other, n_gross, n_ctc,
       inc_amount, inc_pct, 'Draft', req.user.id]);

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_SALARY_REV:emp${employee_id}`, 'payroll', req.ip]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      message: 'Salary revision created as Draft',
      data: { id: result.insertId },
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Create failed' });
  } finally { conn.release(); }
};

// ── POST /api/salary-revisions/:id/submit ────────────────
const submit = async (req, res) => {
  try {
    const [[rev]] = await db.execute('SELECT status FROM salary_revisions WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ success: false, message: 'Not found' });
    if (rev.status !== 'Draft') return res.status(400).json({ success: false, message: 'Only drafts can be submitted' });
    await db.execute("UPDATE salary_revisions SET status='Pending Approval' WHERE id=?", [req.params.id]);
    res.json({ success: true, message: 'Submitted for approval' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Submit failed' });
  }
};

// ── POST /api/salary-revisions/:id/approve ───────────────
const approve = async (req, res) => {
  try {
    const [[rev]] = await db.execute('SELECT status FROM salary_revisions WHERE id = ?', [req.params.id]);
    if (!rev) return res.status(404).json({ success: false, message: 'Not found' });
    if (rev.status !== 'Pending Approval') return res.status(400).json({ success: false, message: 'Only pending revisions can be approved' });
    await db.execute(
      "UPDATE salary_revisions SET status='Approved', approved_by=?, approved_at=NOW() WHERE id=?",
      [req.user.id, req.params.id]
    );
    res.json({ success: true, message: 'Revision approved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Approve failed' });
  }
};

// ── POST /api/salary-revisions/:id/reject ────────────────
const reject = async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    if (!rejection_reason?.trim()) return res.status(422).json({ success: false, message: 'Rejection reason required' });
    await db.execute(
      "UPDATE salary_revisions SET status='Rejected', approved_by=?, approved_at=NOW(), rejection_reason=? WHERE id=?",
      [req.user.id, rejection_reason, req.params.id]
    );
    res.json({ success: true, message: 'Revision rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Reject failed' });
  }
};

// ── POST /api/salary-revisions/:id/implement ─────────────
const implement = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[rev]] = await conn.execute('SELECT * FROM salary_revisions WHERE id = ?', [req.params.id]);
    if (!rev) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Not found' }); }
    if (rev.status !== 'Approved') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Only approved revisions can be implemented' }); }

    const gross   = Number(rev.new_gross);
    const basic   = Number(rev.new_basic);
    const pfEmp   = Math.round(basic  * 0.12);
    const pfEr    = Math.round(basic  * 0.12);
    const esiEmp  = gross <= 21000 ? Math.round(gross * 0.0075) : 0;
    const esiEr   = gross <= 21000 ? Math.round(gross * 0.0325) : 0;
    const ptax    = gross <= 15000 ? 0 : gross <= 20000 ? 150 : 200;

    const [[cur]] = await conn.execute(
      'SELECT * FROM salary_structures WHERE employee_id = ?', [rev.employee_id]
    );

    await conn.execute(`
      INSERT INTO salary_structures
        (employee_id, effective_from, basic_salary, hra, da,
         medical_allow, travel_allow, special_allow, other_allow,
         pf_employee, pf_employer, esi_employee, esi_employer,
         professional_tax, tds, loan_deduction, other_deduction)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        effective_from   = VALUES(effective_from),
        basic_salary     = VALUES(basic_salary),
        hra              = VALUES(hra),
        da               = VALUES(da),
        special_allow    = VALUES(special_allow),
        other_allow      = VALUES(other_allow),
        pf_employee      = VALUES(pf_employee),
        pf_employer      = VALUES(pf_employer),
        esi_employee     = VALUES(esi_employee),
        esi_employer     = VALUES(esi_employer),
        professional_tax = VALUES(professional_tax),
        updated_at       = NOW()`,
      [rev.employee_id, rev.effective_date,
       rev.new_basic, rev.new_hra, rev.new_da,
       cur?.medical_allow || 1500, cur?.travel_allow || 2000,
       rev.new_special_allow, rev.new_other_allow,
       pfEmp, pfEr, esiEmp, esiEr,
       ptax, cur?.tds || 0, cur?.loan_deduction || 0, cur?.other_deduction || 0]
    );

    await conn.execute(
      "UPDATE salary_revisions SET status='Implemented', implemented_at=NOW() WHERE id=?",
      [req.params.id]
    );
    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `IMPLEMENT_SALARY_REV:${req.params.id}:emp${rev.employee_id}`, 'payroll', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: 'Salary revision implemented — salary structure updated' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Implement failed' });
  } finally { conn.release(); }
};

// ── POST /api/salary-revisions/bulk ──────────────────────
const createBulk = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      batch_name, revision_type, effective_date,
      increment_type, increment_value, department_id, employee_ids, notes,
    } = req.body;

    const [batch] = await conn.execute(`
      INSERT INTO salary_revision_batches
        (batch_name, revision_type, effective_date, increment_type,
         increment_value, department_id, status, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [batch_name, revision_type, effective_date, increment_type,
       increment_value, department_id || null, 'Processing', notes || null, req.user.id]);

    const batchId = batch.insertId;

    let empQuery = `
      SELECT ss.*, e.id AS emp_id
      FROM salary_structures ss
      JOIN employees e ON e.id = ss.employee_id
      WHERE e.is_active = 1`;
    const empParams = [];

    if (employee_ids?.length) {
      empQuery += ` AND e.id IN (${employee_ids.map(() => '?').join(',')})`;
      empParams.push(...employee_ids);
    } else if (department_id) {
      empQuery += ' AND e.department_id = ?';
      empParams.push(department_id);
    }

    const [employees] = await conn.execute(empQuery, empParams);
    let totalRevAmount = 0;
    let created = 0;

    for (const emp of employees) {
      const old_gross = Number(emp.gross_salary || 0);
      const old_basic = Number(emp.basic_salary || 0);
      let new_gross, new_basic;

      if (increment_type === 'Percentage') {
        const mult = 1 + Number(increment_value) / 100;
        new_basic  = Math.round(old_basic * mult);
        new_gross  = Math.round(old_gross * mult);
      } else if (increment_type === 'Fixed Amount') {
        new_basic = old_basic + Number(increment_value);
        new_gross = old_gross + Number(increment_value);
      } else {
        // New CTC
        const newCTC = Number(increment_value);
        new_gross    = Math.round(newCTC / 1.175);
        new_basic    = Math.round(new_gross * 0.45);
      }

      const n_hra   = Math.round(new_basic * 0.40);
      const n_da    = Math.round(new_basic * 0.10);
      const n_spec  = Math.round(new_basic * 0.05);
      const n_med   = Number(emp.medical_allow || 1500);
      const n_trav  = Number(emp.travel_allow  || 2000);
      const n_other = Number(emp.other_allow   || 0);
      new_gross = new_basic + n_hra + n_da + n_med + n_trav + n_spec + n_other;

      const n_pfEr  = Math.round(new_basic * 0.12);
      const n_esiEr = new_gross <= 21000 ? Math.round(new_gross * 0.0325) : 0;
      const n_ctc   = new_gross + n_pfEr + n_esiEr;

      const inc_amount = new_gross - old_gross;
      const inc_pct    = old_gross > 0
        ? parseFloat(((inc_amount / old_gross) * 100).toFixed(2))
        : 0;

      await conn.execute(`
        INSERT INTO salary_revisions
          (employee_id, revision_type, effective_date, reason,
           old_basic, old_hra, old_da, old_special_allow, old_other_allow, old_gross, old_ctc,
           new_basic, new_hra, new_da, new_special_allow, new_other_allow, new_gross, new_ctc,
           increment_amount, increment_pct, status, prepared_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [emp.emp_id, revision_type, effective_date, `Batch: ${batch_name}`,
         old_basic, Number(emp.hra || 0), Number(emp.da || 0),
         Number(emp.special_allow || 0), n_other, old_gross, Number(emp.ctc || 0),
         new_basic, n_hra, n_da, n_spec, n_other, new_gross, n_ctc,
         inc_amount, inc_pct, 'Pending Approval', req.user.id]);

      totalRevAmount += inc_amount;
      created++;
    }

    await conn.execute(
      'UPDATE salary_revision_batches SET status=?, total_employees=?, total_revision_amount=? WHERE id=?',
      ['Completed', created, totalRevAmount.toFixed(2), batchId]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      message: `Bulk revision created for ${created} employees`,
      data: { batchId, created, totalRevAmount: totalRevAmount.toFixed(2) },
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Bulk revision failed' });
  } finally { conn.release(); }
};

module.exports = {
  getStats, getAll, getOne, getByEmployee, getEmployeeStructure,
  create, submit, approve, reject, implement, createBulk,
};