const db = require('../config/db');

// ── Helpers ───────────────────────────────────────────────
const fmtCur = v => Number(v || 0).toFixed(2);

// Professional Tax slab (India)
const calcProfTax = (gross) => {
  if (gross <= 15000) return 0;
  if (gross <= 20000) return 150;
  return 200;
};

// ── GET /api/payroll/salary-structures ────────────────────
const getAllStructures = async (req, res) => {
  try {
    const { page = 1, limit = 15, search = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const srch   = `%${search}%`;

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM salary_structures ss
       JOIN employees e ON e.id = ss.employee_id
       WHERE e.full_name LIKE ? OR e.employee_id LIKE ?`,
      [srch, srch]
    );

    const [rows] = await db.execute(
      `SELECT ss.*, e.full_name, e.employee_id AS emp_code, e.avatar_url,
              d.name AS department, des.name AS designation
       FROM salary_structures ss
       JOIN employees    e   ON e.id   = ss.employee_id
       LEFT JOIN departments  d   ON d.id   = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       WHERE e.full_name LIKE ? OR e.employee_id LIKE ?
       ORDER BY e.full_name
       LIMIT ? OFFSET ?`,
      [srch, srch, Number(limit), offset]
    );

    res.json({ success: true, data: rows, meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch salary structures' });
  }
};

// ── GET /api/payroll/salary-structures/:empId ─────────────
const getStructure = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT ss.*, e.full_name, e.employee_id AS emp_code, d.name AS department, des.name AS designation
       FROM salary_structures ss
       JOIN employees e ON e.id = ss.employee_id
       LEFT JOIN departments  d   ON d.id = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       WHERE ss.employee_id = ?`,
      [req.params.empId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Salary structure not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch structure' });
  }
};

// ── POST /api/payroll/salary-structures ───────────────────
const upsertStructure = async (req, res) => {
  try {
    const {
      employee_id, effective_from,
      basic_salary, hra, da, medical_allow, travel_allow, special_allow, other_allow,
      pf_employee, pf_employer, esi_employee, esi_employer,
      professional_tax, tds, loan_deduction, other_deduction,
    } = req.body;

    await db.execute(
      `INSERT INTO salary_structures
         (employee_id, effective_from, basic_salary, hra, da, medical_allow, travel_allow,
          special_allow, other_allow, pf_employee, pf_employer, esi_employee, esi_employer,
          professional_tax, tds, loan_deduction, other_deduction)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         effective_from=VALUES(effective_from), basic_salary=VALUES(basic_salary),
         hra=VALUES(hra), da=VALUES(da), medical_allow=VALUES(medical_allow),
         travel_allow=VALUES(travel_allow), special_allow=VALUES(special_allow),
         other_allow=VALUES(other_allow), pf_employee=VALUES(pf_employee),
         pf_employer=VALUES(pf_employer), esi_employee=VALUES(esi_employee),
         esi_employer=VALUES(esi_employer), professional_tax=VALUES(professional_tax),
         tds=VALUES(tds), loan_deduction=VALUES(loan_deduction),
         other_deduction=VALUES(other_deduction), updated_at=NOW()`,
      [
        employee_id, effective_from || new Date().toISOString().slice(0,10),
        basic_salary||0, hra||0, da||0, medical_allow||0, travel_allow||0,
        special_allow||0, other_allow||0, pf_employee||0, pf_employer||0,
        esi_employee||0, esi_employer||0, professional_tax||0, tds||0,
        loan_deduction||0, other_deduction||0,
      ]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `UPSERT_SALARY:${employee_id}`, 'payroll', req.ip]
    );

    res.json({ success: true, message: 'Salary structure saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to save salary structure' });
  }
};

// ── GET /api/payroll/runs ─────────────────────────────────
const getPayrollRuns = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT pr.*, u.full_name AS processed_by_name
       FROM payroll_runs pr
       LEFT JOIN users u ON u.id = pr.processed_by
       ORDER BY pr.year DESC, pr.month DESC
       LIMIT 24`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch runs' });
  }
};

// ── POST /api/payroll/runs ────────────────────────────────
// Create + auto-process a payroll run
const createPayrollRun = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { month, year, remarks } = req.body;
    const MONTHS_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
    const working_days = MONTHS_DAYS[month-1] - Math.floor(MONTHS_DAYS[month-1] * 2/7);

    // Check duplicate
    const [[dup]] = await conn.execute(
      'SELECT id FROM payroll_runs WHERE month=? AND year=?', [month, year]
    );
    if (dup) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Payroll already processed for this month' });
    }

    // Create run
    const [run] = await conn.execute(
      'INSERT INTO payroll_runs (month, year, status, processed_by, remarks) VALUES (?,?,?,?,?)',
      [month, year, 'Processing', req.user.id, remarks||null]
    );
    const runId = run.insertId;

    // Fetch all employees with salary structures
    const [employees] = await conn.execute(
      `SELECT e.id AS employee_id, ss.*,
              COALESCE(att.present,0) AS days_present,
              COALESCE(att.absent,0)  AS days_absent,
              COALESCE(att.on_leave,0) AS days_leave
       FROM employees e
       JOIN salary_structures ss ON ss.employee_id = e.id
       LEFT JOIN (
         SELECT employee_id,
                SUM(status IN ('Present','Late')) AS present,
                SUM(status='Absent')              AS absent,
                SUM(status='Leave')               AS on_leave
         FROM attendance
         WHERE MONTH(date)=? AND YEAR(date)=?
         GROUP BY employee_id
       ) att ON att.employee_id = e.id
       WHERE e.is_active = 1`,
      [month, year]
    );

    let totalGross = 0, totalDeductions = 0, totalNet = 0;

    for (const emp of employees) {
      // Pro-rate salary based on attendance (LOP)
      const presentRatio = working_days > 0 ? Math.min(1, (emp.days_present) / working_days) : 1;
      const lopDays      = Math.max(0, working_days - emp.days_present - emp.days_leave);
      const lopDeduction = lopDays > 0 ? (emp.gross_salary / working_days) * lopDays : 0;

      const gross = Number(emp.gross_salary || 0);
      const ptax  = calcProfTax(gross);

      const totalDed = Number(emp.pf_employee||0) + Number(emp.esi_employee||0) +
                       ptax + Number(emp.tds||0) + Number(emp.loan_deduction||0) +
                       Number(emp.other_deduction||0) + lopDeduction;

      const net = Math.max(0, gross - totalDed);

      await conn.execute(
        `INSERT INTO payslips
           (payroll_run_id, employee_id, month, year,
            basic_salary, hra, da, medical_allow, travel_allow, special_allow, other_allow,
            gross_salary, pf_employee, esi_employee, professional_tax, tds,
            loan_deduction, other_deduction, lop_deduction, total_deductions, net_salary,
            working_days, days_present, days_absent, days_leave, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           gross_salary=VALUES(gross_salary), net_salary=VALUES(net_salary),
           total_deductions=VALUES(total_deductions), status=VALUES(status)`,
        [
          runId, emp.employee_id, month, year,
          fmtCur(emp.basic_salary), fmtCur(emp.hra), fmtCur(emp.da),
          fmtCur(emp.medical_allow), fmtCur(emp.travel_allow),
          fmtCur(emp.special_allow), fmtCur(emp.other_allow),
          fmtCur(gross),
          fmtCur(emp.pf_employee), fmtCur(emp.esi_employee),
          fmtCur(ptax), fmtCur(emp.tds),
          fmtCur(emp.loan_deduction), fmtCur(emp.other_deduction),
          fmtCur(lopDeduction), fmtCur(totalDed), fmtCur(net),
          working_days, emp.days_present||0, emp.days_absent||0, emp.days_leave||0,
          'Approved',
        ]
      );

      totalGross      += gross;
      totalDeductions += totalDed;
      totalNet        += net;
    }

    // Update run summary
    await conn.execute(
      `UPDATE payroll_runs SET status='Completed', total_employees=?, total_gross=?,
       total_deductions=?, total_net=?, processed_at=NOW() WHERE id=?`,
      [employees.length, fmtCur(totalGross), fmtCur(totalDeductions), fmtCur(totalNet), runId]
    );

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `PROCESS_PAYROLL:${month}/${year}`, 'payroll', req.ip]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      message: `Payroll processed for ${employees.length} employees`,
      data: { runId, employees: employees.length, totalNet: fmtCur(totalNet) },
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Payroll processing failed' });
  } finally {
    conn.release();
  }
};

// ── GET /api/payroll/payslips ─────────────────────────────
const getPayslips = async (req, res) => {
  try {
    const { month, year, employee_id, page = 1, limit = 15 } = req.query;
    const isAdminHR = ['Admin','HR','Manager'].includes(req.user.role_name);
    const conditions = ['1=1'];
    const params     = [];

    if (!isAdminHR) {
      const [[emp]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);
      if (emp) { conditions.push('ps.employee_id=?'); params.push(emp.id); }
    } else if (employee_id) {
      conditions.push('ps.employee_id=?'); params.push(employee_id);
    }
    if (month) { conditions.push('ps.month=?'); params.push(month); }
    if (year)  { conditions.push('ps.year=?');  params.push(year);  }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1) * Number(limit);
    const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM payslips ps WHERE ${where}`, params);

    const [rows] = await db.execute(
      `SELECT ps.*, e.full_name, e.employee_id AS emp_code, e.avatar_url,
              d.name AS department, des.name AS designation
       FROM payslips ps
       JOIN employees e ON e.id = ps.employee_id
       LEFT JOIN departments  d   ON d.id = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       WHERE ${where}
       ORDER BY ps.year DESC, ps.month DESC, e.full_name
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({ success: true, data: rows, meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch payslips' });
  }
};

// ── GET /api/payroll/payslips/:id ─────────────────────────
const getPayslip = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT ps.*, e.full_name, e.employee_id AS emp_code, e.email, e.phone, e.joining_date,
              e.bank_name, e.account_number, e.ifsc_code,
              d.name AS department, des.name AS designation
       FROM payslips ps
       JOIN employees e ON e.id = ps.employee_id
       LEFT JOIN departments  d   ON d.id = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       WHERE ps.id = ?`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Payslip not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch payslip' });
  }
};

// ── GET /api/payroll/stats ────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[cur]] = await db.execute(
      `SELECT SUM(net_salary) AS total_net, SUM(gross_salary) AS total_gross,
              SUM(total_deductions) AS total_ded, COUNT(*) AS emp_count
       FROM payslips WHERE month=MONTH(NOW()) AND year=YEAR(NOW())`
    );
    const [[prev]] = await db.execute(
      `SELECT SUM(net_salary) AS total_net FROM payslips
       WHERE month=MONTH(DATE_SUB(NOW(),INTERVAL 1 MONTH))
         AND year=YEAR(DATE_SUB(NOW(),INTERVAL 1 MONTH))`
    );
    const [monthly] = await db.execute(
      `SELECT month, year, SUM(net_salary) AS net, SUM(gross_salary) AS gross, COUNT(*) AS emp
       FROM payslips WHERE year=YEAR(NOW())
       GROUP BY month, year ORDER BY month`
    );
    res.json({ success: true, data: { current: cur, previous: prev, monthly } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

module.exports = {
  getAllStructures, getStructure, upsertStructure,
  getPayrollRuns, createPayrollRun,
  getPayslips, getPayslip, getStats,
};