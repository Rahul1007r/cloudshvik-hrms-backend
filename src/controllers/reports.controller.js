const db = require('../config/db');

// ── Helpers ───────────────────────────────────────────────
const fmtDate = d => d ? new Date(d).toISOString().slice(0,10) : null;

// ── GET /api/reports/attendance ───────────────────────────
const attendanceReport = async (req, res) => {
  try {
    const {
      month = new Date().getMonth()+1,
      year  = new Date().getFullYear(),
      department_id, employee_id,
    } = req.query;

    const conditions = ['MONTH(a.date)=?','YEAR(a.date)=?','e.is_active=1'];
    const params     = [Number(month), Number(year)];

    if (department_id) { conditions.push('e.department_id=?'); params.push(department_id); }
    if (employee_id)   { conditions.push('e.id=?');            params.push(employee_id); }

    const where = conditions.join(' AND ');

    const [rows] = await db.execute(`
      SELECT
        e.employee_id AS emp_code, e.full_name,
        d.name AS department, des.name AS designation,
        COUNT(a.id)                              AS total_days,
        SUM(a.status IN ('Present','Late'))      AS present,
        SUM(a.status='Absent')                   AS absent,
        SUM(a.status='Late')                     AS late,
        SUM(a.status='Leave')                    AS on_leave,
        SUM(a.status='Half-Day')                 AS half_day,
        ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.check_in, a.check_out))/60, 1) AS total_hours,
        ROUND(AVG(TIMESTAMPDIFF(MINUTE, a.check_in, a.check_out))/60, 1) AS avg_hours,
        MIN(TIME(a.check_in))                    AS earliest_in,
        MAX(TIME(a.check_out))                   AS latest_out
      FROM employees e
      LEFT JOIN attendance a ON a.employee_id=e.id AND ${conditions.slice(0,2).join(' AND ')}
      LEFT JOIN departments  d   ON d.id=e.department_id
      LEFT JOIN designations des ON des.id=e.designation_id
      WHERE ${conditions.slice(2).join(' AND ')} ${department_id?'AND e.department_id=?':''} ${employee_id?'AND e.id=?':''}
      GROUP BY e.id
      ORDER BY d.name, e.full_name`,
      [...params.slice(0,2), ...params.slice(2)]
    );

    // Summary
    const summary = rows.reduce((acc, r) => ({
      total_employees: acc.total_employees + 1,
      total_present:   acc.total_present   + Number(r.present   || 0),
      total_absent:    acc.total_absent    + Number(r.absent    || 0),
      total_late:      acc.total_late      + Number(r.late      || 0),
      total_hours:     acc.total_hours     + Number(r.total_hours|| 0),
    }), { total_employees:0, total_present:0, total_absent:0, total_late:0, total_hours:0 });

    res.json({ success:true, data: rows, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Attendance report failed' });
  }
};

// ── GET /api/reports/leave ────────────────────────────────
const leaveReport = async (req, res) => {
  try {
    const {
      year = new Date().getFullYear(),
      department_id, leave_type_id, status,
    } = req.query;

    const conditions = ['YEAR(lr.start_date)=?','e.is_active=1'];
    const params     = [Number(year)];

    if (department_id) { conditions.push('e.department_id=?');   params.push(department_id); }
    if (leave_type_id) { conditions.push('lr.leave_type_id=?');  params.push(leave_type_id); }
    if (status)        { conditions.push('lr.status=?');          params.push(status); }

    const where = conditions.join(' AND ');

    const [rows] = await db.execute(`
      SELECT
        lr.id, lr.start_date, lr.end_date, lr.total_days,
        lr.status, lr.reason, lr.created_at,
        lr.rejection_reason,
        lt.name AS leave_type, lt.color, lt.is_paid,
        e.employee_id AS emp_code, e.full_name,
        d.name AS department,
        u.full_name AS approved_by_name
      FROM leave_requests lr
      JOIN employees  e  ON e.id  = lr.employee_id
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u ON u.id = lr.approved_by
      WHERE ${where}
      ORDER BY lr.created_at DESC`, params
    );

    // Summary by type
    const byType = {};
    rows.forEach(r => {
      if (!byType[r.leave_type]) byType[r.leave_type] = { count:0, days:0, color:r.color };
      byType[r.leave_type].count++;
      byType[r.leave_type].days += Number(r.total_days||0);
    });

    const summary = {
      total:    rows.length,
      approved: rows.filter(r=>r.status==='Approved').length,
      pending:  rows.filter(r=>r.status==='Pending').length,
      rejected: rows.filter(r=>r.status==='Rejected').length,
      total_days: rows.filter(r=>r.status==='Approved').reduce((s,r)=>s+Number(r.total_days||0),0),
      byType: Object.entries(byType).map(([name, v]) => ({ name, ...v })),
    };

    res.json({ success:true, data:rows, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Leave report failed' });
  }
};

// ── GET /api/reports/payroll ──────────────────────────────
const payrollReport = async (req, res) => {
  try {
    const {
      month = new Date().getMonth()+1,
      year  = new Date().getFullYear(),
      department_id,
    } = req.query;

    const conditions = ['ps.month=?','ps.year=?','e.is_active=1'];
    const params     = [Number(month), Number(year)];

    if (department_id) { conditions.push('e.department_id=?'); params.push(department_id); }

    const where = conditions.join(' AND ');

    const [rows] = await db.execute(`
      SELECT
        e.employee_id AS emp_code, e.full_name, e.joining_date,
        d.name AS department, des.name AS designation,
        ps.basic_salary, ps.hra, ps.da,
        ps.medical_allow, ps.travel_allow, ps.special_allow,
        ps.gross_salary, ps.pf_employee, ps.esi_employee,
        ps.professional_tax, ps.tds, ps.lop_deduction,
        ps.total_deductions, ps.net_salary,
        ps.working_days, ps.days_present, ps.days_absent,
        ps.status AS payslip_status
      FROM payslips ps
      JOIN employees  e   ON e.id  = ps.employee_id
      LEFT JOIN departments  d   ON d.id  = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      WHERE ${where}
      ORDER BY d.name, e.full_name`, params
    );

    const summary = rows.reduce((acc, r) => ({
      total_employees: acc.total_employees + 1,
      total_gross:     acc.total_gross     + Number(r.gross_salary   || 0),
      total_deductions:acc.total_deductions+ Number(r.total_deductions||0),
      total_net:       acc.total_net       + Number(r.net_salary     || 0),
      total_pf:        acc.total_pf        + Number(r.pf_employee    || 0),
      total_tds:       acc.total_tds       + Number(r.tds            || 0),
    }), { total_employees:0, total_gross:0, total_deductions:0, total_net:0, total_pf:0, total_tds:0 });

    res.json({ success:true, data:rows, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Payroll report failed' });
  }
};

// ── GET /api/reports/employees ────────────────────────────
const employeeReport = async (req, res) => {
  try {
    const {
      department_id, employment_type, work_location,
      is_active = 'true', joined_after, joined_before,
    } = req.query;

    const conditions = ['1=1'];
    const params     = [];

    if (department_id)   { conditions.push('e.department_id=?');   params.push(department_id); }
    if (employment_type) { conditions.push('e.employment_type=?'); params.push(employment_type); }
    if (work_location)   { conditions.push('e.work_location=?');   params.push(work_location); }
    if (is_active !== '') { conditions.push('e.is_active=?');      params.push(is_active==='true'?1:0); }
    if (joined_after)    { conditions.push('e.joining_date>=?');   params.push(joined_after); }
    if (joined_before)   { conditions.push('e.joining_date<=?');   params.push(joined_before); }

    const where = conditions.join(' AND ');

    const [rows] = await db.execute(`
      SELECT
        e.employee_id AS emp_code, e.full_name, e.email, e.phone,
        e.gender, e.date_of_birth, e.blood_group,
        e.joining_date, e.employment_type, e.work_location, e.is_active,
        d.name AS department, des.name AS designation, des.level,
        m.full_name AS manager_name,
        e.city, e.state,
        TIMESTAMPDIFF(MONTH, e.joining_date, CURDATE()) AS tenure_months
      FROM employees e
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN employees    m   ON m.id   = e.manager_id
      WHERE ${where}
      ORDER BY d.name, e.full_name`, params
    );

    // Summary
    const byDept = {}, byType = {}, byLoc = {};
    rows.forEach(r => {
      byDept[r.department||'Unknown'] = (byDept[r.department||'Unknown']||0)+1;
      byType[r.employment_type||'Unknown'] = (byType[r.employment_type||'Unknown']||0)+1;
      byLoc[r.work_location||'Unknown']    = (byLoc[r.work_location||'Unknown']||0)+1;
    });

    const summary = {
      total: rows.length,
      active:    rows.filter(r=>r.is_active).length,
      inactive:  rows.filter(r=>!r.is_active).length,
      avg_tenure:rows.length ? Math.round(rows.reduce((s,r)=>s+Number(r.tenure_months||0),0)/rows.length) : 0,
      byDept: Object.entries(byDept).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count),
      byType: Object.entries(byType).map(([name,count])=>({name,count})),
      byLoc:  Object.entries(byLoc).map(([name,count])=>({name,count})),
    };

    res.json({ success:true, data:rows, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Employee report failed' });
  }
};

// ── GET /api/reports/headcount-trend ─────────────────────
const headcountTrend = async (req, res) => {
  try {
    const { months=12 } = req.query;
    const [rows] = await db.execute(`
      SELECT
        DATE_FORMAT(joining_date,'%Y-%m') AS period,
        DATE_FORMAT(joining_date,'%b %Y') AS label,
        COUNT(*)                          AS new_hires,
        SUM(employment_type='Full-Time')  AS full_time,
        SUM(employment_type='Contract')   AS contract
      FROM employees
      WHERE joining_date >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)
        AND is_active = 1
      GROUP BY period ORDER BY period ASC`, [Number(months)]
    );
    res.json({ success:true, data:rows });
  } catch (err) {
    res.status(500).json({ success:false, message:'Trend report failed' });
  }
};

// ── GET /api/reports/audit-log ────────────────────────────
const auditLog = async (req, res) => {
  try {
    const { page=1, limit=25, module, user_id } = req.query;
    const conditions = ['1=1'];
    const params     = [];
    if (module)  { conditions.push('al.module=?');  params.push(module); }
    if (user_id) { conditions.push('al.user_id=?'); params.push(user_id); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);
    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM audit_logs al WHERE ${where}`, params
    );
    const [rows] = await db.execute(
      `SELECT al.*, u.full_name, u.email
       FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id
       WHERE ${where} ORDER BY al.created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );
    res.json({ success:true, data:rows, meta:{ total:Number(total), page:Number(page), pages:Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    res.status(500).json({ success:false, message:'Audit log failed' });
  }
};

// ── GET /api/reports/overview ─────────────────────────────
// Dashboard-style KPIs for the reports landing page
const overview = async (req, res) => {
  try {
    const [[emp]]   = await db.execute("SELECT COUNT(*) AS v FROM employees WHERE is_active=1");
    const [[newEmp]]= await db.execute("SELECT COUNT(*) AS v FROM employees WHERE is_active=1 AND joining_date>=DATE_FORMAT(NOW(),'%Y-%m-01')");
    const [[leavePend]]= await db.execute("SELECT COUNT(*) AS v FROM leave_requests WHERE status='Pending'");
    const [[payroll]]  = await db.execute("SELECT COALESCE(SUM(net_salary),0) AS v FROM payslips WHERE month=MONTH(NOW()) AND year=YEAR(NOW())");
    const [[attToday]] = await db.execute("SELECT COUNT(*) AS v FROM attendance WHERE DATE(date)=CURDATE() AND status IN ('Present','Late')");
    const [[tsSubmit]] = await db.execute("SELECT COUNT(*) AS v FROM timesheets WHERE status='Submitted'");

    // Dept headcount
    const [byDept] = await db.execute(`
      SELECT d.name, COUNT(e.id) AS count
      FROM departments d
      LEFT JOIN employees e ON e.department_id=d.id AND e.is_active=1
      WHERE d.is_active=1 GROUP BY d.id ORDER BY count DESC LIMIT 6`
    );

    // Monthly payroll trend
    const [payTrend] = await db.execute(`
      SELECT month, year,
             SUM(gross_salary) AS gross, SUM(net_salary) AS net,
             COUNT(*) AS emp_count
      FROM payslips WHERE year=YEAR(NOW())
      GROUP BY month,year ORDER BY month`
    );

    // Leave by type (current year approved)
    const [leaveByType] = await db.execute(`
      SELECT lt.name, lt.color, COUNT(lr.id) AS count, SUM(lr.total_days) AS days
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id=lr.leave_type_id
      WHERE lr.status='Approved' AND YEAR(lr.start_date)=YEAR(NOW())
      GROUP BY lt.id ORDER BY days DESC LIMIT 6`
    );

    res.json({
      success:true,
      data:{
        kpis:{
          employees:   Number(emp.v),
          newThisMonth:Number(newEmp.v),
          leavePending:Number(leavePend.v),
          monthPayroll:Number(payroll.v),
          todayPresent:Number(attToday.v),
          tsSubmitted: Number(tsSubmit.v),
        },
        byDept, payTrend, leaveByType,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Overview failed' });
  }
};

module.exports = {
  attendanceReport, leaveReport, payrollReport,
  employeeReport, headcountTrend, auditLog, overview,
};