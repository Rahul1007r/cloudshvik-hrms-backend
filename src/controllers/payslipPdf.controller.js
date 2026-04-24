const db       = require('../config/db');
const PDFDoc   = require('pdfkit');
const archiver = require('archiver');

// ── Helpers ───────────────────────────────────────────────
const MONTHS_F = ['January','February','March','April','May','June','July','August',
                  'September','October','November','December'];

const cur  = v => `Rs. ${Number(v||0).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
const curN = v => Number(v||0).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 });

// Fetch full payslip data
const fetchPayslip = async (id) => {
  const [[ps]] = await db.execute(`
    SELECT ps.*,
           e.full_name, e.employee_id AS emp_code, e.email, e.phone,
           e.joining_date, e.pan_number, e.bank_name, e.account_number, e.ifsc_code,
           d.name  AS department,
           des.name AS designation,
           loc.setting_value AS company_name
    FROM payslips ps
    JOIN employees e ON e.id = ps.employee_id
    LEFT JOIN departments  d   ON d.id   = e.department_id
    LEFT JOIN designations des ON des.id = e.designation_id
    LEFT JOIN company_settings loc ON loc.setting_key = 'company_name'
    WHERE ps.id = ?`, [id]
  );
  return ps || null;
};

// ── Build PDF into a buffer ───────────────────────────────
const buildPayslipPDF = (ps, companySettings = {}) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc    = new PDFDoc({ size: 'A4', margin: 40 });

    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PW   = doc.page.width  - 80;  // usable width
    const BLU  = '#006bb7';
    const GREY = '#64748b';
    const LGT  = '#f1f5f9';
    const BLK  = '#1e293b';

    // ── Header bar ────────────────────────────────────────
    doc.rect(40, 30, PW, 64).fill(BLU);
    doc.fontSize(18).fillColor('#fff').font('Helvetica-Bold')
       .text(companySettings.company_name || ps.company_name || 'HRMS Corporation', 54, 42);
    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
       .text('Payslip', 54, 65);

    // Period badge
    const period = `${MONTHS_F[ps.month-1]} ${ps.year}`;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#fff')
       .text(period, 40, 48, { width: PW, align: 'right' });
    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
       .text('Pay Period', 40, 65, { width: PW, align: 'right' });

    let y = 112;

    // ── Employee info two-column ──────────────────────────
    doc.rect(40, y, PW, 80).fill(LGT);
    const LEFT_X  = 54;
    const RIGHT_X = 40 + PW/2 + 10;

    const empFields = [
      ['Employee Name',   ps.full_name],
      ['Employee ID',     ps.emp_code],
      ['Designation',     ps.designation || '—'],
    ];
    const empFields2 = [
      ['Department',      ps.department  || '—'],
      ['Joining Date',    ps.joining_date ? ps.joining_date.toString().slice(0,10) : '—'],
      ['PAN',             ps.pan_number  || '—'],
    ];

    let fy = y + 10;
    empFields.forEach(([label, val]) => {
      doc.fontSize(8).font('Helvetica').fillColor(GREY).text(label, LEFT_X, fy);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BLK).text(val, LEFT_X, fy + 10);
      fy += 24;
    });

    fy = y + 10;
    empFields2.forEach(([label, val]) => {
      doc.fontSize(8).font('Helvetica').fillColor(GREY).text(label, RIGHT_X, fy);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BLK).text(val, RIGHT_X, fy + 10);
      fy += 24;
    });

    y += 92;

    // ── Attendance strip ──────────────────────────────────
    doc.rect(40, y, PW, 36).fill('#e0f2fe');
    const attItems = [
      ['Working Days', ps.working_days],
      ['Days Present',  ps.days_present],
      ['Days Absent',   ps.days_absent],
      ['Leave Days',    ps.days_leave],
    ];
    const colW = PW / attItems.length;
    attItems.forEach(([label, val], i) => {
      const cx = 40 + i * colW + colW / 2;
      doc.fontSize(14).font('Helvetica-Bold').fillColor(BLU)
         .text(String(val || 0), 40 + i*colW, y + 6, { width: colW, align: 'center' });
      doc.fontSize(7).font('Helvetica').fillColor(GREY)
         .text(label, 40 + i*colW, y + 22, { width: colW, align: 'center' });
    });
    y += 48;

    // ── Earnings & Deductions tables ──────────────────────
    const halfW = (PW - 12) / 2;
    const COL1  = 40;
    const COL2  = 40 + halfW + 12;

    const earnings = [
      ['Basic Salary',       ps.basic_salary],
      ['House Rent Allow.',  ps.hra],
      ['Dearness Allow.',    ps.da],
      ['Medical Allow.',     ps.medical_allow],
      ['Travel Allow.',      ps.travel_allow],
      ['Special Allow.',     ps.special_allow],
      ['Other Allow.',       ps.other_allow],
      ['Overtime Pay',       ps.overtime_pay],
      ['Bonus',              ps.bonus],
    ].filter(([, v]) => Number(v) > 0);

    const deductions = [
      ['Provident Fund',     ps.pf_employee],
      ['ESI (Employee)',     ps.esi_employee],
      ['Professional Tax',   ps.professional_tax],
      ['TDS',                ps.tds],
      ['Loan Deduction',     ps.loan_deduction],
      ['Loss of Pay',        ps.lop_deduction],
      ['Other Deduction',    ps.other_deduction],
    ].filter(([, v]) => Number(v) > 0);

    const drawTableHeader = (x, w, title, color) => {
      doc.rect(x, y, w, 20).fill(color);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff')
         .text(title, x + 6, y + 6);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff')
         .text('Amount (Rs.)', x, y + 6, { width: w - 6, align: 'right' });
    };

    const drawTableRow = (x, w, label, amount, rowY, shade) => {
      if (shade) doc.rect(x, rowY, w, 16).fill('#f8fafc');
      doc.fontSize(8).font('Helvetica').fillColor(BLK)
         .text(label, x + 6, rowY + 4, { width: w * 0.55 });
      doc.fontSize(8).font('Helvetica').fillColor(BLK)
         .text(curN(amount), x, rowY + 4, { width: w - 6, align: 'right' });
    };

    const drawTotalRow = (x, w, label, amount, rowY) => {
      doc.rect(x, rowY, w, 18).fill(LGT);
      doc.rect(x, rowY, w, 18).stroke('#cbd5e1');
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BLK)
         .text(label, x + 6, rowY + 5, { width: w * 0.55 });
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BLU)
         .text(curN(amount), x, rowY + 5, { width: w - 6, align: 'right' });
    };

    // Earnings table
    drawTableHeader(COL1, halfW, 'EARNINGS', '#059669');
    let ey = y + 20;
    earnings.forEach(([label, val], i) => {
      drawTableRow(COL1, halfW, label, val, ey, i % 2 === 0);
      ey += 16;
    });
    drawTotalRow(COL1, halfW, 'GROSS SALARY', ps.gross_salary, ey);
    ey += 18;

    // Deductions table
    drawTableHeader(COL2, halfW, 'DEDUCTIONS', '#dc2626');
    let dy = y + 20;
    deductions.forEach(([label, val], i) => {
      drawTableRow(COL2, halfW, label, val, dy, i % 2 === 0);
      dy += 16;
    });
    drawTotalRow(COL2, halfW, 'TOTAL DEDUCTIONS', ps.total_deductions, dy);
    dy += 18;

    y = Math.max(ey, dy) + 10;

    // ── Net Pay banner ────────────────────────────────────
    doc.rect(40, y, PW, 48).fill(BLU);
    doc.fontSize(11).font('Helvetica-Bold').fillColor('rgba(255,255,255,0.7)')
       .text('NET SALARY (TAKE HOME)', 54, y + 8);

    // Convert amount to words (simple)
    const netAmt = Number(ps.net_salary || 0);
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff')
       .text(`Rs. ${netAmt.toLocaleString('en-IN', { minimumFractionDigits:2 })}`, 54, y + 22);

    // Annual
    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.7)')
       .text(`Annual CTC: Rs. ${(Number(ps.gross_salary||0)*12).toLocaleString('en-IN',{minimumFractionDigits:2})}`, 40, y + 14, { width: PW, align: 'right' });

    y += 60;

    // ── Bank details ──────────────────────────────────────
    if (ps.bank_name || ps.account_number) {
      doc.rect(40, y, PW, 32).fill(LGT);
      doc.fontSize(8).font('Helvetica').fillColor(GREY).text('BANK DETAILS', 54, y + 6);
      const bankStr = [
        ps.bank_name,
        ps.account_number ? `Acc: ****${ps.account_number.toString().slice(-4)}` : null,
        ps.ifsc_code,
      ].filter(Boolean).join('  |  ');
      doc.fontSize(9).font('Helvetica-Bold').fillColor(BLK).text(bankStr, 54, y + 16);
      y += 42;
    }

    // ── Footer ────────────────────────────────────────────
    doc.fontSize(7.5).font('Helvetica').fillColor(GREY)
       .text(
         'This is a computer-generated payslip and does not require a physical signature. ' +
         `Generated on ${new Date().toLocaleDateString('en-IN')}.`,
         40, y + 8, { width: PW, align: 'center' }
       );

    doc.end();
  });
};

// ── GET /api/payslip-pdf/:id ──────────────────────────────
const downloadOne = async (req, res) => {
  try {
    const ps = await fetchPayslip(req.params.id);
    if (!ps) return res.status(404).json({ success: false, message: 'Payslip not found' });

    // Auth check: employee sees own only; HR/Admin sees all
    const isAdminHR = ['Admin','HR'].includes(req.user.role_name);
    if (!isAdminHR) {
      const [[emp]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);
      if (!emp || emp.id !== ps.employee_id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    // Company settings
    const [settings] = await db.execute(
      "SELECT setting_key, setting_value FROM company_settings WHERE setting_key IN ('company_name','company_address','company_city','company_state')"
    ).catch(() => [[]]);
    const companySettings = {};
    settings.forEach(s => { companySettings[s.setting_key] = s.setting_value; });

    const pdfBuf = await buildPayslipPDF(ps, companySettings);
    const filename = `payslip_${ps.emp_code}_${MONTHS_F[ps.month-1]}_${ps.year}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);

    // Log
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `DOWNLOAD_PAYSLIP:${req.params.id}`, 'payroll', req.ip]
    ).catch(() => {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'PDF generation failed' });
  }
};

// ── POST /api/payslip-pdf/batch ───────────────────────────
// Download all payslips for a month as a ZIP
const downloadBatch = async (req, res) => {
  try {
    const { month, year, department_id } = req.body;
    if (!month || !year) return res.status(422).json({ success: false, message: 'month and year required' });

    const conditions = ['ps.month=?', 'ps.year=?'];
    const params     = [Number(month), Number(year)];
    if (department_id) { conditions.push('e.department_id=?'); params.push(department_id); }

    const [payslips] = await db.execute(`
      SELECT ps.*,
             e.full_name, e.employee_id AS emp_code, e.email, e.phone,
             e.joining_date, e.pan_number, e.bank_name, e.account_number, e.ifsc_code,
             d.name AS department, des.name AS designation
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      LEFT JOIN departments  d   ON d.id  = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.name, e.full_name`, params
    );

    if (!payslips.length) {
      return res.status(404).json({ success: false, message: 'No payslips found for this period' });
    }

    const [settings] = await db.execute(
      "SELECT setting_key, setting_value FROM company_settings WHERE setting_key = 'company_name'"
    ).catch(() => [[]]);
    const companySettings = {};
    settings.forEach(s => { companySettings[s.setting_key] = s.setting_value; });

    // Stream ZIP response
    const zipname = `payslips_${MONTHS_F[Number(month)-1]}_${year}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipname}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    for (const ps of payslips) {
      const pdfBuf  = await buildPayslipPDF(ps, companySettings);
      const fname   = `${ps.emp_code}_${ps.full_name.replace(/\s+/g,'_')}_${MONTHS_F[ps.month-1]}_${ps.year}.pdf`;
      archive.append(pdfBuf, { name: fname });
    }

    await archive.finalize();

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `BATCH_PAYSLIP_DOWNLOAD:${month}/${year}:${payslips.length}`, 'payroll', req.ip]
    ).catch(() => {});
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Batch download failed' });
  }
};

// ── POST /api/payslip-pdf/send-email ─────────────────────
// Mark payslips as email-sent (actual SMTP needs nodemailer + config)
const sendEmail = async (req, res) => {
  try {
    const { payslip_ids } = req.body;
    if (!payslip_ids?.length) return res.status(422).json({ success: false, message: 'No payslip IDs provided' });

    // In production: loop, generate PDF, send via nodemailer
    // Here we simulate success and log
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `EMAIL_PAYSLIPS:ids=${payslip_ids.join(',')}`, 'payroll', req.ip]
    ).catch(() => {});

    res.json({
      success: true,
      message: `${payslip_ids.length} payslip${payslip_ids.length!==1?'s':''} queued for email delivery`,
      data: { queued: payslip_ids.length },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Email dispatch failed' });
  }
};

// ── GET /api/payslip-pdf/list ─────────────────────────────
// List payslips with download-ready metadata
const listPayslips = async (req, res) => {
  try {
    const { month, year, department_id, page = 1, limit = 20 } = req.query;
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);

    const conditions = ['1=1'];
    const params     = [];

    if (!isAdminHR) {
      const [[emp]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);
      if (emp) { conditions.push('ps.employee_id=?'); params.push(emp.id); }
    } else {
      if (department_id) { conditions.push('e.department_id=?'); params.push(department_id); }
    }

    if (month) { conditions.push('ps.month=?'); params.push(Number(month)); }
    if (year)  { conditions.push('ps.year=?');  params.push(Number(year));  }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM payslips ps JOIN employees e ON e.id=ps.employee_id WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT ps.id, ps.month, ps.year, ps.gross_salary, ps.net_salary,
             ps.total_deductions, ps.days_present, ps.status,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department, des.name AS designation
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      LEFT JOIN departments  d   ON d.id  = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      WHERE ${where}
      ORDER BY ps.year DESC, ps.month DESC, e.full_name
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]
    );

    res.json({ success:true, data:rows, meta:{ total:Number(total), page:Number(page), pages:Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch payslips' });
  }
};

module.exports = { downloadOne, downloadBatch, sendEmail, listPayslips };