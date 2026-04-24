const db   = require('../config/db');
const path = require('path');
const fs   = require('fs');

const UPLOAD_DIR = process.env.TICKET_UPLOAD_DIR || path.join(__dirname, '../../uploads/tickets');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── helpers ───────────────────────────────────────────────
const getSelfEmpId = async (userId) => {
  const [[r]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [userId]);
  return r?.id || null;
};

const genTicketNo = async (conn) => {
  const [[{ max_id }]] = await conn.execute(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(ticket_no,5) AS UNSIGNED)),0) AS max_id FROM helpdesk_tickets WHERE ticket_no LIKE 'TKT-%'"
  );
  return `TKT-${String(Number(max_id) + 1).padStart(6, '0')}`;
};

const calcDueDate = (slaHours) => {
  const d = new Date();
  d.setHours(d.getHours() + (slaHours || 24));
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

// ── GET /api/helpdesk/stats ───────────────────────────────
const getStats = async (req, res) => {
  try {
    const empId = await getSelfEmpId(req.user.id);
    const isHR  = ['Admin','HR'].includes(req.user.role_name);

    const baseFilter = isHR ? '1=1' : `(ht.raised_by = ${empId} OR ht.assigned_to = ${empId})`;

    const [[counts]] = await db.execute(`
      SELECT
        COUNT(*)                           AS total,
        SUM(status='Open')                 AS open_count,
        SUM(status='In Progress')          AS in_progress,
        SUM(status='Waiting')              AS waiting,
        SUM(status='Resolved')             AS resolved,
        SUM(status='Closed')               AS closed,
        SUM(status='Reopened')             AS reopened,
        SUM(priority='Critical' AND status NOT IN ('Resolved','Closed')) AS critical_open,
        SUM(due_date < NOW() AND status NOT IN ('Resolved','Closed','Cancelled')) AS overdue,
        ROUND(AVG(NULLIF(satisfaction_rating,0)),1) AS avg_satisfaction
      FROM helpdesk_tickets ht
      WHERE ${baseFilter}`);

    const [byCategory] = await db.execute(`
      SELECT tc.name, tc.color,
             COUNT(ht.id) AS total,
             SUM(ht.status NOT IN ('Resolved','Closed')) AS open_count
      FROM ticket_categories tc
      LEFT JOIN helpdesk_tickets ht ON ht.category_id = tc.id
        ${!isHR ? `AND (ht.raised_by=${empId} OR ht.assigned_to=${empId})` : ''}
      WHERE tc.is_active=1
      GROUP BY tc.id ORDER BY total DESC LIMIT 6`);

    const [recentTickets] = await db.execute(`
      SELECT ht.id, ht.ticket_no, ht.subject, ht.status, ht.priority, ht.created_at,
             tc.name AS category, tc.color,
             e.full_name AS raised_name
      FROM helpdesk_tickets ht
      JOIN ticket_categories tc ON tc.id = ht.category_id
      JOIN employees e ON e.id = ht.raised_by
      WHERE ${baseFilter}
      ORDER BY ht.created_at DESC LIMIT 5`);

    res.json({ success: true, data: { counts, byCategory, recentTickets } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

// ── GET /api/helpdesk/tickets ─────────────────────────────
const getTickets = async (req, res) => {
  try {
    const { status, priority, category_id, assigned_to, search, my_tickets, page = 1, limit = 15 } = req.query;
    const empId = await getSelfEmpId(req.user.id);
    const isHR  = ['Admin','HR'].includes(req.user.role_name);

    const conditions = ['1=1']; const params = [];

    // Scope
    if (my_tickets === 'true' || (!isHR)) {
      conditions.push('(ht.raised_by = ? OR ht.assigned_to = ?)');
      params.push(empId, empId);
    }

    if (status)      { conditions.push('ht.status = ?');      params.push(status); }
    if (priority)    { conditions.push('ht.priority = ?');    params.push(priority); }
    if (category_id) { conditions.push('ht.category_id = ?'); params.push(category_id); }
    if (assigned_to) { conditions.push('ht.assigned_to = ?'); params.push(assigned_to); }
    if (search?.trim()) {
      conditions.push('(ht.subject LIKE ? OR ht.ticket_no LIKE ? OR ht.description LIKE ?)');
      const s = `%${search.trim()}%`;
      params.push(s, s, s);
    }

    const where  = conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM helpdesk_tickets ht WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT ht.*,
             tc.name AS category_name, tc.color, tc.sla_hours,
             e1.full_name AS raised_name, e1.employee_id AS raised_emp_code,
             d1.name AS raised_dept,
             e2.full_name AS assigned_name,
             (SELECT COUNT(*) FROM ticket_replies WHERE ticket_id=ht.id AND is_internal=0) AS reply_count,
             (SELECT COUNT(*) FROM ticket_replies WHERE ticket_id=ht.id AND is_internal=1) AS note_count
      FROM helpdesk_tickets ht
      JOIN ticket_categories tc ON tc.id = ht.category_id
      JOIN employees e1 ON e1.id = ht.raised_by
      LEFT JOIN departments d1 ON d1.id = e1.department_id
      LEFT JOIN employees e2 ON e2.id = ht.assigned_to
      WHERE ${where}
      ORDER BY
        FIELD(ht.priority,'Critical','High','Medium','Low'),
        FIELD(ht.status,'Open','Reopened','In Progress','Waiting','Resolved','Closed'),
        ht.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total) / Number(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
  }
};

// ── GET /api/helpdesk/tickets/:id ─────────────────────────
const getTicket = async (req, res) => {
  try {
    const [[ticket]] = await db.execute(`
      SELECT ht.*,
             tc.name AS category_name, tc.color, tc.sla_hours,
             e1.full_name AS raised_name, e1.employee_id AS raised_emp_code,
             d1.name AS raised_dept, e1.email AS raised_email,
             e2.full_name AS assigned_name, e2.employee_id AS assigned_emp_code
      FROM helpdesk_tickets ht
      JOIN ticket_categories tc ON tc.id = ht.category_id
      JOIN employees e1 ON e1.id = ht.raised_by
      LEFT JOIN departments d1 ON d1.id = e1.department_id
      LEFT JOIN employees e2 ON e2.id = ht.assigned_to
      WHERE ht.id = ?`, [req.params.id]);

    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const [replies] = await db.execute(`
      SELECT tr.*,
             e.full_name AS author_name, e.employee_id AS author_emp_code
      FROM ticket_replies tr
      JOIN employees e ON e.id = tr.author_emp_id
      WHERE tr.ticket_id = ?
      ORDER BY tr.created_at ASC`, [req.params.id]);

    const [attachments] = await db.execute(
      'SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC', [req.params.id]
    );

    res.json({ success: true, data: { ...ticket, replies, attachments } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
  }
};

// ── POST /api/helpdesk/tickets ────────────────────────────
const createTicket = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { subject, description, category_id, priority, department_id, tags } = req.body;

    const empId = await getSelfEmpId(req.user.id);
    if (!empId) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Employee not found' }); }

    // Get SLA
    const [[cat]] = await conn.execute('SELECT sla_hours FROM ticket_categories WHERE id=?', [category_id]);
    const due_date = calcDueDate(cat?.sla_hours || 24);

    const ticket_no = await genTicketNo(conn);

    const [result] = await conn.execute(`
      INSERT INTO helpdesk_tickets
        (ticket_no, subject, description, category_id, priority, raised_by, department_id, due_date, tags)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [ticket_no, subject.trim(), description.trim(), category_id,
       priority || 'Medium', empId, department_id || null, due_date, tags || null]);

    // Handle file attachments
    if (req.files?.length) {
      for (const file of req.files) {
        await conn.execute(`
          INSERT INTO ticket_attachments (ticket_id, file_name, file_path, file_size, mime_type, uploaded_by)
          VALUES (?,?,?,?,?,?)`,
          [result.insertId, file.originalname, file.filename, file.size, file.mimetype, empId]);
      }
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_TICKET:${ticket_no}`, 'helpdesk', req.ip]
    );

    await conn.commit();
    res.status(201).json({ success: true, message: `Ticket ${ticket_no} created`, data: { id: result.insertId, ticket_no } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create ticket' });
  } finally { conn.release(); }
};

// ── POST /api/helpdesk/tickets/:id/reply ──────────────────
const addReply = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { message, is_internal } = req.body;
    const empId = await getSelfEmpId(req.user.id);

    const [[ticket]] = await conn.execute('SELECT * FROM helpdesk_tickets WHERE id=?', [req.params.id]);
    if (!ticket) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Ticket not found' }); }

    const [result] = await conn.execute(`
      INSERT INTO ticket_replies (ticket_id, message, is_internal, author_emp_id, reply_type)
      VALUES (?,?,?,?,?)`,
      [req.params.id, message.trim(), is_internal ? 1 : 0, empId, 'Reply']);

    // Handle file attachments for this reply
    if (req.files?.length) {
      for (const file of req.files) {
        await conn.execute(`
          INSERT INTO ticket_attachments (ticket_id, reply_id, file_name, file_path, file_size, mime_type, uploaded_by)
          VALUES (?,?,?,?,?,?,?)`,
          [req.params.id, result.insertId, file.originalname, file.filename, file.size, file.mimetype, empId]);
      }
    }

    // Record first response time if this is support replying (not the raiser)
    if (!ticket.first_response_at && empId !== ticket.raised_by) {
      await conn.execute(
        'UPDATE helpdesk_tickets SET first_response_at=NOW(), status=IF(status=\'Open\',\'In Progress\',status) WHERE id=?',
        [req.params.id]
      );
    }

    // Auto move to In Progress on first non-raiser reply
    if (ticket.status === 'Open' && empId !== ticket.raised_by) {
      await conn.execute("UPDATE helpdesk_tickets SET status='In Progress' WHERE id=?", [req.params.id]);
    }

    await conn.commit();
    res.status(201).json({ success: true, message: 'Reply added' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Reply failed' });
  } finally { conn.release(); }
};

// ── PATCH /api/helpdesk/tickets/:id/status ────────────────
const updateStatus = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { status, message } = req.body;
    const empId = await getSelfEmpId(req.user.id);

    const [[ticket]] = await conn.execute('SELECT * FROM helpdesk_tickets WHERE id=?', [req.params.id]);
    if (!ticket) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Ticket not found' }); }

    const updates = { status };
    if (status === 'Resolved') updates.resolved_at = new Date().toISOString().slice(0,19).replace('T',' ');
    if (status === 'Closed')   updates.closed_at   = new Date().toISOString().slice(0,19).replace('T',' ');

    const setClause = Object.keys(updates).map(k=>`${k}=?`).join(',');
    await conn.execute(`UPDATE helpdesk_tickets SET ${setClause} WHERE id=?`, [...Object.values(updates), req.params.id]);

    // Log status change as reply
    if (message || status) {
      await conn.execute(`
        INSERT INTO ticket_replies (ticket_id, message, reply_type, is_internal, author_emp_id)
        VALUES (?,?,?,1,?)`,
        [req.params.id, message || `Status changed to ${status}`, 'Status Change', empId]);
    }

    await conn.commit();
    res.json({ success: true, message: `Ticket ${status}` });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Status update failed' });
  } finally { conn.release(); }
};

// ── PATCH /api/helpdesk/tickets/:id/assign ────────────────
const assignTicket = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { assigned_to } = req.body;
    const empId = await getSelfEmpId(req.user.id);

    const [[assignee]] = await conn.execute('SELECT full_name FROM employees WHERE id=?', [assigned_to]);

    await conn.execute(
      "UPDATE helpdesk_tickets SET assigned_to=?, status=IF(status='Open','In Progress',status) WHERE id=?",
      [assigned_to, req.params.id]
    );

    await conn.execute(`
      INSERT INTO ticket_replies (ticket_id, message, reply_type, is_internal, author_emp_id)
      VALUES (?,?,?,1,?)`,
      [req.params.id, `Assigned to ${assignee?.full_name || 'Unknown'}`, 'Assignment', empId]);

    await conn.commit();
    res.json({ success: true, message: 'Ticket assigned' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Assignment failed' });
  } finally { conn.release(); }
};

// ── PATCH /api/helpdesk/tickets/:id/priority ─────────────
const updatePriority = async (req, res) => {
  try {
    await db.execute('UPDATE helpdesk_tickets SET priority=? WHERE id=?', [req.body.priority, req.params.id]);
    res.json({ success: true, message: 'Priority updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// ── POST /api/helpdesk/tickets/:id/rate ───────────────────
const rateTicket = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const empId = await getSelfEmpId(req.user.id);

    const [[ticket]] = await db.execute('SELECT raised_by FROM helpdesk_tickets WHERE id=?', [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (ticket.raised_by !== empId) return res.status(403).json({ success: false, message: 'Only ticket raiser can rate' });

    await db.execute(
      'UPDATE helpdesk_tickets SET satisfaction_rating=?, satisfaction_comment=? WHERE id=?',
      [rating, comment || null, req.params.id]
    );
    res.json({ success: true, message: 'Rating submitted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Rating failed' });
  }
};

// ── GET /api/helpdesk/categories ─────────────────────────
const getCategories = async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM ticket_categories WHERE is_active=1 ORDER BY name'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

// ── GET /api/helpdesk/agents ──────────────────────────────
const getAgents = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT e.id, e.full_name, e.employee_id,
             d.name AS department,
             (SELECT COUNT(*) FROM helpdesk_tickets WHERE assigned_to=e.id AND status NOT IN ('Resolved','Closed')) AS open_tickets
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      JOIN users u ON u.id = e.user_id
      WHERE e.is_active=1 AND u.role_name IN ('Admin','HR')
      ORDER BY open_tickets ASC, e.full_name`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

// ── GET download attachment ───────────────────────────────
const downloadAttachment = async (req, res) => {
  try {
    const [[att]] = await db.execute('SELECT * FROM ticket_attachments WHERE id=?', [req.params.attId]);
    if (!att) return res.status(404).json({ success: false, message: 'Not found' });
    const filePath = path.join(UPLOAD_DIR, att.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'File not found on disk' });
    res.setHeader('Content-Disposition', `attachment; filename="${att.file_name}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Download failed' });
  }
};

module.exports = {
  getStats, getTickets, getTicket, createTicket,
  addReply, updateStatus, assignTicket, updatePriority, rateTicket,
  getCategories, getAgents, downloadAttachment,
};