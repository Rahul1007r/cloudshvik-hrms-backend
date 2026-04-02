const db = require('../config/db');

// ── GET /api/departments ───────────────────────────────────
const getAll = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT d.*,
             COUNT(DISTINCT e.id)       AS employee_count,
             COUNT(DISTINCT des.id)     AS designation_count,
             m.full_name                AS manager_name,
             m.employee_id              AS manager_emp_id,
             m.avatar_url               AS manager_avatar
      FROM departments d
      LEFT JOIN employees    e   ON e.department_id = d.id AND e.is_active = 1
      LEFT JOIN designations des ON des.department_id = d.id AND des.is_active = 1
      LEFT JOIN employees    m   ON m.id = d.manager_id
      WHERE d.is_active = 1
      GROUP BY d.id
      ORDER BY d.name ASC
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch departments' });
  }
};

// ── GET /api/departments/:id ───────────────────────────────
const getById = async (req, res) => {
  try {
    const [depts] = await db.execute(`
      SELECT d.*, m.full_name AS manager_name, m.employee_id AS manager_emp_id
      FROM departments d
      LEFT JOIN employees m ON m.id = d.manager_id
      WHERE d.id = ?`, [req.params.id]
    );
    if (!depts.length) return res.status(404).json({ success: false, message: 'Department not found' });

    const [designations] = await db.execute(
      `SELECT des.*, COUNT(e.id) AS employee_count
       FROM designations des
       LEFT JOIN employees e ON e.designation_id = des.id AND e.is_active = 1
       WHERE des.department_id = ? AND des.is_active = 1
       GROUP BY des.id ORDER BY des.level, des.name`,
      [req.params.id]
    );

    const [employees] = await db.execute(
      `SELECT e.id, e.employee_id AS emp_code, e.full_name, e.avatar_url,
              des.name AS designation_name
       FROM employees e
       LEFT JOIN designations des ON des.id = e.designation_id
       WHERE e.department_id = ? AND e.is_active = 1
       ORDER BY e.full_name
       LIMIT 20`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...depts[0], designations, employees } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch department' });
  }
};

// ── POST /api/departments ──────────────────────────────────
const create = async (req, res) => {
  try {
    const { name, description, manager_id } = req.body;

    const [dup] = await db.execute('SELECT id FROM departments WHERE name = ?', [name]);
    if (dup.length) return res.status(409).json({ success: false, message: 'Department name already exists' });

    const [result] = await db.execute(
      'INSERT INTO departments (name, description, manager_id) VALUES (?, ?, ?)',
      [name.trim(), description?.trim() || null, manager_id || null]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `CREATE_DEPT:${name}`, 'departments', req.ip]
    );

    res.status(201).json({ success: true, message: 'Department created', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create department' });
  }
};

// ── PUT /api/departments/:id ───────────────────────────────
const update = async (req, res) => {
  try {
    const { name, description, manager_id } = req.body;
    const { id } = req.params;

    const [dup] = await db.execute(
      'SELECT id FROM departments WHERE name = ? AND id != ?', [name, id]
    );
    if (dup.length) return res.status(409).json({ success: false, message: 'Department name already exists' });

    await db.execute(
      'UPDATE departments SET name = ?, description = ?, manager_id = ? WHERE id = ?',
      [name.trim(), description?.trim() || null, manager_id || null, id]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `UPDATE_DEPT:${name}`, 'departments', req.ip]
    );

    res.json({ success: true, message: 'Department updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to update department' });
  }
};

// ── DELETE /api/departments/:id ────────────────────────────
const remove = async (req, res) => {
  try {
    const { id } = req.params;

    const [[emp]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM employees WHERE department_id = ? AND is_active = 1', [id]
    );
    if (emp.cnt > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete: ${emp.cnt} active employee(s) in this department`,
      });
    }

    await db.execute('UPDATE departments SET is_active = 0 WHERE id = ?', [id]);
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `DELETE_DEPT:${id}`, 'departments', req.ip]
    );

    res.json({ success: true, message: 'Department removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to delete department' });
  }
};

// ── GET /api/departments/stats ─────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[totals]] = await db.execute(`
      SELECT
        COUNT(DISTINCT d.id)   AS total_depts,
        COUNT(DISTINCT des.id) AS total_designations,
        COUNT(DISTINCT e.id)   AS total_employees
      FROM departments d
      LEFT JOIN designations des ON des.department_id = d.id AND des.is_active = 1
      LEFT JOIN employees    e   ON e.department_id   = d.id AND e.is_active = 1
      WHERE d.is_active = 1
    `);
    res.json({ success: true, data: totals });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

module.exports = { getAll, getById, create, update, remove, getStats };