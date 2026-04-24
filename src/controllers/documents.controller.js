const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');

// Upload directory
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads/documents');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const COMPANY_DIR = path.join(UPLOAD_DIR, 'company');
if (!fs.existsSync(COMPANY_DIR)) fs.mkdirSync(COMPANY_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────
const getEmpId = async (userId) => {
  const [[r]] = await db.execute(
    'SELECT id FROM employees WHERE user_id = ? AND is_active = 1', [userId]
  );
  return r?.id || null;
};

const fmtBytes = (b) => {
  if (!b) return '—';
  if (b < 1024)        return `${b} B`;
  if (b < 1024*1024)   return `${(b/1024).toFixed(1)} KB`;
  return `${(b/(1024*1024)).toFixed(1)} MB`;
};

// ── GET /api/documents/categories ────────────────────────
const getCategories = async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM document_categories WHERE is_active = 1 ORDER BY sort_order, name'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
};

// ── GET /api/documents/employee/:empId ───────────────────
const getEmployeeDocuments = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    let empId = Number(req.params.empId);

    // Employees can only see their own docs
    if (!isAdminHR) {
      const selfEmpId = await getEmpId(req.user.id);
      if (!selfEmpId || selfEmpId !== empId) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    const [docs] = await db.execute(`
      SELECT ed.*,
             dc.name AS category_name, dc.color, dc.icon,
             u1.full_name AS uploaded_by_name,
             u2.full_name AS verified_by_name
      FROM employee_documents ed
      JOIN document_categories dc ON dc.id = ed.category_id
      LEFT JOIN users u1 ON u1.id = ed.uploaded_by
      LEFT JOIN users u2 ON u2.id = ed.verified_by
      WHERE ed.employee_id = ?
      ORDER BY dc.sort_order, ed.created_at DESC`, [empId]
    );

    // Also get the required categories checklist
    const [required] = await db.execute(
      'SELECT * FROM document_categories WHERE is_required = 1 AND is_active = 1 ORDER BY sort_order'
    );
    const uploadedCatIds = new Set(docs.filter(d => d.status !== 'Rejected').map(d => d.category_id));
    const checklist = required.map(c => ({
      ...c,
      uploaded: uploadedCatIds.has(c.id),
      doc: docs.find(d => d.category_id === c.id && d.status !== 'Rejected') || null,
    }));

    res.json({ success: true, data: docs, checklist });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch documents' });
  }
};

// ── POST /api/documents/employee/:empId/upload ────────────
// Uses multer (middleware configured in routes)
const uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ success: false, message: 'No file provided' });

    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    let empId = Number(req.params.empId);

    if (!isAdminHR) {
      const selfEmpId = await getEmpId(req.user.id);
      if (!selfEmpId || selfEmpId !== empId) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    const {
      category_id, document_name, document_number,
      issue_date, expiry_date, notes,
    } = req.body;

    const [result] = await db.execute(`
      INSERT INTO employee_documents
        (employee_id, category_id, document_name, original_name,
         file_path, file_size, mime_type, document_number,
         issue_date, expiry_date, notes, status, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        empId, category_id,
        document_name || req.file.originalname,
        req.file.originalname,
        req.file.filename,           // store only filename, not full path
        req.file.size,
        req.file.mimetype,
        document_number || null,
        issue_date  || null,
        expiry_date || null,
        notes       || null,
        'Pending',
        req.user.id,
      ]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `UPLOAD_DOC:emp${empId}:cat${category_id}`, 'documents', req.ip]
    );

    res.status(201).json({ success: true, message: 'Document uploaded', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

// ── POST /api/documents/:docId/verify ────────────────────
const verifyDocument = async (req, res) => {
  try {
    const { notes } = req.body;
    await db.execute(
      "UPDATE employee_documents SET status='Verified', verified_by=?, verified_at=NOW(), notes=COALESCE(?,notes) WHERE id=?",
      [req.user.id, notes || null, req.params.docId]
    );
    res.json({ success: true, message: 'Document verified' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Verify failed' });
  }
};

// ── POST /api/documents/:docId/reject ────────────────────
const rejectDocument = async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    if (!rejection_reason?.trim()) return res.status(422).json({ success: false, message: 'Rejection reason required' });
    await db.execute(
      "UPDATE employee_documents SET status='Rejected', verified_by=?, verified_at=NOW(), rejection_reason=? WHERE id=?",
      [req.user.id, rejection_reason, req.params.docId]
    );
    res.json({ success: true, message: 'Document rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Reject failed' });
  }
};

// ── GET /api/documents/:docId/download ───────────────────
const downloadDocument = async (req, res) => {
  try {
    const isAdminHR = ['Admin', 'HR'].includes(req.user.role_name);
    const [[doc]] = await db.execute('SELECT * FROM employee_documents WHERE id = ?', [req.params.docId]);
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

    // Access check
    if (!isAdminHR) {
      const empId = await getEmpId(req.user.id);
      if (!empId || empId !== doc.employee_id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }

    const filePath = path.join(UPLOAD_DIR, doc.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'File not found on server' });

    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.original_name}"`);
    res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Download failed' });
  }
};

// ── DELETE /api/documents/:docId ─────────────────────────
const deleteDocument = async (req, res) => {
  try {
    const [[doc]] = await db.execute('SELECT * FROM employee_documents WHERE id = ?', [req.params.docId]);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    // Delete file
    const filePath = path.join(UPLOAD_DIR, doc.file_path);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});

    await db.execute('DELETE FROM employee_documents WHERE id = ?', [req.params.docId]);
    res.json({ success: true, message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Delete failed' });
  }
};

// ── GET /api/documents/expiring ──────────────────────────
// Documents expiring in the next N days
const getExpiring = async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const [rows] = await db.execute(`
      SELECT ed.*,
             dc.name AS category_name, dc.color,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department,
             DATEDIFF(ed.expiry_date, CURDATE()) AS days_until_expiry
      FROM employee_documents ed
      JOIN document_categories dc ON dc.id = ed.category_id
      JOIN employees e ON e.id = ed.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ed.expiry_date IS NOT NULL
        AND ed.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
        AND ed.expiry_date >= CURDATE()
        AND ed.status = 'Verified'
        AND e.is_active = 1
      ORDER BY ed.expiry_date ASC
      LIMIT 50`, [days]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch expiring documents' });
  }
};

// ── GET /api/documents/stats ──────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[counts]] = await db.execute(`
      SELECT
        SUM(status='Pending')  AS pending,
        SUM(status='Verified') AS verified,
        SUM(status='Rejected') AS rejected,
        SUM(status='Expired')  AS expired,
        COUNT(*)               AS total
      FROM employee_documents
      WHERE YEAR(created_at) = YEAR(NOW())`
    );

    const [[expiringSoon]] = await db.execute(`
      SELECT COUNT(*) AS count FROM employee_documents
      WHERE expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
        AND status = 'Verified'`
    );

    const [byCategory] = await db.execute(`
      SELECT dc.name, dc.color, COUNT(ed.id) AS count
      FROM employee_documents ed
      JOIN document_categories dc ON dc.id = ed.category_id
      WHERE ed.status = 'Verified'
      GROUP BY dc.id ORDER BY count DESC LIMIT 8`
    );

    // Employees with incomplete required docs
    const [[incomplete]] = await db.execute(`
      SELECT COUNT(DISTINCT e.id) AS count
      FROM employees e
      WHERE e.is_active = 1
        AND (SELECT COUNT(DISTINCT ed.category_id)
             FROM employee_documents ed
             JOIN document_categories dc ON dc.id = ed.category_id
             WHERE ed.employee_id = e.id AND dc.is_required = 1 AND ed.status != 'Rejected'
            ) < (SELECT COUNT(*) FROM document_categories WHERE is_required = 1 AND is_active = 1)`
    );

    res.json({ success: true, data: { counts, expiringSoon: expiringSoon.count, byCategory, incompleteChecklists: incomplete.count } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

// ── GET /api/documents/all ────────────────────────────────
// HR view of all employee documents
const getAllDocuments = async (req, res) => {
  try {
    const { status, category_id, department_id, page = 1, limit = 20 } = req.query;
    const conditions = ['1=1'];
    const params     = [];

    if (status)      { conditions.push('ed.status = ?');          params.push(status); }
    if (category_id) { conditions.push('ed.category_id = ?');     params.push(category_id); }
    if (department_id){ conditions.push('e.department_id = ?');   params.push(department_id); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM employee_documents ed JOIN employees e ON e.id = ed.employee_id WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT ed.*,
             dc.name AS category_name, dc.color, dc.icon,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department,
             u.full_name AS verified_by_name,
             CASE WHEN ed.expiry_date < CURDATE() THEN 1 ELSE 0 END AS is_expired,
             DATEDIFF(ed.expiry_date, CURDATE()) AS days_until_expiry
      FROM employee_documents ed
      JOIN document_categories dc ON dc.id = ed.category_id
      JOIN employees e ON e.id = ed.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u ON u.id = ed.verified_by
      WHERE ${where}
      ORDER BY FIELD(ed.status,'Pending','Rejected','Expired','Verified'), ed.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]
    );

    res.json({ success: true, data: rows, meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total)/Number(limit)) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch documents' });
  }
};

// ── Company Documents ─────────────────────────────────────
const getCompanyDocs = async (req, res) => {
  try {
    const isAdminHR = ['Admin','HR'].includes(req.user.role_name);
    const where = isAdminHR ? "WHERE is_active = 1" : "WHERE is_active = 1 AND visible_to IN ('All')";
    const [rows] = await db.execute(
      `SELECT cd.*, u.full_name AS uploaded_by_name FROM company_documents cd LEFT JOIN users u ON u.id = cd.uploaded_by ${where} ORDER BY cd.category, cd.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch company docs' });
  }
};

const uploadCompanyDoc = async (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ success: false, message: 'No file provided' });
    const { title, category, description, version, visible_to } = req.body;

    const [result] = await db.execute(`
      INSERT INTO company_documents (title, category, description, file_path, original_name, file_size, mime_type, version, visible_to, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [title||req.file.originalname, category||'Policy', description||null, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, version||'1.0', visible_to||'All', req.user.id]
    );
    res.status(201).json({ success: true, message: 'Company document uploaded', data: { id: result.insertId } });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
};

const downloadCompanyDoc = async (req, res) => {
  try {
    const [[doc]] = await db.execute('SELECT * FROM company_documents WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    const filePath = path.join(COMPANY_DIR, doc.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'File not found' });

    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.original_name}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Download failed' });
  }
};

module.exports = {
  getCategories,
  getEmployeeDocuments, uploadDocument,
  verifyDocument, rejectDocument, deleteDocument, downloadDocument,
  getExpiring, getStats, getAllDocuments,
  getCompanyDocs, uploadCompanyDoc, downloadCompanyDoc,
};