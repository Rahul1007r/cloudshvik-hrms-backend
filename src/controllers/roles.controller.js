const db = require('../config/db');

// ── GET /api/roles ─────────────────────────────────────────
const getAllRoles = async (req, res) => {
  try {
    const [roles] = await db.execute(`
      SELECT r.id, r.name, r.description, r.created_at,
             COUNT(DISTINCT rp.permission_id) AS permission_count,
             COUNT(DISTINCT u.id)             AS user_count
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN users u             ON u.role_id  = r.id AND u.is_active = 1
      GROUP BY r.id
      ORDER BY r.id
    `);
    res.json({ success: true, data: roles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch roles' });
  }
};

// ── GET /api/roles/:id ────────────────────────────────────
const getRoleById = async (req, res) => {
  try {
    const { id } = req.params;
    const [roles] = await db.execute('SELECT * FROM roles WHERE id = ?', [id]);
    if (!roles.length) return res.status(404).json({ success: false, message: 'Role not found' });

    const [permissions] = await db.execute(`
      SELECT p.id, p.module, p.action, p.description
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ?
    `, [id]);

    res.json({ success: true, data: { ...roles[0], permissions } });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch role' });
  }
};

// ── POST /api/roles ───────────────────────────────────────
const createRole = async (req, res) => {
  try {
    const { name, description, permissionIds = [] } = req.body;

    const [existing] = await db.execute('SELECT id FROM roles WHERE name = ?', [name]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'Role name already exists' });
    }

    const [result] = await db.execute(
      'INSERT INTO roles (name, description) VALUES (?, ?)',
      [name, description || null]
    );
    const roleId = result.insertId;

    if (permissionIds.length) {
      const values = permissionIds.map(pid => [roleId, pid]);
      await db.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ?', [values]);
    }

    res.status(201).json({ success: true, message: 'Role created', data: { id: roleId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create role' });
  }
};

// ── PUT /api/roles/:id ────────────────────────────────────
const updateRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissionIds = [] } = req.body;

    const [roles] = await db.execute('SELECT id FROM roles WHERE id = ?', [id]);
    if (!roles.length) return res.status(404).json({ success: false, message: 'Role not found' });

    const [dup] = await db.execute(
      'SELECT id FROM roles WHERE name = ? AND id != ?', [name, id]
    );
    if (dup.length) {
      return res.status(409).json({ success: false, message: 'Role name already exists' });
    }

    await db.execute(
      'UPDATE roles SET name = ?, description = ? WHERE id = ?',
      [name, description || null, id]
    );

    await db.execute('DELETE FROM role_permissions WHERE role_id = ?', [id]);
    if (permissionIds.length) {
      const values = permissionIds.map(pid => [id, pid]);
      await db.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ?', [values]);
    }

    res.json({ success: true, message: 'Role updated' });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to update role' });
  }
};

// ── DELETE /api/roles/:id ─────────────────────────────────
const deleteRole = async (req, res) => {
  try {
    const { id } = req.params;

    if (id === '1') {
      return res.status(403).json({ success: false, message: 'Cannot delete the Admin role' });
    }

    const [users] = await db.execute(
      'SELECT id FROM users WHERE role_id = ? AND is_active = 1 LIMIT 1', [id]
    );
    if (users.length) {
      return res.status(409).json({
        success: false,
        message: 'Cannot delete role — active users are assigned to it',
      });
    }

    await db.execute('DELETE FROM roles WHERE id = ?', [id]);
    res.json({ success: true, message: 'Role deleted' });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to delete role' });
  }
};

// ── GET /api/permissions ──────────────────────────────────
const getAllPermissions = async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM permissions ORDER BY module, action');

    const grouped = rows.reduce((acc, p) => {
      if (!acc[p.module]) acc[p.module] = [];
      acc[p.module].push(p);
      return acc;
    }, {});

    res.json({ success: true, data: { flat: rows, grouped } });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch permissions' });
  }
};

module.exports = { getAllRoles, getRoleById, createRole, updateRole, deleteRole, getAllPermissions };