const db     = require('../config/db');
const PDFDoc = require('pdfkit');

const MONTHS_F = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];

// ── All known template variables ──────────────────────────
const ALL_VARIABLES = [
  'candidate_name','candidate_email','designation','department',
  'joining_date','employment_type','work_location','manager_name',
  'gross_salary','annual_ctc','currency_symbol',
  'company_name','company_address','company_city','company_state',
  'hr_signatory','hr_designation',
  'offer_date','response_deadline','emp_code',
];

// ── Fetch company + HR settings ───────────────────────────
const getCompanyVars = async () => {
  const [settings] = await db.execute(
    `SELECT setting_key, setting_value FROM company_settings
     WHERE setting_key IN ('company_name','company_address','company_city',
                           'company_state','currency_symbol')`
  ).catch(() => [[]]);

  const map = {};
  settings.forEach(s => { map[s.setting_key] = s.setting_value; });

  return {
    company_name:    map.company_name    || 'HRMS Corporation',
    company_address: map.company_address || '123 Business Park',
    company_city:    map.company_city    || 'Chennai',
    company_state:   map.company_state   || 'Tamil Nadu',
    currency_symbol: map.currency_symbol || '₹',
    hr_signatory:    'HR Manager',
    hr_designation:  'Human Resources',
    offer_date:      new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' }),
  };
};

// ── Render template: replace {{var}} with values ──────────
const renderTemplate = (html, variables) => {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
};

// ── GET /api/offer-letters/templates ─────────────────────
const getTemplates = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT t.*, u.full_name AS created_by_name
       FROM letter_templates t
       JOIN users u ON u.id = t.created_by
       WHERE t.is_active = 1
       ORDER BY t.letter_type, t.name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch templates' });
  }
};

// ── GET /api/offer-letters/templates/:id ─────────────────
const getTemplate = async (req, res) => {
  try {
    const [[row]] = await db.execute(
      'SELECT * FROM letter_templates WHERE id = ?', [req.params.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, data: { ...row, variables: ALL_VARIABLES } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch template' });
  }
};

// ── POST /api/offer-letters/templates ────────────────────
const createTemplate = async (req, res) => {
  try {
    const { name, letter_type, subject, body_html } = req.body;
    const [result] = await db.execute(
      'INSERT INTO letter_templates (name, letter_type, subject, body_html, created_by) VALUES (?,?,?,?,?)',
      [name.trim(), letter_type, subject || null, body_html, req.user.id]
    );
    res.status(201).json({ success: true, message: 'Template created', data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create template' });
  }
};

// ── PUT /api/offer-letters/templates/:id ─────────────────
const updateTemplate = async (req, res) => {
  try {
    const { name, letter_type, subject, body_html, is_active } = req.body;
    await db.execute(
      'UPDATE letter_templates SET name=?,letter_type=?,subject=?,body_html=?,is_active=? WHERE id=?',
      [name.trim(), letter_type, subject || null, body_html, is_active ?? true, req.params.id]
    );
    res.json({ success: true, message: 'Template updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update template' });
  }
};

// ── GET /api/offer-letters/variables ─────────────────────
const getVariables = async (req, res) => {
  res.json({ success: true, data: ALL_VARIABLES });
};

// ── GET /api/offer-letters ────────────────────────────────
const getAll = async (req, res) => {
  try {
    const { status, letter_type, page = 1, limit = 15 } = req.query;
    const conditions = ['1=1'];
    const params     = [];
    if (status)      { conditions.push('gl.status = ?');       params.push(status); }
    if (letter_type) { conditions.push('gl.letter_type = ?'); params.push(letter_type); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM generated_letters gl WHERE ${where}`, params
    );
    const [rows] = await db.execute(`
      SELECT gl.*,
             e.full_name AS emp_name, e.employee_id AS emp_code,
             d.name AS department,
             u.full_name AS generated_by_name
      FROM generated_letters gl
      LEFT JOIN employees  e ON e.id = gl.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u ON u.id = gl.generated_by
      WHERE ${where}
      ORDER BY gl.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]
    );
    res.json({ success: true, data: rows, meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch letters' });
  }
};

// ── POST /api/offer-letters/generate ─────────────────────
// Generate a letter from a template with supplied variables
const generate = async (req, res) => {
  try {
    const {
      template_id, employee_id,
      candidate_name, candidate_email,
      letter_type, custom_variables = {},
      expires_at,
    } = req.body;

    // Fetch template
    const [[tmpl]] = await db.execute('SELECT * FROM letter_templates WHERE id=?', [template_id]);
    if (!tmpl) return res.status(404).json({ success: false, message: 'Template not found' });

    // Build variable set
    const companyVars = await getCompanyVars();
    let   empVars     = {};

    if (employee_id) {
      const [[emp]] = await db.execute(`
        SELECT e.*, d.name AS department, des.name AS designation,
               m.full_name AS manager_name, ss.gross_salary, ss.ctc
        FROM employees e
        LEFT JOIN departments  d   ON d.id   = e.department_id
        LEFT JOIN designations des ON des.id = e.designation_id
        LEFT JOIN employees    m   ON m.id   = e.manager_id
        LEFT JOIN salary_structures ss ON ss.employee_id = e.id
        WHERE e.id = ?`, [employee_id]
      );
      if (emp) {
        empVars = {
          candidate_name:  emp.full_name,
          candidate_email: emp.email,
          emp_code:        emp.employee_id,
          designation:     emp.designation || '',
          department:      emp.department  || '',
          joining_date:    emp.joining_date ? new Date(emp.joining_date).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}) : '',
          employment_type: emp.employment_type || 'Full-Time',
          work_location:   emp.work_location   || 'Office',
          manager_name:    emp.manager_name    || 'HR Manager',
          gross_salary:    emp.gross_salary ? Number(emp.gross_salary).toLocaleString('en-IN') : '—',
          annual_ctc:      emp.ctc ? Number(emp.ctc*12).toLocaleString('en-IN') : '—',
        };
      }
    } else {
      empVars = {
        candidate_name:  candidate_name || '',
        candidate_email: candidate_email || '',
      };
    }

    const finalVars = {
      ...companyVars,
      ...empVars,
      response_deadline: expires_at
        ? new Date(expires_at).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})
        : new Date(Date.now()+7*24*3600*1000).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}),
      ...custom_variables,
    };

    const renderedSubject = renderTemplate(tmpl.subject || '', finalVars);
    const renderedBody    = renderTemplate(tmpl.body_html, finalVars);

    const [result] = await db.execute(`
      INSERT INTO generated_letters
        (template_id, employee_id, candidate_name, candidate_email,
         letter_type, subject, body_html, variables_json,
         expires_at, generated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        template_id, employee_id || null,
        finalVars.candidate_name, finalVars.candidate_email || null,
        tmpl.letter_type, renderedSubject, renderedBody,
        JSON.stringify(finalVars), expires_at || null, req.user.id,
      ]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `GENERATE_LETTER:${tmpl.letter_type}:letter${result.insertId}`, 'hr', req.ip]
    );

    res.status(201).json({ success: true, message: 'Letter generated', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Generation failed' });
  }
};

// ── GET /api/offer-letters/:id ────────────────────────────
const getOne = async (req, res) => {
  try {
    const [[row]] = await db.execute(`
      SELECT gl.*,
             e.full_name AS emp_name,
             u.full_name AS generated_by_name
      FROM generated_letters gl
      LEFT JOIN employees e ON e.id = gl.employee_id
      LEFT JOIN users u ON u.id = gl.generated_by
      WHERE gl.id = ?`, [req.params.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Letter not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch letter' });
  }
};

// ── PATCH /api/offer-letters/:id/status ──────────────────
const updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['Draft','Sent','Accepted','Declined','Expired'];
    if (!validStatuses.includes(status)) {
      return res.status(422).json({ success: false, message: 'Invalid status' });
    }

    const updates = { status };
    if (status === 'Sent')     updates.sent_at     = new Date();
    if (status === 'Accepted') updates.accepted_at = new Date();

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.execute(
      `UPDATE generated_letters SET ${setClause} WHERE id = ?`,
      [...Object.values(updates), req.params.id]
    );
    res.json({ success: true, message: `Status updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Status update failed' });
  }
};

// ── GET /api/offer-letters/:id/download ──────────────────
const downloadPdf = async (req, res) => {
  try {
    const [[letter]] = await db.execute(
      'SELECT * FROM generated_letters WHERE id = ?', [req.params.id]
    );
    if (!letter) return res.status(404).json({ success: false, message: 'Letter not found' });

    // Build PDF from HTML body
    const chunks = [];
    const doc    = new PDFDoc({ size:'A4', margin:60 });
    doc.on('data', c => chunks.push(c));

    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);

      const BLU  = '#006bb7';
      const GREY = '#64748b';
      const PW   = doc.page.width - 120;

      // Header
      doc.rect(60, 40, PW, 56).fill(BLU);
      const vars = letter.variables_json ? JSON.parse(letter.variables_json) : {};
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#fff')
         .text(vars.company_name || 'HRMS Corporation', 74, 52);
      doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
         .text(letter.letter_type, 74, 72);
      doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
         .text(new Date(letter.created_at).toLocaleDateString('en-IN'), 60, 72, { width: PW, align:'right' });

      let y = 114;

      // Strip HTML tags for PDF text
      const text = letter.body_html
        .replace(/<h3[^>]*>(.*?)<\/h3>/gis,  (_, t) => `\n**${t.trim()}**\n`)
        .replace(/<strong>(.*?)<\/strong>/gis,(_, t) => t)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<p[^>]*>(.*?)<\/p>/gis,    (_, t) => `${t.trim()}\n\n`)
        .replace(/<tr[^>]*>(.*?)<\/tr>/gis,  (_, t) => {
          const cells = [...t.matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(m => m[1].trim()).join('   ');
          return `${cells}\n`;
        })
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Render paragraphs
      text.split('\n').forEach(line => {
        const isBold = line.startsWith('**') && line.endsWith('**');
        const clean  = isBold ? line.slice(2,-2) : line;
        if (clean.trim() === '') { y += 6; return; }
        if (y > doc.page.height - 100) { doc.addPage(); y = 60; }
        doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica')
           .fontSize(isBold ? 11 : 10.5)
           .fillColor(isBold ? BLU : '#1e293b')
           .text(clean, 60, y, { width: PW, lineGap: 2 });
        y = doc.y + (isBold ? 6 : 3);
      });

      // Signature box
      y += 20;
      if (y < doc.page.height - 120) {
        doc.moveTo(60, y).lineTo(220, y).stroke('#cbd5e1');
        doc.fontSize(9).font('Helvetica').fillColor(GREY)
           .text('Authorised Signatory', 60, y + 5);
        doc.moveTo(PW - 100, y).lineTo(PW + 60, y).stroke('#cbd5e1');
        doc.text("Candidate's Signature", PW - 100, y + 5);
      }

      // Footer
      doc.fontSize(8).fillColor('#94a3b8')
         .text(`Generated: ${new Date().toLocaleDateString('en-IN')}  ·  Ref: LTR-${String(letter.id).padStart(6,'0')}`,
               60, doc.page.height - 50, { width: PW, align:'center' });

      doc.end();
    });

    const buf      = Buffer.concat(chunks);
    const slug     = letter.letter_type.replace(/\s+/g,'_');
    const cand     = (letter.candidate_name||'Letter').replace(/\s+/g,'_');
    const filename = `${slug}_${cand}_LTR${String(letter.id).padStart(5,'0')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buf);

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `DOWNLOAD_LETTER:${req.params.id}`, 'hr', req.ip]
    ).catch(() => {});
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'PDF generation failed' });
  }
};

// ── GET /api/offer-letters/stats ─────────────────────────
const getStats = async (req, res) => {
  try {
    const [[counts]] = await db.execute(`
      SELECT
        SUM(status='Draft')    AS drafts,
        SUM(status='Sent')     AS sent,
        SUM(status='Accepted') AS accepted,
        SUM(status='Declined') AS declined,
        SUM(status='Expired')  AS expired,
        COUNT(*)               AS total
      FROM generated_letters
      WHERE YEAR(created_at) = YEAR(NOW())`
    );
    const [byType] = await db.execute(`
      SELECT letter_type, COUNT(*) AS count
      FROM generated_letters
      WHERE YEAR(created_at) = YEAR(NOW())
      GROUP BY letter_type ORDER BY count DESC`
    );
    res.json({ success: true, data: { counts, byType } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

module.exports = {
  getTemplates, getTemplate, createTemplate, updateTemplate,
  getVariables, getAll, generate, getOne, updateStatus, downloadPdf, getStats,
};