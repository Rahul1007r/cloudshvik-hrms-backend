const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');

const UPLOAD_DIR = process.env.ANN_UPLOAD_DIR || path.join(__dirname, '../../uploads/announcements');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── helpers ───────────────────────────────────────────────
const isAnnVisible = (ann, userId, userDeptId, userRole) => {
  if (!ann.is_active) return false;
  if (ann.expires_at && new Date(ann.expires_at) < new Date()) return false;
  if (ann.publish_at && new Date(ann.publish_at) > new Date()) return false;
  if (ann.audience === 'All') return true;
  if (ann.audience === 'Department' && String(ann.department_id) === String(userDeptId)) return true;
  if (ann.audience === 'Role' && ann.target_role === userRole) return true;
  if (ann.audience === 'Individual') {
    try {
      const ids = JSON.parse(ann.target_emp_ids || '[]');
      return ids.includes(userId);
    } catch { return false; }
  }
  return false;
};

// ── GET /api/notifications/stats ─────────────────────────
const getStats = async (req, res) => {
  try {
    const [[unread]] = await db.execute(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND is_read=0',
      [req.user.id]
    );
    const [[announcements]] = await db.execute(`
      SELECT COUNT(*) AS count FROM announcements
      WHERE is_active=1 AND (publish_at IS NULL OR publish_at <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())`
    );
    res.json({ success:true, data:{ unread:unread.count, announcements:announcements.count } });
  } catch(err) {
    res.status(500).json({ success:false, message:'Stats failed' });
  }
};

// ── GET /api/notifications ────────────────────────────────
const getNotifications = async (req, res) => {
  try {
    const { page=1, limit=20, unread_only } = req.query;
    const offset = (Number(page)-1)*Number(limit);
    const cond = unread_only === 'true' ? 'AND n.is_read=0' : '';

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM notifications n WHERE n.user_id=? ${cond}`,
      [req.user.id]
    );

    const [rows] = await db.execute(
      `SELECT * FROM notifications WHERE user_id=? ${cond}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [req.user.id, Number(limit), offset]
    );

    res.json({ success:true, data:rows, meta:{ total:Number(total), unread:0 } });
  } catch(err) {
    res.status(500).json({ success:false, message:'Failed to fetch notifications' });
  }
};

// ── PATCH /api/notifications/:id/read ────────────────────
const markRead = async (req, res) => {
  try {
    await db.execute(
      'UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    );
    res.json({ success:true, message:'Marked as read' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── PATCH /api/notifications/read-all ────────────────────
const markAllRead = async (req, res) => {
  try {
    await db.execute(
      'UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0',
      [req.user.id]
    );
    res.json({ success:true, message:'All marked as read' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── DELETE /api/notifications/:id ────────────────────────
const deleteNotification = async (req, res) => {
  try {
    await db.execute('DELETE FROM notifications WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ success:true, message:'Deleted' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── POST /api/notifications/send (internal helper + admin use) ──
const sendNotification = async (userId, type, title, message, link=null, color='#006bb7') => {
  try {
    await db.execute(
      'INSERT INTO notifications (user_id,type,title,message,link,color) VALUES (?,?,?,?,?,?)',
      [userId, type, title, message||null, link||null, color]
    );
  } catch(err) { console.error('Notification send error:', err.message); }
};

// ── POST /api/notifications/broadcast (admin sends to many) ──
const broadcastNotification = async (req, res) => {
  try {
    const { title, message, link, type='admin_broadcast', color='#006bb7', audience='all', department_id, role } = req.body;
    if (!title?.trim()) return res.status(422).json({ success:false, message:'Title required' });

    let users = [];
    if (audience === 'all') {
      const [rows] = await db.execute('SELECT id FROM users WHERE is_active=1');
      users = rows;
    } else if (audience === 'department' && department_id) {
      const [rows] = await db.execute(
        'SELECT u.id FROM users u JOIN employees e ON e.user_id=u.id WHERE e.department_id=? AND u.is_active=1',
        [department_id]
      );
      users = rows;
    } else if (audience === 'role' && role) {
      const [rows] = await db.execute(
        'SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name=? AND u.is_active=1',
        [role]
      );
      users = rows;
    }

    let sent = 0;
    for (const u of users) {
      await sendNotification(u.id, type, title, message, link, color);
      sent++;
    }

    res.json({ success:true, message:`Notification sent to ${sent} users` });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Broadcast failed' });
  }
};

// ═══════════════════════════════════════════════════════════
// ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════

// ── GET /api/notifications/announcements/stats ────────────
const getAnnouncementStats = async (req, res) => {
  try {
    const [[counts]] = await db.execute(`
      SELECT
        COUNT(*)                          AS total,
        SUM(is_active=1 AND (expires_at IS NULL OR expires_at > NOW()) AND publish_at <= NOW()) AS active,
        SUM(is_pinned=1)                  AS pinned,
        SUM(publish_at > NOW())           AS scheduled,
        SUM(is_active=0 OR (expires_at IS NOT NULL AND expires_at <= NOW())) AS expired
      FROM announcements`);

    const [byCategory] = await db.execute(`
      SELECT category, COUNT(*) AS count
      FROM announcements WHERE is_active=1
      GROUP BY category ORDER BY count DESC`);

    res.json({ success:true, data:{ counts, byCategory } });
  } catch(err) {
    res.status(500).json({ success:false, message:'Stats failed' });
  }
};

// ── GET /api/notifications/announcements (admin) ─────────
const getAllAnnouncements = async (req, res) => {
  try {
    const { category, audience, page=1, limit=15 } = req.query;
    const conds = ['1=1']; const params = [];
    if (category) { conds.push('a.category=?'); params.push(category); }
    if (audience) { conds.push('a.audience=?'); params.push(audience); }

    const where  = conds.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM announcements a WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT a.*, u.full_name AS created_by_name, d.name AS department_name,
             (SELECT COUNT(*) FROM announcement_reads WHERE announcement_id=a.id) AS read_count
      FROM announcements a
      LEFT JOIN users u ON u.id=a.created_by
      LEFT JOIN departments d ON d.id=a.department_id
      WHERE ${where}
      ORDER BY a.is_pinned DESC, a.publish_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({ success:true, data:rows, meta:{ total:Number(total), page:Number(page), pages:Math.ceil(Number(total)/Number(limit)) } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to fetch announcements' });
  }
};

// ── GET /api/notifications/announcements/feed (employee) ─
const getAnnouncementFeed = async (req, res) => {
  try {
    const { page=1, limit=15, category } = req.query;

    // Get user context for filtering
    const [[emp]] = await db.execute(
      'SELECT e.department_id, r.name AS role_name FROM employees e JOIN users u ON u.id=e.user_id JOIN roles r ON r.id=u.role_id WHERE e.user_id=?',
      [req.user.id]
    );

    const offset = (Number(page)-1)*Number(limit);
    const conds  = [
      'a.is_active=1',
      '(a.publish_at IS NULL OR a.publish_at <= NOW())',
      '(a.expires_at IS NULL OR a.expires_at > NOW())',
      `(a.audience='All'
        OR (a.audience='Department' AND a.department_id=${emp?.department_id||0})
        OR (a.audience='Role' AND a.target_role='${emp?.role_name||''}')
        OR a.audience='Individual'
       )`,
    ];
    if (category) { conds.push('a.category=?'); }

    const where  = conds.join(' AND ');
    const params = category ? [category] : [];

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM announcements a WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT a.*, u.full_name AS created_by_name, d.name AS department_name,
             (SELECT 1 FROM announcement_reads WHERE announcement_id=a.id AND user_id=?) AS is_read
      FROM announcements a
      LEFT JOIN users u ON u.id=a.created_by
      LEFT JOIN departments d ON d.id=a.department_id
      WHERE ${where}
      ORDER BY a.is_pinned DESC, a.publish_at DESC
      LIMIT ? OFFSET ?`, [req.user.id, ...params, Number(limit), offset]);

    res.json({ success:true, data:rows, meta:{ total:Number(total), page:Number(page), pages:Math.ceil(Number(total)/Number(limit)) } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to fetch feed' });
  }
};

// ── GET /api/notifications/announcements/:id ─────────────
const getAnnouncement = async (req, res) => {
  try {
    const [[ann]] = await db.execute(`
      SELECT a.*, u.full_name AS created_by_name, d.name AS department_name,
             (SELECT COUNT(*) FROM announcement_reads WHERE announcement_id=a.id) AS read_count
      FROM announcements a
      LEFT JOIN users u ON u.id=a.created_by
      LEFT JOIN departments d ON d.id=a.department_id
      WHERE a.id=?`, [req.params.id]);

    if (!ann) return res.status(404).json({ success:false, message:'Not found' });

    // Auto-read and increment views
    await db.execute('UPDATE announcements SET views_count=views_count+1 WHERE id=?', [req.params.id]);
    await db.execute(
      'INSERT IGNORE INTO announcement_reads (announcement_id,user_id) VALUES (?,?)',
      [req.params.id, req.user.id]
    );

    res.json({ success:true, data:ann });
  } catch(err) {
    res.status(500).json({ success:false, message:'Failed' });
  }
};

// ── POST /api/notifications/announcements ─────────────────
const createAnnouncement = async (req, res) => {
  try {
    const {
      title, body, category, priority, audience,
      department_id, target_role, target_emp_ids,
      publish_at, expires_at, is_pinned,
    } = req.body;

    const attachPath = req.file?.filename || null;
    const attachName = req.file?.originalname || null;

    const [result] = await db.execute(`
      INSERT INTO announcements
        (title,body,category,priority,audience,department_id,target_role,target_emp_ids,
         publish_at,expires_at,is_pinned,attachment_path,attachment_name,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title.trim(), body.trim(), category||'General', priority||'Normal',
       audience||'All', department_id||null, target_role||null,
       target_emp_ids ? JSON.stringify(target_emp_ids) : null,
       publish_at||new Date().toISOString().slice(0,19).replace('T',' '),
       expires_at||null, is_pinned?1:0,
       attachPath, attachName, req.user.id]
    );

    // Send in-app notification to all relevant users
    if (!publish_at || new Date(publish_at) <= new Date()) {
      // Fire-and-forget broadcast
      const color = { Normal:'#006bb7', Important:'#d97706', Urgent:'#dc2626' }[priority||'Normal'] || '#006bb7';
      broadcastNotification({
        body: {
          title: `📢 ${title}`,
          message: body.slice(0, 120) + (body.length > 120 ? '…' : ''),
          type: 'announcement',
          link: '/announcements',
          color,
          audience: audience||'all',
          department_id,
          role: target_role,
        },
        user: req.user,
      }, { json: () => {} });
    }

    await db.execute(
      'INSERT INTO audit_logs (user_id,action,module,ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_ANNOUNCEMENT:${result.insertId}`, 'announcements', req.ip]
    );

    res.status(201).json({ success:true, message:'Announcement published', data:{ id:result.insertId } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Create failed' });
  }
};

// ── PUT /api/notifications/announcements/:id ─────────────
const updateAnnouncement = async (req, res) => {
  try {
    const { title, body, category, priority, audience, department_id,
            target_role, publish_at, expires_at, is_pinned, is_active } = req.body;

    await db.execute(`
      UPDATE announcements SET
        title=?, body=?, category=?, priority=?, audience=?,
        department_id=?, target_role=?, publish_at=?, expires_at=?,
        is_pinned=?, is_active=?
      WHERE id=?`,
      [title.trim(), body.trim(), category||'General', priority||'Normal',
       audience||'All', department_id||null, target_role||null,
       publish_at||null, expires_at||null, is_pinned?1:0, is_active?1:0,
       req.params.id]);

    res.json({ success:true, message:'Announcement updated' });
  } catch(err) { res.status(500).json({ success:false, message:'Update failed' }); }
};

// ── DELETE /api/notifications/announcements/:id ───────────
const deleteAnnouncement = async (req, res) => {
  try {
    await db.execute('UPDATE announcements SET is_active=0 WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'Announcement removed' });
  } catch(err) { res.status(500).json({ success:false, message:'Delete failed' }); }
};

// ── PATCH /api/notifications/announcements/:id/pin ────────
const togglePin = async (req, res) => {
  try {
    await db.execute('UPDATE announcements SET is_pinned=NOT is_pinned WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'Pin toggled' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── GET /api/notifications/preferences ───────────────────
const getPreferences = async (req, res) => {
  try {
    let [[prefs]] = await db.execute(
      'SELECT * FROM notification_preferences WHERE user_id=?', [req.user.id]
    );
    if (!prefs) {
      await db.execute('INSERT IGNORE INTO notification_preferences (user_id) VALUES (?)', [req.user.id]);
      [[prefs]] = await db.execute('SELECT * FROM notification_preferences WHERE user_id=?', [req.user.id]);
    }
    res.json({ success:true, data:prefs });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── PUT /api/notifications/preferences ───────────────────
const savePreferences = async (req, res) => {
  try {
    const { leave_updates, payroll_updates, task_updates, hr_updates, announcements_pref, email_digest } = req.body;
    await db.execute(`
      INSERT INTO notification_preferences
        (user_id,leave_updates,payroll_updates,task_updates,hr_updates,announcements,email_digest)
      VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        leave_updates=VALUES(leave_updates),
        payroll_updates=VALUES(payroll_updates),
        task_updates=VALUES(task_updates),
        hr_updates=VALUES(hr_updates),
        announcements=VALUES(announcements),
        email_digest=VALUES(email_digest)`,
      [req.user.id,
       leave_updates?1:0, payroll_updates?1:0, task_updates?1:0,
       hr_updates?1:0, announcements_pref?1:0, email_digest||'None']
    );
    res.json({ success:true, message:'Preferences saved' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── Export sendNotification for use by other modules ──────
module.exports = {
  getStats,
  getNotifications, markRead, markAllRead, deleteNotification, broadcastNotification,
  getAnnouncementStats, getAllAnnouncements, getAnnouncementFeed, getAnnouncement,
  createAnnouncement, updateAnnouncement, deleteAnnouncement, togglePin,
  getPreferences, savePreferences,
  sendNotification, // helper for other controllers
};