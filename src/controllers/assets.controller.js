const db = require('../config/db');

// ── helpers ───────────────────────────────────────────────
const genAssetCode = async (conn) => {
  const [[{ max_id }]] = await conn.execute(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(asset_code,4) AS UNSIGNED)),0) AS max_id FROM assets WHERE asset_code LIKE 'AST%'"
  );
  return `AST${String(Number(max_id) + 1).padStart(5, '0')}`;
};

// ── GET /api/assets/stats ─────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[counts]] = await db.execute(`
      SELECT
        COUNT(*)                              AS total,
        SUM(status = 'Available')             AS available,
        SUM(status = 'Assigned')              AS assigned,
        SUM(status = 'Under Maintenance')     AS maintenance,
        SUM(status = 'Retired')               AS retired,
        SUM(status = 'Lost')                  AS lost,
        SUM(purchase_price)                   AS total_value,
        SUM(warranty_expiry < CURDATE() AND warranty_expiry IS NOT NULL) AS warranty_expired,
        SUM(warranty_expiry BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS warranty_expiring
      FROM assets`);

    const [byCategory] = await db.execute(`
      SELECT ac.name, ac.color,
             COUNT(a.id)        AS total,
             SUM(a.status='Available') AS available,
             SUM(a.status='Assigned')  AS assigned
      FROM asset_categories ac
      LEFT JOIN assets a ON a.category_id = ac.id
      WHERE ac.is_active = 1
      GROUP BY ac.id ORDER BY total DESC LIMIT 8`);

    const [recentAssignments] = await db.execute(`
      SELECT aa.*, a.name AS asset_name, a.asset_code,
             ac.name AS category_name, ac.color,
             e.full_name, e.employee_id AS emp_code
      FROM asset_assignments aa
      JOIN assets a ON a.id = aa.asset_id
      JOIN asset_categories ac ON ac.id = a.category_id
      JOIN employees e ON e.id = aa.employee_id
      WHERE aa.is_active = 1
      ORDER BY aa.created_at DESC LIMIT 5`);

    res.json({ success: true, data: { counts, byCategory, recentAssignments } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

// ── GET /api/assets ───────────────────────────────────────
const getAll = async (req, res) => {
  try {
    const { status, category_id, search, page = 1, limit = 16 } = req.query;
    const conditions = ['1=1']; const params = [];

    if (status)      { conditions.push('a.status = ?');      params.push(status); }
    if (category_id) { conditions.push('a.category_id = ?'); params.push(category_id); }
    if (search?.trim()) {
      conditions.push('(a.name LIKE ? OR a.asset_code LIKE ? OR a.serial_number LIKE ? OR a.brand LIKE ?)');
      const s = `%${search.trim()}%`;
      params.push(s, s, s, s);
    }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM assets a WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT a.*,
             ac.name AS category_name, ac.color, ac.icon,
             e.full_name AS assigned_emp_name,
             e.employee_id AS assigned_emp_code,
             d.name AS assigned_dept
      FROM assets a
      JOIN asset_categories ac ON ac.id = a.category_id
      LEFT JOIN employees e ON e.id = a.assigned_to
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ${where}
      ORDER BY FIELD(a.status,'Available','Assigned','Under Maintenance','Retired','Lost'), a.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total) / Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch assets' });
  }
};

// ── GET /api/assets/:id ───────────────────────────────────
const getOne = async (req, res) => {
  try {
    const [[asset]] = await db.execute(`
      SELECT a.*,
             ac.name AS category_name, ac.color, ac.icon,
             e.full_name AS assigned_emp_name,
             e.employee_id AS assigned_emp_code,
             d.name AS assigned_dept,
             u.full_name AS created_by_name
      FROM assets a
      JOIN asset_categories ac ON ac.id = a.category_id
      LEFT JOIN employees e ON e.id = a.assigned_to
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u ON u.id = a.created_by
      WHERE a.id = ?`, [req.params.id]);

    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });

    const [history] = await db.execute(`
      SELECT aa.*,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department,
             u1.full_name AS assigned_by_name,
             u2.full_name AS returned_by_name
      FROM asset_assignments aa
      JOIN employees e ON e.id = aa.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u1 ON u1.id = aa.assigned_by
      LEFT JOIN users u2 ON u2.id = aa.returned_by
      WHERE aa.asset_id = ?
      ORDER BY aa.created_at DESC`, [req.params.id]);

    const [maintenance] = await db.execute(
      'SELECT * FROM asset_maintenance WHERE asset_id = ? ORDER BY start_date DESC', [req.params.id]
    );

    res.json({ success: true, data: { ...asset, history, maintenance } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch asset' });
  }
};

// ── POST /api/assets ──────────────────────────────────────
const create = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      name, category_id, brand, model, serial_number,
      purchase_date, purchase_price, vendor, warranty_expiry,
      location, description, condition_grade,
    } = req.body;

    const asset_code = await genAssetCode(conn);

    const [result] = await conn.execute(`
      INSERT INTO assets
        (asset_code, name, category_id, brand, model, serial_number,
         purchase_date, purchase_price, vendor, warranty_expiry,
         location, description, condition_grade, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [asset_code, name.trim(), category_id, brand||null, model||null, serial_number||null,
       purchase_date||null, purchase_price||0, vendor||null, warranty_expiry||null,
       location||null, description||null, condition_grade||'Good', req.user.id]);

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_ASSET:${asset_code}`, 'assets', req.ip]
    );

    await conn.commit();
    res.status(201).json({ success: true, message: `Asset ${asset_code} created`, data: { id: result.insertId, asset_code } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create asset' });
  } finally { conn.release(); }
};

// ── PUT /api/assets/:id ───────────────────────────────────
const update = async (req, res) => {
  try {
    const {
      name, category_id, brand, model, serial_number,
      purchase_date, purchase_price, vendor, warranty_expiry,
      location, description, condition_grade, status, notes,
    } = req.body;

    await db.execute(`
      UPDATE assets SET
        name=?, category_id=?, brand=?, model=?, serial_number=?,
        purchase_date=?, purchase_price=?, vendor=?, warranty_expiry=?,
        location=?, description=?, condition_grade=?, status=?, notes=?
      WHERE id=?`,
      [name.trim(), category_id, brand||null, model||null, serial_number||null,
       purchase_date||null, purchase_price||0, vendor||null, warranty_expiry||null,
       location||null, description||null, condition_grade||'Good', status||'Available',
       notes||null, req.params.id]);

    res.json({ success: true, message: 'Asset updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// ── POST /api/assets/:id/assign ───────────────────────────
const assign = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { employee_id, assigned_date, return_date, purpose, condition_out, notes } = req.body;

    const [[asset]] = await conn.execute('SELECT * FROM assets WHERE id = ?', [req.params.id]);
    if (!asset) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Asset not found' }); }
    if (asset.status === 'Assigned') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Asset is already assigned' }); }
    if (!['Available','Retired','Lost'].includes(asset.status) === false && asset.status !== 'Available') {
      // Only allow assigning Available assets (soft check)
    }

    // Close any open assignment
    await conn.execute(
      "UPDATE asset_assignments SET is_active = 0 WHERE asset_id = ? AND is_active = 1",
      [req.params.id]
    );

    // Create new assignment record
    const [result] = await conn.execute(`
      INSERT INTO asset_assignments
        (asset_id, employee_id, assigned_date, return_date, purpose, condition_out, notes, assigned_by)
      VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, employee_id, assigned_date || new Date().toISOString().slice(0,10),
       return_date||null, purpose||null, condition_out||asset.condition_grade, notes||null, req.user.id]);

    // Update asset
    await conn.execute(
      "UPDATE assets SET status='Assigned', assigned_to=?, assigned_date=?, return_date=?, condition_grade=? WHERE id=?",
      [employee_id, assigned_date||new Date().toISOString().slice(0,10), return_date||null, condition_out||asset.condition_grade, req.params.id]
    );

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `ASSIGN_ASSET:${asset.asset_code}:emp${employee_id}`, 'assets', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: 'Asset assigned successfully', data: { assignment_id: result.insertId } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Assignment failed' });
  } finally { conn.release(); }
};

// ── POST /api/assets/:id/return ───────────────────────────
const returnAsset = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { condition_in, notes, returned_date } = req.body;

    const [[asset]] = await conn.execute('SELECT * FROM assets WHERE id = ?', [req.params.id]);
    if (!asset) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Asset not found' }); }
    if (asset.status !== 'Assigned') { await conn.rollback(); return res.status(400).json({ success: false, message: 'Asset is not currently assigned' }); }

    const retDate = returned_date || new Date().toISOString().slice(0,10);

    // Close assignment
    await conn.execute(`
      UPDATE asset_assignments
      SET returned_date=?, condition_in=?, notes=COALESCE(?,notes), is_active=0, returned_by=?
      WHERE asset_id=? AND is_active=1`,
      [retDate, condition_in||asset.condition_grade, notes||null, req.user.id, req.params.id]);

    // Update asset
    await conn.execute(`
      UPDATE assets SET status='Available', assigned_to=NULL, assigned_date=NULL, return_date=NULL,
      condition_grade=?, notes=COALESCE(?,notes) WHERE id=?`,
      [condition_in||asset.condition_grade, notes||null, req.params.id]);

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `RETURN_ASSET:${asset.asset_code}`, 'assets', req.ip]
    );

    await conn.commit();
    res.json({ success: true, message: 'Asset returned successfully' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Return failed' });
  } finally { conn.release(); }
};

// ── POST /api/assets/:id/maintenance ─────────────────────
const addMaintenance = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { maintenance_type, description, cost, vendor, start_date, end_date, performed_by, notes } = req.body;

    const [result] = await conn.execute(`
      INSERT INTO asset_maintenance
        (asset_id, maintenance_type, description, cost, vendor, start_date, end_date, performed_by, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, maintenance_type||'Service', description, cost||0, vendor||null,
       start_date, end_date||null, performed_by||null, notes||null, req.user.id]);

    // Set asset to Under Maintenance if status is started
    const [[asset]] = await conn.execute('SELECT status FROM assets WHERE id=?', [req.params.id]);
    if (asset?.status === 'Available' || asset?.status === 'Assigned') {
      await conn.execute(
        "UPDATE assets SET status='Under Maintenance' WHERE id=?", [req.params.id]
      );
    }

    await conn.commit();
    res.status(201).json({ success: true, message: 'Maintenance record added', data: { id: result.insertId } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to add maintenance' });
  } finally { conn.release(); }
};

// ── PATCH /api/assets/maintenance/:mainId/complete ───────
const completeMaintenance = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { end_date, notes, condition_grade } = req.body;

    const [[maint]] = await conn.execute('SELECT * FROM asset_maintenance WHERE id=?', [req.params.mainId]);
    if (!maint) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Not found' }); }

    await conn.execute(
      "UPDATE asset_maintenance SET status='Completed', end_date=COALESCE(?,end_date), notes=COALESCE(?,notes) WHERE id=?",
      [end_date||null, notes||null, req.params.mainId]
    );

    // Set asset back to Available
    await conn.execute(
      "UPDATE assets SET status='Available', condition_grade=COALESCE(?,condition_grade) WHERE id=?",
      [condition_grade||null, maint.asset_id]
    );

    await conn.commit();
    res.json({ success: true, message: 'Maintenance completed — asset set to Available' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Failed' });
  } finally { conn.release(); }
};

// ── GET /api/assets/categories ────────────────────────────
const getCategories = async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM asset_categories WHERE is_active = 1 ORDER BY name'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

// ── GET /api/assets/employee/:empId ──────────────────────
const getEmployeeAssets = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT a.*,
             ac.name AS category_name, ac.color, ac.icon,
             aa.assigned_date, aa.return_date, aa.purpose
      FROM assets a
      JOIN asset_categories ac ON ac.id = a.category_id
      LEFT JOIN asset_assignments aa ON aa.asset_id = a.id AND aa.is_active = 1
      WHERE a.assigned_to = ?
      ORDER BY aa.assigned_date DESC`, [req.params.empId]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

// ── GET /api/assets/my-assets ─────────────────────────────
const getMyAssets = async (req, res) => {
  try {
    const [[emp]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const [rows] = await db.execute(`
      SELECT a.*,
             ac.name AS category_name, ac.color, ac.icon,
             aa.assigned_date, aa.return_date, aa.purpose, aa.condition_out
      FROM assets a
      JOIN asset_categories ac ON ac.id = a.category_id
      LEFT JOIN asset_assignments aa ON aa.asset_id = a.id AND aa.is_active = 1
      WHERE a.assigned_to = ?
      ORDER BY aa.assigned_date DESC`, [emp.id]);

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

module.exports = {
  getStats, getAll, getOne, create, update,
  assign, returnAsset, addMaintenance, completeMaintenance,
  getCategories, getEmployeeAssets, getMyAssets,
};