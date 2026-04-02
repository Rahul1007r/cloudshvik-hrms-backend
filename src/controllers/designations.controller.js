const db = require('../config/db');

const VALID_LEVELS = ['Junior','Mid','Senior','Lead','Manager','Director','C-Level'];

// ── GET /api/designations ──────────────────────────────────
const getAll = async (req, res) => {
  try {
    const { department_id } = req.query;
    const conditions = ['des.is_active = 1'];
    const params = [];

    if (department_id) {
      conditions.push('des.department_id = ?');
      params.push(department_id);
    }

    const [rows] = await db.execute(`
      SELECT des.*,
             d.name AS department_name,
             COUNT(e.id) AS employee_count
      FROM designations des
      LEFT JOIN departments d ON d.id = des.department_id
      LEFT JOIN employees   e ON e.designation_id = des.id AND e.is_active = 1
      WHERE ${conditions.join(' AND ')}
      GROUP BY des.id
      ORDER BY d.name, des.level, des.name
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch designations' });
  }
};

// ── GET /api/designations/:id ──────────────────────────────
const getById = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT des.*, d.name AS department_name
      FROM designations des
      LEFT JOIN departments d ON d.id = des.department_id
      WHERE des.id = ?`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Designation not found' });

    const [employees] = await db.execute(
      `SELECT e.id, e.full_name, e.employee_id AS emp_code, e.avatar_url
       FROM employees e WHERE e.designation_id = ? AND e.is_active = 1
       ORDER BY e.full_name LIMIT 10`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...rows[0], employees } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch designation' });
  }
};

// ── POST /api/designations ────────────────────────────────
const create = async (req, res) => {
  try {
    const { name, department_id, level } = req.body;

    if (!VALID_LEVELS.includes(level)) {
      return res.status(422).json({ success: false, message: 'Invalid level' });
    }

    const [dup] = await db.execute(
      'SELECT id FROM designations WHERE name = ? AND department_id = ?',
      [name, department_id]
    );
    if (dup.length) {
      return res.status(409).json({ success: false, message: 'Designation already exists in this department' });
    }

    const [result] = await db.execute(
      'INSERT INTO designations (name, department_id, level) VALUES (?, ?, ?)',
      [name.trim(), department_id, level]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `CREATE_DESIG:${name}`, 'departments', req.ip]
    );

    res.status(201).json({ success: true, message: 'Designation created', data: { id: result.insertId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create designation' });
  }
};

// ── PUT /api/designations/:id ─────────────────────────────
const update = async (req, res) => {
  try {
    const { name, department_id, level } = req.body;
    const { id } = req.params;

    const [dup] = await db.execute(
      'SELECT id FROM designations WHERE name = ? AND department_id = ? AND id != ?',
      [name, department_id, id]
    );
    if (dup.length) {
      return res.status(409).json({ success: false, message: 'Designation already exists in this department' });
    }

    await db.execute(
      'UPDATE designations SET name = ?, department_id = ?, level = ? WHERE id = ?',
      [name.trim(), department_id, level, id]
    );

    res.json({ success: true, message: 'Designation updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update designation' });
  }
};

// ── DELETE /api/designations/:id ──────────────────────────
const remove = async (req, res) => {
  try {
    const { id } = req.params;

    const [[emp]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM employees WHERE designation_id = ? AND is_active = 1', [id]
    );
    if (emp.cnt > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete: ${emp.cnt} employee(s) hold this designation`,
      });
    }

    await db.execute('UPDATE designations SET is_active = 0 WHERE id = ?', [id]);
    res.json({ success: true, message: 'Designation removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete designation' });
  }
};

module.exports = { getAll, getById, create, update, remove };