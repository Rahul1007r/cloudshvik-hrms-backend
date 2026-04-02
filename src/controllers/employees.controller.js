const bcrypt = require('bcryptjs');
const db = require('../config/db');

// ── GET /api/employees ─────────────────────────────────────
// List with search, filter, pagination
const getAll = async (req, res) => {
  try {
    const {
      page = 1, limit = 10,
      search = '', department = '', employment_type = '',
      work_location = '', is_active = '',
      sort = 'e.created_at', order = 'DESC',
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const conditions = ['1=1'];
    const params = [];

    if (search) {
      conditions.push('(e.full_name LIKE ? OR e.email LIKE ? OR e.employee_id LIKE ? OR e.phone LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (department)       { conditions.push('e.department_id = ?');   params.push(department); }
    if (employment_type)  { conditions.push('e.employment_type = ?'); params.push(employment_type); }
    if (work_location)    { conditions.push('e.work_location = ?');   params.push(work_location); }
    if (is_active !== '') { conditions.push('e.is_active = ?');       params.push(is_active === 'true' ? 1 : 0); }

    const where = conditions.join(' AND ');
    const safeSort  = ['e.full_name','e.created_at','e.joining_date','e.employee_id'].includes(sort) ? sort : 'e.created_at';
    const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM employees e WHERE ${where}`,
      params
    );

    const [rows] = await db.execute(
      `SELECT e.id, e.employee_id, e.full_name, e.email, e.phone,
              e.gender, e.employment_type, e.work_location, e.joining_date,
              e.avatar_url, e.is_active, e.created_at,
              d.name AS department,   d.id AS department_id,
              des.name AS designation, des.id AS designation_id,
              CONCAT(m.full_name) AS manager_name
       FROM employees e
       LEFT JOIN departments  d   ON d.id  = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN employees    m   ON m.id  = e.manager_id
       WHERE ${where}
       ORDER BY ${safeSort} ${safeOrder}
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    res.json({
      success: true,
      data: rows,
      meta: {
        total: Number(total),
        page:  Number(page),
        limit: Number(limit),
        pages: Math.ceil(Number(total) / Number(limit)),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch employees' });
  }
};

// ── GET /api/employees/:id ─────────────────────────────────
const getById = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT e.*,
              d.name   AS department_name,
              des.name AS designation_name,
              m.full_name    AS manager_name,
              m.employee_id  AS manager_emp_id,
              m.avatar_url   AS manager_avatar
       FROM employees e
       LEFT JOIN departments  d   ON d.id  = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN employees    m   ON m.id  = e.manager_id
       WHERE e.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch employee' });
  }
};

// ── POST /api/employees ────────────────────────────────────
const create = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      employee_id, full_name, email, phone, gender, date_of_birth, blood_group,
      address, city, state, pincode,
      department_id, designation_id, manager_id, employment_type,
      joining_date, work_location,
      bank_name, account_number, ifsc_code, pan_number,
      emergency_contact_name, emergency_contact_phone,
      // User account creation
      create_user_account = false, role_id = 4, password = 'Hrms@1234',
    } = req.body;

    // Check duplicate email
    const [dupEmail] = await conn.execute('SELECT id FROM employees WHERE email = ?', [email]);
    if (dupEmail.length) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Email already exists' });
    }

    // Auto-generate employee_id if not provided
    let empId = employee_id;
    if (!empId) {
      const [[{ maxId }]] = await conn.execute("SELECT MAX(CAST(SUBSTRING(employee_id, 4) AS UNSIGNED)) AS maxId FROM employees WHERE employee_id LIKE 'EMP%'");
      empId = `EMP${String((maxId || 0) + 1).padStart(3, '0')}`;
    }

    // Check duplicate employee_id
    const [dupEmpId] = await conn.execute('SELECT id FROM employees WHERE employee_id = ?', [empId]);
    if (dupEmpId.length) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Employee ID already exists' });
    }

    // Create user account if requested
    let userId = null;
    if (create_user_account) {
      const hash = await bcrypt.hash(password, 12);
      const [userRes] = await conn.execute(
        `INSERT INTO users (employee_id, full_name, email, password_hash, role_id)
         VALUES (?, ?, ?, ?, ?)`,
        [empId, full_name, email, hash, role_id]
      );
      userId = userRes.insertId;
    }

    const [result] = await conn.execute(
      `INSERT INTO employees
         (user_id, employee_id, full_name, email, phone, gender, date_of_birth, blood_group,
          address, city, state, pincode,
          department_id, designation_id, manager_id, employment_type,
          joining_date, work_location,
          bank_name, account_number, ifsc_code, pan_number,
          emergency_contact_name, emergency_contact_phone)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId, empId, full_name, email, phone || null, gender || null,
        date_of_birth || null, blood_group || null,
        address || null, city || null, state || null, pincode || null,
        department_id || null, designation_id || null, manager_id || null,
        employment_type || 'Full-Time', joining_date || null,
        work_location || 'Office',
        bank_name || null, account_number || null, ifsc_code || null, pan_number || null,
        emergency_contact_name || null, emergency_contact_phone || null,
      ]
    );

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `CREATE_EMPLOYEE:${empId}`, 'employees', req.ip]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      message: `Employee ${empId} created successfully`,
      data: { id: result.insertId, employee_id: empId },
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create employee' });
  } finally {
    conn.release();
  }
};

// ── PUT /api/employees/:id ────────────────────────────────
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      full_name, phone, gender, date_of_birth, blood_group,
      address, city, state, pincode,
      department_id, designation_id, manager_id, employment_type,
      joining_date, work_location,
      bank_name, account_number, ifsc_code, pan_number,
      emergency_contact_name, emergency_contact_phone,
    } = req.body;

    const [existing] = await db.execute('SELECT id FROM employees WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ success: false, message: 'Employee not found' });

    await db.execute(
      `UPDATE employees SET
         full_name=?, phone=?, gender=?, date_of_birth=?, blood_group=?,
         address=?, city=?, state=?, pincode=?,
         department_id=?, designation_id=?, manager_id=?, employment_type=?,
         joining_date=?, work_location=?,
         bank_name=?, account_number=?, ifsc_code=?, pan_number=?,
         emergency_contact_name=?, emergency_contact_phone=?
       WHERE id=?`,
      [
        full_name, phone || null, gender || null, date_of_birth || null, blood_group || null,
        address || null, city || null, state || null, pincode || null,
        department_id || null, designation_id || null, manager_id || null,
        employment_type || 'Full-Time', joining_date || null, work_location || 'Office',
        bank_name || null, account_number || null, ifsc_code || null, pan_number || null,
        emergency_contact_name || null, emergency_contact_phone || null,
        id,
      ]
    );

    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `UPDATE_EMPLOYEE:${id}`, 'employees', req.ip]
    );

    res.json({ success: true, message: 'Employee updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to update employee' });
  }
};

// ── PATCH /api/employees/:id/toggle-status ────────────────
const toggleStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const [[emp]] = await db.execute('SELECT id, is_active, full_name FROM employees WHERE id = ?', [id]);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const newStatus = emp.is_active ? 0 : 1;
    await db.execute('UPDATE employees SET is_active = ? WHERE id = ?', [newStatus, id]);
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `${newStatus ? 'ACTIVATE' : 'DEACTIVATE'}_EMPLOYEE:${id}`, 'employees', req.ip]
    );

    res.json({ success: true, message: `Employee ${newStatus ? 'activated' : 'deactivated'}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Status update failed' });
  }
};

// ── DELETE /api/employees/:id ─────────────────────────────
const remove = async (req, res) => {
  try {
    const { id } = req.params;
    const [[emp]] = await db.execute('SELECT id, employee_id FROM employees WHERE id = ?', [id]);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    // Soft delete
    await db.execute('UPDATE employees SET is_active = 0 WHERE id = ?', [id]);
    await db.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?, ?, ?, ?)',
      [req.user.id, `DELETE_EMPLOYEE:${emp.employee_id}`, 'employees', req.ip]
    );

    res.json({ success: true, message: 'Employee removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Delete failed' });
  }
};

// ── GET /api/employees/meta/options ───────────────────────
// Departments, designations, managers for form dropdowns
const getFormOptions = async (req, res) => {
  try {
    const [departments]  = await db.execute('SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name');
    const [designations] = await db.execute(
      'SELECT id, name, department_id, level FROM designations WHERE is_active = 1 ORDER BY name'
    );
    const [managers] = await db.execute(
      `SELECT id, full_name, employee_id, department_id FROM employees
       WHERE is_active = 1 ORDER BY full_name`
    );
    const [roles] = await db.execute('SELECT id, name FROM roles ORDER BY id');

    res.json({ success: true, data: { departments, designations, managers, roles } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch options' });
  }
};

// ── GET /api/employees/meta/stats ─────────────────────────
const getStats = async (req, res) => {
  try {
    const [[total]]      = await db.execute('SELECT COUNT(*) AS v FROM employees WHERE is_active = 1');
    const [[newMonth]]   = await db.execute("SELECT COUNT(*) AS v FROM employees WHERE is_active=1 AND joining_date >= DATE_FORMAT(NOW(),'%Y-%m-01')");
    const [[inactive]]   = await db.execute('SELECT COUNT(*) AS v FROM employees WHERE is_active = 0');
    const [[fullTime]]   = await db.execute("SELECT COUNT(*) AS v FROM employees WHERE is_active=1 AND employment_type='Full-Time'");

    const [byDept] = await db.execute(
      `SELECT d.name, COUNT(e.id) AS count
       FROM departments d LEFT JOIN employees e ON e.department_id=d.id AND e.is_active=1
       WHERE d.is_active=1 GROUP BY d.id ORDER BY count DESC LIMIT 5`
    );
    const [byType] = await db.execute(
      `SELECT employment_type AS type, COUNT(*) AS count FROM employees WHERE is_active=1 GROUP BY employment_type`
    );

    res.json({
      success: true,
      data: {
        total:     Number(total.v),
        newMonth:  Number(newMonth.v),
        inactive:  Number(inactive.v),
        fullTime:  Number(fullTime.v),
        byDept, byType,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

module.exports = { getAll, getById, create, update, toggleStatus, remove, getFormOptions, getStats };