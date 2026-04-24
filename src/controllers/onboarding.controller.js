const db = require('../config/db');

// ── helpers ───────────────────────────────────────────────
const recalcProgress = async (conn, planId) => {
  const [[r]] = await conn.execute(
    `SELECT COUNT(*) AS total,
            SUM(status='Completed') AS done,
            SUM(status='Skipped')   AS skipped
     FROM onboarding_tasks WHERE plan_id = ? AND is_required = 1`, [planId]
  );
  const total   = Number(r.total   || 0);
  const done    = Number(r.done    || 0);
  const skipped = Number(r.skipped || 0);
  const pct     = total > 0 ? Math.round(((done + skipped) / total) * 100) : 0;

  const [[all]] = await conn.execute(
    `SELECT COUNT(*) AS total, SUM(status='Completed' OR status='Skipped') AS done
     FROM onboarding_tasks WHERE plan_id = ?`, [planId]
  );
  const allDone = Number(all.total) > 0 && Number(all.done) === Number(all.total);

  let status = 'In Progress';
  if (pct === 0) status = 'Not Started';
  if (pct === 100 || allDone) status = 'Completed';

  // Check overdue
  const [[plan]] = await conn.execute('SELECT target_date, status AS old_status FROM onboarding_plans WHERE id=?', [planId]);
  if (plan && plan.target_date < new Date().toISOString().slice(0, 10) && status !== 'Completed') {
    status = 'Overdue';
  }

  await conn.execute(
    `UPDATE onboarding_plans SET progress_pct=?, status=?,
     completed_at = IF(? = 'Completed' AND completed_at IS NULL, NOW(), completed_at)
     WHERE id=?`,
    [pct, status, status, planId]
  );
};

// ── GET /api/onboarding/stats ─────────────────────────────
const getStats = async (req, res) => {
  try {
    const [[counts]] = await db.execute(`
      SELECT
        COUNT(*)                          AS total,
        SUM(status='Not Started')         AS not_started,
        SUM(status='In Progress')         AS in_progress,
        SUM(status='Completed')           AS completed,
        SUM(status='Overdue')             AS overdue,
        ROUND(AVG(progress_pct),0)        AS avg_progress
      FROM onboarding_plans`
    );

    const [recent] = await db.execute(`
      SELECT op.id, op.status, op.progress_pct, op.joining_date,
             e.full_name, e.employee_id AS emp_code,
             d.name AS department
      FROM onboarding_plans op
      JOIN employees  e ON e.id = op.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      ORDER BY op.created_at DESC LIMIT 5`
    );

    const [[tasks]] = await db.execute(`
      SELECT SUM(status='Pending') AS pending, SUM(status='Completed') AS completed,
             SUM(due_date < CURDATE() AND status='Pending') AS overdue_tasks
      FROM onboarding_tasks`
    );

    res.json({ success: true, data: { counts, recent, tasks } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Stats failed' });
  }
};

// ── GET /api/onboarding/plans ─────────────────────────────
const getPlans = async (req, res) => {
  try {
    const { status, page = 1, limit = 12 } = req.query;
    const conditions = ['1=1']; const params = [];
    if (status) { conditions.push('op.status = ?'); params.push(status); }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM onboarding_plans op WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT op.*,
             e.full_name, e.employee_id AS emp_code, e.avatar_url,
             d.name  AS department,
             des.name AS designation,
             b.full_name AS buddy_name,
             m.full_name AS manager_name,
             t.name AS template_name,
             (SELECT COUNT(*) FROM onboarding_tasks WHERE plan_id=op.id) AS total_tasks,
             (SELECT COUNT(*) FROM onboarding_tasks WHERE plan_id=op.id AND status='Completed') AS done_tasks,
             (SELECT COUNT(*) FROM onboarding_tasks WHERE plan_id=op.id AND status='Pending' AND due_date < CURDATE()) AS overdue_tasks
      FROM onboarding_plans op
      JOIN employees  e   ON e.id   = op.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN employees    b   ON b.id   = op.buddy_id
      LEFT JOIN employees    m   ON m.id   = op.manager_id
      LEFT JOIN onboarding_templates t ON t.id = op.template_id
      WHERE ${where}
      ORDER BY FIELD(op.status,'In Progress','Not Started','Overdue','Completed'), op.joining_date DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({
      success: true, data: rows,
      meta: { total: Number(total), page: Number(page), pages: Math.ceil(Number(total)/Number(limit)) }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch plans' });
  }
};

// ── GET /api/onboarding/plans/:id ─────────────────────────
const getPlan = async (req, res) => {
  try {
    const [[plan]] = await db.execute(`
      SELECT op.*,
             e.full_name, e.employee_id AS emp_code, e.email, e.phone, e.avatar_url,
             d.name  AS department,
             des.name AS designation,
             b.full_name AS buddy_name,
             m.full_name AS manager_name,
             t.name AS template_name
      FROM onboarding_plans op
      JOIN employees  e   ON e.id   = op.employee_id
      LEFT JOIN departments  d   ON d.id   = e.department_id
      LEFT JOIN designations des ON des.id = e.designation_id
      LEFT JOIN employees    b   ON b.id   = op.buddy_id
      LEFT JOIN employees    m   ON m.id   = op.manager_id
      LEFT JOIN onboarding_templates t ON t.id = op.template_id
      WHERE op.id = ?`, [req.params.id]);

    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

    const [tasks] = await db.execute(`
      SELECT ot.*,
             ae.full_name AS assigned_emp_name,
             u.full_name  AS completed_by_name
      FROM onboarding_tasks ot
      LEFT JOIN employees ae ON ae.id = ot.assigned_to_emp
      LEFT JOIN users     u  ON u.id  = ot.completed_by
      WHERE ot.plan_id = ?
      ORDER BY ot.sort_order, ot.due_date, ot.id`, [req.params.id]);

    const [comments] = await db.execute(`
      SELECT oc.*, u.full_name AS author
      FROM onboarding_comments oc
      JOIN users u ON u.id = oc.created_by
      WHERE oc.plan_id = ?
      ORDER BY oc.created_at ASC`, [req.params.id]);

    // Group tasks by category
    const byCategory = {};
    tasks.forEach(t => {
      if (!byCategory[t.category]) byCategory[t.category] = [];
      byCategory[t.category].push(t);
    });

    res.json({ success: true, data: { ...plan, tasks, byCategory, comments } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch plan' });
  }
};

// ── POST /api/onboarding/plans ────────────────────────────
const createPlan = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      employee_id, template_id, title, joining_date,
      target_date, buddy_id, manager_id, notes, custom_tasks = []
    } = req.body;

    // Check if plan already exists
    const [[existing]] = await conn.execute(
      'SELECT id FROM onboarding_plans WHERE employee_id = ?', [employee_id]
    );
    if (existing) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Onboarding plan already exists for this employee' });
    }

    // Create plan
    const [planResult] = await conn.execute(`
      INSERT INTO onboarding_plans
        (employee_id, template_id, title, joining_date, target_date, buddy_id, manager_id, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [employee_id, template_id||null, title, joining_date, target_date,
       buddy_id||null, manager_id||null, notes||null, req.user.id]
    );
    const planId = planResult.insertId;

    // Instantiate tasks from template
    if (template_id) {
      const [templateTasks] = await conn.execute(
        'SELECT * FROM onboarding_template_tasks WHERE template_id = ? ORDER BY sort_order',
        [template_id]
      );
      for (const tt of templateTasks) {
        const dueDate = new Date(joining_date);
        dueDate.setDate(dueDate.getDate() + tt.due_day - 1);
        await conn.execute(`
          INSERT INTO onboarding_tasks
            (plan_id, title, description, category, due_date, is_required, assigned_to_role, sort_order)
          VALUES (?,?,?,?,?,?,?,?)`,
          [planId, tt.title, tt.description||null, tt.category, dueDate.toISOString().slice(0,10),
           tt.is_required, tt.assigned_to_role||'HR', tt.sort_order]
        );
      }
    }

    // Add custom tasks
    for (const [i, t] of custom_tasks.entries()) {
      await conn.execute(`
        INSERT INTO onboarding_tasks (plan_id, title, description, category, due_date, is_required, assigned_to_role, sort_order)
        VALUES (?,?,?,?,?,?,?,?)`,
        [planId, t.title, t.description||null, t.category||'Other', t.due_date||null, t.is_required!==false, t.assigned_to_role||'HR', 100+i]
      );
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id, action, module, ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_ONBOARD_PLAN:emp${employee_id}`, 'onboarding', req.ip]
    );

    await conn.commit();
    res.status(201).json({ success: true, message: 'Onboarding plan created', data: { id: planId } });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create plan' });
  } finally { conn.release(); }
};

// ── PUT /api/onboarding/plans/:id ─────────────────────────
const updatePlan = async (req, res) => {
  try {
    const { title, target_date, buddy_id, manager_id, notes } = req.body;
    await db.execute(
      'UPDATE onboarding_plans SET title=?,target_date=?,buddy_id=?,manager_id=?,notes=? WHERE id=?',
      [title, target_date, buddy_id||null, manager_id||null, notes||null, req.params.id]
    );
    res.json({ success: true, message: 'Plan updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Update failed' });
  }
};

// ── PATCH /api/onboarding/tasks/:taskId/complete ──────────
const completeTask = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { notes } = req.body;

    const [[task]] = await conn.execute('SELECT * FROM onboarding_tasks WHERE id=?', [req.params.taskId]);
    if (!task) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Task not found' }); }

    const newStatus = task.status === 'Completed' ? 'Pending' : 'Completed';
    await conn.execute(
      `UPDATE onboarding_tasks SET status=?,
       completed_by = IF(?='Completed',?,NULL),
       completed_at = IF(?='Completed',NOW(),NULL),
       notes = COALESCE(?,notes)
       WHERE id=?`,
      [newStatus, newStatus, req.user.id, newStatus, notes||null, task.id]
    );

    await recalcProgress(conn, task.plan_id);
    await conn.commit();
    res.json({ success: true, message: newStatus === 'Completed' ? 'Task completed' : 'Task reopened' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, message: 'Task update failed' });
  } finally { conn.release(); }
};

// ── PATCH /api/onboarding/tasks/:taskId/skip ─────────────
const skipTask = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[task]] = await conn.execute('SELECT plan_id FROM onboarding_tasks WHERE id=?', [req.params.taskId]);
    if (!task) { await conn.rollback(); return res.status(404).json({ success: false, message: 'Task not found' }); }
    await conn.execute("UPDATE onboarding_tasks SET status='Skipped' WHERE id=?", [req.params.taskId]);
    await recalcProgress(conn, task.plan_id);
    await conn.commit();
    res.json({ success: true, message: 'Task skipped' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Skip failed' });
  } finally { conn.release(); }
};

// ── POST /api/onboarding/plans/:id/tasks ─────────────────
const addTask = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { title, description, category, due_date, is_required, assigned_to_role } = req.body;

    const [[{ max_order }]] = await conn.execute(
      'SELECT COALESCE(MAX(sort_order),0) AS max_order FROM onboarding_tasks WHERE plan_id=?', [req.params.id]
    );
    await conn.execute(`
      INSERT INTO onboarding_tasks (plan_id, title, description, category, due_date, is_required, assigned_to_role, sort_order)
      VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, title.trim(), description||null, category||'Other',
       due_date||null, is_required!==false, assigned_to_role||'HR', max_order+1]
    );
    await conn.commit();
    res.status(201).json({ success: true, message: 'Task added' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Add task failed' });
  } finally { conn.release(); }
};

// ── POST /api/onboarding/plans/:id/comments ──────────────
const addComment = async (req, res) => {
  try {
    const { comment, task_id } = req.body;
    if (!comment?.trim()) return res.status(422).json({ success: false, message: 'Comment required' });
    await db.execute(
      'INSERT INTO onboarding_comments (plan_id, task_id, comment, created_by) VALUES (?,?,?,?)',
      [req.params.id, task_id||null, comment.trim(), req.user.id]
    );
    res.status(201).json({ success: true, message: 'Comment added' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Comment failed' });
  }
};

// ── GET /api/onboarding/templates ────────────────────────
const getTemplates = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT ot.*, d.name AS department_name,
             (SELECT COUNT(*) FROM onboarding_template_tasks WHERE template_id=ot.id) AS task_count
      FROM onboarding_templates ot
      LEFT JOIN departments d ON d.id = ot.department_id
      WHERE ot.is_active = 1
      ORDER BY ot.is_default DESC, ot.name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch templates' });
  }
};

// ── GET /api/onboarding/templates/:id ────────────────────
const getTemplate = async (req, res) => {
  try {
    const [[tmpl]] = await db.execute('SELECT * FROM onboarding_templates WHERE id=?', [req.params.id]);
    if (!tmpl) return res.status(404).json({ success: false, message: 'Template not found' });
    const [tasks] = await db.execute(
      'SELECT * FROM onboarding_template_tasks WHERE template_id=? ORDER BY sort_order', [req.params.id]
    );
    res.json({ success: true, data: { ...tmpl, tasks } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch template' });
  }
};

// ── POST /api/onboarding/templates ────────────────────────
const createTemplate = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { name, description, department_id, role_type, tasks = [] } = req.body;

    const [result] = await conn.execute(
      'INSERT INTO onboarding_templates (name, description, department_id, role_type, created_by) VALUES (?,?,?,?,?)',
      [name.trim(), description||null, department_id||null, role_type||null, req.user.id]
    );
    const tmplId = result.insertId;

    for (const [i, t] of tasks.entries()) {
      await conn.execute(`
        INSERT INTO onboarding_template_tasks
          (template_id, title, description, category, due_day, is_required, assigned_to_role, sort_order)
        VALUES (?,?,?,?,?,?,?,?)`,
        [tmplId, t.title.trim(), t.description||null, t.category||'Other', t.due_day||1, t.is_required!==false, t.assigned_to_role||'HR', i+1]
      );
    }

    await conn.commit();
    res.status(201).json({ success: true, message: 'Template created', data: { id: tmplId } });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Create template failed' });
  } finally { conn.release(); }
};

// ── GET /api/onboarding/my-plan ───────────────────────────
const getMyPlan = async (req, res) => {
  try {
    const [[emp]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [req.user.id]);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const [[plan]] = await db.execute(
      'SELECT id FROM onboarding_plans WHERE employee_id=?', [emp.id]
    );
    if (!plan) return res.status(404).json({ success: false, message: 'No onboarding plan found' });

    // Reuse getPlan logic
    req.params.id = plan.id;
    return getPlan(req, res);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
};

module.exports = {
  getStats, getPlans, getPlan, createPlan, updatePlan,
  completeTask, skipTask, addTask, addComment,
  getTemplates, getTemplate, createTemplate, getMyPlan,
};