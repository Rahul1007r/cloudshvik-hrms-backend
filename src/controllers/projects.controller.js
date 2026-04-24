const db = require('../config/db');

// ── helpers ───────────────────────────────────────────────
const genProjectCode = async (conn) => {
  const [[{ n }]] = await conn.execute(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(project_code,4) AS UNSIGNED)),0)+1 AS n FROM projects WHERE project_code LIKE 'PRJ%'"
  );
  return `PRJ${String(n).padStart(4,'0')}`;
};

const recalcProgress = async (conn, projectId) => {
  const [[r]] = await conn.execute(
    `SELECT COUNT(*) AS total, SUM(status='Done') AS done
     FROM tasks WHERE project_id=? AND parent_task_id IS NULL`, [projectId]
  );
  const pct = r.total > 0 ? Math.round((r.done / r.total) * 100) : 0;
  await conn.execute('UPDATE projects SET progress_pct=? WHERE id=?', [pct, projectId]);
};

const getSelfEmpId = async (userId) => {
  const [[r]] = await db.execute('SELECT id FROM employees WHERE user_id=?', [userId]);
  return r?.id || null;
};

// ── GET /api/projects/stats ───────────────────────────────
const getStats = async (req, res) => {
  try {
    const selfEmpId = await getSelfEmpId(req.user.id);

    const [[counts]] = await db.execute(`
      SELECT
        COUNT(*)                      AS total,
        SUM(status='Planning')        AS planning,
        SUM(status='Active')          AS active,
        SUM(status='On Hold')         AS on_hold,
        SUM(status='Completed')       AS completed,
        SUM(status='Cancelled')       AS cancelled,
        ROUND(AVG(progress_pct),0)    AS avg_progress
      FROM projects`);

    const [[taskCounts]] = await db.execute(`
      SELECT
        COUNT(*)                      AS total,
        SUM(status='To Do')           AS todo,
        SUM(status='In Progress')     AS in_progress,
        SUM(status='In Review')       AS in_review,
        SUM(status='Done')            AS done,
        SUM(status='Blocked')         AS blocked,
        SUM(due_date < CURDATE() AND status NOT IN ('Done')) AS overdue
      FROM tasks`);

    let myTasks = 0;
    if (selfEmpId) {
      const [[r]] = await db.execute(
        "SELECT COUNT(*) AS c FROM tasks WHERE assigned_to=? AND status NOT IN ('Done')", [selfEmpId]
      );
      myTasks = r.c;
    }

    res.json({ success:true, data:{ counts, taskCounts, myTasks } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Stats failed' });
  }
};

// ── GET /api/projects ─────────────────────────────────────
const getProjects = async (req, res) => {
  try {
    const { status, department_id, my_projects, search, page=1, limit=12 } = req.query;
    const selfEmpId = await getSelfEmpId(req.user.id);

    const conditions = ['1=1']; const params = [];

    if (my_projects === 'true' && selfEmpId) {
      conditions.push('(p.manager_id=? OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.employee_id=?))');
      params.push(selfEmpId, selfEmpId);
    }
    if (status)        { conditions.push('p.status=?');           params.push(status); }
    if (department_id) { conditions.push('p.department_id=?');    params.push(department_id); }
    if (search?.trim()) {
      conditions.push('(p.name LIKE ? OR p.project_code LIKE ? OR p.client LIKE ?)');
      const s = `%${search.trim()}%`;
      params.push(s,s,s);
    }

    const where  = conditions.join(' AND ');
    const offset = (Number(page)-1)*Number(limit);

    const [[{total}]] = await db.execute(
      `SELECT COUNT(*) AS total FROM projects p WHERE ${where}`, params
    );

    const [rows] = await db.execute(`
      SELECT p.*,
             d.name  AS department_name,
             m.full_name AS manager_name,
             u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM tasks WHERE project_id=p.id) AS total_tasks,
             (SELECT COUNT(*) FROM tasks WHERE project_id=p.id AND status='Done') AS done_tasks,
             (SELECT COUNT(*) FROM tasks WHERE project_id=p.id AND status='Blocked') AS blocked_tasks,
             (SELECT COUNT(*) FROM project_members WHERE project_id=p.id) AS member_count
      FROM projects p
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN employees   m ON m.id = p.manager_id
      LEFT JOIN users       u ON u.id = p.created_by
      WHERE ${where}
      ORDER BY FIELD(p.status,'Active','Planning','On Hold','Completed','Cancelled'), p.created_at DESC
      LIMIT ? OFFSET ?`, [...params, Number(limit), offset]);

    res.json({ success:true, data:rows, meta:{ total:Number(total), page:Number(page), pages:Math.ceil(Number(total)/Number(limit)) } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to fetch projects' });
  }
};

// ── GET /api/projects/:id ─────────────────────────────────
const getProject = async (req, res) => {
  try {
    const [[p]] = await db.execute(`
      SELECT p.*,
             d.name  AS department_name,
             m.full_name AS manager_name,
             u.full_name AS created_by_name
      FROM projects p
      LEFT JOIN departments d ON d.id=p.department_id
      LEFT JOIN employees   m ON m.id=p.manager_id
      LEFT JOIN users       u ON u.id=p.created_by
      WHERE p.id=?`, [req.params.id]);
    if (!p) return res.status(404).json({ success:false, message:'Project not found' });

    const [members] = await db.execute(`
      SELECT pm.*, e.full_name, e.employee_id AS emp_code, d.name AS department
      FROM project_members pm
      JOIN employees e ON e.id=pm.employee_id
      LEFT JOIN departments d ON d.id=e.department_id
      WHERE pm.project_id=? ORDER BY pm.role`, [req.params.id]);

    const [milestones] = await db.execute(`
      SELECT ms.*,
             (SELECT COUNT(*) FROM tasks WHERE milestone_id=ms.id) AS task_count,
             (SELECT COUNT(*) FROM tasks WHERE milestone_id=ms.id AND status='Done') AS done_count
      FROM project_milestones ms WHERE ms.project_id=? ORDER BY ms.due_date`, [req.params.id]);

    const [tasks] = await db.execute(`
      SELECT t.*,
             e.full_name AS assigned_name,
             (SELECT COUNT(*) FROM tasks WHERE parent_task_id=t.id) AS subtask_count,
             (SELECT COUNT(*) FROM task_comments WHERE task_id=t.id) AS comment_count
      FROM tasks t
      LEFT JOIN employees e ON e.id=t.assigned_to
      WHERE t.project_id=? AND t.parent_task_id IS NULL
      ORDER BY t.sort_order, t.created_at`, [req.params.id]);

    // Group tasks by status for kanban
    const kanban = {};
    ['To Do','In Progress','In Review','Done','Blocked'].forEach(s => kanban[s]=[]);
    tasks.forEach(t => { if(kanban[t.status]) kanban[t.status].push(t); });

    res.json({ success:true, data:{ ...p, members, milestones, tasks, kanban } });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Failed to fetch project' });
  }
};

// ── POST /api/projects ────────────────────────────────────
const createProject = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { name, description, client, department_id, status, priority,
            start_date, end_date, budget, color, manager_id, member_ids=[] } = req.body;

    const code = await genProjectCode(conn);

    const [result] = await conn.execute(`
      INSERT INTO projects
        (project_code,name,description,client,department_id,status,priority,
         start_date,end_date,budget,color,manager_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, name.trim(), description||null, client||null, department_id||null,
       status||'Planning', priority||'Medium', start_date||null, end_date||null,
       budget||0, color||'#006bb7', manager_id||null, req.user.id]);

    const projectId = result.insertId;

    // Add manager as member
    if (manager_id) {
      await conn.execute(
        'INSERT IGNORE INTO project_members (project_id,employee_id,role) VALUES (?,?,?)',
        [projectId, manager_id, 'Manager']
      );
    }
    // Add other members
    for (const empId of member_ids) {
      if (empId && empId !== manager_id) {
        await conn.execute(
          'INSERT IGNORE INTO project_members (project_id,employee_id,role) VALUES (?,?,?)',
          [projectId, empId, 'Member']
        );
      }
    }

    await conn.execute(
      'INSERT INTO audit_logs (user_id,action,module,ip_address) VALUES (?,?,?,?)',
      [req.user.id, `CREATE_PROJECT:${code}`, 'projects', req.ip]
    );

    await conn.commit();
    res.status(201).json({ success:true, message:`Project ${code} created`, data:{ id:projectId, project_code:code } });
  } catch(err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success:false, message:'Create failed' });
  } finally { conn.release(); }
};

// ── PUT /api/projects/:id ─────────────────────────────────
const updateProject = async (req, res) => {
  try {
    const { name, description, client, department_id, status, priority,
            start_date, end_date, budget, spent, color, manager_id } = req.body;
    await db.execute(`
      UPDATE projects SET name=?,description=?,client=?,department_id=?,status=?,
      priority=?,start_date=?,end_date=?,budget=?,spent=?,color=?,manager_id=?
      WHERE id=?`,
      [name.trim(), description||null, client||null, department_id||null, status||'Planning',
       priority||'Medium', start_date||null, end_date||null, budget||0, spent||0,
       color||'#006bb7', manager_id||null, req.params.id]);
    res.json({ success:true, message:'Project updated' });
  } catch(err) { res.status(500).json({ success:false, message:'Update failed' }); }
};

// ── POST /api/projects/:id/members ────────────────────────
const addMember = async (req, res) => {
  try {
    const { employee_id, role } = req.body;
    await db.execute(
      'INSERT IGNORE INTO project_members (project_id,employee_id,role) VALUES (?,?,?)',
      [req.params.id, employee_id, role||'Member']
    );
    res.json({ success:true, message:'Member added' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── DELETE /api/projects/:id/members/:empId ───────────────
const removeMember = async (req, res) => {
  try {
    await db.execute(
      'DELETE FROM project_members WHERE project_id=? AND employee_id=?',
      [req.params.id, req.params.empId]
    );
    res.json({ success:true, message:'Member removed' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── POST /api/projects/:id/milestones ─────────────────────
const addMilestone = async (req, res) => {
  try {
    const { title, description, due_date } = req.body;
    const [r] = await db.execute(
      'INSERT INTO project_milestones (project_id,title,description,due_date) VALUES (?,?,?,?)',
      [req.params.id, title.trim(), description||null, due_date||null]
    );
    res.status(201).json({ success:true, message:'Milestone added', data:{ id:r.insertId } });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── PATCH /api/milestones/:id/complete ────────────────────
const completeMilestone = async (req, res) => {
  try {
    await db.execute(
      "UPDATE project_milestones SET status='Completed',completed_at=NOW() WHERE id=?",
      [req.params.id]
    );
    res.json({ success:true, message:'Milestone completed' });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── GET /api/projects/:id/tasks ───────────────────────────
const getTasks = async (req, res) => {
  try {
    const { status, assigned_to, milestone_id } = req.query;
    const conditions = ['t.project_id=?']; const params = [req.params.id];
    if (status)       { conditions.push('t.status=?');       params.push(status); }
    if (assigned_to)  { conditions.push('t.assigned_to=?');  params.push(assigned_to); }
    if (milestone_id) { conditions.push('t.milestone_id=?'); params.push(milestone_id); }

    const [rows] = await db.execute(`
      SELECT t.*,
             e.full_name AS assigned_name,
             ms.title    AS milestone_title,
             (SELECT COUNT(*) FROM tasks WHERE parent_task_id=t.id) AS subtask_count,
             (SELECT COUNT(*) FROM task_comments WHERE task_id=t.id) AS comment_count
      FROM tasks t
      LEFT JOIN employees e ON e.id=t.assigned_to
      LEFT JOIN project_milestones ms ON ms.id=t.milestone_id
      WHERE ${conditions.join(' AND ')} AND t.parent_task_id IS NULL
      ORDER BY t.sort_order, t.created_at`, params);

    res.json({ success:true, data:rows });
  } catch(err) { res.status(500).json({ success:false, message:'Failed to fetch tasks' }); }
};

// ── GET /api/tasks/:id ────────────────────────────────────
const getTask = async (req, res) => {
  try {
    const [[task]] = await db.execute(`
      SELECT t.*,
             e.full_name AS assigned_name,
             ms.title    AS milestone_title,
             p.name AS project_name, p.project_code
      FROM tasks t
      LEFT JOIN employees e ON e.id=t.assigned_to
      LEFT JOIN project_milestones ms ON ms.id=t.milestone_id
      JOIN projects p ON p.id=t.project_id
      WHERE t.id=?`, [req.params.id]);
    if (!task) return res.status(404).json({ success:false, message:'Task not found' });

    const [subtasks] = await db.execute(`
      SELECT t.*, e.full_name AS assigned_name
      FROM tasks t LEFT JOIN employees e ON e.id=t.assigned_to
      WHERE t.parent_task_id=? ORDER BY t.sort_order`, [req.params.id]);

    const [comments] = await db.execute(`
      SELECT tc.*, u.full_name AS author
      FROM task_comments tc JOIN users u ON u.id=tc.created_by
      WHERE tc.task_id=? ORDER BY tc.created_at ASC`, [req.params.id]);

    const [timeLogs] = await db.execute(`
      SELECT tl.*, e.full_name AS logged_by_name
      FROM task_time_logs tl JOIN employees e ON e.id=tl.employee_id
      WHERE tl.task_id=? ORDER BY tl.log_date DESC LIMIT 20`, [req.params.id]);

    res.json({ success:true, data:{ ...task, subtasks, comments, timeLogs } });
  } catch(err) { res.status(500).json({ success:false, message:'Failed to fetch task' }); }
};

// ── POST /api/projects/:id/tasks ─────────────────────────
const createTask = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { title, description, status, priority, assigned_to,
            estimated_hours, due_date, milestone_id, parent_task_id, tags } = req.body;

    const [[{max_order}]] = await conn.execute(
      'SELECT COALESCE(MAX(sort_order),0) AS max_order FROM tasks WHERE project_id=?', [req.params.id]
    );

    const [result] = await conn.execute(`
      INSERT INTO tasks
        (project_id,milestone_id,parent_task_id,title,description,status,priority,
         assigned_to,estimated_hours,due_date,tags,sort_order,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, milestone_id||null, parent_task_id||null, title.trim(),
       description||null, status||'To Do', priority||'Medium',
       assigned_to||null, estimated_hours||0, due_date||null,
       tags||null, max_order+1, req.user.id]);

    await recalcProgress(conn, req.params.id);
    await conn.commit();
    res.status(201).json({ success:true, message:'Task created', data:{ id:result.insertId } });
  } catch(err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success:false, message:'Create task failed' });
  } finally { conn.release(); }
};

// ── PATCH /api/tasks/:id ──────────────────────────────────
const updateTask = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { title, description, status, priority, assigned_to,
            estimated_hours, due_date, milestone_id, tags } = req.body;

    const [[old]] = await conn.execute('SELECT project_id, status AS old_status FROM tasks WHERE id=?', [req.params.id]);
    if (!old) { await conn.rollback(); return res.status(404).json({ success:false, message:'Not found' }); }

    const completed = status === 'Done' && old.old_status !== 'Done'
      ? new Date().toISOString().slice(0,19).replace('T',' ') : null;

    await conn.execute(`
      UPDATE tasks SET title=COALESCE(?,title), description=COALESCE(?,description),
        status=COALESCE(?,status), priority=COALESCE(?,priority),
        assigned_to=COALESCE(?,assigned_to), estimated_hours=COALESCE(?,estimated_hours),
        due_date=COALESCE(?,due_date), milestone_id=COALESCE(?,milestone_id),
        tags=COALESCE(?,tags),
        completed_at=CASE WHEN ?='Done' THEN COALESCE(completed_at,NOW()) ELSE completed_at END
      WHERE id=?`,
      [title||null, description||null, status||null, priority||null,
       assigned_to!==undefined?assigned_to:null, estimated_hours||null,
       due_date||null, milestone_id||null, tags||null,
       status||null, req.params.id]);

    await recalcProgress(conn, old.project_id);
    await conn.commit();
    res.json({ success:true, message:'Task updated' });
  } catch(err) {
    await conn.rollback();
    res.status(500).json({ success:false, message:'Update failed' });
  } finally { conn.release(); }
};

// ── PATCH /api/tasks/:id/move ─────────────────────────────
const moveTask = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { status } = req.body;
    const [[task]] = await conn.execute('SELECT project_id FROM tasks WHERE id=?', [req.params.id]);
    if (!task) { await conn.rollback(); return res.status(404).json({ success:false, message:'Not found' }); }

    await conn.execute(
      "UPDATE tasks SET status=?, completed_at=CASE WHEN ?='Done' THEN COALESCE(completed_at,NOW()) ELSE NULL END WHERE id=?",
      [status, status, req.params.id]
    );
    await recalcProgress(conn, task.project_id);
    await conn.commit();
    res.json({ success:true, message:`Task moved to ${status}` });
  } catch(err) {
    await conn.rollback();
    res.status(500).json({ success:false, message:'Move failed' });
  } finally { conn.release(); }
};

// ── DELETE /api/tasks/:id ─────────────────────────────────
const deleteTask = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[task]] = await conn.execute('SELECT project_id FROM tasks WHERE id=?', [req.params.id]);
    await conn.execute('DELETE FROM tasks WHERE id=?', [req.params.id]);
    if (task) await recalcProgress(conn, task.project_id);
    await conn.commit();
    res.json({ success:true, message:'Task deleted' });
  } catch(err) {
    await conn.rollback();
    res.status(500).json({ success:false, message:'Delete failed' });
  } finally { conn.release(); }
};

// ── POST /api/tasks/:id/comments ─────────────────────────
const addComment = async (req, res) => {
  try {
    const { comment } = req.body;
    if (!comment?.trim()) return res.status(422).json({ success:false, message:'Comment required' });
    const [r] = await db.execute(
      'INSERT INTO task_comments (task_id,comment,created_by) VALUES (?,?,?)',
      [req.params.id, comment.trim(), req.user.id]
    );
    res.status(201).json({ success:true, message:'Comment added', data:{ id:r.insertId } });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

// ── POST /api/tasks/:id/time-log ─────────────────────────
const logTime = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { hours, log_date, note } = req.body;
    const selfEmpId = await getSelfEmpId(req.user.id);
    if (!selfEmpId) { await conn.rollback(); return res.status(400).json({ success:false, message:'Employee not found' }); }

    await conn.execute(
      'INSERT INTO task_time_logs (task_id,employee_id,hours,log_date,note) VALUES (?,?,?,?,?)',
      [req.params.id, selfEmpId, hours, log_date||new Date().toISOString().slice(0,10), note||null]
    );
    // Update logged hours on task
    await conn.execute('UPDATE tasks SET logged_hours=logged_hours+? WHERE id=?', [hours, req.params.id]);
    await conn.commit();
    res.status(201).json({ success:true, message:`${hours}h logged` });
  } catch(err) {
    await conn.rollback();
    res.status(500).json({ success:false, message:'Log time failed' });
  } finally { conn.release(); }
};

// ── GET /api/projects/my-tasks ────────────────────────────
const getMyTasks = async (req, res) => {
  try {
    const selfEmpId = await getSelfEmpId(req.user.id);
    if (!selfEmpId) return res.status(404).json({ success:false, message:'Employee not found' });

    const [tasks] = await db.execute(`
      SELECT t.*,
             p.name AS project_name, p.project_code, p.color,
             ms.title AS milestone_title
      FROM tasks t
      JOIN projects p ON p.id=t.project_id
      LEFT JOIN project_milestones ms ON ms.id=t.milestone_id
      WHERE t.assigned_to=? AND t.status NOT IN ('Done')
      ORDER BY FIELD(t.priority,'Critical','High','Medium','Low'),
               FIELD(t.status,'Blocked','In Progress','In Review','To Do'),
               t.due_date ASC
      LIMIT 50`, [selfEmpId]);

    res.json({ success:true, data:tasks });
  } catch(err) { res.status(500).json({ success:false, message:'Failed' }); }
};

module.exports = {
  getStats, getProjects, getProject, createProject, updateProject,
  addMember, removeMember, addMilestone, completeMilestone,
  getTasks, getTask, createTask, updateTask, moveTask, deleteTask,
  addComment, logTime, getMyTasks,
};