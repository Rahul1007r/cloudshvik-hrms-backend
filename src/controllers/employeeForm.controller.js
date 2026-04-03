const bcrypt = require('bcryptjs');
const db = require('../config/db');

// ── GET /api/employees/form-meta ──────────────────────────
// All dropdown data needed for the employee form
const getFormMeta = async (req, res) => {
  try {
    const [departments]  = await db.execute('SELECT id, name FROM departments  WHERE is_active=1 ORDER BY name');
    const [designations] = await db.execute('SELECT id, name, department_id, level FROM designations WHERE is_active=1 ORDER BY name');
    const [managers]     = await db.execute(
      `SELECT id, full_name, employee_id, department_id FROM employees WHERE is_active=1 ORDER BY full_name`
    );
    const [roles]        = await db.execute('SELECT id, name FROM roles ORDER BY id');

    // Next auto employee ID
    const [[maxRow]] = await db.execute(
      "SELECT MAX(CAST(SUBSTRING(employee_id, 4) AS UNSIGNED)) AS maxId FROM employees WHERE employee_id LIKE 'EMP%'"
    );
    const nextId = `EMP${String((maxRow.maxId || 0) + 1).padStart(3, '0')}`;

    res.json({ success: true, data: { departments, designations, managers, roles, nextId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch form meta' });
  }
};

// ── GET /api/employees/:id/full ───────────────────────────
// Full employee record for the edit form
const getEmployeeForEdit = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT e.*,
              d.name AS department_name, des.name AS designation_name,
              m.full_name AS manager_name
       FROM employees e
       LEFT JOIN departments  d   ON d.id  = e.department_id
       LEFT JOIN designations des ON des.id = e.designation_id
       LEFT JOIN employees    m   ON m.id  = e.manager_id
       WHERE e.id = ?`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch employee' });
  }
};

// ── POST /api/employees ────────────────────────────────────
const createEmployee = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      // Personal
      full_name, email, phone, gender, date_of_birth, blood_group,
      address, city, state, pincode,
      // Employment
      employee_id: customId, department_id, designation_id, manager_id,
      employment_type, joining_date, work_location,
      // Bank
      bank_name, account_number, ifsc_code, pan_number,
      // Emergency
      emergency_contact_name, emergency_contact_phone,
      // Account
      create_account, role_id, password,
    } = req.body;

    // Duplicate email check
    const [dupEmail] = await conn.execute('SELECT id FROM employees WHERE email=?', [email]);
    if (dupEmail.length) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Auto generate or validate employee_id
    let empId = customId?.trim();
    if (!empId) {
      const [[m]] = await conn.execute(
        "SELECT MAX(CAST(SUBSTRING(employee_id,4) AS UNSIGNED)) AS n FROM employees WHERE employee_id LIKE 'EMP%'"
      );
      empId = `EMP${String((m.n || 0) + 1).padStart(3, '0')}`;
    } else {
      const [dup] = await conn.execute('SELECT id FROM employees WHERE employee_id=?', [empId]);
      if (dup.length) {
        await conn.rollback();
        return res.status(409).json({ success: false, message: `Employee ID ${empId} already exists` });
      }
    }

    // Optionally create user account
    let userId = null;
    if (create_account) {
      const hash = await bcrypt.hash(password || 'Hrms@1234', 12);
      const [ur] = await conn.execute(
        'INSERT INTO users (employee_id, full_name, email, password_hash, role_id) VALUES (?,?,?,?,?)',
        [empId, full_name, email, hash, role_id || 4]
      );
      userId = ur.insertId;
    }

    const [result] = await conn.execute(
      `INSERT INTO employees
         (user_id, employee_id, full_name, email, phone, gender, date_of_birth, blood_group,
          address, city, state, pincode,
          department_id, designation_id, manager_id, employment_type, joining_date, work_location,
          bank_name, account_number, ifsc_code, pan_number,
          emergency_contact_name, emergency_contact_phone)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId, empId, full_name, email,
        phone||null, gender||null, date_of_birth||null, blood_group||null,
        address||null, city||null, state||null, pincode||null,
        department_id||null, designation_id||null, manager_id||null,
        employment_type||'Full-Time', joining_date||null, work_location||'Office',
        bank_name||null, account_number||null, ifsc_code||null, pan_number||null,
        emergency_contact_name||null, emergency_contact_phone||null,
      ]
    );

    // Auto-allocate leave balance for current year
    const year = new Date().getFullYear();
    const [leaveTypes] = await conn.execute(
      'SELECT id, max_days FROM leave_types WHERE is_active=1 AND max_days > 0'
    ).catch(() => [[]]);

    for (const lt of leaveTypes) {
      await conn.execute(
        `INSERT IGNORE INTO leave_balance (employee_id, leave_type_id, year, total_days)
         VALUES (?,?,?,?)`, [result.insertId, lt.id, year, lt.max_days]
      ).catch(() => {});
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_EMP:${empId}`, 'employees', req.ip]
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
const updateEmployee = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const {
      full_name, phone, gender, date_of_birth, blood_group,
      address, city, state, pincode,
      department_id, designation_id, manager_id,
      employment_type, joining_date, work_location,
      bank_name, account_number, ifsc_code, pan_number,
      emergency_contact_name, emergency_contact_phone,
    } = req.body;

    const [[existing]] = await conn.execute('SELECT id FROM employees WHERE id=?', [id]);
    if (!existing) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    await conn.execute(
      `UPDATE employees SET
         full_name=?, phone=?, gender=?, date_of_birth=?, blood_group=?,
         address=?, city=?, state=?, pincode=?,
         department_id=?, designation_id=?, manager_id=?,
         employment_type=?, joining_date=?, work_location=?,
         bank_name=?, account_number=?, ifsc_code=?, pan_number=?,
         emergency_contact_name=?, emergency_contact_phone=?
       WHERE id=?`,
      [
        full_name, phone||null, gender||null, date_of_birth||null, blood_group||null,
        address||null, city||null, state||null, pincode||null,
        department_id||null, designation_id||null, manager_id||null,
        employment_type||'Full-Time', joining_date||null, work_location||'Office',
        bank_name||null, account_number||null, ifsc_code||null, pan_number||null,
        emergency_contact_name||null, emergency_contact_phone||null,
        id,
      ]
    );

    // Sync user account name/email if linked
    await conn.execute(
      'UPDATE users u JOIN employees e ON e.user_id=u.id SET u.full_name=? WHERE e.id=?',
      [full_name, id]
    ).catch(() => {});

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `UPDATE_EMP:${id}`, 'employees', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: 'Employee updated successfully' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to update employee' });
  } finally {
    conn.release();
  }
};

// ── POST /api/employees/:id/check-email ───────────────────
const checkEmail = async (req, res) => {
  try {
    const { email, exclude_id } = req.body;
    const [rows] = await db.execute(
      'SELECT id FROM employees WHERE email=? AND id != ?',
      [email, exclude_id || 0]
    );
    res.json({ success: true, available: rows.length === 0 });
  } catch {
    res.status(500).json({ success: false, message: 'Check failed' });
  }
};

module.exports = { getFormMeta, getEmployeeForEdit, createEmployee, updateEmployee, checkEmail };